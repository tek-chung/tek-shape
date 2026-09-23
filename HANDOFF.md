# Handoff — Phase 3 review and content migration

Session date: 2026-09-22/23. Agent: Claude (Cowork). Audience: the next agent working in this repo.

Everything below is **uncommitted**. `HEAD` is `4cfdd60 Document live sample URL and deployment
verification`, which is Phase 2 — the browser-only, no-auth sample app. The working tree contains
two layers of later work mixed together: the Supabase authentication layer, which already existed
when this session started, and this session's changes on top of it. See "Commit boundaries" at the
end before doing anything else.

---

## 1. Starting state

The tree held a half-finished migration from `localStorage` to Supabase. The schema and row level
security were sound. The client was not:

- `src/components/Feed.tsx:120` referenced an undeclared `latest` → **the app did not compile**.
- `tests/feed.spec.ts` still targeted the pre-authentication app; all seven tests failed.
- `README.md` claimed "No Supabase, authentication … or reader accounts" and "no sign-in" — on a
  public portfolio repo.

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

## 3. What changed

### Database — `supabase/migrations/202609220001_private_reading.sql` (rewritten)

- **`public.post` table added.** Content now lives in the database. `status` is
  `draft` / `sample` / `published`; only the latter two are served. Readable by the enrolled reader
  only; writable by nobody over PostgREST — seeding uses the service role out of band.
- **`is_allowed_reader()` extracted.** The original gate was `exists (select 1 from allowed_reader)`,
  correct only because `allowed_reader`'s own RLS scoped it. Policies are OR'd, so a second policy
  added later would have silently opened the app to every authenticated user. The function names
  `auth.uid()` explicitly. **Do not reintroduce the unqualified form.**
- **Hardcoded post-ID lists removed** from three places, replaced by foreign keys to `post`.
- **`queue` array and `visible_count` (4/8) dropped**, replaced by `loaded_count` — how many posts
  had been paged in, so a reload restores the same depth.
- **`reading_page(after_published_at, after_id, limit)` added.** Keyset paging ordered by
  `(published_at desc, id desc)`, matching the partial index `post_feed_order`. Inserts never shift
  a page under the reader.
- **`save_progress` no longer erases position.** It previously wrote `position_post_id = p_post_id`
  unconditionally, so paging in more posts (which passes a null position) wiped where you were. Now
  `coalesce(p_post_id, position_post_id)`.
- **`rating` validated in-function**, so a bad value returns `Invalid state value` rather than a raw
  check violation.
- **`reading_state` raises** instead of returning JSON null if the row is somehow absent.

All three RPCs remain `security invoker` with `search_path = ''`.

### Client

- **`src/hooks/useReading.ts` (rewritten).** Local-first. Writes update React state immediately and
  are recorded in an outbox persisted to `localStorage`, flushed in the background with backoff and
  retry on `online` / `visibilitychange`. A refresh replays the outbox over the server snapshot, so
  pulling never discards unsynced work. Also owns content paging (`loadUpTo`, `loadMore`).
  - Fixed: `unsaved.current` was only cleared on success, so **one failed write killed sync for the
    session** — silently, while the UI kept accepting taps.
  - Fixed: `saveProgress` never called `setBusy`, so `busy` could stick `true` with nothing in
    flight, disabling every control permanently.
  - Fixed: no optimistic updates — every tap cost two serialised round trips with the button
    disabled.
- **`src/lib/storage.ts` (rewritten).** Per-account cache keys (`tek-shape:*:v3:<userId>`), so a
  shared browser never leaks one account's state to another. Validates the cache *and* the RPC
  payloads — the previous `data as ReadingState` cast was unchecked. Caches fetched pages.
- **`src/components/Feed.tsx` (rewritten).** Fixed the compile error; infinite scroll via a sentinel
  with a 600px `rootMargin`; indices and focus targets now come from the fetched list rather than the
  static array.
- **`src/types/post.ts`** — `SeedPost` (repo) vs `Post` (has `publishedAt`, from the database).
- **`src/data/posts.ts`** — now `SeedPost[]`, seed data only, not rendered.

### Service worker — `public/sw.js` (rewritten)

It cached only `offline.html`, so **a cold launch with no signal showed the offline page rather than
the cached feed** — defeating the entire local-first effort on exactly the device it was built for.
Now keeps the last good app shell (network-first) plus content-hashed `/_next/static/` assets
(cache-first). Cross-origin Supabase traffic still falls straight through, uncached. Added
`skipWaiting`; `respondWith` can no longer receive `undefined`.

