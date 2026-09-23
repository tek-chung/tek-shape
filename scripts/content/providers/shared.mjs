/**
 * The contract every provider adapter implements:
 *
 *   request({ model, key, instruction, input, schema, maxOutputTokens, options, fetchImpl })
 *     -> Promise<{ json, usage: { input, output } }>
 *   listModels({ key, fetchImpl }) -> Promise<string[]>        (optional)
 *
 * Adapters throw ProviderError on any failure. The fallback chain in model.mjs
 * decides what happens next, so an adapter never retries on its own.
 */
export class ProviderError extends Error {
  constructor(message, { status = null, reason = "failed", code = null, retryAfter = null } = {}) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.reason = reason;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

const TIMEOUT_MS = 90_000;

// A retired or unknown model: skip it for the rest of the run rather than paying for it again.
const UNAVAILABLE = /model_not_found|model_decommissioned|decommissioned|not_found|unknown_model|invalid_model/i;

/**
 * The machine-readable code goes into the error message. The provider's own
 * message can quote the prompt, so it is kept separately as `detail` and only
 * the `probe` command — which sends synthetic input — ever prints it.
 */
async function errorBody(response) {
  let text = "";
  try {
    text = typeof response.text === "function" ? await response.text() : JSON.stringify(await response.json());
  } catch {
    return { code: null, detail: null };
  }
  try {
    const body = JSON.parse(text);
    const raw = body?.error?.code ?? body?.error?.type ?? body?.code ?? body?.type;
    const code = typeof raw === "string" && /^[A-Za-z0-9_.-]{1,60}$/.test(raw) ? raw : null;
    const message = body?.error?.message ?? body?.message ?? body?.detail;
    const detail = typeof message === "string" ? message.slice(0, 600) : message ? JSON.stringify(message).slice(0, 600) : text.slice(0, 600);
    return { code, detail };
  } catch {
    // Not JSON at all: typically a proxy, firewall or gateway page rather than the provider.
    const type = response.headers?.get?.("content-type") ?? "unknown type";
    const snippet = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
    return { code: null, detail: `non-JSON reply (${type}), so probably not from the provider itself: ${snippet || "empty body"}` };
  }
}

function retryAfterSeconds(response) {
  const raw = response.headers?.get?.("retry-after");
  // A missing header is null, and Number(null) is 0: without this guard, "no advice" read as "retry now".
  if (raw === null || raw === undefined || String(raw).trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

async function send(fetchImpl, url, init) {
  let response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (cause) {
    const error = new ProviderError("Provider unreachable", { reason: "network" });
    // Timeout, DNS failure, refused or reset connection: the probe shows which.
    Object.defineProperty(error, "detail", { value: String(cause?.cause?.code ?? cause?.name ?? cause?.message ?? cause).slice(0, 200), enumerable: false });
    throw error;
  }
  if (!response.ok) {
    const { code, detail } = await errorBody(response);
    // 403 covers "not available in your subscription tier" (Mistral code 1910): as good as absent for this
    // account, so skip that model for the run rather than paying a call on it for every article.
    const reason = response.status === 429 ? "rate_limited"
      : response.status === 404 || response.status === 403 || (code && UNAVAILABLE.test(code)) ? "model_unavailable"
      : response.status >= 500 ? "unavailable"
      : "rejected";
    const error = new ProviderError(`Provider returned HTTP ${response.status}${code ? ` (${code})` : ""}`, {
      status: response.status, reason, code, retryAfter: retryAfterSeconds(response),
    });
    // Not enumerable, so it cannot leak through JSON.stringify of the error, a trace or saved checks.
    Object.defineProperty(error, "detail", { value: detail, enumerable: false });
    throw error;
  }
  try {
    return await response.json();
  } catch {
    throw new ProviderError("Provider returned malformed JSON", { reason: "malformed" });
  }
}

export const postJSON = (fetchImpl, url, headers, body) =>
  send(fetchImpl, url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

export const getJSON = (fetchImpl, url, headers) => send(fetchImpl, url, { method: "GET", headers });

/**
 * Parse the model's text as JSON. Some reasoning models put their thinking in
 * <think> tags ahead of the answer; drop that rather than fail on it.
 */
export function parseModelJSON(text) {
  if (typeof text !== "string") throw new ProviderError("Provider returned no text", { reason: "empty" });
  // Some models wrap JSON in a Markdown fence even when a schema is enforced; unwrap rather than reject.
  const answer = text.replace(/^\s*<think>[\s\S]*?<\/think>/i, "").trim()
    .replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, "$1").trim();
  if (!answer) throw new ProviderError("Provider returned no text", { reason: "empty" });
  try {
    return JSON.parse(answer);
  } catch {
    throw new ProviderError("Provider returned text that is not valid JSON", { reason: "malformed" });
  }
}
