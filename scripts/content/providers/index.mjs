import { gemini } from "./gemini.mjs";
import { groq } from "./groq.mjs";
import { mistral } from "./mistral.mjs";
import { openai } from "./openai.mjs";
import { openrouter } from "./openrouter.mjs";

/**
 * Every provider the content engine can use. To add one, write an adapter that
 * implements the contract in shared.mjs — or, for an OpenAI-compatible API,
 * call chatCompletions() in chat.mjs — and register it here. Nothing else in
 * the engine needs to change.
 *
 * Default chain: mistral, then openrouter. groq, gemini and openai stay available by configuration
 * (Gemini's free tier is not offered to UK users; Groq's console was unreachable from the owner's network).
 */
export const providers = { mistral, openrouter, groq, gemini, openai };
