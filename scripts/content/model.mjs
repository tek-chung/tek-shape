import { providers } from "./providers/index.mjs";
import { ProviderError } from "./providers/shared.mjs";

const string = { type: "string" };
// The nullable form Gemini documents explicitly; also standard JSON Schema for Groq, Mistral and OpenAI.
const nullable = { type: ["string", "null"] };
const array = (items) => ({ type: "array", items });
const object = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
export const draftSchema = object({
  topic:string, subtopic:string, title:string, explanation:array(string), insight:string, deeper:string,
  contentType:{ type:"string", enum:["news","evergreen"] }, difficulty:{ type:"integer" },
  conceptIds:array(string), eventDate:nullable, articleDate:nullable,
  sources:array(object({ url:string, publisher:string, title:string, articleDate:nullable, accessedAt:string })),
  // Claims cite sentences by number; the engine fills in the verbatim text. Models are far better at
  // pointing than at copying, and the evidence is then exact by construction.
  claims:array(object({ claim:string, sentences:array({ type:"integer" }) })),
});
export const reviewSchema = object({ supported:{type:"boolean"}, complete:{type:"boolean"}, misleading:{type:"boolean"},
  // A few words on what failed, so a held draft can be understood without re-running the review.
  problems:string,
  claims:array(object({ index:{type:"integer"}, supported:{type:"boolean"}, reason:string })) });

/** Primary first, then fallbacks. Override with CONTENT_PROVIDERS. */
export const DEFAULT_CHAIN = "gemini,mistral,openrouter";
const MAX_INPUT_BYTES = 180_000;

function number(value, name, { min = 0, max = Infinity, integer = false } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max || (integer && !Number.isInteger(parsed))) {
    throw new Error(`${name} must be ${integer ? "an integer" : "a number"} between ${min} and ${max}`);
  }
  return parsed;
}

const list = (value) => String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);

/**
 * Build the ordered chain from the environment.
 *
 * Per provider P in CONTENT_PROVIDERS:
 *   CONTENT_<P>_MODEL                    required; a comma-separated preference list,
 *                                        e.g. "qwen/qwen3.8-27b,qwen/qwen3-32b"
 *   <provider key variable>              required, e.g. GROQ_API_KEY
 *   CONTENT_<P>_DAILY_CALLS              default 100, shared by that provider's models
 *   CONTENT_<P>_REASONING_EFFORT         optional; sent only when set
 *   CONTENT_<P>_INPUT_USD_PER_MILLION    default 0 (free tier)
 *   CONTENT_<P>_OUTPUT_USD_PER_MILLION   default 0 (free tier)
 *
 * The chain tries every model of the first provider, then every model of the
 * next. A provider missing its model or key is skipped. CONTENT_DAILY_USD caps
 * spend across all providers and defaults to 0: free calls only.
 */
