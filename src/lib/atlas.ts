import type { KnowledgeMap } from "@/lib/knowledgeMap";

/** One Atlas tile: a field to discover, with how much is waiting there. */
export interface Tile { field: string; label: string; area: string; waiting: number; read: number; niche: boolean }

/**
 * The Atlas (after Instagram's Explore grid): fields with posts waiting that you have barely read, unexplored
 * ones first, plus the niches the feed has noticed you enjoy. At most `limit` tiles; never Other.
 */
export function atlasTiles(map: KnowledgeMap, niches: { field: string }[] = [], limit = 12): Tile[] {
  const nicheFields = new Set(niches.map((n) => n.field));
  const tiles: Tile[] = [];
  for (const u of map.umbrellas) {
    if (u.umbrella.id === "other") continue;
    for (const f of u.fields) {
      const waiting = Math.max(0, f.posts - f.read);
      const niche = nicheFields.has(f.field.id);
      if (!waiting || (f.read > 2 && !niche)) continue;
      tiles.push({ field: f.field.id, label: f.field.label, area: u.umbrella.short, waiting, read: f.read, niche });
    }
  }
  // Unexplored first, then niches, then the least read; more waiting breaks ties.
  tiles.sort((a, b) => Number(b.read === 0) - Number(a.read === 0) || Number(b.niche) - Number(a.niche) || a.read - b.read || b.waiting - a.waiting || a.label.localeCompare(b.label));
  return tiles.slice(0, limit);
}
