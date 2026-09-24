/**
 * Make a one-time sign-in link for the enrolled reader WITHOUT sending an email, so Supabase's hourly email
 * limit does not apply. Run on your own machine only: the link signs whoever opens it into your account,
 * so never paste it anywhere public. It works once and expires after an hour (your project's OTP expiry).
 *
 *   npm run signin-link                       # for the deployed app
 *   npm run signin-link -- http://localhost:3000
 */
import nextEnv from "@next/env";
import { createClient } from "@supabase/supabase-js";

nextEnv.loadEnvConfig(process.cwd());
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const app = (process.argv[2] || process.env.APP_URL || "https://tek-shape.tekkanchung.workers.dev").replace(/\/+$/, "");
if (process.env.CI) throw new Error("Refusing to print a sign-in link in CI, where logs are public.");
if (!url || !key) throw new Error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.");
if (!/^https:\/\/|^http:\/\/localhost(:\d+)?$/.test(app)) throw new Error("The app address must be https:// (or http://localhost).");

const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const { data: reader, error: readerError } = await admin.from("allowed_reader").select("user_id").single();
if (readerError || !reader) throw new Error("No enrolled reader found in allowed_reader.");
const { data: user, error: userError } = await admin.auth.admin.getUserById(reader.user_id);
if (userError || !user?.user?.email) throw new Error("Could not look up the enrolled reader's email.");

const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email: user.user.email });
if (error || !data?.properties?.hashed_token) throw new Error(`Could not make a link: ${error?.message ?? "no token returned"}`);

console.log(`\nOne-time sign-in link for ${user.user.email} (open it on your phone within the hour):\n`);
console.log(`${app}/?token_hash=${data.properties.hashed_token}&type=magiclink\n`);
