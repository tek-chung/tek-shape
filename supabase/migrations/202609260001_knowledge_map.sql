-- Phase 4c: a fixed subject map (umbrella → field → free-text subtopic) and the knowledge map over it.
-- Additive. Existing posts start as other/general until `npm run content -- classify` files them.
begin;

alter table public.post
  add column umbrella text not null default 'other' check (umbrella ~ '^[a-z0-9-]{1,40}$'),
  add column field text not null default 'general' check (field ~ '^[a-z0-9-]{1,60}$');
create index post_field on public.post(field);

-- Publishing now carries the subject map across from the candidate.
create or replace function public.publish_candidate(p_id text, p_note text) returns text
language plpgsql security invoker set search_path = '' as $$
declare c public.content_candidate; p jsonb;
begin
  if p_note is null or length(trim(p_note)) < 10 then raise exception 'Editorial review note required'; end if;
  select * into c from public.content_candidate where id=p_id for update;
  if not found or c.status <> 'checked' or c.checks->'passed' is distinct from 'true'::jsonb then raise exception 'Candidate has not passed checks'; end if;
  p := c.payload;
  if c.created_at < now() - interval '7 days' then raise exception 'Candidate needs a fresh review'; end if;
  if p->>'contentType' = 'news' and ((p->>'articleDate') is null
    or (p->>'articleDate')::timestamptz < now() - interval '14 days'
    or (p->>'articleDate')::timestamptz > now()) then raise exception 'News needs a fresh review'; end if;
  insert into public.post(id,topic,title,explanation,insight,deeper,status,published_at,
    content_type,subtopic,difficulty,concept_ids,event_date,verification_status,sources,reviewed_at,editorial_note,article_date,
    umbrella,field)
  values(c.id,p->>'topic',p->>'title',array(select jsonb_array_elements_text(p->'explanation')),
    p->>'insight',p->>'deeper','published',now(),p->>'contentType',p->>'subtopic',(p->>'difficulty')::integer,
    array(select jsonb_array_elements_text(p->'conceptIds')),nullif(p->>'eventDate','')::date,
    'source_checked',p->'sources',now(),p_note,(p->>'articleDate')::timestamptz,
    coalesce(nullif(p->>'umbrella',''),'other'),coalesce(nullif(p->>'field',''),'general'));
  update public.content_candidate set status='published',reviewed_at=now(),review_note=p_note where id=p_id;
  return c.id;
end;
$$;
revoke all on function public.publish_candidate(text,text) from public, anon, authenticated;
grant execute on function public.publish_candidate(text,text) to service_role;

create or replace function public.post_json(p public.post) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'id',p.id,'topic',p.topic,'title',p.title,'explanation',p.explanation,'insight',p.insight,'deeper',p.deeper,
    'source',case when p.source_url is null then null else jsonb_build_object('label',p.source_label,'url',p.source_url) end,
    'publishedAt',p.published_at,'status',p.status,'contentType',p.content_type,'subtopic',p.subtopic,
    'difficulty',p.difficulty,'conceptIds',p.concept_ids,'eventDate',p.event_date,
    'sources',p.sources,'reviewedAt',p.reviewed_at,'articleDate',p.article_date,
    'umbrella',p.umbrella,'field',p.field)
$$;

/*
 * The reader's knowledge map: one row per (umbrella, field, subtopic) among posts in their feed, counting
 * what was read, gone deeper on, saved and rated. Grouping subtopics case-insensitively keeps "Prime gaps"
 * and "Prime Gaps" together. The client builds the tree and the T-shape from these rows.
 */
create function public.knowledge_map() returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare rows jsonb;
begin
  if not public.is_allowed_reader() then raise exception 'Private account required' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'umbrella', g.umbrella, 'field', g.field, 'subtopic', g.subtopic,
    'posts', g.posts, 'read', g.read, 'deeper', g.deeper, 'saved', g.saved,
    'more', g.more, 'harder', g.harder, 'uninteresting', g.uninteresting,
    'depth', g.depth, 'lastRead', g.last_read) order by g.umbrella, g.field, g.subtopic), '[]'::jsonb)
  into rows from (
    select p.umbrella, p.field, min(p.subtopic) as subtopic,
      count(*) as posts,
      count(s.read_at) as read,
      count(s.deeper_opened_at) as deeper,
      count(*) filter (where s.bookmarked) as saved,
      count(*) filter (where s.rating = 'more') as more,
      count(*) filter (where s.rating = 'harder') as harder,
      count(*) filter (where s.rating = 'uninteresting') as uninteresting,
      -- Depth: each read post counts its difficulty (1–5), plus one more if you opened the deeper explanation.
      coalesce(sum(p.difficulty + case when s.deeper_opened_at is not null then 1 else 0 end) filter (where s.read_at is not null), 0) as depth,
      max(s.read_at) as last_read
    from public.feed_queue q
    join public.post p on p.id = q.post_id and p.status in ('sample','published')
    left join public.user_post_state s on s.user_id = q.user_id and s.post_id = p.id
    where q.user_id = auth.uid()
    group by p.umbrella, p.field, lower(p.subtopic)
  ) g;
  return rows;
end;
$$;
revoke all on function public.knowledge_map() from public, anon;
grant execute on function public.knowledge_map() to authenticated;

commit;
