import { chatCompletions } from "./chat.mjs";

/**
 * Groq, OpenAI-compatible. Free plan, per model: ~1,000 requests and 200K tokens a
 * day, but only ~8K tokens a minute — which is why requests are kept small.
 * https://console.groq.com/docs/structured-outputs
 */
export const groq = chatCompletions({
  name: "groq",
  keyVariable: "GROQ_API_KEY",
  baseUrl: "https://api.groq.com/openai/v1",
  maxTokensField: "max_completion_tokens",
});
