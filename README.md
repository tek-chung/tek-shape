# T

**Know broadly. Explore deeply.**

See [the master project specification](SPEC.md) for the product requirements, editorial standards, target architecture, phased roadmap and working agreement. It describes the intended product; the implementation status is documented below.

A mobile-first personal knowledge feed intended to replace habitual social scrolling with curiosity-driven learning. Built directly in the `tek-shape` repository with Next.js App Router, TypeScript, Tailwind CSS, ESLint and lucide-react.

The source code is a public coding portfolio. Personal reading activity and the deployed personal app remain private. Phase 3 adds a private sign-in and a Supabase account behind it, so reading state syncs across devices instead of living in one browser. Content is still the synthetic sample collection; moving it into the database is the next milestone.

## Requirements and setup

Node.js 22.18 or newer. Next.js 16 needs 20.9, but `npm run seed` imports the TypeScript seed file directly and relies on native type stripping. This repository was created using **Node.js v24.19.0 and npm 11.17.0**; use Node.js 24 for the closest match.

Two environment variables are required. Without them the app builds and runs, but shows "Private sign-in is not configured yet" instead of the feed. Create `.env.local` (git-ignored):

```text
NEXT_PUBLIC_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=YOUR-PUBLISHABLE-KEY
```

Both are public by design; database grants and row level security enforce access. They are inlined at build time, so a deployment built without them is permanently unconfigured.

In PowerShell:

```powershell
Set-Location C:\Users\tekka\tek-shape
npm ci
npm run dev -- --hostname 127.0.0.1
```

Open http://localhost:3000. Stop the server with Ctrl+C.

### Database setup

Apply `supabase/migrations/202609220001_private_reading.sql` to the project, then enrol exactly one reader. The app has no self-registration: sign-in uses a magic link with `shouldCreateUser: false`, and the `allowed_reader` table is a singleton, so only the enrolled account can read or write anything.

```sql
insert into public.allowed_reader (user_id) values ('<your-auth-user-uuid>');
```

Until that row exists, every signed-in user is refused with `Private account required` and the app shows a generic load failure. Create the auth user first in the Supabase dashboard.

Then load the content. Posts live in `public.post`; `src/data/posts.ts` is the versioned seed source, not what the app renders. Add `SUPABASE_SERVICE_ROLE_KEY` to `.env.local` — it bypasses row level security, so it must never reach the browser or the repository — and run:

```powershell
npm run seed
```

Re-running is idempotent. Array order in `posts.ts` becomes feed order, newest first.

For a production preview:

```powershell
npm run build
npm run start -- --hostname 127.0.0.1
```

## Preview on your Android phone

Connect the phone and computer to the same trusted Wi-Fi network. Stop any existing server on port 3000, then run:

```powershell
npm run dev -- --hostname 0.0.0.0
ipconfig
```

Find the computer's Wi-Fi IPv4 address in `ipconfig` and open `http://YOUR-PC-IP:3000` in Android Chrome. If Windows asks, permit Node.js only on your private network. This makes the development server accessible on that network; there is no authentication. Do not expose or forward the port to the internet. The phone's data is separate from the computer's browser data.

## What works

- Content served from `public.post`, eight clearly labelled SAMPLE evergreen posts across psychology, economics, art, astronomy, biology, computer science, music and physics. These are illustrative summaries, not verified editorial content; real topic-matching links are provided for further reading. No current-news claims. A `status` column separates `draft`, `sample` and reviewed `published` content; only the latter two are served.
- Keyset (cursor) pagination, eight posts at a time, newest first. Inserting a post never shifts a page under the reader. Infinite scroll loads the next page as you approach the end, with a **Keep scrolling** button as a fallback.
- A returning reader comes back to the same depth: `loaded_count` is stored, and the client re-pages to it before restoring the scroll anchor.
- Five icon-only controls directly below each post: thumbs up (more at the same level), thumbs down (not interesting), double check (same topic, greater difficulty), bookmark (independent save), book (expand/collapse deeper explanation).
- One rating per post, with a second tap clearing it. Visible selected states, accessible labels, keyboard focus and at least 44 × 44 CSS-pixel touch targets.
- A Library view with saved posts and an empty state. Removing a bookmark never clears a rating.
- Private sign-in by emailed magic link (PKCE). One enrolled reader only; new accounts cannot be created from the app.
- Local-first reading state. Every tap updates the interface immediately and is written to a per-account localStorage cache, then flushed to Supabase in the background. A refresh replays anything still queued on top of the server snapshot, so pulling never discards unsynced work. Fetched pages are cached too, so a reload — or a reading session with no signal — works from the cache.
- Offline tolerance. Losing signal mid-read costs nothing: writes queue in a persisted outbox, survive a reload, and retry on reconnect with backoff. The status line distinguishes "Saved on this device" from "Saved to your account".
- Ratings, bookmarks and expanded state keyed by stable post ID, plus the revealed batch and a reading anchor (post ID and pixel offset). Position saves after a short scroll debounce and on page hide, and resumes after reload. Library scrolling does not replace the feed anchor.
- Invalid cached or server fields are ignored. Unreadable or unavailable browser storage degrades to memory for the session rather than failing.

