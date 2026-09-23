import { ProviderError, parseModelJSON, postJSON } from "./shared.mjs";

/**
 * Google Gemini, via the Interactions API.
 * https://ai.google.dev/api/interactions-api
 */
export const gemini = {
  name: "gemini",
  keyVariable: "GEMINI_API_KEY",

  async request({ model, key, instruction, input, schema, maxOutputTokens, fetchImpl = fetch }) {
    const result = await postJSON(
      fetchImpl,
      "https://generativelanguage.googleapis.com/v1beta/interactions",
      { "x-goog-api-key": key },
      {
        model,
        system_instruction: instruction,
        input: JSON.stringify(input),
        response_format: { type: "text", mime_type: "application/json", schema },
        generation_config: { max_output_tokens: maxOutputTokens },
        // Do not keep source text or drafts on the provider side.
        store: false,
      },
    );
    // `incomplete` means the answer was cut short, e.g. by the token limit.
    if (result?.status !== "completed") {
      throw new ProviderError(`Gemini interaction ended as ${result?.status ?? "unknown"}`, { reason: "incomplete" });
    }
    const text = (result.steps ?? [])
      .filter((step) => step?.type === "model_output")
      .flatMap((step) => step.content ?? [])
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
    return {
      json: parseModelJSON(text),
      usage: { input: result.usage?.total_input_tokens ?? 0, output: result.usage?.total_output_tokens ?? 0 },
    };
  },
};