export function modelConfig(env) {
  const names = list(env.CONTENT_PROVIDERS ?? DEFAULT_CHAIN).map((name) => name.toLowerCase());
  if (!names.length) throw new Error("CONTENT_PROVIDERS lists no providers");
  if (new Set(names).size !== names.length) throw new Error("CONTENT_PROVIDERS lists a provider twice");
  for (const name of names) {
    if (!providers[name]) throw new Error(`Unknown content provider "${name}". Available: ${Object.keys(providers).join(", ")}`);
  }

  const dailyUsd = number(env.CONTENT_DAILY_USD ?? 0, "CONTENT_DAILY_USD");
  // Kept modest: free tiers can have small per-minute token limits (Groq's is ~8K), and some count the cap, not actual use.
  const maxOutputTokens = number(env.CONTENT_MAX_OUTPUT_TOKENS ?? 2500, "CONTENT_MAX_OUTPUT_TOKENS", { min: 256, max: 32_000, integer: true });
  const maxWaitSeconds = number(env.CONTENT_MAX_WAIT_SECONDS ?? 60, "CONTENT_MAX_WAIT_SECONDS", { max: 300 });
  // Used when a provider answers 429 without saying how long to wait, as Mistral does. A full minute,
  // because free tiers mostly cap tokens per minute, and a shorter wait lands in the same full window.
  const rateLimitWaitSeconds = number(env.CONTENT_RATE_LIMIT_WAIT_SECONDS ?? 60, "CONTENT_RATE_LIMIT_WAIT_SECONDS", { max: 300 });
  const chain = [];
  const skipped = [];
  for (const name of names) {
    const provider = providers[name];
    const prefix = `CONTENT_${name.toUpperCase()}`;
    const models = list(env[`${prefix}_MODEL`]);
    const key = env[provider.keyVariable];
    if (!models.length || !key) {
      skipped.push(`${name} needs ${[!models.length && `${prefix}_MODEL`, !key && provider.keyVariable].filter(Boolean).join(" and ")}`);
      continue;
    }
    if (new Set(models).size !== models.length) throw new Error(`${prefix}_MODEL lists a model twice`);
    const shared = {
      name, provider, key,
      calls: number(env[`${prefix}_DAILY_CALLS`] ?? 100, `${prefix}_DAILY_CALLS`, { min: 1, max: 10_000, integer: true }),
      inputPrice: number(env[`${prefix}_INPUT_USD_PER_MILLION`] ?? 0, `${prefix}_INPUT_USD_PER_MILLION`),
      outputPrice: number(env[`${prefix}_OUTPUT_USD_PER_MILLION`] ?? 0, `${prefix}_OUTPUT_USD_PER_MILLION`),
      options: { reasoningEffort: env[`${prefix}_REASONING_EFFORT`] || undefined },
      // Gap between calls to this provider. Free tiers often allow only about one request a second or less.
      minIntervalMs: number(env[`${prefix}_MIN_INTERVAL_MS`] ?? 3000, `${prefix}_MIN_INTERVAL_MS`, { max: 120_000, integer: true }),
    };
    for (const model of models) chain.push({ ...shared, model });
  }
  if (!chain.length) throw new Error(`Configure at least one content provider locally: ${skipped.join("; ")}`);
  // A priced provider under a zero budget would be refused on every call; say so once, up front.
  if (dailyUsd === 0 && chain.some((entry) => entry.inputPrice > 0 || entry.outputPrice > 0)) {
    throw new Error("A provider has a price but CONTENT_DAILY_USD is 0. Set a daily budget or remove the price.");
  }
  // `unavailable`: models found retired this run, keyed "provider/model", skipped without another attempt.
  // `lastCall`: when each provider was last called, for pacing.
  return { chain, skipped, dailyUsd, maxOutputTokens, maxWaitSeconds, rateLimitWaitSeconds, unavailable: new Set(), lastCall: new Map() };
}

/** Raised when no provider in the chain produced a result. */
export class ModelChainError extends Error {
  constructor(attempts) {
    super(`Every content provider failed: ${attempts.map((a) => `${a.provider}/${a.model} (${a.reason}${a.status ? ` ${a.status}` : ""})`).join(", ")}`);
    this.name = "ModelChainError";
    this.attempts = attempts;
    // Worth stopping the whole run for only when every provider is out of quota or throttling us:
    // carrying on would just hit the same walls for every remaining article. Anything else may clear.
    const blocked = ["budget", "rate_limited", "model_unavailable"];
    const stopping = attempts.length > 0 && attempts.every((attempt) => blocked.includes(attempt.reason));
    this.exhausted = stopping && attempts.some((attempt) => attempt.reason === "budget");
    this.rateLimited = stopping && !this.exhausted && attempts.some((attempt) => attempt.reason === "rate_limited");
  }
}

const isBudgetRefusal = (error) => /exhausted|limit reached/i.test(String(error?.message));
const wait = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

/**
 * Try each (provider, model) in order until one returns valid JSON.
 *
 * Every attempt reserves its budget first, so a failed call still counts against
 * that provider's quota and fallback cannot multiply spending beyond the limits.
 * Calls to each provider are spaced by its minimum interval. The only repeat is a
 * single wait after a 429; anything else moves on to the next model.
 */