The feedback records preferences only; it does not personalise the order or generate new posts. Reading state syncs across devices signed in to the same account. Multiple tabs are last-write-wins per field; live cross-tab merging is outside this milestone. No reading data is written to repository files.

## Checks

```powershell
npm run lint
npm run build
npm run test:sql
npx playwright install chromium
npm run test:e2e
```

`npm run test:sql` runs the migration inside an in-memory Postgres (pglite) with a stubbed Supabase `auth` schema, then exercises it as the `authenticated` role so row level security is genuinely enforced rather than bypassed by a superuser. It covers the `allowed_reader` gate, cross-account isolation of both state and content, cursor paging, `save_post` patch validation, timestamp stickiness, `save_progress` position preservation, and cascade behaviour when a post is deleted. No network or Supabase project is needed.

### Browser tests

`npm run test:e2e` needs **a disposable Supabase project — never your personal one.** `allowed_reader` is a singleton, so enrolling the test reader evicts the real one, and the suite writes content and reading state. The global setup refuses to run if `PLAYWRIGHT_SUPABASE_URL` matches `NEXT_PUBLIC_SUPABASE_URL`.

Apply the migration to the disposable project, then:

```powershell
$env:PLAYWRIGHT_SUPABASE_URL = 'https://YOUR-TEST-PROJECT.supabase.co'
$env:PLAYWRIGHT_SUPABASE_PUBLISHABLE_KEY = '...'
$env:PLAYWRIGHT_SUPABASE_SERVICE_ROLE_KEY = '...'
npm run test:e2e
```

The setup creates a confirmed test user, enrols it, seeds content, clears its reading state, signs in, and writes the session to the git-ignored `tests/.auth/state.json`, so the suite starts past the magic-link wall. Build before running. Playwright starts a local production server on port 3000 (or reuses one already there). Stop unrelated servers on that port to ensure it tests this app. Tests cover interactions, per-post isolation, reload persistence, reading restoration, Library behaviour, corrupt/blocked storage, and overflow/touch targets at 320, 360 and 390 pixels. Screenshots and results stay in ignored `test-results/`.

These are Chromium mobile-viewport tests, not tests on a physical Android phone or a screen-reader audit. External source destinations are not tested by the browser suite.

On this managed Windows sandbox, Playwright's automatic server shutdown stalled after the assertions passed. The workaround is to keep `npm run start -- --hostname 127.0.0.1` running in one terminal and run `npm run test:e2e` in another; the test configuration reuses that server.

**Phase 3 validation status: partial.** ESLint, `next build`, `tsc --noEmit` and all 26 pglite tests pass against the current tree, including the `post` table, cursor paging and content-deletion cascades. `npm audit` reports zero known vulnerabilities.

Still unrun, because each needs a live Supabase project: `npm run seed`, `npm run build:cloudflare` (the environment guard and CSP pinning), and the browser suite. Nothing in the app has yet been exercised against a real database — the pglite suite covers the SQL, not the client's use of it. Physical Android, other browser engines, screen-reader behaviour and a full editorial fact-check also remain untested.

## Structure

```text
src/app/                        App Router page, manifest, metadata and global/Tailwind styles
src/components/PrivateApp.tsx   Session handling and the magic-link sign-in panel
src/components/Feed.tsx         Feed, Library, infinite scroll, scroll restoration, read tracking
src/components/PostCard.tsx
src/components/FeedbackBar.tsx
src/components/InstallApp.tsx   PWA install prompt and service worker registration
src/hooks/useReading.ts         Local-first state and paging: optimistic writes, outbox, sync
src/lib/storage.ts              Per-account state/content cache, outbox, untrusted-input validation
src/lib/supabase.ts             Browser client (publishable key only)
src/data/posts.ts               Seed content, versioned in the repo; not rendered directly
src/types/post.ts               Post, feedback, cursor and reading-state types
supabase/migrations/            Schema, row level security and the reading RPCs
scripts/seed-content.mjs        Upserts posts.ts into public.post (service role)
scripts/build-cloudflare.mjs    Env guard, static export, CSP pinned to the Supabase origin
public/sw.js                    Offline page only; never caches auth or reading requests
tests/sql/                      pglite tests for the migration and its policies
tests/global-setup.ts           Signs a disposable test reader in for the browser suite
tests/feed.spec.ts              Browser checks, including offline writes and position restore
```

