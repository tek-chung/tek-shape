import { readFileSync } from "node:fs";

/**
 * The difficulty scale (src/data/levels.json, shared with the app; SPEC §3). One definition, so every model
 * that drafts or regrades a post means the same thing by "level 3", and the reader sees the same names.
 */
export const levels = JSON.parse(readFileSync(new URL("../../src/data/levels.json", import.meta.url), "utf8"));
export const LEVEL_SCALE = levels.version;

/** For prompts: one line per level. */
export const LEVELS_PROMPT = `Difficulty is an integer 1 to 5 for ${levels.reader}:\n` + levels.levels
  .map((l) => `${l.level} ${l.name}: assumes ${l.assumes}; ${l.does} (e.g. ${l.example}).`).join("\n");

/**
 * A level that disagrees with the prerequisites a draft lists: worth a look in `review`, never a reason to
 * hold the post. Specialist and frontier posts should say what they assume; orientation posts should not
 * need a list of prerequisites.
 */
export function levelWarnings(draft) {
  const n = Array.isArray(draft?.assumes) ? draft.assumes.length : 0;
  const d = draft?.difficulty;
  if (d >= 4 && n === 0) return [`Level ${d} names no prerequisites`];
  if (d <= 1 && n >= 2) return [`Level ${d} lists ${n} prerequisites`];
  return [];
}
