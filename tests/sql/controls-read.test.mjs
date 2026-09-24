import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
const reader = "11111111-1111-4111-8111-111111111111";
let db;
const migration = (name) => readFile(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), "utf8");
const readAt = async (id) => (await db.query("select read_at from public.user_post_state where post_id=$1", [id])).rows[0]?.read_at?.toISOString() ?? null;
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
  await db.exec(`insert into auth.users values('${reader}'); insert into public.allowed_reader(user_id) values('${reader}');`);
  for (let i = 0; i < 9; i++) await db.query(`insert into public.post(id,topic,title,explanation,insight,deeper,status,published_at)
    values($1,'Topic','Title',array['Body'],'Insight','Deeper','sample',$2)`, [`p${i}`, new Date(Date.UTC(2026, 0, 1) - i * 60000).toISOString()]);
  for (const name of ["202609230001_content_engine", "202609240001_model_providers", "202609250001_unread_feed",
    "202609260001_knowledge_map", "202609270001_taste", "202609280001_feed_queued_at"]) await db.exec(await migration(name));
  // Touched on an older app, which did not count a control as reading: no read time.
  await db.exec(`insert into public.user_post_state(user_id,post_id,rating,bookmarked,expanded,first_seen_at,read_at,deeper_opened_at,opened_at,updated_at) values
    ('${reader}','p0','harder',false,false,null,null,null,null,'2026-09-23T10:00:00Z'),
    ('${reader}','p1',null,true,false,null,null,null,null,'2026-09-23T11:00:00Z'),
    ('${reader}','p2',null,false,false,'2026-09-23T08:00:00Z',null,null,null,'2026-09-23T08:00:00Z'),
    ('${reader}','p3',null,false,true,null,null,'2026-09-23T09:00:00Z',null,'2026-09-23T12:00:00Z'),
    ('${reader}','p4','more',false,false,null,'2026-09-22T08:00:00Z',null,null,'2026-09-23T13:00:00Z'),
    ('${reader}','p5',null,false,false,null,null,null,'2026-09-23T07:30:00Z','2026-09-23T07:45:00Z')`);
  await db.exec(await migration("202609290001_controls_mark_read"));
});
after(async () => db?.close());

test("posts rated, saved, expanded or opened on an older app are marked read as of when that happened", async () => {
  assert.equal(await readAt("p0"), "2026-09-23T10:00:00.000Z", "rated");
  assert.equal(await readAt("p1"), "2026-09-23T11:00:00.000Z", "saved");
  assert.equal(await readAt("p3"), "2026-09-23T09:00:00.000Z", "the deeper explanation, opened before the last change");
  assert.equal(await readAt("p5"), "2026-09-23T07:30:00.000Z", "the original");
  assert.equal(await readAt("p4"), "2026-09-22T08:00:00.000Z", "an existing read time stands");
  assert.equal(await readAt("p2"), null, "only seen: not read");
});

test("so they leave the feed at the next sitting and are listed under Read", async () => {
  await role("authenticated");
  const feed = (await db.query("select public.feed_page(null,20,'2026-09-24T12:00:00Z') p")).rows[0].p.map((p) => p.id);
  assert.deepEqual(feed, ["p2", "p6", "p7", "p8"]);
  const read = (await db.query("select public.saved_page('read') p")).rows[0].p.map((p) => p.id);
  assert.deepEqual(read, ["p1", "p0", "p3", "p5", "p4"]);
  const summary = (await db.query("select public.feed_summary('2026-09-24T12:00:00Z','2026-09-24T11:00:00Z') s")).rows[0].s;
  assert.equal(summary.unread, 4);
});

test("from now on the server counts any control as reading, whatever the app sends; seen alone does not", async () => {
  await role("authenticated");
  await db.query(`select public.save_post('p6','{"rating":"more"}')`);
  await db.query(`select public.save_post('p7','{"bookmarked":false}')`);
  await db.query(`select public.save_post('p8','{"seen":true}')`);
  await db.query(`select public.save_post('p2','{"expanded":true}')`);
  assert.ok(await readAt("p6"), "a rating");
  assert.ok(await readAt("p7"), "even un-saving");
  assert.ok(await readAt("p2"), "the deeper explanation");
  assert.equal(await readAt("p8"), null, "seen only");
  const first = await readAt("p6");
  await db.query(`select public.save_post('p6','{"rating":null,"opened":true}')`);
  assert.equal(await readAt("p6"), first, "the first read time stands");
  await assert.rejects(db.query(`select public.save_post('p6','{"read":false}')`), /Invalid state value/);
  await assert.rejects(db.query(`select public.save_post('p6','{"liked":true}')`), /Invalid post patch/);
});

test("running the migration again changes nothing", async () => {
  await db.exec("reset role");
  const before = (await db.query("select post_id, read_at from public.user_post_state order by post_id")).rows;
  await db.exec(await migration("202609290001_controls_mark_read"));
  assert.deepEqual((await db.query("select post_id, read_at from public.user_post_state order by post_id")).rows, before);
});
