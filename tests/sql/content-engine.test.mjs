import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
const reader = "11111111-1111-4111-8111-111111111111";
const stranger = "22222222-2222-4222-8222-222222222222";
let db;
before(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    grant usage on schema public to anon,authenticated,service_role;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid',true),'')::uuid $$;
    grant usage on schema auth to anon,authenticated,service_role;
    grant execute on function auth.uid() to anon,authenticated,service_role;`);
  await db.exec(await readFile(new URL("../../supabase/migrations/202609220001_private_reading.sql",import.meta.url),"utf8"));
  await db.exec(`insert into auth.users values('${reader}'),('${stranger}');
    insert into public.allowed_reader(user_id) values('${reader}');`);
  for (let i=0;i<11;i++) await db.query(`insert into public.post(id,topic,title,explanation,insight,deeper,status,published_at)
    values($1,'Topic','Title',array['Body'],'Insight','Deeper','sample',$2)`,[`sample-${i}`,new Date(Date.UTC(2026,0,1)-i*60000).toISOString()]);
  await db.exec(await readFile(new URL("../../supabase/migrations/202609230001_content_engine.sql",import.meta.url),"utf8"));
  await db.exec(await readFile(new URL("../../supabase/migrations/202609240001_model_providers.sql",import.meta.url),"utf8"));
});
after(async () => db?.close());
async function role(name,uid=reader) { await db.exec(`reset role; select set_config('test.uid','${uid}',false); set role ${name}`); }
const payload = { topic:"Science",title:"Evidence",explanation:["Body"],insight:"Insight",deeper:"Deeper",contentType:"evergreen",subtopic:"Physics",difficulty:2,conceptIds:["energy"],eventDate:null,articleDate:null,sources:[{url:"https://example.org/evidence"}] };
async function candidate(id,status="checked",extra={}) {
  await db.query("insert into public.content_candidate(id,payload,evidence,checks,status) values($1,$2,'[]',$3,$4)",[id,JSON.stringify({...payload,...extra}),JSON.stringify({passed:status==="checked"}),status]);
}
test("migration retains all eleven sample positions and pages past eight", async () => {
  await role("authenticated");
  const first=(await db.query("select public.reading_page() p")).rows[0].p;
  assert.equal(first.length,8); assert.equal(first[0].id,"sample-0");
  const next=(await db.query("select public.reading_page($1,$2,8) p",[first[7].publishedAt,first[7].id])).rows[0].p;
  assert.deepEqual(next.map(p=>p.id),["sample-8","sample-9","sample-10"]);
  assert.equal((await db.query("select public.reading_state() s")).rows[0].s.total,11);
});
test("stranger cannot see queue or call reading RPC", async () => {
  await role("authenticated",stranger);
  assert.equal((await db.query("select * from public.feed_queue")).rows.length,0);
  await assert.rejects(db.query("select public.reading_page()"),/Private account required/);
});
test("reader cannot read candidates, reserve budget, publish or append", async () => {
  await role("authenticated");
  for (const sql of ["select * from public.content_candidate","select public.reserve_content_call('gemini',0,10,10)","select public.publish_candidate('x','review note')",`select public.append_feed('${reader}',array['x'])`])
    await assert.rejects(db.query(sql),/permission denied/);
});
test("drafts are hidden even through direct table access", async () => {
  await role("service_role");
  await db.exec("insert into public.post(id,topic,title,explanation,insight,deeper,status) values('draft','Topic','Hidden',array['Body'],'Insight','Deeper','draft')");
  await role("authenticated");
  assert.equal((await db.query("select id from public.post where id='draft'")).rows.length,0);
});
const reserve = (provider,cost,daily,calls) => db.query("select public.reserve_content_call($1,$2,$3,$4)",[provider,cost,daily,calls]);
const budgetRow = async (provider) => (await db.query("select calls,reserved_usd::text cost from public.content_budget where day=current_date and provider=$1",[provider])).rows[0];
test("service budget refuses overspend and excessive calls without consuming failed reservations", async () => {
  await role("service_role");
  await db.exec("delete from public.content_budget");
  await reserve("openai",0.4,1,2);
  await assert.rejects(reserve("openai",0.7,1,2),/exhausted/);
  await reserve("openai",0.4,1,2);
  // Within spend (0.9 of 1) but over the call limit: the error now says which limit bit.
  await assert.rejects(reserve("openai",0.1,1,2),/limit reached for openai/);
  const row=await budgetRow("openai");
  assert.equal(row.calls,2); assert.equal(Number(row.cost),0.8);
});
test("free tiers run at zero cost under a zero budget, and a priced call does not", async () => {
  await role("service_role");
  await db.exec("delete from public.content_budget");
  await reserve("gemini",0,0,5);
  await reserve("gemini",0,0,5);
  await assert.rejects(reserve("openai",0.01,0,5),/exhausted/);
  assert.equal((await budgetRow("gemini")).calls,2);
});
test("call limits are counted per provider, so a full primary leaves the fallback usable", async () => {
  await role("service_role");
  await db.exec("delete from public.content_budget");
  await reserve("gemini",0,0,1);
  await assert.rejects(reserve("gemini",0,0,1),/limit reached for gemini/);
  await reserve("mistral",0,0,1);
  assert.equal((await budgetRow("gemini")).calls,1);
  assert.equal((await budgetRow("mistral")).calls,1);
});
test("spend is capped across providers, not per provider", async () => {
  await role("service_role");
  await db.exec("delete from public.content_budget");
  await reserve("openai",0.6,1,10);
  await assert.rejects(reserve("mistral",0.6,1,10),/exhausted/);
  await reserve("mistral",0.3,1,10);
});
test("budget rejects malformed input", async () => {
  await role("service_role");
  for (const args of [["",0,1,1],["Bad Name",0,1,1],["gemini",-1,1,1],["gemini",0,-1,1],["gemini",0,1,0]])
    await assert.rejects(reserve(...args),/Invalid budget/);
});
test("held or stale candidates cannot publish", async () => {
  await role("service_role");
  await candidate("held","held");
  await assert.rejects(db.query("select public.publish_candidate('held','Evidence reviewed')"),/not passed/);
  await candidate("old-news","checked",{contentType:"news",articleDate:"2020-01-01"});
  await assert.rejects(db.query("select public.publish_candidate('old-news','Evidence reviewed')"),/fresh review/);
  await candidate("stale"); await db.exec("update public.content_candidate set created_at=now()-interval '8 days' where id='stale'");
  await assert.rejects(db.query("select public.publish_candidate('stale','Evidence reviewed')"),/fresh review/);
});
test("checked publication requires a note and remains out of the queue until prepared", async () => {
  await role("service_role"); await candidate("approved");
  await assert.rejects(db.query("select public.publish_candidate('approved','')"),/note required/);
  await db.query("select public.publish_candidate('approved','Checked every cited claim')");
  assert.equal((await db.query("select count(*)::int n from public.feed_queue")).rows[0].n,11);
  assert.equal((await db.query("select verification_status from public.post where id='approved'")).rows[0].verification_status,"source_checked");
});
test("append is idempotent and does not reshuffle existing posts", async () => {
  await role("service_role");
  const append = () => db.query("select public.append_feed($1,array['approved','held','draft']) n",[reader]);
  assert.equal((await append()).rows[0].n,1); assert.equal((await append()).rows[0].n,0);
  await role("authenticated");
  const page=(await db.query("select public.reading_page(null,null,50) p")).rows[0].p;
  assert.equal(page[0].id,"sample-0"); assert.equal(page.at(-1).id,"approved");
  assert.equal(page.at(-1).contentType,"evergreen");
});