No AI generation, in-app analytics or paid services. Authentication and storage are Supabase; the browser only ever holds the publishable key. No external fonts or images are fetched. Source links navigate externally only when opened. `.gitignore` excludes `.env*`, dependencies, build outputs and test artefacts. Do not add secrets or personal reading exports to the repository.

### Security model

- One reader. `allowed_reader` is a single-row table; every policy on the reading tables requires `is_allowed_reader()`, which is explicit about `auth.uid()` rather than relying on another table's policy to scope an unqualified `exists`.
- All three RPCs are `security invoker` with `search_path = ''`, so nothing runs with owner privileges and no unqualified name can be hijacked.
- Writes are validated twice: in the RPCs, and by column and table check constraints that also bind the direct PostgREST grants.
- The service worker caches only `/offline.html` and intercepts only same-origin navigations. Auth and reading requests are never cached.
- Content is readable only by the enrolled reader, and writable by nobody over PostgREST — seeding uses the service role out of band.
- `public/_headers` sets `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, `Strict-Transport-Security` and a Content-Security-Policy. `npm run build:cloudflare` narrows the policy's `connect-src` from `https://*.supabase.co` to the exact project origin, and refuses to build at all when the Supabase environment variables are missing. A static export rules out script nonces, so `script-src` still needs `'unsafe-inline'`.

## Manual phone checks

1. Use a fresh browser profile to check that four posts appear and **Keep scrolling** reveals the other four.
2. Try all three ratings on one post: only one should remain selected; tap it again to clear. Other posts should be unaffected.
3. Bookmark a rated post, open Library, then remove the bookmark. The rating should remain.
4. Open and close a deeper explanation using the book icon. Only that post should expand in place.
5. Scroll into the second batch, refresh, and check that position, ratings and bookmarks return. Repeat after switching between Library and feed.
6. At 320–390px width, check comfortable text, no sideways scrolling and all five touch controls. With an external keyboard, check visible focus and Enter/Space activation; with Android TalkBack, check labels and selected/expanded announcements.

## Cloudflare sample deployment

Live sample: [tek-shape.tekkanchung.workers.dev](https://tek-shape.tekkanchung.workers.dev). Public source: [tek-chung/tek-shape](https://github.com/tek-chung/tek-shape).

The app is a Next.js static export hosted by Cloudflare Workers Static Assets. Authentication and storage run entirely in the browser against Supabase, so no server runtime is needed; a server-capable deployment becomes necessary only for content generation or secrets that cannot be public.

```powershell
npm run build:cloudflare
npm run preview:cloudflare
```

Open http://127.0.0.1:8787. To run the browser suite against that preview in a second terminal:

```powershell
$env:PLAYWRIGHT_BASE_URL = 'http://127.0.0.1:8787'
npm run test:e2e
Remove-Item Env:PLAYWRIGHT_BASE_URL
```

After signing in with `npx wrangler login`, `npm run deploy` builds and publishes the sample app as the `tek-shape` Worker. Only the generated `out/` directory is uploaded; browser reading state is never part of the build. No database or paid service is configured. Cloudflare credentials and local state must remain outside version control.

The hosted app is reachable by anyone, but requires a magic-link sign-in and only the single enrolled account can get past it. Reading state lives in that account, not in the visitor's browser. Build with the Supabase environment variables set, or the deployment will be permanently unconfigured. Physical Android testing remains a manual check using the checklist above.

Phase 2 validation (pre-authentication, still accurate for that milestone): ESLint and the Cloudflare static production build passed, and seven Chromium browser tests passed against both the local Wrangler preview and the live HTTPS deployment at 320, 360 and 390px. Those checks do not cover the Phase 3 changes, which are unvalidated — see **Checks** above.

References: [Cloudflare static hosting](https://developers.cloudflare.com/workers/static-assets/get-started/) and the installed Next.js static-export guide in `node_modules/next/dist/docs/01-app/02-guides/static-exports.md`.

## Next planned milestones

These are future work, not features implemented or authorisation to connect services:

1. Run the content-migration checks: seed a project, then lint, build, `test:sql` and the browser suite against a disposable project.
2. Add an authenticated capture route so a post can be added from the phone, rather than only by editing `posts.ts` and re-seeding.
3. Use the recorded ratings to influence order and difficulty, with transparent reset controls. The five controls currently record preferences only.
4. Test the reading loop on a physical Android phone; refine density, navigation and accessibility from actual use.
5. Add a reviewed evergreen-content workflow with provenance, promoting posts from `sample` to `published`.
6. Consider converting the RPCs to `security definer` and revoking direct table `INSERT`/`UPDATE` from `authenticated`, so every write goes through a validating function and `updated_at` cannot be left stale.

Committing, pushing, connecting accounts and deploying each require explicit approval. Personal-data directories, exports, local JSON data, browser profiles and database files are ignored as an additional safeguard; `.gitignore` is not an access-control mechanism and cannot protect files already tracked by Git.
