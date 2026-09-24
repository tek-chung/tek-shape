import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
const reader = "11111111-1111-4111-8111-111111111111";
const stranger = "22222222-2222-4222-8222-222222222222";
let db;
const migration = (name) => readFile(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), "utf8");
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
  for (let i = 0; i < 6; i++) await db.query(`insert into public.post(id,topic,title,explanation,insight,deeper,status,published_at)
    values($1,'Topic','Title',array['Body'],'Insight','Deeper','sample',$2)`, [`p${i}`, new Date(Date.UTC(2026, 0, 1) - i * 60000).toISOString()]);
  for (const name of ["202609230001_content_engine", "202609240001_model_providers", "202609250001_unread_feed"]) await db.exec(await migration(name));
  // p0 and p2 read yesterday; p4 read after the cut-off (this sitting); p1 and p4 bookmarked.
  await db.exec(`insert into public.user_post_state(user_id,post_id,read_at,bookmarked,updated_at) values
    ('${reader}','p0','2026-09-23T10:00:00Z',false,'2026-09-23T10:00:00Z'),
    ('${reader}','p2','2026-09-23T11:00:00Z',false,'2026-09-23T11:00:00Z'),
    ('${reader}','p4','2026-09-24T12:30:00Z',true,'2026-09-24T12:30:00Z'),
    ('${reader}','p1',null,true,'2026-09-24T09:00:00Z')`);
});
after(async () => db?.close());
async function role(name, uid = reader) { await db.exec(`reset role; select set_config('test.uid','${uid}',false); set role ${name}`); }
const cutoff = "2026-09-24T12:00:00Z";
const ids = (rows) => rows.map((p) => p.id);

test("the feed skips posts read before the app was opened, but keeps ones read in this sitting", async () => {
  await role("authenticated");
  const page = (await db.query("select public.feed_page(null,8,$1) p", [cutoff])).rows[0].p;
  assert.deepEqual(ids(page), ["p1", "p3", "p4", "p5"]);
  assert.equal(page[0].title, "Title");
});

test("feed paging continues after any held post, even a read one", async () => {
  await role("authenticated");
  assert.deepEqual(ids((await db.query("select public.feed_page('p1',2,$1) p", [cutoff])).rows[0].p), ["p3", "p4"]);
  assert.deepEqual(ids((await db.query("select public.feed_page('p0',8,$1) p", [cutoff])).rows[0].p), ["p1", "p3", "p4", "p5"]);
  await assert.rejects(db.query("select public.feed_page('nope',8,$1)", [cutoff]), /Unknown queue cursor/);
  await assert.rejects(db.query("select public.feed_page(null,0,$1)", [cutoff]), /Invalid page size/);
  await assert.rejects(db.query("select public.feed_page(null,8,null)"), /Invalid read cutoff/);
});

test("Read and Library list posts newest first", async () => {
  await role("authenticated");
  assert.deepEqual(ids((await db.query("select public.saved_page('read') p")).rows[0].p), ["p4", "p2", "p0"]);
  assert.deepEqual(ids((await db.query("select public.saved_page('read',1,1) p")).rows[0].p), ["p2"]);
  assert.deepEqual(ids((await db.query("select public.saved_page('bookmarked') p")).rows[0].p), ["p4", "p1"]);
  await assert.rejects(db.query("select public.saved_page('everything')"), /Invalid list/);
});

test("a stranger gets neither the feed nor the lists", async () => {
  await role("authenticated", stranger);
  await assert.rejects(db.query("select public.feed_page()"), /Private account required/);
  await assert.rejects(db.query("select public.saved_page('read')"), /Private account required/);
  await role("anon", stranger);
  await assert.rejects(db.query("select public.feed_page()"), /permission denied/);
});
