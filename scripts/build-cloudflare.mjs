import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
// @next/env is CommonJS, so the named export is not visible to ESM.
import nextEnv from "@next/env";

// Next loads .env files itself, so read them the same way before checking.
nextEnv.loadEnvConfig(process.cwd());

const HEADERS = new URL("../out/_headers", import.meta.url);
const PLACEHOLDER = "https://*.supabase.co";

function fail(message) {
  console.error(`\nBuild stopped: ${message}\n`);
  process.exit(1);
}

/**
 * These are inlined at build time. A build without them produces a site that
 * permanently shows "Private sign-in is not configured yet", so stop here
 * rather than shipping a deployment that can never be signed in to.
 */
function supabaseOrigin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const missing = [
    !url && "NEXT_PUBLIC_SUPABASE_URL",
    !key && "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  ].filter(Boolean);
  if (missing.length) {
    fail(`${missing.join(" and ")} not set. Add them to .env.local or the deploy environment.`);
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return fail(`NEXT_PUBLIC_SUPABASE_URL is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "https:") fail(`NEXT_PUBLIC_SUPABASE_URL must be https, got ${parsed.protocol}`);
  return parsed.origin;
}

/** Narrow the checked-in wildcard connect-src to this project's exact origin. */
async function pinContentSecurityPolicy(origin) {
  let headers;
  try {
    headers = await readFile(HEADERS, "utf8");
  } catch {
    fail("out/_headers is missing. Did the export run?");
  }
  if (!headers.includes(PLACEHOLDER)) {
    fail(`out/_headers has no ${PLACEHOLDER} to pin. Check public/_headers still carries the CSP.`);
  }
  await writeFile(HEADERS, headers.replaceAll(PLACEHOLDER, origin));
  console.log(`\nContent-Security-Policy connect-src pinned to ${origin}`);
}

const origin = supabaseOrigin();

const result = spawnSync(process.execPath, ["node_modules/next/dist/bin/next", "build"], {
  stdio: "inherit",
  env: { ...process.env, CLOUDFLARE_EXPORT: "1" },
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

await pinContentSecurityPolicy(origin);
