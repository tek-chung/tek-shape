/**
 * Posts read straight from the `post` table (which the reader may select), in the shape `post_json` gives the
 * feed, so `coercePost` validates them the same way. Used by Latest and the Briefing ring.
 */
export const POST_COLUMNS = "id,topic,title,explanation,insight,deeper,source_label,source_url,published_at,status,content_type,subtopic,difficulty,concept_ids,event_date,sources,reviewed_at,article_date,umbrella,field,kind,first_block:body->0";
export type Row = Record<string, unknown>;
export const asPostJson = (r: Row) => ({
  id: r.id, topic: r.topic, title: r.title, explanation: r.explanation, insight: r.insight ?? "", deeper: r.deeper ?? "",
  source: r.source_url ? { label: r.source_label, url: r.source_url } : null, publishedAt: r.published_at, status: r.status,
  contentType: r.content_type, subtopic: r.subtopic, difficulty: r.difficulty, conceptIds: r.concept_ids, eventDate: r.event_date,
  sources: r.sources, reviewedAt: r.reviewed_at, articleDate: r.article_date, umbrella: r.umbrella, field: r.field, kind: r.kind,
  hasBody: r.first_block !== null && r.first_block !== undefined,
});
