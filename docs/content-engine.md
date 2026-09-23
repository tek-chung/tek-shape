# Content engine

Turns articles from trusted sources into feed posts, checks them, and keeps your reading queue topped up.

```
sources (RSS) → fetch article → draft (AI) → deterministic checks → review (AI) → publish → queue
```

Every post is a summary of a real article you can open. The model never supplies facts of its own: each
claim must quote an exact excerpt from the fetched source, citations must match what was actually
retrieved, and a second model call reviews the draft sceptically. Drafts that fail are held, never shown.

## Setup

1. Apply `supabase/migrations/202609230001_content_engine.sql`, then `202609240001_model_providers.sql`, in
   the Supabase SQL Editor, in that order.
2. Get free keys: Mistral from the [Mistral console](https://console.mistral.ai), OpenRouter from
   [openrouter.ai/keys](https://openrouter.ai/keys).
3. Fill `MISTRAL_API_KEY` and `OPENROUTER_API_KEY` in `.env.local`. See `.env.example` for every setting.
4. Run `npm run content -- models`. It lists the free OpenRouter models available right now; copy one or
   more IDs into `CONTENT_OPENROUTER_MODEL`, best first. (Until you do, OpenRouter is skipped and Mistral
   runs alone — nothing breaks.)
5. Check the chain with `npm run content -- providers`, then run once by hand: `npm run content -- cycle`.

Sources default to `content-sources.example.json` (Quanta, Aeon, NASA). To use your own, copy it to
`content-sources.local.json`, which is git-ignored. Each group lists its `hosts`: the engine refuses to fetch
anything outside them, and refuses private network addresses, so a hostile feed cannot point it elsewhere.

## Providers

Providers are tried in the order of `CONTENT_PROVIDERS` (default `mistral,openrouter`). If one fails —
rate limit, outage, quota, a truncated or malformed answer — the next is tried. A provider is skipped, not
fatal, if its key or model is missing.

| Provider | Key variable | Model variable | Default models |
|---|---|---|---|
| `mistral` (primary) | `MISTRAL_API_KEY` | `CONTENT_MISTRAL_MODEL` | `ministral-14b-latest,ministral-8b-latest,mistral-medium-latest` |
| `openrouter` (fallback) | `OPENROUTER_API_KEY` | `CONTENT_OPENROUTER_MODEL` | `qwen/qwen3.8-27b:free,nex-agi/nex-n2.5-pro:free` |
| `groq` | `GROQ_API_KEY` | `CONTENT_GROQ_MODEL` | `qwen/qwen3.8-27b,qwen/qwen3-32b` if enabled |
| `gemini` | `GEMINI_API_KEY` | `CONTENT_GEMINI_MODEL` | — not offered free in the UK |
| `openai` | `OPENAI_API_KEY` | `CONTENT_OPENAI_MODEL` | — paid |

OpenRouter requests carry `provider.require_parameters: true`, so they are only routed to hosts that honour
the JSON schema; without it a host could silently ignore the schema and return free text.

### When models change

Every `*_MODEL` setting is a **preference list**, tried left to right. When a provider retires a model
it answers "not found" or "decommissioned"; the engine then skips that model for the rest of the run and
moves to the next, without paying for it again. So the feed keeps working when models are withdrawn —
you only notice because `models` reports it:

```
npm run content -- models
```

lists what each provider serves right now and marks each preferred model `live: true` or `false`. When a
newer model appears, put it at the front of the list. No code changes.

For OpenRouter, `models` lists only free (`:free`) models, since those are the ones this setup uses.

**To swap providers**, change `CONTENT_PROVIDERS`. **To add one**, write an adapter in
`scripts/content/providers/` implementing the contract in `shared.mjs` — for any OpenAI-compatible API
(OpenRouter, Cerebras, Together…) that is one `chatCompletions({...})` call — and register it in
`index.mjs`. Nothing else changes.

## Limits and cost

- `CONTENT_<P>_DAILY_CALLS` caps each provider separately (default 100), shared by that provider's models,
  because each free tier has its own quota. When the primary's cap is reached, the fallback takes over.
- **Requests are kept small** so they fit tight free-tier limits (Groq's, for instance, is ~8K tokens a
  minute): each article is trimmed to 10,000 characters (`CONTENT_SOURCE_CHARS`), output is capped at
  2,500 tokens, and the prompt carries a bounded summary of your ratings and recent concepts rather than
  your whole history. A test checks the real prompts at worst case.
- Calls to each provider are spaced at least 3 seconds apart (`CONTENT_<P>_MIN_INTERVAL_MS`); bursts are
  what free tiers throttle first.
- After a 429 the engine waits once — as long as the provider asks, or 60 seconds if it doesn't say
  (`CONTENT_RATE_LIMIT_WAIT_SECONDS`) — re-reserving budget, then falls back if it happens again.
- If every provider is rate-limiting at once, the run stops (`stopped: "rate_limited"`) and the next
  scheduled run tries again, rather than hammering them with the remaining articles.
- **Mistral's limits are set per model**, and are shown at admin.mistral.ai → Admin → Limits. They vary
  enormously: in September 2026 this account had 20,000 tokens a minute on `mistral-medium-latest` but
  937,500 on `ministral-14b` and 625,000 on `ministral-8b`. A post (draft plus review) needs roughly
  20,000, so **check a model's tokens-per-minute before putting it first**.
- A model can appear on the limits page yet be outside the free tier: `mistral-large-2512` did, and
  answered 403 "not available in your subscription tier". `probe` shows which models actually work.
- OpenRouter's free allowance is about 50 requests a day in total — roughly 25 posts — so it covers a bad
  day for Mistral rather than replacing it.
- `CONTENT_DAILY_USD` caps spend across all providers, and defaults to `0`: free calls only. Prices default
  to `0`. Setting a price without a budget is refused up front, so a bill cannot appear by accident.
- Every attempt reserves budget *before* calling, and a failed call still counts. Fallback can therefore
  never exceed the limits you set.
- A source already drafted on an earlier run is skipped without any model call.
- When every provider is out of quota, the run stops cleanly and keeps everything saved so far.

Each post costs one or two calls: one to draft, and one to review if the draft passes the deterministic
checks. `CONTENT_DRAFT_LIMIT` (default 8) caps drafts per run.

## Publishing

By default nothing reaches your feed without approval:

```
npm run content -- status               # what is waiting
npm run content -- review <id>          # read one candidate
npm run content -- publish <id> "note"  # approve it
npm run content -- prepare              # add published posts to your queue
```

For a continuous feed, set `CONTENT_AUTO_PUBLISH=true`. Candidates that pass *both* the source-excerpt
checks and the model review are then published automatically, with a note recording which models checked
them. Everything is re-checked immediately before publishing. Held drafts are never auto-published.

## Scheduling

`.github/workflows/content.yml` runs `cycle` every three hours on GitHub's machines, so your laptop can be
off. It does nothing until you add repository secrets (listed at the top of the file). The repository is
public, so its logs are too: the engine prints counts and status codes only, never text, drafts or keys.

GitHub pauses scheduled workflows in repositories with no recent activity. If posts stop arriving, check the
Actions tab.

## Commands

| Command | Does |
|---|---|
| `check` | pre-flight: migrations, reader, providers, models, feeds — spends no AI quota |
| `cycle` | draft, auto-publish if enabled, top up the queue |
| `draft` | draft new candidates |
| `publish-checked` | publish every candidate that passed its checks |
| `publish <id> <note>` | publish one, with a review note |
| `review <id>` | print one candidate |
| `prepare` | append published posts to your queue |
| `status` | candidate counts, queue depth, today's usage per provider |
| `providers` | show the configured chain (never prints keys) |
| `models` | ask each provider which models it serves now; flags retired ones |
