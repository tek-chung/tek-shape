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
    "202610020001_mixer_foundations", "202610030001_understanding", "202610040001_concepts", "202610050001_stem"])
    await db.exec(await migration(name));
  for (const id of ["p0", "p1", "p2"]) {
    await db.query(`insert into public.post(id,topic,title,explanation,insight,deeper,status,verification_status,reviewed_at,concept_ids,sources,editorial_note)
      values($1,'T','Title',array['B'],'I','D','published','source_checked',now(),array['idea'],'[{"url":"https://p.example/a"}]','Checked.')`, [id]);
  }
});
after(async () => db?.close());

test("up to three fields can be the stem; subtopics cannot; the rest of steering is as before", async () => {
  await role("authenticated");
  for (const f of ["ethics", "neuroscience", "quantum-physics"]) await db.query("select public.set_topic_preference('field', $1, 'stem')", [f]);
  await db.query("select public.set_topic_preference('field', 'ethics', 'stem')");
  await assert.rejects(db.query("select public.set_topic_preference('field', 'geology', 'stem')"), /Three stem fields at most/);
  await assert.rejects(db.query("select public.set_topic_preference('subtopic', 'ethics::moral luck', 'stem')"), /Only a field/);
  await db.query("select public.set_topic_preference('field', 'ethics', 'more')");
  await db.query("select public.set_topic_preference('field', 'geology', 'stem')");
  const view = (await db.query("select public.taste_view() v")).rows[0].v;
  assert.deepEqual(view.preferences.filter((p) => p.choice === "stem").map((p) => p.key).sort(), ["geology", "neuroscience", "quantum-physics"]);
  await assert.rejects(db.query("select public.set_topic_preference('field', 'ethics', 'deep')"), /Invalid choice/);
  await role("authenticated", stranger);
  await assert.rejects(db.query("select public.set_topic_preference('field', 'ethics', 'stem')"), /Private account required/);
  await db.exec("reset role");
});
