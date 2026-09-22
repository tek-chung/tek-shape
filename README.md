# T

**Know broadly. Explore deeply.**

See [the master project specification](SPEC.md) for the product requirements, editorial standards, target architecture, phased roadmap and working agreement. It describes the intended product; the implementation status is documented below.

A mobile-first personal knowledge feed intended to replace habitual social scrolling with curiosity-driven learning. Built directly in the `tek-shape` repository with Next.js App Router, TypeScript, Tailwind CSS, ESLint and lucide-react.

The source code is intended for a public coding portfolio. Personal reading activity and any future deployed personal app must remain private. This milestone runs locally, with synthetic sample content and browser-only reading state; it does not create a private hosted service. The existing `tek-shape:reading:v1` storage key is retained so the T branding change preserves saved preferences.

## Requirements and setup

Node.js 20.9 or newer is required by Next.js 16. This repository was created using **Node.js v24.19.0 and npm 11.17.0**. Use Node.js 24 for the closest match. No environment variables or accounts are needed.

In PowerShell:

```powershell
Set-Location C:\Users\tekka\tek-shape
npm ci
npm run dev -- --hostname 127.0.0.1
```

Open http://localhost:3000. Stop the server with Ctrl+C.

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

- Eight clearly labelled SAMPLE evergreen posts across psychology, economics, art, astronomy, biology, computer science, music and physics. These are illustrative summaries, not verified editorial content; real topic-matching links are provided for further reading. No current-news claims.
- Four posts on a fresh visit, then four more via **Keep scrolling**. A returning reader retains the revealed batch.
- Five icon-only controls directly below each post: thumbs up (more at the same level), thumbs down (not interesting), double check (same topic, greater difficulty), bookmark (independent save), book (expand/collapse deeper explanation).
- One rating per post, with a second tap clearing it. Visible selected states, accessible labels, keyboard focus and at least 44 × 44 CSS-pixel touch targets.
- A Library view with saved posts and an empty state. Removing a bookmark never clears a rating.
- Browser localStorage under `tek-shape:reading:v1`: ratings, bookmarks and expanded state keyed by stable post ID, plus the revealed batch and a reading anchor (post ID and pixel offset). Position saves after a short scroll debounce and on page hide, and resumes after reload. Library scrolling does not replace the feed anchor.
- Invalid saved fields are ignored. Unreadable or unavailable storage shows a notice and allows in-memory use.

The feedback records preferences only; it does not personalise the order or generate new posts. Storage is per browser and origin, with no cross-device sync or encryption. A different hostname or port has separate data. Clearing this site's browser data removes the saved state. No reading data is written to repository files. Multiple tabs are last-write-wins; live cross-tab merging is outside this milestone.

## Checks

```powershell
npm run lint
npm run build
npx playwright install chromium
npm run test:e2e
```

Build before running the browser tests. Playwright starts a local production server on port 3000 (or reuses one already there). Stop unrelated servers on that port to ensure it tests this app. Tests cover interactions, per-post isolation, reload persistence, reading restoration, Library behaviour, corrupt/blocked storage, and overflow/touch targets at 320, 360 and 390 pixels. Screenshots and results stay in ignored `test-results/`.

These are Chromium mobile-viewport tests, not tests on a physical Android phone or a screen-reader audit. External source destinations are not tested by the browser suite.

On this managed Windows sandbox, Playwright's automatic server shutdown stalled after the assertions passed. The workaround is to keep `npm run start -- --hostname 127.0.0.1` running in one terminal and run `npm run test:e2e` in another; the test configuration reuses that server.

Milestone validation: ESLint and the production build (including TypeScript checks) passed. Seven Chromium browser tests passed, covering the behaviours above. The 320px and 390px viewport screenshots were also visually reviewed. Physical Android, other browser engines, screen-reader behaviour and a full editorial fact-check remain untested.

## Structure

```text
src/app/                 App Router page, metadata and global/Tailwind styles
src/components/Feed.tsx  Feed, Library and browser persistence lifecycle
src/components/PostCard.tsx
src/components/FeedbackBar.tsx
src/data/posts.ts        Typed, static sample content
src/types/post.ts        Post, feedback and reading-state types
src/lib/storage.ts       Storage key and saved-data validation
tests/feed.spec.ts       Browser interaction and phone-width checks
```

No Supabase, authentication, AI generation, analytics, paid services, accounts or deployment. No external fonts or images are fetched by the app. Source links navigate externally only when opened. `.gitignore` excludes `.env*`, dependencies, build outputs and test artefacts. Do not add secrets or personal reading exports to the repository.

## Manual phone checks

1. Use a fresh browser profile to check that four posts appear and **Keep scrolling** reveals the other four.
2. Try all three ratings on one post: only one should remain selected; tap it again to clear. Other posts should be unaffected.
3. Bookmark a rated post, open Library, then remove the bookmark. The rating should remain.
4. Open and close a deeper explanation using the book icon. Only that post should expand in place.
5. Scroll into the second batch, refresh, and check that position, ratings and bookmarks return. Repeat after switching between Library and feed.
6. At 320–390px width, check comfortable text, no sideways scrolling and all five touch controls. With an external keyboard, check visible focus and Enter/Space activation; with Android TalkBack, check labels and selected/expanded announcements.

## Cloudflare sample deployment

Phase 2 uses a Next.js static export hosted by Cloudflare Workers Static Assets. This suits the current browser-only sample feed and keeps the existing local Next.js workflow. A server-capable deployment will be needed when adding private authentication, shared storage and content generation.

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

The hosted sample app is publicly accessible and has no sign-in. Ratings and bookmarks stay in each visitor's browser and do not sync. It is not yet the private personal feed. Physical Android testing remains a manual check using the checklist above.

Phase 2 validation: ESLint, the Cloudflare static production build (including TypeScript) and all seven Chromium browser tests passed against the local Wrangler preview, including 320, 360 and 390px widths. The dependency installation reported zero known vulnerabilities. These checks do not constitute a physical-phone test or an exhaustive security audit.

References: [Cloudflare static hosting](https://developers.cloudflare.com/workers/static-assets/get-started/) and the installed Next.js static-export guide in `node_modules/next/dist/docs/01-app/02-guides/static-exports.md`.

## Next planned milestones

These are future work, not features implemented or authorisation to connect services:

1. Test the reading loop on a physical Android phone; refine density, navigation and accessibility from actual use.
2. Add a reviewed evergreen-content workflow with provenance and explicit editorial status, keeping sample content separate.
3. Define and test local preference-based topic and difficulty selection, including transparent reset controls.
4. Design private storage, retention and access controls before considering cross-device sync or a personal deployment. Keep runtime data and credentials out of the public code repository.

Committing, pushing, connecting accounts and deploying each require explicit approval. Personal-data directories, exports, local JSON data, browser profiles and database files are ignored as an additional safeguard; `.gitignore` is not an access-control mechanism and cannot protect files already tracked by Git.
