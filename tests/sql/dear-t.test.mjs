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
    "202610020001_mixer_foundations", "202610030001_understanding", "202610040001_concepts", "202610050001_stem", "202610060001_briefing_echoes", "202610070001_dear_t"])
    await db.exec(await migration(name));
  for (const id of ["p0", "p1", "p2"]) {
    await db.query(`insert into public.post(id,topic,title,explanation,insight,deeper,status,verification_status,reviewed_at,concept_ids,sources,editorial_note)
      values($1,'T','Title',array['B'],'I','D','published','source_checked',now(),array['idea'],'[{"url":"https://p.example/a"}]','Checked.')`, [id]);
  }
});
after(async () => db?.close());

test("Dear T: the reader sends and removes requests; five at most; the engine fills in the steers", async () => {
  await role("authenticated");
  const id = (await db.query("select public.dear_t_send($1, 3) id", ["Dear T, less AI news, more Byzantine history"])).rows[0].id;
  const row = (await db.query("select text, days, status, until > now() + interval '71 hours' as later from public.dear_t")).rows[0];
  assert.deepEqual(row, { text: "Dear T, less AI news, more Byzantine history", days: 3, status: "pending", later: true });
  for (const [text, days, why] of [["ok", 3, /3 and 280/], ["x".repeat(281), 3, /3 and 280/], ["fine text", 2, /1, 3 or 7/]])
    await assert.rejects(db.query("select public.dear_t_send($1, $2)", [text, days]), why);
  for (let i = 0; i < 4; i++) await db.query("select public.dear_t_send($1, 1)", [`request ${i}`]);
  await assert.rejects(db.query("select public.dear_t_send('one too many', 1)"), /Five requests/);
  await assert.rejects(db.query("update public.dear_t set status = 'applied'"), /permission denied/);
  await db.exec("reset role");
  await db.query("update public.dear_t set status = 'applied', steers = $2 where id = $1", [id, JSON.stringify([{ scope: "field", key: "artificial-intelligence", choice: "less" }])]);
  await role("authenticated", stranger);
  await assert.rejects(db.query("select public.dear_t_send('hello there', 1)"), /Private account required/);
  await role("authenticated");
  assert.equal((await db.query("select steers from public.dear_t where id = $1", [id])).rows[0].steers[0].choice, "less");
  await db.query("select public.dear_t_remove($1)", [id]);
  assert.equal((await db.query("select count(*)::int n from public.dear_t")).rows[0].n, 4);
  await db.exec("reset role");
});
