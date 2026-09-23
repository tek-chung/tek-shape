# Handoff — live Supabase verification pending

Session date: 2026-09-23. Agent: Codex.

## 1. Current task and checkpoint

The owner asked to close the gap between passing offline checks and the client actually
running against Supabase. Stop for user-entered credentials and magic links; do not obtain
these on their behalf. Live seeding has now succeeded; see the latest checkpoint below.

The previous Phase 3 work is committed at `715522c`; its old handoff warning about an
uncommitted mixed tree was stale. This handoff's changes are committed separately.

## 2. Direction set by the repo owner

Asked directly, and worth not relitigating:

| Question | Decision |
|---|---|
| localStorage or Supabase? | **Supabase.** Daily use, phone-first, cross-device sync is the point. |
| Where does content live? | **Supabase**, not `src/data/posts.ts`. |
| State architecture | **Local-first with a persisted outbox**, Supabase authoritative. |
| Pagination | **Cursor (keyset) paging with infinite scroll.** Owner chose infinite scroll knowing it sits awkwardly with the project's anti-endless-scroll premise. |
| Content authoring | **Seed script now**, authenticated capture route later. |
| Browser tests | **Rewrite against a real test account**, not stubs. |
| SQL tests | **pglite**, in-process, no network. |
| Migration file | **Edited in place** — nothing was deployed. |

## 3. Changes in this checkpoint

- Confirmed the session-storage convention by reading installed source:
  `@supabase/supabase-js/src/SupabaseClient.ts:333` constructs
  `sb-${baseUrl.hostname.split('.')[0]}-auth-token`.
  `@supabase/auth-js/src/GoTrueClient.ts:5224` saves the full session when no separate
  userStorage is configured. `src/lib/helpers.ts:129` JSON-stringifies it.
  The original assumption was correct. Global setup now captures the SDK's real storage
  adapter output instead of duplicating its key and serialisation rules.
- Added three labelled sample seed posts (mathematics, logic, operations): 11 total.
  The original eight keep their IDs, order and deterministic seed timestamps.
- Playwright loads `.env.local`, defaults to a separate local port 3100, and starts
  `scripts/test-server.mjs`. That script builds the app with the disposable project's
  public configuration before starting it. Previously tests authenticated against the
  disposable project while the app could remain built for the personal project.
  Existing servers are not reused. External PLAYWRIGHT_BASE_URL remains a manual override:
  its app MUST already be built with the disposable project's public configuration.
- Test project comparison now uses URL origins and fails closed without a configured
  personal URL. The singleton/RLS rules and database migration are unchanged.
- Created an ignored `.env.local` with empty personal and test configuration fields.
  User must fill it locally. No secrets were read or printed. README was not changed.

## 4. Verification actually run

Passed in this checkpoint: `npm run lint`, `npx tsc --noEmit`, `npm run test:sql` (26/26),
`npm run build`, and `git diff --check`.

Not run: live migration, `npm run seed`, magic-link sign-in, client synchronisation,
live cursor paging, browser suite, or Cloudflare export/deployment. The ordinary build
passed without Supabase credentials; that is NOT evidence that sign-in works.

## 5. Next steps requiring the user

An asynchronous question asks whether personal and disposable projects exist, their
safe dashboard URLs and whether either already has the migration. No answer yet.

1. Guide user through applying `supabase/migrations/202609220001_private_reading.sql`
   in the personal project's SQL Editor (only once, on the intended fresh project).
2. User creates/confirms their Auth user and enrols its UUID in `allowed_reader`.
   Allow local redirect `http://127.0.0.1:3000` for magic links. No signup path.
3. User fills personal `.env.local` fields. Run `npm run seed` and verify 11 posts.
4. Start local app. User requests/opens the magic link in the same browser/profile.
   Verify sign-in -> feed, a local tap -> account-saved status, and paging beyond 8.
5. For automated tests, user supplies a DIFFERENT disposable project and applies the
   same migration there. Global setup will enrol its test user and seed filler content.
   Do not point it at the personal project. Run browser suite and fix observed failures.
6. Re-run every AGENTS.md check after fixes, update this handoff and commit.

## 6. Traps still relevant

- Auth client stays a module-level singleton; do not recreate it per render.
- Supabase public env vars are inlined at build time. Browser tests now rebuild `.next`
  for the disposable project; rebuild with personal config before using personal production preview.
- Browser tests currently reset database state once in global setup, not per test.
  Investigate state leakage between tests when the real suite can run.
- Existing browser tests bypass the email flow via a stored password-authenticated session.
  They do not establish that magic-link sign-in works; that needs the separate manual path.
- `@next/env` needs a default ESM import. Use its `loadEnvConfig` method.
- Reading data is local-first with a persisted outbox. Never disable controls to await sync.
- Service worker caches app shell/static assets; Supabase requests are not cached.

## 7. Latest checkpoint — personal project seeded

The user reports that the personal Supabase project exists and the migration is applied.
Verified the three personal configuration fields are populated without printing values.
Ran `npm run seed` against that configured project: succeeded, 11 sample posts readable.
A service-role count query confirmed exactly one enrolled reader without displaying identity.
Started `npm run dev -- --hostname 127.0.0.1`: ready at http://127.0.0.1:3000.

Now paused for the user to request and open their magic link in the same browser/profile.
Do not retrieve credentials or magic links on their behalf. No browser sign-in, sync status
transition or live paging has yet been verified. The disposable test project remains unconfirmed.
No code changed at this checkpoint; the last full offline check results remain those above.
