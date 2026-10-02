import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
const reader = "11111111-1111-4111-8111-111111111111";
const stranger = "22222222-2222-4222-8222-222222222222";
let db;
const migration = (name) => readFile(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), "utf8");
async function role(name, uid = reader) { await db.exec(`reset role; select set_config('test.uid','${uid}',false); set role ${name}`); }

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
    "202610020001_mixer_foundations", "202610030001_understanding", "202610040001_concepts", "202610050001_stem", "202610060001_briefing_echoes"])
    await db.exec(await migration(name));
  for (const id of ["p0", "p1", "p2"]) {
    await db.query(`insert into public.post(id,topic,title,explanation,insight,deeper,status,verification_status,reviewed_at,concept_ids,sources,editorial_note)
      values($1,'T','Title',array['B'],'I','D','published','source_checked',now(),array['idea'],'[{"url":"https://p.example/a"}]','Checked.')`, [id]);
  }
});
after(async () => db?.close());

const days = (n) => `now() - interval '${n} days'`;
const valued = (post, readDaysAgo, extra = "rating = 'more'") => db.exec(`reset role;
  insert into public.user_post_state(user_id, post_id, read_at) values ('${reader}', '${post}', ${days(readDaysAgo)})
  on conflict (user_id, post_id) do update set read_at = excluded.read_at;
  update public.user_post_state set ${extra} where user_id = '${reader}' and post_id = '${post}'`);
async function due() { await role("authenticated"); const r = (await db.query("select public.echo_due(10) d")).rows[0].d; await db.exec("reset role"); return r; }

test("echoes: a valued post returns after two days, then 7, 21 and 60 after each remembering; forgetting repeats in two", async () => {
  await valued("p0", 3);
  await valued("p1", 1);
  await valued("p2", 5, "rating = 'uninteresting'");
  let list = await due();
  assert.deepEqual(list.map((p) => [p.id, p.echoStage]), [["p0", 0]], "two days on, the liked post; not the disliked one; not yesterday's");
  assert.ok(list[0].insight && list[0].title, "it carries the post to recall");
  await role("authenticated");
  assert.equal((await db.query("select public.echo_answer('p0', true) n")).rows[0].n, 1);
  await assert.rejects(db.query("select public.echo_answer('p0', true)"), /Not due/, "a double tap cannot skip a stage");
  await assert.rejects(db.query("select public.echo_answer('p1', true)"), /Not due/);
  await db.exec("reset role");
  assert.deepEqual(await due(), [], "next due in seven days");
  await db.exec(`update public.echo_answer set answered_at = ${days(8)} where post_id = 'p0'`);
  assert.deepEqual((await due()).map((p) => [p.id, p.echoStage]), [["p0", 1]]);
  await role("authenticated");
  assert.equal((await db.query("select public.echo_answer('p0', false) n")).rows[0].n, 1, "forgotten: same stage");
  await db.exec("reset role");
  await db.exec(`update public.echo_answer set answered_at = ${days(3)} where post_id = 'p0' and not remembered`);
  assert.deepEqual((await due()).map((p) => [p.id, p.echoStage]), [["p0", 1]], "back two days after forgetting");
});

test("echoes and the briefing are the reader's own", async () => {
  await db.exec(`reset role; insert into public.briefing(user_id, post_id, rank) values ('${reader}', 'p1', 1)`);
  await role("authenticated");
  assert.equal((await db.query("select count(*)::int n from public.briefing")).rows[0].n, 1);
  await assert.rejects(db.query(`insert into public.briefing(user_id, post_id, rank) values ('${reader}', 'p2', 2)`), /permission denied/);
  await assert.rejects(db.query(`insert into public.echo_answer(user_id, post_id, stage, remembered) values ('${reader}', 'p1', 0, true)`), /permission denied/);
  await assert.rejects(db.query(`select * from public.echo_schedule('${reader}')`), /permission denied/);
  await role("authenticated", stranger);
  assert.equal((await db.query("select count(*)::int n from public.briefing")).rows[0].n, 0);
  await assert.rejects(db.query("select public.echo_due(3)"), /Private account required/);
  await role("anon", "");
  await assert.rejects(db.query("select public.echo_due(3)"), /permission denied/);
  await db.exec("reset role");
});
