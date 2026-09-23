import { spawnSync, spawn } from "node:child_process";
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());
const url = process.env.PLAYWRIGHT_SUPABASE_URL;
const key = process.env.PLAYWRIGHT_SUPABASE_PUBLISHABLE_KEY;
if (!url || !key || !process.env.PLAYWRIGHT_SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Configure the disposable project's PLAYWRIGHT_SUPABASE_* variables first.");
}
if (new URL(url).origin === new URL(process.env.NEXT_PUBLIC_SUPABASE_URL || url).origin) {
  throw new Error("The disposable test project must differ from the configured personal project.");
}
// Public variables are inlined during the build, not when the server starts.
const env = { ...process.env, NEXT_PUBLIC_SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: key, CLOUDFLARE_EXPORT: "0" };
delete env.SUPABASE_SERVICE_ROLE_KEY;
delete env.PLAYWRIGHT_SUPABASE_SERVICE_ROLE_KEY;
const next = "node_modules/next/dist/bin/next";
const build = spawnSync(process.execPath, [next, "build"], { env, stdio: "inherit" });
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
const server = spawn(process.execPath, [next, "start", "--hostname", "127.0.0.1", "--port", "3100"], { env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.kill(signal));
server.on("exit", (code) => process.exit(code ?? 0));
