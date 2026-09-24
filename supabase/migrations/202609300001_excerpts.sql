-- Phase 4g: excerpts and saved articles. Additive.
--   * An excerpt is a post made without AI, for sources whose terms rule AI out: the publisher's own words
--     (the opening of the article, its feed summary, or a page's first paragraph) and the link. It has no
--     insight or deeper explanation.
--   * Any post may keep the article body its feed carried, as plain text blocks, for reading in the app when
--     the site itself is behind a sign-in or subscription. Fetched one at a time (post_body), never with the
--     feed, so paging stays light.
begin;

alter table public.post
  add column kind text not null default 'post' check (kind in ('post','excerpt')),
  add column body jsonb check (body is null or (jsonb_typeof(body) = 'array'
    and jsonb_array_length(body) between 1 and 300 and octet_length(body::text) <= 150000));

-- An excerpt has no insight or deeper explanation; every other post still must.
alter table public.post alter column insight drop not null, alter column deeper drop not null;
alter table public.post drop constraint post_insight_check, drop constraint post_deeper_check;
alter table public.post
  add constraint post_insight_check check ((kind = 'excerpt') = (insight is null) and (insight is null or length(insight) between 1 and 400)),
  add constraint post_deeper_check check ((kind = 'excerpt') = (deeper is null) and (deeper is null or length(deeper) between 1 and 4000));

-- Publishing carries the kind and any saved article across from the candidate (otherwise as in 202609260001).
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
    umbrella,field,kind,body)
  values(c.id,p->>'topic',p->>'title',array(select jsonb_array_elements_text(p->'explanation')),
    p->>'insight',p->>'deeper','published',now(),p->>'contentType',p->>'subtopic',(p->>'difficulty')::integer,
    array(select jsonb_array_elements_text(p->'conceptIds')),nullif(p->>'eventDate','')::date,
    'source_checked',p->'sources',now(),p_note,(p->>'articleDate')::timestamptz,
    coalesce(nullif(p->>'umbrella',''),'other'),coalesce(nullif(p->>'field',''),'general'),
    coalesce(nullif(p->>'kind',''),'post'),case when jsonb_typeof(p->'body') = 'array' then p->'body' end);
  update public.content_candidate set status='published',reviewed_at=now(),review_note=p_note where id=p_id;
  return c.id;
end;
$$;
revoke all on function public.publish_candidate(text,text) from public, anon, authenticated;
grant execute on function public.publish_candidate(text,text) to service_role;

-- Posts say what kind they are and whether an article is saved with them; the article itself stays behind.
create or replace function public.post_json(p public.post) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'id',p.id,'topic',p.topic,'title',p.title,'explanation',p.explanation,'insight',p.insight,'deeper',p.deeper,
    'source',case when p.source_url is null then null else jsonb_build_object('label',p.source_label,'url',p.source_url) end,
    'publishedAt',p.published_at,'status',p.status,'contentType',p.content_type,'subtopic',p.subtopic,
    'difficulty',p.difficulty,'conceptIds',p.concept_ids,'eventDate',p.event_date,
    'sources',p.sources,'reviewedAt',p.reviewed_at,'articleDate',p.article_date,
    'umbrella',p.umbrella,'field',p.field,'kind',p.kind,'hasBody',p.body is not null)
$$;

/* The saved article for one post, for the reader to open. Null when none was saved. */
create function public.post_body(p_post_id text) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare result jsonb;
begin
  if not public.is_allowed_reader() then raise exception 'Private account required' using errcode = '42501'; end if;
  select p.body into result from public.post p where p.id = p_post_id and p.status in ('sample','published');
  return result;
end;
$$;
revoke all on function public.post_body(text) from public, anon;
grant execute on function public.post_body(text) to authenticated;

commit;
