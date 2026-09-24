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
  for (const name of ["202609230001_content_engine", "202609240001_model_providers", "202609250001_unread_feed", "202609260001_knowledge_map"]) await db.exec(await migration(name));
});
after(async () => db?.close());
async function role(name, uid = reader) { await db.exec(`reset role; select set_config('test.uid','${uid}',false); set role ${name}`); }

test("publishing carries the subject map, and the knowledge map aggregates reading per subtopic", async () => {
  await role("service_role");
  const payload = (subtopic, difficulty) => ({ topic: "Mathematics", umbrella: "mathematics", field: "algebra-number-theory", subtopic, title: "T", explanation: ["B"],
    insight: "I", deeper: "D", contentType: "evergreen", difficulty, conceptIds: ["primes"], eventDate: null, articleDate: null, sources: [{ url: "https://e.org/a" }] });
  const add = async (id, p) => {
    await db.query("insert into public.content_candidate(id,payload,evidence,checks,status) values($1,$2,'[]','{\"passed\":true}','checked')", [id, JSON.stringify(p)]);
    await db.query("select public.publish_candidate($1,'Reviewed and fine')", [id]);
  };
  await add("idea-a", payload("Prime Gaps", 3));
  await add("idea-b", payload("prime gaps", 2));
  await add("idea-c", payload("Group Theory", 4));
  const row = (await db.query("select umbrella, field, subtopic from public.post where id='idea-a'")).rows[0];
  assert.deepEqual(row, { umbrella: "mathematics", field: "algebra-number-theory", subtopic: "Prime Gaps" });
  await db.query(`select public.append_feed('${reader}', array['idea-a','idea-b','idea-c'])`);
  await db.exec(`reset role; insert into public.user_post_state(user_id,post_id,read_at,deeper_opened_at,rating,bookmarked) values
    ('${reader}','idea-a',now(),now(),'more',true), ('${reader}','idea-b',now(),null,'uninteresting',false)`);
  await role("authenticated");
  const map = (await db.query("select public.knowledge_map() m")).rows[0].m;
  assert.equal(map.length, 2);
  const primes = map.find((r) => r.subtopic.toLowerCase() === "prime gaps");
  assert.deepEqual({ posts: primes.posts, read: primes.read, deeper: primes.deeper, saved: primes.saved, more: primes.more, uninteresting: primes.uninteresting, depth: primes.depth },
    { posts: 2, read: 2, deeper: 1, saved: 1, more: 1, uninteresting: 1, depth: 3 + 1 + 2 });
  const groups = map.find((r) => r.subtopic === "Group Theory");
  assert.equal(groups.read, 0); assert.equal(groups.depth, 0);
  const post = (await db.query("select public.feed_page(null,8,now()) p")).rows[0].p;
  assert.ok(post.every((p) => p.field && p.umbrella));
});

test("a stranger gets no knowledge map", async () => {
  await role("authenticated", stranger);
  await assert.rejects(db.query("select public.knowledge_map()"), /Private account required/);
  await role("anon", stranger);
  await assert.rejects(db.query("select public.knowledge_map()"), /permission denied/);
});
