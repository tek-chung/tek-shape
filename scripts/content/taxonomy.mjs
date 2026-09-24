import { readFileSync } from "node:fs";

/**
 * The fixed subject map shared with the app (src/data/taxonomy.json): umbrellas → fields. Each post is filed
 * under exactly one field; its subtopic is free text within that field. Field IDs are unique across
 * umbrellas, so a field alone identifies where a post sits.
 */
export const taxonomy = JSON.parse(readFileSync(new URL("../../src/data/taxonomy.json", import.meta.url), "utf8"));

const byField = new Map();
for (const umbrella of taxonomy.umbrellas) {
  for (const field of umbrella.fields) byField.set(field.id, { umbrella: umbrella.id, umbrellaLabel: umbrella.label, field: field.id, fieldLabel: field.label });
}
export const FIELD_IDS = [...byField.keys()];
export const placeOf = (fieldId) => byField.get(fieldId) ?? byField.get("general");

/** Compact enough for every prompt: one line per umbrella, field IDs only. */
export const TAXONOMY_PROMPT = taxonomy.umbrellas
  .map((umbrella) => `${umbrella.label}: ${umbrella.fields.map((field) => field.id).join(", ")}`)
  .join("\n");

/** Subtopics are free text; normalise so "Prime gaps", "prime  gaps" and "Prime Gaps." group together. */
export const cleanSubtopic = (value) => (typeof value === "string" ? value : "")
  .replace(/\s+/g, " ").trim().replace(/[.。]+$/, "").trim().slice(0, 80);
