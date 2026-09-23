import { chatCompletions } from "./chat.mjs";

/**
 * Mistral, via chat completions with custom structured output.
 * https://docs.mistral.ai/studio/conversations/structured-output/custom
 */
export const mistral = chatCompletions({
  name: "mistral",
  keyVariable: "MISTRAL_API_KEY",
  baseUrl: "https://api.mistral.ai/v1",
});
