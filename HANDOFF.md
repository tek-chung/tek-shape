# Handoff — Phase 4 content engine, provider-agnostic

Session date: 2026-09-23. Agents: Codex (engine, until usage ran out), then Claude (providers, budget,
continuous running). Uncommitted at time of writing — see section 6.

## 1. State

Phase 3 is **user-verified** in Chrome: magic-link sign-in, sync, paging past post 8.

Phase 4 is built. Both Phase 4 migrations are applied to the personal project and `check` passes fully.
Live drafting works on `mistral/ministral-14b-latest`: three posts have passed every check including the
model review (none published yet — auto-publish is off). Claims now cite sentence numbers rather than
copying quotes; that change has not yet been run live.

## 2. Direction set by the repo owner

Settled — do not relitigate:

| Question | Decision |
|---|---|
| localStorage or Supabase? | **Supabase.** Daily use, phone-first, cross-device sync is the point. |
| Where does content live? | **Supabase**, not `src/data/posts.ts`. |
| State architecture | **Local-first with a persisted outbox**, Supabase authoritative. |
| Pagination | **Cursor paging with infinite scroll.** Chosen knowingly despite the anti-endless-scroll premise. |
| Feed volume | **Twitter-like** — continuous, many posts a day, shaped by ratings. |
| Content origin | **Aggregate, don't invent.** Summarise real articles from trusted feeds; every claim must quote its source. |
| AI cost | **Free tiers only.** No paid API credit. `CONTENT_DAILY_USD` defaults to 0. |
| AI provider | **Gemini 3.5 Flash-Lite primary, then Mistral, then OpenRouter** (owner confirmed a Gemini free tier on their AI Studio account: 15 RPM, 250K TPM, 500 RPD). Groq remains available by config. |
| Model churn | Model settings are **ordered preference lists**; retired models are skipped automatically. |
| Scheduling | **GitHub Actions**, so the laptop can be off. |
| Migration style | Phase 3 migration edited in place; Phase 4 migrations are **additive**. |

## 3. What Phase 4 is

`docs/content-engine.md` is the user-facing reference. In short:

```
RSS → fetch article → draft (AI) → deterministic excerpt checks → review (AI) → publish → queue
```

Codex built the engine: SSRF-hardened fetching (`sources.mjs`), exact-excerpt claim checks and ranking
(`editorial.mjs`), the pipeline (`engine.mjs`), the runner (`run.mjs`), the `content_engine` migration
(candidates, runs, budget, `feed_queue`, `publish_candidate`, queue-ordered `reading_page`), and tests.

Claude then made it provider-agnostic and able to run continuously on free tiers:

- **`scripts/content/providers/`** — one adapter per provider behind a single contract (`shared.mjs`):
  Gemini (Interactions API), Mistral (chat completions, strict JSON schema), and OpenAI (kept, not in the
  default chain). Adapters never retry and never echo response bodies.
- **`model.mjs`** — ordered fallback chain from `CONTENT_PROVIDERS`. Each attempt reserves budget first;
  a failed attempt still counts, so fallback cannot multiply spend. Unconfigured providers are skipped.
- **`202609240001_model_providers.sql`** — **fixes a blocker**: Codex's `reserve_content_call` rejected
  `p_cost <= 0`, so free tiers could never run. Now: calls capped per provider, spend capped across all
  providers, zero cost valid, zero budget = free only.
- **Engine** — skips sources already drafted (previously every run re-drafted the same feed items, burning
  quota and creating duplicates); one failed article no longer ends the run; quota exhaustion on every
  provider stops cleanly and keeps what was saved; genuine bugs are not mistaken for provider failures.
- **Runner** — `cycle` command (draft → auto-publish → prepare), opt-in `CONTENT_AUTO_PUBLISH`, model
  provenance recorded on each candidate, `providers` diagnostic, configurable draft limit and queue target.
- **`.github/workflows/content.yml`** — every three hours; skips cleanly until secrets exist.
- **`content-sources.example.json`** — Quanta, Aeon, NASA. All three feeds fetched and checked live.
  The Conversation and Wikipedia's featured feed returned nothing and were left out.
