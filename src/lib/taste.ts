/** The engine's taste snapshot (scripts/content/taste.mjs `snapshotOf`), as the Map shows it. */
export interface Pause { by: "you" | "feed"; until: string | null }
export interface FieldTaste { field: string; mean: number; weight: number; targetDifficulty: number; paused: Pause | null }
export interface SubtopicTaste { key: string; field: string; name: string; mean: number; weight: number; paused: Pause | null }
export interface Niche { key: string; field: string; umbrella: string; name: string; mean: number }
export interface FeedMetrics { placed: number; hitRate: number | null; delightRate: number | null; explorations: number; explorationHitRate: number | null }
export interface TasteSnapshot { computedAt: string; exploreShare: number; metrics: FeedMetrics; niches: Niche[]; fields: FieldTaste[]; subtopics: SubtopicTaste[] }
export type Choice = "more" | "less" | "snooze";
export interface Preference { scope: "field" | "subtopic"; key: string; choice: Choice; until: string | null }

/** Same rule as the engine's cleanSubtopic + subtopicKey, so steers land on the subtopics the engine sees. */
export const subtopicKey = (field: string, name: string) =>
  `${field}::${name.replace(/\s+/g, " ").trim().replace(/[.。]+$/, "").trim().slice(0, 80).toLowerCase()}`;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const text = (v: unknown, max = 160) => (typeof v === "string" && v.length <= max ? v : null);
const pause = (v: unknown): Pause | null =>
  isObject(v) && (v.by === "you" || v.by === "feed") ? { by: v.by, until: text(v.until, 40) } : null;
const list = <T,>(v: unknown, each: (x: Record<string, unknown>) => T | null): T[] =>
  Array.isArray(v) ? v.slice(0, 500).flatMap((x) => { const y = isObject(x) ? each(x) : null; return y ? [y] : []; }) : [];

/** Validate the `taste_view` payload; anything malformed is dropped rather than trusted. */
export function coerceTaste(value: unknown): { snapshot: TasteSnapshot | null; preferences: Preference[] } {
  if (!isObject(value)) return { snapshot: null, preferences: [] };
  const preferences = list<Preference>(value.preferences, (p) => {
    const scope: Preference["scope"] | null = p.scope === "field" || p.scope === "subtopic" ? p.scope : null;
    const choice: Choice | null = p.choice === "more" || p.choice === "less" || p.choice === "snooze" ? p.choice : null;
    const key = text(p.key);
    return scope && choice && key ? { scope, key, choice, until: text(p.until, 40) } : null;
  });
  const s = value.snapshot;
  if (!isObject(s)) return { snapshot: null, preferences };
  const m = isObject(s.metrics) ? s.metrics : {};
  const snapshot: TasteSnapshot = {
    computedAt: text(s.computedAt, 40) ?? "",
    exploreShare: num(s.exploreShare) ?? 0.25,
    metrics: { placed: num(m.placed) ?? 0, hitRate: num(m.hitRate), delightRate: num(m.delightRate), explorations: num(m.explorations) ?? 0, explorationHitRate: num(m.explorationHitRate) },
    niches: list(s.niches, (n) => { const key = text(n.key), field = text(n.field, 60), umbrella = text(n.umbrella, 40), name = text(n.name, 100), mean = num(n.mean);
      return key && field && umbrella && name && mean !== null ? { key, field, umbrella, name, mean } : null; }),
    fields: list(s.fields, (f) => { const field = text(f.field, 60), mean = num(f.mean);
      return field && mean !== null ? { field, mean, weight: num(f.weight) ?? 0, targetDifficulty: num(f.targetDifficulty) ?? 2.5, paused: pause(f.paused) } : null; }),
    subtopics: list(s.subtopics, (t) => { const key = text(t.key), field = text(t.field, 60), name = text(t.name, 100), mean = num(t.mean);
      return key && field && name && mean !== null ? { key, field, name, mean, weight: num(t.weight) ?? 0, paused: pause(t.paused) } : null; }),
  };
  return { snapshot, preferences };
}
