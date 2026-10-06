import data from "@/data/levels.json";

/** The difficulty scale (SPEC §3), shared with the content engine (scripts/content/levels.mjs). */
export interface Level { level: number; name: string; assumes: string; does: string; example: string }
export const levels: Level[] = data.levels;
export const levelOf = (difficulty: number | undefined) => levels.find((l) => l.level === difficulty);