- **`.env.example`** — every setting, documented. `.gitignore` now excepts it from the `.env*` rule.

### Groq switch (later the same day)

- **`providers/chat.mjs`** — one adapter for any OpenAI-compatible chat API. Groq, Mistral and OpenRouter
  are each a few lines on top of it. Gemini and OpenAI adapters kept but out of the default chain.
- **Default chain `groq,mistral`**, Groq models `qwen/qwen3.8-27b,qwen/qwen3-32b`. Per Groq's docs on
  2026-09-23, `qwen3-32b` is no longer listed; `qwen3.8-27b` is current and supports strict schemas.
- **Retired models**: a 404 or `model_not_found`/`decommissioned` code skips that model for the rest of the
  run. `npm run content -- models` lists what each provider serves now.
- **Groq free plan is ~8K tokens a minute, ~200K a day.** Defaults cut to fit: 10,000-character sources,
  2,500 output tokens, 80 recent concepts, a 20-row per-subtopic ratings summary instead of raw ratings.
  A test measures the real prompts at worst case against the limit. One bounded wait on a short
  `retry-after`, re-reserving budget; otherwise fall back.
- Qwen reasoning: Groq moves it out of `content` when JSON output is on; stray `<think>` text is stripped
  defensively. `CONTENT_GROQ_REASONING_EFFORT` is sent only if set.
- The user could not reach console.groq.com (likely a network filter; unconfirmed).

### Final chain: Mistral, then OpenRouter

- Default `CONTENT_PROVIDERS=mistral,openrouter`. Groq adapter kept, not in the chain.
- OpenRouter sends `provider.require_parameters: true` so only schema-honouring hosts serve requests, and
  its `models` listing is filtered to `:free` IDs.
- **No default OpenRouter model**, deliberately: free IDs churn. The user picks from `models`. Until then
  OpenRouter is skipped and Mistral runs alone. `CONTENT_OPENROUTER_DAILY_CALLS=50` matches its free quota.
