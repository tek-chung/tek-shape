import { createClient } from "@supabase/supabase-js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { posts } from "../src/data/posts";

/**
 * Signs a disposable test reader in once and writes the session to a Playwright
 * storage state, so the browser suite starts past the magic-link wall.
 *
 * This must point at a DISPOSABLE Supabase project, never the personal one:
 * `allowed_reader` is a singleton, so enrolling the test user evicts the real
 * reader, and the suite writes reading state and content.
 *
 *   PLAYWRIGHT_SUPABASE_URL
 *   PLAYWRIGHT_SUPABASE_PUBLISHABLE_KEY
 *   PLAYWRIGHT_SUPABASE_SERVICE_ROLE_KEY
 */
export const STORAGE_STATE = "tests/.auth/state.json";

const TEST_EMAIL = "playwright@tek-shape.test";
const TEST_PASSWORD = "playwright-local-only-password";
const BASE = Date.parse("2026-01-01T00:00:00Z");

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. The browser suite needs a disposable Supabase project — see "Browser tests" in the README.`,
    );
  }
  return value;
}

export default async function globalSetup() {
  const url = required("PLAYWRIGHT_SUPABASE_URL");
  const publishableKey = required("PLAYWRIGHT_SUPABASE_PUBLISHABLE_KEY");
  const serviceKey = required("PLAYWRIGHT_SUPABASE_SERVICE_ROLE_KEY");
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || new URL(url).origin === new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).origin) {
    throw new Error("PLAYWRIGHT_SUPABASE_URL matches your personal project. Use a disposable one.");
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  // Reuse the test user across runs; create it confirmed on the first run.
  // listUsers is typed as a union of two shapes, so narrow before searching.
  const { data: existing } = await admin.auth.admin.listUsers({ perPage: 200 });
  const known: { id: string; email?: string }[] = existing?.users ?? [];
  let userId = known.find((user) => user.email === TEST_EMAIL)?.id;
  if (!userId) {
    const { data, error } = await admin.auth.admin.createUser({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      email_confirm: true,
    });
    if (error || !data.user) throw new Error(`Could not create the test user: ${error?.message}`);
    userId = data.user.id;
  }

  // Singleton: overwrite whoever is enrolled in this disposable project.
  const { error: enrolError } = await admin
    .from("allowed_reader")
    .upsert({ singleton: true, user_id: userId }, { onConflict: "singleton" });
  if (enrolError) throw new Error(`Could not enrol the test reader: ${enrolError.message}`);

  const sample = posts.map((post, index) => ({
    id: post.id,
    topic: post.topic,
    title: post.title,
    explanation: post.explanation,
    insight: post.insight,
    deeper: post.deeper,
    source_label: post.source?.label ?? null,
    source_url: post.source?.url ?? null,
    status: "sample",
    published_at: new Date(BASE - index * 60_000).toISOString(),
  }));

  // Additional filler exercises multiple complete pages and a final partial page.
  const filler = Array.from({ length: 14 }, (_, index) => ({
    id: `paging-filler-${String(index).padStart(2, "0")}`,
    topic: "Test",
    title: `Filler ${index}`,
    explanation: ["Seeded by the browser suite to give the cursor something to walk."],
    insight: "Filler insight.",
    deeper: "Filler deeper explanation.",
    source_label: null,
    source_url: null,
    status: "sample",
    published_at: new Date(BASE - (posts.length + index) * 60_000).toISOString(),
  }));

  const { error: seedError } = await admin.from("post").upsert([...sample, ...filler], { onConflict: "id" });
  if (seedError) throw new Error(`Could not seed content: ${seedError.message}`);

  const { error: clearQueueError } = await admin.from("feed_queue").delete().eq("user_id", userId);
  if (clearQueueError) throw new Error(`Apply both migrations to the disposable project: ${clearQueueError.message}`);
  const { error: queueError } = await admin.from("feed_queue").insert([...sample,...filler].map((post,index) => ({
    user_id:userId,post_id:post.id,position:index+1,
  })));
  if (queueError) throw new Error(`Could not prepare test queue: ${queueError.message}`);

  // Start each run from a clean slate so position and ratings are deterministic.
  await admin.from("user_post_state").delete().eq("user_id", userId);
  await admin.from("reading_progress").delete().eq("user_id", userId);

  // Let the installed SDK produce its own storage format. SupabaseClient.ts uses
  // sb-<first hostname segment>-auth-token; GoTrueClient._saveSession serialises
  // the whole session through setItemAsync when userStorage is not configured.
  const sessionStorage = new Map<string, string>();
  const anon = createClient(url, publishableKey, { auth: {
    persistSession: true,
    autoRefreshToken: false,
    detectSessionInUrl: false,
    flowType: "pkce",
    storage: {
      getItem: (key) => sessionStorage.get(key) ?? null,
      setItem: (key, value) => { sessionStorage.set(key, value); },
      removeItem: (key) => { sessionStorage.delete(key); },
    },
  } });
  const { data: signedIn, error: signInError } = await anon.auth.signInWithPassword({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  });
  if (signInError || !signedIn.session) throw new Error(`Could not sign the test user in: ${signInError?.message}`);

  const storage = {
    cookies: [],
    origins: [
      {
        origin: new URL(process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3100").origin,
        localStorage: Array.from(sessionStorage, ([name, value]) => ({ name, value })),
      },
    ],
  };
  await mkdir(dirname(STORAGE_STATE), { recursive: true });
  await writeFile(STORAGE_STATE, JSON.stringify(storage, null, 2));
}
