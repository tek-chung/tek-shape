import { umbrellas, type Field, type Umbrella } from "@/lib/taxonomy";

/** One row of the `knowledge_map` RPC: reading in one subtopic. */
export interface MapRow {
  umbrella: string; field: string; subtopic: string;
  posts: number; read: number; deeper: number; saved: number;
  more: number; harder: number; uninteresting: number;
  depth: number; lastRead: string | null;
}

export interface Tally { posts: number; read: number; deeper: number; saved: number; more: number; harder: number; uninteresting: number; depth: number; lastRead: string | null }
export interface SubtopicNode extends Tally { name: string }
export interface FieldNode extends Tally { field: Field; subtopics: SubtopicNode[] }
export interface UmbrellaNode extends Tally { umbrella: Umbrella; fields: FieldNode[]; fieldsExplored: number }
export interface KnowledgeMap { umbrellas: UmbrellaNode[]; breadth: number; areas: number; maxDepth: number; deepest: UmbrellaNode | null; totalRead: number }

const empty = (): Tally => ({ posts: 0, read: 0, deeper: 0, saved: 0, more: 0, harder: 0, uninteresting: 0, depth: 0, lastRead: null });
const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

function add(into: Tally, from: Tally) {
  for (const key of ["posts", "read", "deeper", "saved", "more", "harder", "uninteresting", "depth"] as const) into[key] += from[key];
  if (from.lastRead && (!into.lastRead || from.lastRead > into.lastRead)) into.lastRead = from.lastRead;
}

/** Validate rows from the server: unknown shapes are dropped rather than trusted. */
export function coerceRows(value: unknown): MapRow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const r = row as Record<string, unknown>;
    if (typeof r.umbrella !== "string" || typeof r.field !== "string") return [];
    return [{ umbrella: r.umbrella, field: r.field, subtopic: typeof r.subtopic === "string" && r.subtopic.trim() ? r.subtopic.trim().slice(0, 100) : "General",
      posts: count(r.posts), read: count(r.read), deeper: count(r.deeper), saved: count(r.saved), more: count(r.more),
      harder: count(r.harder), uninteresting: count(r.uninteresting), depth: count(r.depth),
      lastRead: typeof r.lastRead === "string" && Number.isFinite(Date.parse(r.lastRead)) ? r.lastRead : null }];
  });
}

/**
 * Build the tree in the order of the subject map, so every umbrella and field appears, explored or not:
 * the gaps are the point of a breadth view. Breadth counts umbrellas (other than Other) with anything read.
 */
export function buildMap(rows: MapRow[]): KnowledgeMap {
  const tree: UmbrellaNode[] = umbrellas.map((umbrella) => ({
    umbrella, ...empty(), fieldsExplored: 0,
    fields: umbrella.fields.map((field) => ({ field, ...empty(), subtopics: [] })),
  }));
  const byField = new Map(tree.flatMap((u) => u.fields.map((f) => [f.field.id, { u, f }] as const)));
  for (const row of rows) {
    const home = byField.get(row.field) ?? byField.get("general")!;
    const tally: Tally = { posts: row.posts, read: row.read, deeper: row.deeper, saved: row.saved, more: row.more, harder: row.harder, uninteresting: row.uninteresting, depth: row.depth, lastRead: row.lastRead };
    home.f.subtopics.push({ name: row.subtopic, ...tally });
    add(home.f, tally);
    add(home.u, tally);
  }
  for (const u of tree) {
    u.fieldsExplored = u.fields.filter((f) => f.read > 0).length;
    for (const f of u.fields) f.subtopics.sort((a, b) => b.depth - a.depth || b.read - a.read || a.name.localeCompare(b.name));
  }
  // Other only shows once something lands there.
  const shown = tree.filter((u) => u.umbrella.id !== "other" || u.posts > 0);
  const counted = shown.filter((u) => u.umbrella.id !== "other");
  const deepest = counted.reduce<UmbrellaNode | null>((best, u) => (u.depth > (best?.depth ?? 0) ? u : best), null);
  return {
    umbrellas: shown,
    breadth: counted.filter((u) => u.read > 0).length,
    areas: counted.length,
    maxDepth: Math.max(1, ...shown.map((u) => u.depth)),
    deepest,
    totalRead: shown.reduce((sum, u) => sum + u.read, 0),
  };
}
