import { ProviderError, parseModelJSON, postJSON } from "./shared.mjs";

/**
 * OpenAI, via the Responses API with strict structured output.
 * Not in the default chain; kept so a paid provider can be swapped in by config alone.
 */
export const openai = {
  name: "openai",
  keyVariable: "OPENAI_API_KEY",

  async request({ model, key, instruction, input, schema, maxOutputTokens, fetchImpl = fetch }) {
    const result = await postJSON(
      fetchImpl,
      "https://api.openai.com/v1/responses",
      { Authorization: `Bearer ${key}` },
      {
        model,
        store: false,
        max_output_tokens: maxOutputTokens,
        instructions: instruction,
        input: JSON.stringify(input),
        text: { format: { type: "json_schema", name: "editorial_result", strict: true, schema } },
      },
    );
    if (result?.status !== "completed") {
      throw new ProviderError(`OpenAI response ended as ${result?.status ?? "unknown"}`, { reason: "incomplete" });
    }
    const parts = (result.output ?? []).flatMap((item) => item?.content ?? []);
    if (parts.some((part) => part?.type === "refusal")) throw new ProviderError("OpenAI declined the task", { reason: "refused" });
    const texts = parts.filter((part) => part?.type === "output_text");
    if (texts.length !== 1) throw new ProviderError("OpenAI returned an unexpected result", { reason: "malformed" });
    return {
      json: parseModelJSON(texts[0].text),
      usage: { input: result.usage?.input_tokens ?? 0, output: result.usage?.output_tokens ?? 0 },
    };
  },
};