- User confirmed live: Mistral key works, `mistral-small-latest` is served.
- **Models chosen:** Mistral `mistral-medium-latest,mistral-small-latest` (user's choice; Small as backup).
  OpenRouter `qwen/qwen3.8-27b:free,nex-agi/nex-n2.5-pro:free`. Of 21 free OpenRouter models, only 4
  listed `structured_outputs` in its catalogue on 2026-09-23 (those two, `nex-n2.5-mini`,
  `dots-3-note-preview`). Any other free model would be refused by `require_parameters: true`.
- `models` now needs only a key, not a model, so it can list a provider before one is chosen (it
  previously omitted OpenRouter entirely for that reason). `run.mjs` no longer calls `process.exit()`
  after network calls: on Windows that tripped a libuv `UV_HANDLE_CLOSING` assertion after output.

### Pre-flight and card fixes

- `npm run content -- check`: read-only pre-flight (config, both migrations, one enrolled reader, content,
  provider chain, live models, each feed). No AI quota spent. A fallback that isn't set up is a warning,
  not a failure. Run it before the first `cycle`.
- Cards: added the missing `.post-sources` style (the Sources toggle had no 44px tap target), and
  publication/event dates now use `.source-meta` instead of the underlined link style.

- User's first `check`: all green except the NASA feed, "resolved to a non-public address". Cause:
  Codex's `publicIPv4` blocked whole /16s (192.0.x.x, 198.51.x.x, 203.0.x.x) where IANA reserves only a
  /24. WordPress VIP, which I believe hosts nasa.gov, sits in 192.0.64.0/18. Rewritten as an explicit CIDR list at exact sizes.
  **Trap:** the first rewrite forgot that `&` is signed in JS, so every range above 128.0.0.0 silently
  never matched — private 192.168.x.x would have passed. Caught by the new boundary test; keep `>>> 0`.
  The error now names the offending address, to tell a real block apart from a corporate DNS filter.

### First live cycle: rate limits

- First `cycle`: every model failed on article 1 — Mistral Medium, Mistral Small and OpenRouter Qwen all
  `429`, and `nex-n2.5-pro` returned non-JSON. Not a schema problem.
- Causes and fixes: no pacing between calls (now `CONTENT_<P>_MIN_INTERVAL_MS`, default 3000); a 429 with
  no `retry-after` never waited — **because `Number(null)` is 0**, so a missing header read as "retry now"
  (now waits `CONTENT_RATE_LIMIT_WAIT_SECONDS`, default 20); the run kept going when everything was
  throttled (now stops with `stopped: "rate_limited"`); models wrapping JSON in a code fence were rejected
  as malformed (now unwrapped).
- `probe` command: one synthetic draft per model with the real schema, printing the provider's own error
  text (safe only because the input is synthetic; `ProviderError.detail` is non-enumerable so it cannot
  reach traces, saved checks or logs).
- Progress lines name each attempt's provider, model, reason and status.
- **Root cause found via the Mistral console (Admin → Limits):** limits are per model, and
  `mistral-medium-latest` has only 20,000 tokens a minute. A post needs ~19,000 (draft ~9.5K incl. the
  2,500 output cap, plus review), so retries inside one minute kept it saturated — even a single probe was
  refused (Mistral error code 1300). Mistral chain changed to `mistral-large-2512` (250K TPM, higher
  quality — listed on the limits page though not in `/v1/models`, so unconfirmed) → `ministral-14b-latest`
  (937.5K TPM) → Medium. Default wait on a bare 429 raised from 20 s to 60 s, since per-minute token
  windows need a full minute to clear.
- **First passing live draft:** `probe` → `ministral-14b-latest` ✓. `mistral-large-2512` is 403 / code
  1910 "not available in your subscription tier" despite being on the limits page, so it was dropped.
  Chain now `ministral-14b-latest,ministral-8b-latest,mistral-medium-latest`. 403 is now classed as
  `model_unavailable` (skipped for the run) rather than retried on every article.
- **First real cycle with ministral-14b: every draft held.** Errors (from `content_candidate.checks`):
  every claim "no exact supporting source excerpt", every draft "Citations must match retrieved sources",
  3 of 5 "Invalid canonical concepts". Fixes, none weakening the evidence rule:
  - citations are now stamped by the engine from the retrieved source (and each claim's `url` set to it),
    instead of requiring the model to copy metadata character for character;
  - `conceptIds` folded to slugs deterministically (`slugs()` in engine.mjs);
  - excerpt matching (`excerptFound()` in editorial.mjs) folds typography only — curly/straight quotes,
    dashes, ellipsis, NBSP, case — and accepts `A … B` only if every fragment is ≥4 words, verbatim, in order;
  - `DRAFT_INSTRUCTION` now spells out verbatim 6–30-word excerpts and slug-format concept IDs, and says
    to drop a claim that has no supporting passage.
  - Held articles were locked out forever (their URL counted as "known"). Now retried after
    `CONTENT_RETRY_HELD_HOURS` (default 24; 0 = every run).
  - `review` with no id shows the latest held draft, each quote marked ✓/✗ against the article.
- **Second real cycle: 1 of 8 passed every check including review** (Aeon). Remaining holds were near-miss
  quotes (the model changing a word or two) and "News needs a supported recent article date". Fixes:
  - `snapExcerpt()`: a quote matching ≥85% of a real passage's words, in order, and ≥6 words long, is
    replaced with that passage verbatim. Evidence stays genuine source text; the reviewer still judges
    support. Loose paraphrases are not rescued.
  - `articleDate` is stamped from the source. "News" without a recent (≤14-day) source date is relabelled
    evergreen rather than held.
- **Third real cycle: 2 of 8 passed** (3 checked in total); 5 still held on excerpts. Root fix — **claims
  now cite sentence numbers instead of copying quotes.** `modelSource()` sends the article as numbered
  sentences (`splitSentences()` in sources.mjs); the draft schema's claims are `{claim, sentences:[int]}`;
  `citedExcerpt()` turns the numbers back into the verbatim sentences. Evidence is exact by construction;
  an invalid number yields an empty excerpt, so the claim fails. The reviewer still judges support.
  `settleDraft()` holds all engine-side settling (citation, evidence, date, concept slugs) and is shared
  with `probe`, so a probe ✓ means a real run would accept the draft. Quote-style replies still go through
  `snapExcerpt()` for any model that ignores the new schema.
- `probe` now uses the real `DRAFT_INSTRUCTION` (exported from engine.mjs) and a realistic synthetic source,
  and applies full `checkDraft`: ✓ means a draft that would pass, not merely valid JSON.

## 4. Verification

Run and passing against the current tree: `npx tsc --noEmit`; `npm run test:content` (66/66, including
fallback, retired models, retry-after, request size, adapter wire formats and error redaction);
`npm run test:sql` (38/38). `run.mjs` exercised
directly: `providers`, `help`, and clean failures without Supabase or without any provider.

**Not run**: `npm run lint` and `npm run build` (sandbox limits — run locally), either Phase 4 migration
against the live project, any real Gemini or Mistral call, the workflow on GitHub, `tests/feed.spec.ts`.

API contracts were read from current documentation on 2026-09-23, not from memory: Gemini's Interactions
API endpoint, request fields, status values and nullable schema form; Mistral's structured-output format.

## 5. Traps

- **Gemini's nullable form is a type array**, `{"type": ["string","null"]}`, per its docs. Keep it.
- **Mistral's free tier is described as "evaluation, not production"**, and it is now the primary. Fine
  for a single-reader personal feed, but if it starts throttling, OpenRouter's ~50/day will not cover
  full volume — expect a thinner feed rather than an error.
- **Free-tier quotas are unpublished and change often.** `CONTENT_<P>_DAILY_CALLS` is our own cap, not
  the provider's; a provider can still return 429 first, which falls through to the next.
- **The repo is public, so Actions logs are public.** Never add logging that prints source text, drafts,
  prompts or provider response bodies.
- **Load time in the Claude sandbox is misleading.** `cheerio` takes ~22 s to import cold there; that is
  the mounted filesystem, not the code.
- Existing traps still apply: singleton auth client; public env vars inlined at build time; `@next/env`
  needs a default import; never disable controls to await sync.

## 5b. Source links and more feeds (23 Sep 2026)

- `PostCard` shows "Read the original · publisher: title" on every post, plus the publication date.
- Sources: 14 groups in `content-sources.example.json` (see docs/content-engine.md for options).
  CNN added 24 Sep via its text-only site (`pages` lite.cnn.com, match dated paths). Reuters excluded (no public RSS; blocks automated readers). FT and The Economist removed 24 Sep: hard
  paywalls, their RSS carries only headlines and standfirsts.
- Engine: listing-page discovery (`pages` + `match`), `skip`, `openHosts`, round-robin across publishers,
  charset decoding (Big5/GBK), CJK sentence splitting and excerpts, paywall guard, 800-character minimum.
- Tests: 75 content tests pass (new `tests/content/sources.test.mjs`); tsc passes.

## 5c. Gemini primary (23 Sep 2026)

- Chain is now `gemini,mistral,openrouter`; `CONTENT_GEMINI_MODEL=gemini-3.5-flash-lite,gemini-flash-lite-latest`,
  4.5 s spacing, 450 calls a day (free tier: 15 RPM, 250K TPM, 500 RPD). Mistral and OpenRouter are fallbacks.
- Gemini adapter gained `listModels`, so `npm run content -- models` confirms the ID. First live Gemini call
  is the real test of the Interactions API adapter.

## 5d. Extraction and concept fixes (24 Sep 2026)

- Al Jazeera draft held: cheerio ran blocks together with no space, so the whole page was "sentence 1" and
  every excerpt exceeded 2,400 chars. Extraction now prefers `<p>` text, drops figures/buttons/aria-hidden,
  spaces blocks; the splitter also breaks run-together sentences over 500 chars.
- Gemini Flash-Lite copied the prompt's example slug and the recent-concepts list as tags. Prompt reworded;
  `relevantConcepts` drops tags with no word in the article (skipped for non-Latin sources).
- `[1]`-style markers stripped from prose. `review <publisher>` finds the latest draft by name and prints the URL.

## 5e. Checks switch (24 Sep 2026)

- Owner chose `CONTENT_CHECKS=off` locally after a run of false holds. Off = format checks only, no quote
  check, no review call; candidates record `checks.mode`, and publish notes say claims are unverified.
  CI default stays `strict` unless the `CONTENT_CHECKS` variable is set. Posts still show as
  `source_checked` in the database (schema allows only that or `unreviewed`); the note records the truth.
- The 7 "Invalid canonical concepts" holds were caused by my relevance filter leaving no tags (and Chinese
  tags slugging to nothing). Tags now fall back to subtopic/topic, so they never hold a post.
- Redirects may move between hosts of the same site (SCMP, Nature); feed size limit 1 MB → 5 MB (Physics World).

## 5f. Unread feed and Read list (24 Sep 2026)

- Migration `202609250001_unread_feed.sql` (additive): `post_json`, `feed_page(p_after_id, p_limit,
  p_read_before)` skipping posts read before the app opened, `saved_page('bookmarked'|'read', offset, limit)`.
  `reading_page` kept for old clients. SQL tests: `tests/sql/unread-feed.test.mjs`.
- Client: `useReading` pages `feed_page` with `since` = app-open time and drops read-before-since posts from
  the cache; at the end of the feed each poll looks for new posts. New `useList` hook; Feed has
  Your feed / Library / Read tabs, Library count from all bookmarks, lists fetched from the server.
- Playwright: `beforeEach` clears `read_at` for the test user; new "moves to Read" test. Not yet run.

## 5g. Seeded-post sources (24 Sep 2026)

- Added The Learning Scientists (RSS), NASA Space Place (listing pages), Open Music Theory (Pressbooks
  contents page). Listing pages now yield up to 200 links, so later chapters are reached on later runs.
- Not added: OpenStax (its pages say the books may not be ingested by LLMs/generative AI without
  permission), Khan Academy (content is rendered by JavaScript; the fetcher sees an empty page),
  NPS and Cornell (single pages with no feed or listing).

## 5h. More sources (24 Sep 2026)

- Removed Open Music Theory (owner not interested). Added ScienceDaily, The Marginalian, Tiny Buddha (RSS),
  etnet 雷鳴天下 by Francis Lui (listing page; Chinese), Stanford Encyclopedia of Philosophy (What's New +
  full contents; chosen over IEP for its update stream and depth). Now 20 groups: the validator's maximum.
- Listing pages yield up to 2,000 links, so SEP's contents are worked through over many runs.
  `CONTENT_DRAFT_LIMIT` 20 locally and as the CI default.

## 5i. Psychology Today; two refused (24 Sep 2026)

- Added Psychology Today (Essential Reads pages 1–2, blog-post links). Source cap raised 20 → 30.
- Not added: FT Alphaville (needs an FT account; the engine never signs in), CFO Secrets (its footer says
  content "may not be used, reproduced, or scraped without express permission", incl. for AI).

- Added Think Fast Talk Smart (podcast; episode pages carry full transcripts). 22 groups.

- Added Investopedia (feed URL unverified: my fetch tool is blocked there) and MIT Sloan Management Review
  (feed returned nothing to my tool; articles may be registration-walled). 24 groups; `check` decides.

- Added The Conversation UK (Atom feed + homepage; the feed returned nothing to my tool) and Knowledge at
  Wharton (RSS verified; protected special reports skipped). 26 groups.

- Nature fix: its feed is RSS 1.0 (RDF), whose items sit under `rdf:RDF`, not `rss.channel`; `discoverXML`
  read none. Now handled (19 of Nature's first 20 items are `d41586-` news). Test added; 85 content tests pass.

- Investopedia and MIT SMR now have several discovery routes each (feeds + homepage/dictionary/topic pages).
  Paywall guard only rejects pages under 3,000 chars, so an upsell box after a full article no longer
  rejects it. No bot-block or paywall circumvention (no browser spoofing, no archive mirrors).

- Investopedia removed: HTTP 403 on every feed and page (the site refuses automated readers). 25 groups.

- NASA Space Place removed (owner: too elementary). 24 groups.

## 5j. Subject map and knowledge map (26 Sep 2026)

- `src/data/taxonomy.json`: 10 umbrellas (+ Other) → 68 fields; shared by app (`src/lib/taxonomy.ts`) and
  engine (`scripts/content/taxonomy.mjs`). Drafts now return `field` (schema enum) + free-text `subtopic`;
  `settleDraft` derives `umbrella` and sets `topic` to the umbrella label. Unknown field → other/general.
- Migration `202609260001_knowledge_map.sql`: `post.umbrella`/`post.field`, `publish_candidate` and
  `post_json` carry them, `knowledge_map()` RPC aggregates per (umbrella, field, lower(subtopic)).
- `npm run content -- classify` files older posts (field = general) with one small AI call each.
- App: Map tab (`KnowledgeMap.tsx`, `lib/knowledgeMap.ts`): T-shape (breadth band + depth bars), drill to
  fields, then subtopics, with ratings/deeper counts. Card chip shows field · subtopic.
- Next (agreed, not started): feedback-driven generation at field/subtopic granularity: skip disliked
  subtopics before drafting, give well-rated sources more turns, count saves and deeper opens as positive.

## 5k. Taste model and recommender (27 Sep 2026)

- `scripts/content/taste.mjs`: rewards, layered shrinkage estimates, learned pauses, difficulty targets, niches,
  self-tuning exploration, `rankQueue` (favourite/explore/stretch batches), `planSources`, `judgeTopic`,
  `promptSummary`, `snapshotOf`. Replaces `selectQueue`/`summarisePreferences` (removed with their tests).
- Engine: `discover` keeps headlines (`discoverXMLItems`/`discoverHTMLItems`); `draftCandidates` takes `plan`,
  `triage`, `guidance`; `interleave` honours `turns`. Runner: triage call (`triageSchema`), `prepare` writes
  `feed_queue.slot` and `taste_snapshot`; `status` prints the report card and niches (local only).
- Migration `202609270001_taste.sql`: `user_post_state.opened_at` (+ `save_post` `opened`, `reading_state`
  `openedAt`), `feed_queue.slot`, `topic_preference` + `set_topic_preference`, `taste_snapshot` + `taste_view`.
- App: "Read the original" sends `opened`; Map shows niches, report card, per-field enjoyment and target
  difficulty, pauses, and More / Less / Snooze on fields and subtopics.
- **Order matters**: apply the migrations before deploying; the new app's `opened` patch is rejected by the old
  `save_post`, which would stall the outbox.

- 24 Sep scheduled run (old code): Investopedia's two feed URLs gave 403/404 but its homepage and dictionary
  pages were readable from GitHub's runners (the owner's own network got 403 on everything). Restored with
  pages only. Workflow: actions v5 (Node 24), `npm ci --ignore-scripts`. That run used CONTENT_CHECKS=strict
  (variable unset): 13 of 26 drafts held by the reviewer.

## 5l. Sittings: refresh brings new posts and clears read ones (28 Sep 2026)

- `useReading`: a *sitting* starts on open/reload, on the Refresh button, or on return after 30 min hidden.
  Each sitting rebuilds the unread feed from the server to the previous depth (min one page), drops posts
  read before it (including unsynced local reads), then asks `feed_summary` how many posts joined since the
  previous sitting (stored in localStorage `tek-shape:visit:v1:<user>`). Feed shows "N new posts since you
  last looked" with Show me (pages down to the first arrival) and scrolls to top after Refresh/resume.
  Within a sitting nothing moves. `readBefore` now compares parsed times (server and client formats differ).
- Read and Library lists merge local not-yet-synced reads/saves ahead of the server's page.
- Migration `202609280001_feed_queued_at.sql`: `feed_page` rows carry `queuedAt`; `feed_summary(read_before,
  since)` returns unread, arrivals and firstArrival. SQL tests in `tests/sql/taste.test.mjs` (49 SQL pass).
- Playwright: "Refresh moves posts read earlier to Read" added (not run here).

## 5m. Controls count as reading, everywhere (24 Sep 2026)

- Bug seen on the phone: posts rated on an earlier build (before "any icon counts as read") had no
  `read_at`, so Refresh left them in the feed. Migration `202609290001_controls_mark_read.sql`:
  `save_post` sets `read_at` for any of rating / bookmarked / expanded / opened / read (not `seen`), and
  backfills `read_at = least(updated_at, deeper_opened_at, opened_at)` for touched rows without one.
  Idempotent. Tests: `tests/sql/controls-read.test.mjs` (53 SQL pass).
- Client (`src/lib/storage.ts`): `applyPatch` mirrors that rule (`marksRead`); `readBefore` moved here and
  treats a touched post with no read time as read in an earlier sitting (covers a database without 0929);
  `applyOutbox(..., local)` keeps this device's own times for unsynced changes, so a post read offline
  moves to Read at the next sitting instead of being re-stamped at each merge (the 5l claim was wrong
  without this).
- `useReading`: `flush` joins a pass already under way (sync waits up to 4 s for it) and sends late taps
  straight after; `rebuild` waits up to 5 s for a page in flight instead of deferring to the next poll;
  a failed rebuild now shows the "could not be refreshed" notice rather than failing silently (a missing
  `feed_page` migration used to look like a stale feed).
- New `npm run test:client` (Node type stripping, no new dependencies): `tests/client/storage.test.mjs`.

## 5n. Gemini 400 on every draft (24 Sep 2026)

- After the subject map shipped, every draft call returned HTTP 400 from both Gemini models (not 429: quota
  was fine, ~350 of 500 that day). The 04:57 UTC run on the older schema drafted 26 posts; the triage call,
  whose small schema carries the same 69-value field enum, kept working. Cause: the enum made the large
  draft schema too complex for Gemini's structured output ("very large ... schemas may be rejected").
- Fix: `draftSchema.field` is a plain string; `DRAFT_INSTRUCTION` lists the IDs (`TAXONOMY_PROMPT`);
  `settleDraft(..., fallbackField)` folds case/spacing and falls back to triage's field, then Other.
  Triage and classify keep their enums. Test guards against a long enum returning to the draft schema.
- Confirm with `npm run content -- probe` (real draft schema; prints Gemini's own error text if any).

## 5o. Excerpt sources and saved articles (24 Sep 2026)

- Owner asked for MIT Technology Review, OpenStax and CFO Secrets without AI: "first paragraph / summary
  and the link". MIT TR's terms bar AI use (incl. classification) but allow keeping content for your own
  non-commercial use; OpenStax (CC BY-NC-SA 4.0) bars only LLM use; CFO Secrets forbids use, reproduction
  or scraping without permission and has no feed, so it stays out.
- Owner also asked: where a site is gated but its feed carries the article, save the body and make it
  readable in the app under the source link.
- Engine: group `mode: "excerpt"` (never triaged, never sent to a model; `field`, `fieldRules` by feed
  category or URL, `perRun`, `contentType`, `licence`), `keepBody` for any group. `sources.mjs`:
  `discoverXMLItems` returns description/categories/published/author (+ `body` on request) and reads
  sitemaps; `feedBlocks` turns feed HTML into text-only blocks (p/h/q/ul/ol/table); `pageExcerpt` takes a
  page's first real paragraph (skips learning objectives). Gated page + feed body → drafted from the feed's
  copy; the reviewer never sees the body. `checkExcerpt`/`validBlocks` in `editorial.mjs`.
  `run.mjs` reads posts without bodies (`POST_COLUMNS`) and `check` reports feed summaries/full text.
- Migration `202609300001_excerpts.sql`: `post.kind` ('post'|'excerpt'), `post.body` jsonb (≤300 blocks,
  ≤150 KB); insight/deeper nullable only for excerpts (checks renamed in place); `publish_candidate`
  carries kind/body; `post_json` adds `kind`, `hasBody` (never the body); `post_body(id)` RPC.
- App: excerpt card (EXCERPT label, "in their words" note, no insight/deeper/Book control), "Read the full
  article here" → `ArticleReader` overlay (fetches `post_body`, text-only rendering, history entry so Back
  closes it, counts as opened). Auto-read observes `.insight, .excerpt`.
- Sources: MIT Technology Review (excerpt + keepBody; skips The Download, Roundtables, AI Hype Index),
  OpenStax Biology 2e and Principles of Economics 3e (excerpt via sitemaps, one per run, URL rules by
  chapter), MIT SMR `keepBody`. 28 groups. Tests: content 107, SQL 57, client 6.
- Then CFO Secrets, on the owner's statement that they have the publisher's express permission (the site's
  notice requires it). Excerpt mode via its sitemap (`/p/` posts, newest first, one per run) with
  `excerptFrom: "description"`: issues open with sponsor copy, so the card shows the publisher's own
  subtitle. URL keyword rules file careers and leadership issues; `plainTitle` strips emoji from
  headlines. If the permission covers AI summaries too, drop `mode`/`excerptFrom` to draft it normally.
  29 groups; content tests 108.
- First live run: 6 excerpts published, none queued. With many publishers competing, a one-paragraph
  excerpt (difficulty 1, unknown publisher) never wins a favourite slot (0/40 seeds in a probe). Fix in
  `rankQueue`: one favourite slot per batch (index ≥ 3, never the opener) goes to the best waiting excerpt
  if its value is at least 0.6 × prior; excerpts get neutral difficulty fit. `POST_COLUMNS` now reads
  `kind` (needs 202609300001). Log lines for excerpts read `[excerpt, no AI]`; `publishChecked` reports
  `excerptsPublished` and warns when the excerpt migration is missing; `prepare` reports `unreadBefore`;
  `status` lists excerpts per publisher (saved / published / in feed / unread). Content tests 109.
- SMR posts drafted before `keepBody` (or published before 202609300001) had no saved article. Each run
  now offers every keepBody feed's current articles to `attachBodies`, which saves them onto published
  posts citing that URL with `body is null` (`feedArticles` in engine.mjs, `bodyAttacher` in run.mjs);
  `npm run content -- bodies` does just that, no AI. Only articles still in the feed can be recovered
  (FeedBurner carries the latest ~8). Content tests 110.

## 5p. The feed refills itself (25 Sep 2026)

- Owner saw many published posts never reach the feed. Not the taste model: `prepare` only tops up to
  `CONTENT_QUEUE_TARGET` (24) unread, once per 3-hour run. At 17:21 ~21 were unread (3 added); at 21:39 ~26
  (none added); the owner then read ~20 at 01:00. ~200 drafts/day far outpace reading.
- Migration `202610010001_feed_reserve.sql`: `feed_reserve` (engine-written, not readable by the reader)
  and `feed_top_up(p_count ≤ 30)`, security definer, caller's rows only, published+checked posts not yet
  queued, same advisory lock as `append_feed`. `prepare` ranks the next `CONTENT_RESERVE` (default 60)
  posts after its picks with the same `rankQueue` and replaces the reserve (reports `reserve`, or a hint if
  the migration is missing). `check` covers the migration.
- `useReading`: at the end of the feed (in `loadUpTo` or a sitting's `rebuild`), with fewer than a page of
  unread posts held, `drawReserve` calls `feed_top_up(10)` once per load and reads on; an idle feed never
  grows because the unread check fails. Tests: `tests/sql/feed-reserve.test.mjs` (SQL 60).
- Lever not pulled: `CONTENT_DRAFT_LIMIT` could drop to ~12 to stop spending quota on posts never read.

## 6. Next steps

1. **User:** `npm run lint` and `npm run build`.
2. **User:** apply `202609230001_content_engine.sql`, then `202609240001_model_providers.sql`, in the
   Supabase SQL Editor, in that order.
3. **User:** add `MISTRAL_API_KEY` and `OPENROUTER_API_KEY` to `.env.local`, run
   `npm run content -- models`, and paste a free OpenRouter model ID into `CONTENT_OPENROUTER_MODEL`.
4. `npm run content -- providers`, then `npm run content -- cycle` with auto-publish still off. Inspect
   with `status` and `review <id>` before trusting auto-publish.
5. First live call is the real test of each adapter. Most likely failure: a schema keyword one provider
   rejects (HTTP 400, reason `rejected`). The trace on each candidate records which provider answered.
6. Once happy: `CONTENT_AUTO_PUBLISH=true`, then add the repo secrets to enable the schedule.
7. Commit. Suggested message: `Phase 4: provider-agnostic content engine on free tiers`.
