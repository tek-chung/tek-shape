import data from "@/data/taxonomy.json";

export interface Field { id: string; label: string }
export interface Umbrella { id: string; label: string; short: string; fields: Field[] }

/** The fixed subject map, shared with the content engine (scripts/content/taxonomy.mjs). */
export const umbrellas: Umbrella[] = data.umbrellas;

const fieldIndex = new Map<string, { umbrella: Umbrella; field: Field }>();
for (const umbrella of umbrellas) for (const field of umbrella.fields) fieldIndex.set(field.id, { umbrella, field });

export const placeOf = (fieldId: string | undefined) => (fieldId ? fieldIndex.get(fieldId) : undefined);
