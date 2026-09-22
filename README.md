# tek shape

A mobile-first, local personal knowledge-feed prototype. Built directly in this repository with Next.js App Router, TypeScript, Tailwind CSS, ESLint and lucide-react.

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