export async function generateJSON({ config, reserve, instruction, input, schema, fetchImpl = fetch, trace = [], sleep = wait, now = Date.now }) {
  const bytes = Buffer.byteLength(JSON.stringify({ instruction, input, schema }));
  if (bytes > MAX_INPUT_BYTES) throw new Error("Editorial input exceeds the bounded context");
  const attempts = [];

  for (const entry of config.chain) {
    const id = `${entry.name}/${entry.model}`;
    const record = (outcome) => {
      attempts.push({ provider: entry.name, model: entry.model, ...outcome });
      trace.push({ provider: entry.name, model: entry.model, ok: false, ...outcome });
    };
    if (config.unavailable.has(id)) { record({ reason: "model_unavailable" }); continue; }
    // UTF-8 bytes bound input tokens conservatively; reserve the full output allowance.
    const cost = ((bytes + 4096) * entry.inputPrice + config.maxOutputTokens * entry.outputPrice) / 1e6;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await reserve({ provider: entry.name, cost, dailyUsd: config.dailyUsd, calls: entry.calls });
      } catch (error) {
        // A database failure is not a quota answer: stop rather than call a provider unreserved.
        if (!isBudgetRefusal(error)) throw error;
        record({ reason: "budget" });
        break;
      }
      // Pace calls to each provider rather than bursting: bursts are what free tiers throttle first.
      const since = now() - (config.lastCall.get(entry.name) ?? -Infinity);
      if (since < entry.minIntervalMs) await sleep((entry.minIntervalMs - since) / 1000);
      config.lastCall.set(entry.name, now());
      try {
        const { json, usage } = await entry.provider.request({
          model: entry.model, key: entry.key, instruction, input, schema,
          maxOutputTokens: config.maxOutputTokens, options: entry.options, fetchImpl,
        });
        trace.push({ provider: entry.name, model: entry.model, ok: true, usage });
        return json;
      } catch (error) {
        // Anything other than a provider failure is a bug here, not a reason to fall back.
        if (!(error instanceof ProviderError)) throw error;
        // Wait once on a 429: for as long as the provider asks, or a default if it doesn't say.
        const delay = error.retryAfter ?? config.rateLimitWaitSeconds;
        if (attempt === 0 && error.reason === "rate_limited" && delay <= config.maxWaitSeconds) { await sleep(delay); continue; }
        if (error.reason === "model_unavailable") config.unavailable.add(id);
        record({ reason: error.reason, status: error.status });
        break;
      }
    }
  }
  throw new ModelChainError(attempts);
}

/**
 * For the `models` command: what each provider in CONTENT_PROVIDERS serves right now.
 *
 * Needs only the API key, not a model: the point is to help choose one. A
 * provider with a key but no model yet is still listed, with nothing preferred.
 */
export async function liveModels(env, fetchImpl = fetch) {
  const names = list(env.CONTENT_PROVIDERS ?? DEFAULT_CHAIN).map((name) => name.toLowerCase());
  const report = [];
  for (const name of names) {
    const provider = providers[name];
    if (!provider) { report.push({ provider: name, error: "unknown provider" }); continue; }
    const key = env[provider.keyVariable];
    const preferred = list(env[`CONTENT_${name.toUpperCase()}_MODEL`]);
    if (!key) { report.push({ provider: name, error: `set ${provider.keyVariable} to list its models` }); continue; }
    if (!provider.listModels) { report.push({ provider: name, preferred, note: "listing not supported" }); continue; }
    try {
      const live = await provider.listModels({ key, fetchImpl });
      report.push({
        provider: name,
        preferred: preferred.map((model) => ({ model, live: live.includes(model) })),
        ...(preferred.length ? {} : { note: `no model chosen yet: copy one or more IDs below into CONTENT_${name.toUpperCase()}_MODEL` }),
        available: live,
      });
    } catch (error) {
      report.push({ provider: name, preferred, error: error.message });
    }
  }
  return report;
}
