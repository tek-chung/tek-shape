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
  await db.query(`insert into public.post(id,topic,title,explanation,insight,deeper,status,published_at) values('sample-a','T','Title',array['B'],'I','D','sample',now())`);
  for (const name of ["202609230001_content_engine", "202609240001_model_providers", "202609250001_unread_feed", "202609260001_knowledge_map", "202609270001_taste", "202609280001_feed_queued_at"])
    await db.exec(await migration(name));
});
after(async () => db?.close());
async function role(name, uid = reader) { await db.exec(`reset role; select set_config('test.uid','${uid}',false); set role ${name}`); }

test("opening the original is recorded once and returned with the reading state", async () => {
  await role("authenticated");
  await db.query(`select public.save_post('sample-a', '{"opened":true,"read":true}')`);
  const first = (await db.query("select opened_at from public.user_post_state where post_id='sample-a'")).rows[0].opened_at;
  await db.query(`select public.save_post('sample-a', '{"opened":true}')`);
  assert.deepEqual((await db.query("select opened_at from public.user_post_state where post_id='sample-a'")).rows[0].opened_at, first);
  const state = (await db.query("select public.reading_state() s")).rows[0].s;
  assert.ok(state.posts["sample-a"].openedAt);
  await assert.rejects(db.query(`select public.save_post('sample-a', '{"opened":false}')`), /Invalid state value/);
});

test("the reader steers fields and subtopics; a snooze lasts 30 days; clearing removes it", async () => {
  await role("authenticated");
  await db.query("select public.set_topic_preference('field','probability-statistics','less')");
  await db.query("select public.set_topic_preference('subtopic','algebra-number-theory::prime gaps','snooze')");
  let view = (await db.query("select public.taste_view() v")).rows[0].v;
  assert.equal(view.snapshot, null);
  assert.deepEqual(view.preferences.map((p) => [p.scope, p.key, p.choice]).sort(), [["field", "probability-statistics", "less"], ["subtopic", "algebra-number-theory::prime gaps", "snooze"]]);
  const until = view.preferences.find((p) => p.choice === "snooze").until;
  assert.ok(Math.abs(Date.parse(until) - Date.now() - 30 * 86_400_000) < 3_600_000);
  await db.query("select public.set_topic_preference('field','probability-statistics','more')");
  await db.query("select public.set_topic_preference('subtopic','algebra-number-theory::prime gaps',null)");
  view = (await db.query("select public.taste_view() v")).rows[0].v;
  assert.deepEqual(view.preferences.map((p) => [p.key, p.choice]), [["probability-statistics", "more"]]);
  for (const bad of ["select public.set_topic_preference('umbrella','x','more')", "select public.set_topic_preference('field','Bad Key','more')",
    "select public.set_topic_preference('subtopic','no-separator','more')", "select public.set_topic_preference('field','ethics','love')"])
    await assert.rejects(db.query(bad), /Invalid/);
});

test("the engine writes the snapshot and queue slots; the reader only reads their own", async () => {
  await role("service_role");
  await db.query("insert into public.taste_snapshot(user_id, model) values($1, $2)", [reader, JSON.stringify({ version: 1, niches: [{ name: "Behavioural Finance" }] })]);
  await db.query("update public.feed_queue set slot='explore' where user_id=$1 and post_id='sample-a'", [reader]);
  await assert.rejects(db.query("update public.feed_queue set slot='surprise' where post_id='sample-a'"), /check/);
  await role("authenticated");
  assert.equal((await db.query("select public.taste_view() v")).rows[0].v.snapshot.niches[0].name, "Behavioural Finance");
  await assert.rejects(db.query("insert into public.taste_snapshot(user_id, model) values($1, '{}')", [reader]), /permission denied/);
  await role("authenticated", stranger);
  await assert.rejects(db.query("select public.taste_view()"), /Private account required/);
  await assert.rejects(db.query("select public.set_topic_preference('field','ethics','more')"), /Private account required/);
  assert.equal((await db.query("select * from public.topic_preference")).rows.length, 0);
  await role("anon", stranger);
  await assert.rejects(db.query("select public.taste_view()"), /permission denied/);
});

test("feed items say when they joined the feed, so the app can count what is new", async () => {
  await role("authenticated");
  const page = (await db.query("select public.feed_page(null, 8, '2000-01-01'::timestamptz) p")).rows[0].p;
  assert.ok(page.length >= 1);
  assert.ok(page.every((p) => Number.isFinite(Date.parse(p.queuedAt)) && p.id && p.title));
});

test("the summary counts unread posts that joined the feed since the last visit, and names the first", async () => {
  await role("service_role");
  await db.query(`insert into public.post(id,topic,title,explanation,insight,deeper,status,published_at) values('sample-b','T','New one',array['B'],'I','D','sample',now())`);
  await db.query(`insert into public.feed_queue(user_id,post_id,position,queued_at) values($1,'sample-b',(select coalesce(max(position),0)+1 from public.feed_queue where user_id=$1),now())`, [reader]);
  await role("authenticated");
  const summary = (await db.query("select public.feed_summary(now(), now() - interval '1 hour') s")).rows[0].s;
  assert.deepEqual([summary.arrivals, summary.firstArrival], [1, "sample-b"]);
  assert.equal(summary.unread, 1, "sample-a was read earlier in this file, so only the new one waits");
  const none = (await db.query("select public.feed_summary(now(), now() + interval '1 hour') s")).rows[0].s;
  assert.deepEqual([none.arrivals, none.firstArrival], [0, null]);
  await assert.rejects(db.query("select public.feed_summary(null, now())"), /Invalid window/);
  await role("authenticated", stranger);
  await assert.rejects(db.query("select public.feed_summary(now(), now())"), /Private account required/);
});
