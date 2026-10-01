import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
const reader = "11111111-1111-4111-8111-111111111111";
const stranger = "22222222-2222-4222-8222-222222222222";
let db;
const migration = (name) => readFile(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), "utf8");
async function role(name, uid = reader) { await db.exec(`reset role; select set_config('test.uid','${uid}',false); set role ${name}`); }
const candidate = (id, status, url, publisher, age = "0 hours", kind = null) => db.query(
  `insert into public.content_candidate(id,payload,evidence,checks,status,created_at) values($1,$2,$3,'{}',$4,now() - $5::interval)`,
  [id, JSON.stringify(kind ? { kind } : {}), JSON.stringify([{ url, publisher, text: "…" }]), status, age]);
const state = async (post) => (await db.query(`select dwell_ms, read_at, updated_at from public.user_post_state where user_id = '${reader}' and post_id = $1`, [post])).rows[0];

before(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    grant usage on schema public to anon,authenticated,service_role;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid',true),'')::uuid $$;
    grant usage on schema auth to anon,authenticated,service_role;
    grant execute on function auth.uid() to anon,authenticated,service_role;`);
  await db.exec(await migration("202609220001_private_reading"));
  await db.exec(`insert into auth.users values('${reader}'),('${stranger}'); insert into public.allowed_reader(user_id) values('${reader}');`);
  for (const name of ["202609230001_content_engine", "202609240001_model_providers", "202609250001_unread_feed", "202609260001_knowledge_map",
    "202609270001_taste", "202609280001_feed_queued_at", "202609290001_controls_mark_read", "202609300001_excerpts", "202610010001_feed_reserve",
    "202610020001_mixer_foundations"])
    await db.exec(await migration(name));
  for (const id of ["p0", "p1", "p2"]) {
    await db.query(`insert into public.post(id,topic,title,explanation,insight,deeper,status,verification_status,reviewed_at,concept_ids,sources,editorial_note)
      values($1,'T','Title',array['B'],'I','D','published','source_checked',now(),array['idea'],'[{"url":"https://p.example/a"}]','Checked.')`, [id]);
  }
  await candidate("c-checked", "checked", "https://a.example/1", "Aeon");
  await candidate("c-held-old", "held", "https://a.example/2", "Aeon", "48 hours");
  await candidate("c-held-new", "held", "https://a.example/3", "Aeon", "1 hour");
  await candidate("c-published", "published", "https://b.example/4", "blog.example (via Hacker News)", "3 hours");
  await candidate("c-excerpt", "checked", "https://c.example/5", "MIT Technology Review", "2 hours", "excerpt");
});
after(async () => db?.close());

test("drafted sources are looked up, not loaded: held drafts are retried once old enough", async () => {
  await db.exec("reset role; set role service_role");
  const urls = ["https://a.example/1", "https://a.example/2", "https://a.example/3", "https://b.example/4", "https://new.example/9"];
  const found = (await db.query("select url from public.drafted_sources($1, now() - interval '24 hours') order by url", [urls])).rows.map((r) => r.url);
  assert.deepEqual(found, ["https://a.example/1", "https://a.example/3", "https://b.example/4"], "the day-old held draft is due a retry; the new URL is new");
  const all = (await db.query("select url from public.drafted_sources($1, null)", [urls])).rows.length;
  assert.equal(all, 4, "with no retry window every drafted URL counts");
  await assert.rejects(db.query("select * from public.drafted_sources($1, now())", [Array.from({ length: 5001 }, (_, i) => `https://x.example/${i}`)]), /Invalid source list/);
});

test("last drafted per publisher and the status summary come from the database in one row each", async () => {
  await db.exec("reset role; set role service_role");
  const last = Object.fromEntries((await db.query("select publisher, last_drafted from public.drafted_publishers()")).rows.map((r) => [r.publisher, r.last_drafted]));
  assert.deepEqual(Object.keys(last).sort(), ["Aeon", "MIT Technology Review", "blog.example (via Hacker News)"]);
  const summary = (await db.query("select public.candidate_summary() s")).rows[0].s;
  assert.deepEqual(summary.byStatus, { checked: 2, held: 2, published: 1 });
  assert.deepEqual(summary.excerpts, { "MIT Technology Review": 1 });
});

test("those helpers are the engine's alone", async () => {
  for (const sql of ["select * from public.drafted_sources(array['x'], now())", "select * from public.drafted_publishers()", "select public.candidate_summary()"]) {
    await role("authenticated");
    await assert.rejects(db.query(sql), /permission denied/, sql);
    await role("anon", "");
    await assert.rejects(db.query(sql), /permission denied/, sql);
  }
  await db.exec("reset role");
});

test("reading time adds up, is capped, is not reading, and leaves the change time alone", async () => {
  await role("authenticated");
  await db.query("select public.save_post('p0', $1)", [{ seen: true }]);
  const seen = await state("p0");
  await db.query("select public.save_post('p0', $1)", [{ dwell: 4200 }]);
  await db.query("select public.save_post('p0', $1)", [{ dwell: 1800 }]);
  let after = await state("p0");
  assert.equal(Number(after.dwell_ms), 6000);
  assert.equal(after.read_at, null, "time in view alone is not a read");
  assert.equal(after.updated_at.getTime(), seen.updated_at.getTime(), "dwell does not date the post's evidence or reorder the Library");
  await db.query("select public.save_post('p0', $1)", [{ rating: "more", dwell: 1000 }]);
  after = await state("p0");
  assert.equal(Number(after.dwell_ms), 7000);
  assert.ok(after.read_at, "a rating still counts as reading");
  for (const dwell of [0, -5, 600001, 1.5, "100", null, true])
    await assert.rejects(db.query("select public.save_post('p1', $1)", [{ dwell }]), /Invalid state value/, JSON.stringify(dwell));
  await assert.rejects(db.query("select public.save_post('p1', $1)", [{ dwel: 10 }]), /Invalid post patch/);
  for (let i = 0; i < 150; i++) await db.query("select public.save_post('p1', $1)", [{ dwell: 600000 }]);
  assert.equal(Number((await state("p1")).dwell_ms), 86400000, "capped at a day");
  await role("authenticated", stranger);
  await assert.rejects(db.query("select public.save_post('p2', $1)", [{ dwell: 100 }]), /row-level security/, "a stranger cannot report, as for any other patch");
  await db.exec("reset role");
});

test("each placement keeps its reasons and ranker from the reserve into the feed", async () => {
  await db.exec(`reset role; insert into public.feed_reserve(user_id,post_id,rank,slot,reasons,ranker) values
    ('${reader}','p2',1,'explore','{"v":1,"why":"thin-area"}','taste-1')`);
  await assert.rejects(db.exec(`insert into public.feed_reserve(user_id,post_id,rank,reasons) values('${reader}','p1',2,'[1]')`), /check/);
  await role("authenticated");
  assert.equal((await db.query("select public.feed_top_up(5) n")).rows[0].n, 1);
  const row = (await db.query(`select slot, reasons, ranker from public.feed_queue where post_id = 'p2'`)).rows[0];
  assert.deepEqual(row, { slot: "explore", reasons: { v: 1, why: "thin-area" }, ranker: "taste-1" }, "the reader can see why their own post was placed");
  await db.exec("reset role");
});
