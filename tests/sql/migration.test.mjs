/**
 * Runs the real migration inside pglite with a stubbed Supabase auth schema and
 * exercises it as the `authenticated` role, so row level security is actually
 * enforced rather than bypassed by a superuser.
 *
 *   npm run test:sql
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const MIGRATION = new URL("../../supabase/migrations/202609220001_private_reading.sql", import.meta.url);

const READER = "11111111-1111-4111-8111-111111111111";
const INTRUDER = "22222222-2222-4222-8222-222222222222";
const SEEDED = 10;

// Minimal stand-in for the parts of Supabase the migration depends on.
const BOOTSTRAP = `
  create role anon;
  create role authenticated;
  grant usage on schema public to anon, authenticated;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('test.uid', true), '')::uuid;
  $$;
  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
`;

let db;

/** Run the next statements as the given signed-in user, with RLS applied. */
async function as(uid) {
  await db.exec(`reset role; select set_config('test.uid', '${uid}', false); set role authenticated;`);
}
/** Drop back to the superuser for seeding and assertions about raw rows. */
async function asAdmin() {
  await db.exec("reset role;");
}
async function rejects(run, match) {
  try {
    await run();
  } catch (caught) {
    assert.match(String(caught.message), match);
    return;
  }
  assert.fail(`expected a rejection matching ${match}`);
}
const state = async () => (await db.query("select public.reading_state() as s")).rows[0].s;
const page = async (after = null, limit = 8) =>
  (
    await db.query("select public.reading_page($1, $2, $3) as p", [
      after?.publishedAt ?? null,
      after?.id ?? null,
      limit,
    ])
  ).rows[0].p;
const cursorOf = (post) => ({ publishedAt: post.publishedAt, id: post.id });
const savePost = (id, patch) => db.query("select public.save_post($1, $2::jsonb)", [id, JSON.stringify(patch)]);
const saveProgress = (count, postId, offset) =>
  db.query("select public.save_progress($1, $2, $3)", [count, postId, offset]);

before(async () => {
  db = new PGlite();
  await db.exec(BOOTSTRAP);
  await db.exec(await readFile(MIGRATION, "utf8"));
  await db.exec(`insert into auth.users(id) values ('${READER}'), ('${INTRUDER}');`);
  // Ten published posts, newest first by index, plus one draft that must stay hidden.
  const rows = Array.from({ length: SEEDED }, (_, index) => {
    const at = new Date(Date.parse("2026-01-01T00:00:00Z") - index * 60_000).toISOString();
    return `('post-${String(index).padStart(2, "0")}','Topic','Title ${index}',array['Body'],'Insight','Deeper','sample','${at}')`;
  });
  await db.exec(`
    insert into public.post(id,topic,title,explanation,insight,deeper,status,published_at)
    values ${rows.join(",")},
    ('post-draft','Topic','Draft',array['Body'],'Insight','Deeper','draft','2026-01-01T00:00:00Z');
  `);
});

after(async () => {
  await db?.close();
});

describe("access gate", () => {
  test("a signed-in user who is not the allowed reader is refused", async () => {
    await as(READER);
    await rejects(() => state(), /Private account required/);
    await rejects(() => page(), /Private account required/);
  });

  test("the allowed reader gets a default state once enrolled", async () => {
    await asAdmin();
    await db.exec(`insert into public.allowed_reader(user_id) values ('${READER}');`);
    await as(READER);
    const result = await state();
    assert.equal(result.loadedCount, 0);
    assert.equal(result.position, null);
    assert.deepEqual(result.posts, {});
    assert.equal(result.total, SEEDED);
  });

  test("allowed_reader is a singleton, so no second reader can be enrolled", async () => {
    await asAdmin();
    await rejects(
      () => db.exec(`insert into public.allowed_reader(user_id) values ('${INTRUDER}');`),
      /duplicate key|allowed_reader_pkey/,
    );
  });

  test("another signed-in user is refused and sees neither content nor the reader's rows", async () => {
    await as(READER);
    await savePost("post-00", { bookmarked: true });
    await as(INTRUDER);
    await rejects(() => state(), /Private account required/);
    assert.equal((await db.query("select * from public.user_post_state")).rows.length, 0);
    assert.equal((await db.query("select * from public.post")).rows.length, 0);
    assert.equal((await db.query("select public.is_allowed_reader() as ok")).rows[0].ok, false);
  });

  test("the intruder cannot write rows for themselves or for the reader", async () => {
    await as(INTRUDER);
    await rejects(
      () => db.query("insert into public.user_post_state(user_id,post_id) values (auth.uid(),'post-00')"),
      /row-level security/,
    );
    await rejects(
      () => db.query(`insert into public.user_post_state(user_id,post_id) values ('${READER}','post-01')`),
      /row-level security/,
    );
  });

  test("nobody can write content over PostgREST", async () => {
    await as(READER);
    await rejects(
      () => db.query("insert into public.post(id,topic,title,explanation,insight,deeper) values ('x','t','t',array['b'],'i','d')"),
      /permission denied/,
    );
  });
});

