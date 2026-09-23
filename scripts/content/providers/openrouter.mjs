import { chatCompletions } from "./chat.mjs";

/**
 * OpenRouter, OpenAI-compatible, fronting many hosts. Free models end in ":free".
 * Free allowance is account-wide: ~50 requests a day (1,000 after a one-off credit
 * purchase), so it suits a fallback rather than the primary.
 * https://openrouter.ai/docs
 */
export const openrouter = chatCompletions({
  name: "openrouter",
  keyVariable: "OPENROUTER_API_KEY",
  baseUrl: "https://openrouter.ai/api/v1",
  // Route only to hosts that honour every parameter sent, so the JSON schema is never silently dropped.
  extraBody: { provider: { require_parameters: true } },
  // `models` lists only what costs nothing.
  listFilter: (id) => id.endsWith(":free"),
});
