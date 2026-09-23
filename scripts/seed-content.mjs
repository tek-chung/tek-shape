/**
 * Upserts the repository's sample collection into public.post.
 *
 *   npm run seed
 *
 * Requires SUPABASE_SERVICE_ROLE_KEY, which bypasses row level security and must
 * never be exposed to the browser or committed. Keep it in .env.local only.
 * Re-running is idempotent: ids and timestamps are deterministic.
 */
import { createClient } from "@supabase/supabase-js";
// @next/env is CommonJS, so the named export is not visible to ESM.
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

// Fixed so re-seeding never reshuffles the feed. Index 0 is newest, which keeps
// the array order in src/data/posts.ts as the reading order.
const BASE = Date.parse("2026-01-01T00:00:00Z");
const SPACING_MS = 60_000;

function fail(message) {
  console.error(`\nSeed stopped: ${message}\n`);
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url) fail("NEXT_PUBLIC_SUPABASE_URL is not set.");
if (!serviceKey) fail("SUPABASE_SERVICE_ROLE_KEY is not set. Copy it from the Supabase dashboard into .env.local.");
if (serviceKey === process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) {
  fail("SUPABASE_SERVICE_ROLE_KEY is the publishable key. Seeding needs the service role key.");
}

// Node strips the type annotations; the `import type` line is erased before resolution.
const { posts } = await import("../src/data/posts.ts");
if (!Array.isArray(posts) || !posts.length) fail("src/data/posts.ts exported no posts.");

const rows = posts.map((post, index) => ({
  id: post.id,
  topic: post.topic,
  title: post.title,
  explanation: post.explanation,
  insight: post.insight,
  deeper: post.deeper,
  source_label: post.source?.label ?? null,
  source_url: post.source?.url ?? null,
  status: "sample",
  published_at: new Date(BASE - index * SPACING_MS).toISOString(),
}));

const client = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const { error } = await client.from("post").upsert(rows, { onConflict: "id" });
if (error) fail(`${error.message}${error.details ? ` — ${error.details}` : ""}`);

const { count, error: countError } = await client
  .from("post")
  .select("id", { count: "exact", head: true })
  .in("status", ["sample", "published"]);
if (countError) fail(countError.message);

console.log(`\nSeeded ${rows.length} sample posts. ${count} posts are now readable.\n`);
