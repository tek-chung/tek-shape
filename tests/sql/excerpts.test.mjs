import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
const reader = "11111111-1111-4111-8111-111111111111";
const stranger = "22222222-2222-4222-8222-222222222222";
let db;
const migration = (name) => readFile(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), "utf8");
async function role(name, uid = reader) { await db.exec(`reset role; select set_config('test.uid','${uid}',false); set role ${name}`); }
const body = [{ t: "p", text: "The opening paragraph." }, { t: "h", text: "A heading" }, { t: "ul", items: ["One", "Two"] }];
const source = { url: "https://www.technologyreview.com/2026/09/23/1/towers/", publisher: "MIT Technology Review", title: "Towers", articleDate: null, accessedAt: "2026-09-24T10:00:00.000Z" };
const excerpt = { kind: "excerpt", topic: "Politics & society", subtopic: "Tech Policy", title: "Towers", explanation: ["The opening paragraph."],
  insight: null, deeper: null, contentType: "evergreen", difficulty: 1, conceptIds: ["tech-policy"], eventDate: null, articleDate: null,
  umbrella: "politics-society", field: "public-policy", sources: [source], body };

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
    "202609270001_taste", "202609280001_feed_queued_at", "202609290001_controls_mark_read", "202609300001_excerpts"]) await db.exec(await migration(name));
  const candidate = (id, payload) => db.query(`insert into public.content_candidate(id,payload,evidence,checks,status) values($1,$2,'[]','{"passed":true}','checked')`, [id, payload]);
  await candidate("idea-excerpt", excerpt);
  const { kind: _k, body: _b, ...drafted } = excerpt; void _k; void _b;
  await candidate("idea-post", { ...drafted, insight: "An insight.", deeper: "A deeper note." });
  await db.query("select public.publish_candidate('idea-excerpt','Auto-published excerpt: the publisher''s own words.')");
  await db.query("select public.publish_candidate('idea-post','Auto-published: passed checks and review.')");
});
after(async () => db?.close());

test("an excerpt publishes without insight or deeper, with its saved article; an ordinary post is unchanged", async () => {
  const rows = (await db.query("select id, kind, insight, deeper, body is not null as saved from public.post where id in ('idea-excerpt','idea-post') order by id")).rows;
  assert.deepEqual(rows, [
    { id: "idea-excerpt", kind: "excerpt", insight: null, deeper: null, saved: true },
    { id: "idea-post", kind: "post", insight: "An insight.", deeper: "A deeper note.", saved: false },
  ]);
});

test("the feed says what kind a post is and whether an article is saved, but never carries the article", async () => {
  const json = (await db.query("select public.post_json(p) j from public.post p where id = 'idea-excerpt'")).rows[0].j;
  assert.equal(json.kind, "excerpt");
  assert.equal(json.hasBody, true);
  assert.equal(json.body, undefined);
  assert.equal((await db.query("select public.post_json(p) j from public.post p where id = 'idea-post'")).rows[0].j.hasBody, false);
});

test("the reader opens a saved article; a stranger cannot", async () => {
  await role("authenticated");
  assert.deepEqual((await db.query("select public.post_body('idea-excerpt') b")).rows[0].b, body);
  assert.equal((await db.query("select public.post_body('idea-post') b")).rows[0].b, null);
  await role("authenticated", stranger);
  await assert.rejects(db.query("select public.post_body('idea-excerpt')"), /Private account required/);
  await db.exec("reset role");
});

test("only an excerpt may lack an insight, and an excerpt may not have one", async () => {
  const insert = (id, kind, insight, deeper) => db.query(`insert into public.post(id,topic,title,explanation,insight,deeper,status,kind) values($1,'T','T',array['B'],$2,$3,'sample',$4)`,
    [id, insight, deeper, kind]);
  await assert.rejects(insert("idea-no-insight", "post", null, "Deeper."), /post_insight_check/);
  await assert.rejects(insert("idea-no-deeper", "post", "An insight.", null), /post_deeper_check/);
  await assert.rejects(insert("idea-bad-excerpt", "excerpt", "An insight.", null), /post_insight_check/);
  await insert("idea-sample-excerpt", "excerpt", null, null);
  await assert.rejects(db.query(`insert into public.post(id,topic,title,explanation,insight,deeper,status,body) values('idea-big','T','T',array['B'],'I','D','sample','{"not":"a list"}')`), /check/);
});