### Tooling

- **`scripts/seed-content.mjs` (new)** — upserts `posts.ts` into `public.post` with the service role.
  Deterministic timestamps, idempotent.
- **`scripts/build-cloudflare.mjs`** — refuses to build without the Supabase env vars (previously a
  missing var shipped a site permanently showing "Private sign-in is not configured yet"), and
  narrows the CSP `connect-src` from `https://*.supabase.co` to the exact project origin.
- **`public/_headers`** — added CSP and HSTS.
- **`tests/sql/migration.test.mjs` (new)** — 26 tests running the real migration in pglite with a
  stubbed `auth` schema, executed as the `authenticated` role so RLS genuinely applies.
- **`tests/global-setup.ts` (new)** + **`tests/feed.spec.ts` (rewritten)** — signs a test reader in
  and writes a Playwright storage state.
- **`package.json`** — added `seed`, `test:sql`; `@next/env` dependency; **Node floor raised to
  22.18** (the seed script relies on native type stripping).

## 4. Verification status

Run and passing against the current tree:

| Check | Result |
|---|---|
| `npm run lint` | clean |
| `npm run build` | clean |
| `npx tsc --noEmit` | clean |
| `npm run test:sql` | 26/26 |
| `npm audit` | 0 vulnerabilities |

**Never run.** Each needs a live Supabase project:

- `npm run seed` — reaches the network call with rows validated against every column constraint
  (checked offline: max insight 71/400, max deeper 429/4000, all ids match the slug regex, all
  `source_is_whole` pairs valid). Not yet executed against a real database.
- `npm run build:cloudflare` — the env guard and CSP pinning both work; the export half is unrun.
- `npm run test:e2e` — **never executed.** Highest-risk item: `tests/global-setup.ts` assumes
  supabase-js persists the session at `sb-<project-ref>-auth-token`. If that is wrong, every test
  sticks at the sign-in wall.
- No client code has ever talked to a real Supabase instance. The pglite suite proves the SQL is
  correct; it says nothing about the client's use of it.

## 5. Traps worth knowing before you touch this

1. **`allowed_reader` is a singleton.** The browser suite therefore needs a *separate, disposable*
   Supabase project — enrolling a test user evicts the real reader. `tests/global-setup.ts` refuses
   to run if `PLAYWRIGHT_SUPABASE_URL` matches `NEXT_PUBLIC_SUPABASE_URL`.
2. **`@next/env` is CommonJS.** Its `.d.ts` advertises a named `loadEnvConfig`, but ESM only sees
   `default`. Import the default and destructure. This bit both scripts.
3. **`supabase` must stay a module-level singleton** (`src/lib/supabase.ts`). `useReading`'s mount
   effect depends on a `useCallback` chain rooted in `client`; a per-render client turns it into an
   infinite mount loop.
4. **Do not let a `useCallback` call itself.** `react-hooks/immutability` fails the build. The retry
   timer reaches `flush` through `flushLater.current`.
5. **`.continue` and `.end-note` share padding** in `globals.css`. Do not nest them.
6. **The collection is exactly one page** (8 posts, `PAGE_SIZE` 8), so pagination is not exercised
   locally. `tests/global-setup.ts` seeds 14 filler posts for this reason.
7. **Env vars are inlined at build time.** A deploy built without them can never be signed in to.

## 6. Suggested next steps

1. Apply the migration, `npm run seed`, and exercise the app against a real project.
2. Run the browser suite against a disposable project; expect to fix the auth storage key.
3. Authenticated capture route, so a post can be added from the phone.
4. Use the recorded ratings to influence order and difficulty — the five controls currently record
   preferences and nothing else.
5. Consider `security definer` RPCs plus revoking direct `INSERT`/`UPDATE` from `authenticated`, so
   every write goes through a validating function and `updated_at` cannot be left stale.

## 7. Commit boundaries — read this first

`git status` shows 31 changed or untracked paths spanning two agents' work with no commit between
them. Nothing here is separable by `git diff`, and nothing is revertible.

Recommended before further work:

```bash
git add -A && git commit -m "Phase 3: Supabase auth, local-first sync, database-backed content"
```

Or, better, split it: the authentication layer, then the local-first rewrite, then the content
migration. Then **commit at every agent handoff**, so the next session can read a diff instead of a
document like this one.
