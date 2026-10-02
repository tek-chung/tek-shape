/**
 * "Why this post?": the engine's stored reasons for a placement (feed_queue.reasons, written by
 * scripts/content/taste.mjs), in plain words. Untrusted input: anything unexpected is ignored. `names` turns a
 * field ID into its field and area labels (the subject map), passed in so this stays free of imports.
 */
export type Names = (fieldId: string) => { field: string; area: string } | undefined;
type Reasons = Record<string, unknown>;

const isObject = (v: unknown): v is Reasons => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function explainPlacement(value: unknown, names: Names = () => undefined): string[] {
  if (!isObject(value)) return ["Placed before the feed recorded its reasons."];
  const place = typeof value.field === "string" ? names(value.field) : undefined;
  const field = place?.field ?? "this field";
  const area = place?.area ?? "this area";
  const lines: string[] = [];
  switch (value.why) {
    case "next-step": lines.push(`The next step in ${field}, one of your deep fields: it builds on ideas you already know.`); break;
    case "stem": lines.push(`From your stem: ${field} is one of your deep fields.`); break;
    case "harder": lines.push(`Harder than usual in ${field}, as you asked.`); break;
    case "breadth": lines.push(`Breadth: ${area} has not appeared in your recent reading.`); break;
    case "thin-area": lines.push(`Breadth: you have read little in ${area} so far.`); break;
    case "bar": lines.push(`Breadth beyond your stem, in ${area}.`); break;
    case "bridge": lines.push(`A bridge: it shares an idea you enjoyed, in a field you rarely read.`); break;
    case "trusted": lines.push("From one of the sources you enjoy most."); break;
    case "fresh": lines.push("Recent news."); break;
    case "excerpt": lines.push("From a source you asked for by name, in its own words."); break;
    case "uncertain": lines.push(`Exploring: the feed is not yet sure whether you will enjoy ${field}.`); break;
    case "favourite": lines.push(`Close to what you enjoy in ${field}.`); break;
    default: lines.push(`Close to what you enjoy in ${field}.`);
  }
  if (value.steer === "more" || value.steer === "stem") lines.push("You asked for more of this.");
  if (value.steer === "less") lines.push("You asked for less of this, so it is shown more rarely.");
  if (value.reteach === true) lines.push("It covers ideas you know, so it was scored down; it came through on its other merits.");
  const fatigue = num(value.fatigue);
  if (fatigue !== null && fatigue < 1) lines.push("Shown less often since a recent Not interesting on a similar subject.");
  const difficulty = num(value.difficulty), target = num(value.target);
  if (difficulty !== null && target !== null && Math.abs(difficulty - target) >= 1)
    lines.push(difficulty > target ? `Pitched above your usual level here (${difficulty} of 5).` : `Pitched below your usual level here (${difficulty} of 5).`);
  return lines;
}
