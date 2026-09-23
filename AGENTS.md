<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# tek-shape — working agreement

Read by Codex (`AGENTS.md`) and by Claude (`CLAUDE.md` imports this file). Keep durable rules here.
Session-specific state goes in `HANDOFF.md`, which is rewritten each handoff.

## What this is

A private, phone-first reading feed for one person. Next.js 16 static export on Cloudflare Workers,
Supabase for auth and storage, PWA. The source repository is **public**; the reading data is not.

## Non-negotiables

- **One reader.** `allowed_reader` is a single-row table. No self-registration: magic link with
  `shouldCreateUser: false`. Do not add a signup path.
- **Never commit secrets or reading data.** `SUPABASE_SERVICE_ROLE_KEY` is build/seed-time only and
  must never reach the browser. `.env*` is git-ignored; `.gitignore` is not access control.
- **Row level security is the boundary.** Every policy names `auth.uid()` explicitly via
  `is_allowed_reader()`. Never gate on an unqualified `exists (select 1 from allowed_reader)` — a
  second policy added later would silently open the app to every authenticated user.
- **Local-first.** Writes update local state immediately and queue to a persisted outbox. Never make
  the interface wait on a round trip; never disable a control while syncing.
- **The README must not overstate what is verified.** It is a public portfolio document. If a check
  has not been run, say so.

## Before you claim it works

```bash
npm run lint          # eslint; react-hooks rules are enforced and have caught real design bugs
npx tsc --noEmit
npm run test:sql      # 26 pglite tests; runs the real migration, no network needed
npm run build
```

`npm run test:e2e` additionally needs a **disposable** Supabase project — see `HANDOFF.md`.

## Conventions

- British English throughout, including user-facing copy.
- Node >= 22.18 (the seed script relies on native TypeScript type stripping).
- Content lives in `public.post`. `src/data/posts.ts` is versioned seed data, not what renders.
- Validate anything crossing a trust boundary — browser cache and RPC payloads both — in
  `src/lib/storage.ts`. Do not `as`-cast RPC responses.
- Comments explain *why*, not what. Do not narrate the code.

## Handoff protocol

**Commit at every handoff.** A diff is a better handoff than prose. When work spans agents, leave
the tree clean and update `HANDOFF.md` with: what changed and why, decisions already settled (so the
next agent does not relitigate them), what was verified and what was not, and any trap that cost
time to find.