describe("reading_page", () => {
  before(async () => {
    await as(READER);
  });

  test("returns a page newest first and hides drafts", async () => {
    const first = await page(null, 8);
    assert.equal(first.length, 8);
    assert.equal(first[0].id, "post-00");
    assert.equal(first[7].id, "post-07");
    assert.ok(!first.some((post) => post.id === "post-draft"));
  });

  test("the cursor continues without overlap and reaches the end", async () => {
    const first = await page(null, 8);
    const second = await page(cursorOf(first[7]), 8);
    assert.deepEqual(
      second.map((post) => post.id),
      ["post-08", "post-09"],
    );
    assert.equal((await page(cursorOf(second[1]), 8)).length, 0);
  });

  test("a post carries its content and an absent source stays null", async () => {
    const [first] = await page(null, 1);
    assert.equal(first.title, "Title 0");
    assert.deepEqual(first.explanation, ["Body"]);
    assert.equal(first.source, null);
    assert.ok(first.publishedAt);
  });

  test("a whole source is returned when present", async () => {
    await asAdmin();
    await db.exec(
      "update public.post set source_label = 'Somewhere', source_url = 'https://example.com/a' where id = 'post-00';",
    );
    await as(READER);
    const [first] = await page(null, 1);
    assert.deepEqual(first.source, { label: "Somewhere", url: "https://example.com/a" });
  });

  test("rejects a bad page size and a half-supplied cursor", async () => {
    await rejects(() => page(null, 0), /Invalid page size/);
    await rejects(() => page(null, 51), /Invalid page size/);
    await rejects(
      () => db.query("select public.reading_page('2026-01-01T00:00:00Z', null, 8)"),
      /Invalid cursor/,
    );
  });
});

describe("save_post", () => {
  before(async () => {
    await as(READER);
  });

  test("stores a rating and a bookmark independently", async () => {
    await savePost("post-01", { rating: "more" });
    await savePost("post-01", { bookmarked: true });
    const { posts } = await state();
    assert.equal(posts["post-01"].rating, "more");
    assert.equal(posts["post-01"].bookmarked, true);
  });

  test("an explicit null rating clears the rating and leaves the bookmark", async () => {
    await savePost("post-01", { rating: null });
    const { posts } = await state();
    assert.equal(posts["post-01"].rating, null);
    assert.equal(posts["post-01"].bookmarked, true);
  });

  test("rejects unknown keys", async () => {
    await rejects(() => savePost("post-01", { admin: true }), /Invalid post patch/);
  });

  test("rejects a bad rating with the function's own error, not a check violation", async () => {
    await rejects(() => savePost("post-01", { rating: "bogus" }), /Invalid state value/);
    await rejects(() => savePost("post-01", { rating: 7 }), /Invalid state value/);
  });

  test("rejects non-boolean flags and a falsy seen marker", async () => {
    await rejects(() => savePost("post-01", { bookmarked: "yes" }), /Invalid state value/);
    await rejects(() => savePost("post-01", { seen: false }), /Invalid state value/);
  });

  test("rejects a post id that is not in the content table", async () => {
    await rejects(() => savePost("not-a-post", { bookmarked: true }), /foreign key|violates/);
  });

  test("seen and read timestamps are set once and never moved", async () => {
    await savePost("post-02", { seen: true });
    const first = (await state()).posts["post-02"].firstSeenAt;
    assert.ok(first);
    await savePost("post-02", { seen: true });
    assert.equal((await state()).posts["post-02"].firstSeenAt, first);
  });

  test("expanding records deeperOpenedAt once; collapsing keeps it", async () => {
    await savePost("post-03", { expanded: true });
    const opened = (await state()).posts["post-03"].deeperOpenedAt;
    assert.ok(opened);
    await savePost("post-03", { expanded: false });
    const result = (await state()).posts["post-03"];
    assert.equal(result.expanded, false);
    assert.equal(result.deeperOpenedAt, opened);
  });
});

describe("save_progress", () => {
  before(async () => {
    await as(READER);
  });

  test("records a position", async () => {
    await saveProgress(8, "post-02", 120);
    const { position, loadedCount } = await state();
    assert.deepEqual(position, { postId: "post-02", offset: 120 });
    assert.equal(loadedCount, 8);
  });

  test("a null post id pages in more without erasing the saved position", async () => {
    await saveProgress(16, null, 0);
    const result = await state();
    assert.equal(result.loadedCount, 16);
    assert.deepEqual(result.position, { postId: "post-02", offset: 120 });
  });

  test("loaded_count never decreases", async () => {
    await saveProgress(4, "post-02", 10);
    assert.equal((await state()).loadedCount, 16);
  });

  test("rejects a negative or oversized count and a null offset", async () => {
    await rejects(() => saveProgress(-1, "post-02", 0), /Invalid reading position/);
    await rejects(() => saveProgress(9999, "post-02", 0), /Invalid reading position/);
    await rejects(() => saveProgress(8, "post-02", null), /Invalid reading position/);
  });

  test("rejects an offset outside the clamp range", async () => {
    await rejects(() => saveProgress(8, "post-02", 99999), /position_offset|violates check/);
  });

  test("rejects a position that is not a real post", async () => {
    await rejects(() => saveProgress(8, "not-a-post", 0), /foreign key|violates/);
  });
});

describe("content deletion", () => {
  test("removing a post clears it from state and from the saved position", async () => {
    await as(READER);
    await savePost("post-09", { bookmarked: true });
    await saveProgress(16, "post-09", 40);
    await asAdmin();
    await db.exec("delete from public.post where id = 'post-09';");
    await as(READER);
    const result = await state();
    assert.equal(result.posts["post-09"], undefined);
    assert.equal(result.position, null);
    assert.equal(result.total, SEEDED - 1);
  });
});
