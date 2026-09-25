import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
const reader = "11111111-1111-4111-8111-111111111111";
const stranger = "22222222-2222-4222-8222-222222222222";
let db;
const migration = (name) => readFile(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), "utf8");
async function role(name, uid = reader) { await db.exec(`reset role; select set_config('test.uid','${uid}',false); set role ${name}`); }
const queue = async () => (await db.query(`select post_id, position, slot from public.feed_queue where user_id = '${reader}' order by position`)).rows;

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
    "202609270001_taste", "202609280001_feed_queued_at", "202609290001_controls_mark_read", "202609300001_excerpts", "202610010001_feed_reserve"])
    await db.exec(await migration(name));
  for (const [id, status] of [["p0", "published"], ["p1", "published"], ["p2", "published"], ["p3", "published"], ["p4", "sample"]]) {
    await db.query(`insert into public.post(id,topic,title,explanation,insight,deeper,status,verification_status,reviewed_at,concept_ids,sources,editorial_note)
      values($1,'T','Title',array['B'],'I','D',$2,$3,now(),array['idea'],'[{"url":"https://p.example/a"}]','Checked.')`, [id, status, status === "published" ? "source_checked" : "unreviewed"]);
  }
  await db.exec(`insert into public.feed_queue(user_id,post_id,position) values('${reader}','p0',1);
    insert into public.feed_reserve(user_id,post_id,rank,slot) values
      ('${reader}','p3',1,'explore'), ('${reader}','p1',2,'favourite'), ('${reader}','p2',3,'stretch'),
      ('${reader}','p0',4,'favourite'), ('${reader}','p4',5,'favourite');`);
});
after(async () => db?.close());

test("the reader draws the engine's next posts into the feed, best first, after what is already there", async () => {
  await role("authenticated");
  assert.equal((await db.query("select public.feed_top_up(2) n")).rows[0].n, 2);
  await db.exec("reset role");
  assert.deepEqual(await queue(), [
    { post_id: "p0", position: 1, slot: "legacy" },
    { post_id: "p3", position: 2, slot: "explore" },
    { post_id: "p1", position: 3, slot: "favourite" },
  ]);
  assert.deepEqual((await db.query(`select post_id from public.feed_reserve where user_id = '${reader}' order by rank`)).rows.map((r) => r.post_id), ["p2", "p4"],
    "drawn posts, and one already in the feed, leave the reserve");
});

test("only published, checked posts are drawn, and the reserve simply runs out", async () => {
  await role("authenticated");
  assert.equal((await db.query("select public.feed_top_up(30) n")).rows[0].n, 1, "p2 only; the sample p4 is never drawn");
  assert.equal((await db.query("select public.feed_top_up(30) n")).rows[0].n, 0);
  await db.exec("reset role");
  assert.deepEqual((await queue()).map((r) => r.post_id), ["p0", "p3", "p1", "p2"]);
});

test("the reserve is the engine's alone: no reading it, no writing the feed, no drawing for anyone else", async () => {
  await role("authenticated");
  await assert.rejects(db.query("select public.feed_top_up(0)"), /Invalid count/);
  await assert.rejects(db.query("select public.feed_top_up(31)"), /Invalid count/);
  await assert.rejects(db.query("select * from public.feed_reserve"), /permission denied/);
  await assert.rejects(db.query(`insert into public.feed_queue(user_id,post_id,position) values('${reader}','p4',99)`), /permission denied/);
  await role("authenticated", stranger);
  await assert.rejects(db.query("select public.feed_top_up(5)"), /Private account required/);
  await role("anon", "");
  await assert.rejects(db.query("select public.feed_top_up(5)"), /permission denied/);
  await db.exec("reset role");
});
