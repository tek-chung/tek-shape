import { ProviderError, getJSON, parseModelJSON, postJSON } from "./shared.mjs";

/**
 * An adapter for any OpenAI-compatible chat completions API with JSON-schema
 * output. Groq and Mistral both use it; OpenRouter, Cerebras, Together and
 * similar can too, with one registry line each.
 */
export function chatCompletions({ name, keyVariable, baseUrl, maxTokensField = "max_tokens", temperature = 0.2, extraBody = {}, listFilter = () => true }) {
  const auth = (key) => ({ Authorization: `Bearer ${key}` });
  return {
    name,
    keyVariable,

    async request({ model, key, instruction, input, schema, maxOutputTokens, options = {}, fetchImpl = fetch }) {
      const body = {
        model,
        messages: [
          { role: "system", content: instruction },
          { role: "user", content: JSON.stringify(input) },
        ],
        response_format: { type: "json_schema", json_schema: { name: "editorial_result", schema, strict: true } },
        [maxTokensField]: maxOutputTokens,
        temperature,
        ...extraBody,
      };
      // Model-specific knobs are sent only when configured, since other models reject them.
      if (options.reasoningEffort) body.reasoning_effort = options.reasoningEffort;

      const result = await postJSON(fetchImpl, `${baseUrl}/chat/completions`, auth(key), body);
      const choice = result?.choices?.[0];
      // `length` means the answer was truncated at the token limit.
      if (choice?.finish_reason !== "stop") {
        throw new ProviderError(`${name} completion ended as ${choice?.finish_reason ?? "unknown"}`, { reason: "incomplete" });
      }
      return {
        json: parseModelJSON(choice.message?.content),
        usage: { input: result.usage?.prompt_tokens ?? 0, output: result.usage?.completion_tokens ?? 0 },
      };
    },

    async listModels({ key, fetchImpl = fetch }) {
      const result = await getJSON(fetchImpl, `${baseUrl}/models`, auth(key));
      return (result?.data ?? []).map((model) => model?.id).filter((id) => typeof id === "string" && listFilter(id)).sort();
    },
  };
}
