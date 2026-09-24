-- Phase 4b: the feed shows what you have not read; read and saved posts are listed separately.
-- Additive: reading_page is kept for older clients.
begin;

-- One post as the client expects it; shared by the feed and the lists.
create function public.post_json(p public.post) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'id',p.id,'topic',p.topic,'title',p.title,'explanation',p.explanation,'insight',p.insight,'deeper',p.deeper,
    'source',case when p.source_url is null then null else jsonb_build_object('label',p.source_label,'url',p.source_url) end,
    'publishedAt',p.published_at,'status',p.status,'contentType',p.content_type,'subtopic',p.subtopic,
    'difficulty',p.difficulty,'conceptIds',p.concept_ids,'eventDate',p.event_date,
    'sources',p.sources,'reviewedAt',p.reviewed_at,'articleDate',p.article_date)
$$;

/*
 * The feed in queue order, skipping posts read before p_read_before. The client passes the moment the
 * app was opened, so a post read in this sitting stays put under your thumb and is gone next time.
 * The cursor is the last post already held; it may itself be a read post.
 */
create function public.feed_page(p_after_id text default null, p_limit integer default 8, p_read_before timestamptz default now())
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare items jsonb; after_position bigint := 0;
begin
  if not public.is_allowed_reader() then raise exception 'Private account required' using errcode = '42501'; end if;
  if p_limit is null or p_limit < 1 or p_limit > 50 then raise exception 'Invalid page size'; end if;
  if p_read_before is null then raise exception 'Invalid read cutoff'; end if;
  if p_after_id is not null then
    select position into after_position from public.feed_queue where user_id = auth.uid() and post_id = p_after_id;
    if after_position is null then raise exception 'Unknown queue cursor'; end if;
  end if;
  select coalesce(jsonb_agg(page.row order by page.position),'[]'::jsonb) into items from (
    select q.position, public.post_json(p) as row
    from public.feed_queue q join public.post p on p.id = q.post_id
    where q.user_id = auth.uid() and q.position > after_position and p.status in ('sample','published')
      and not exists (select 1 from public.user_post_state s
        where s.user_id = auth.uid() and s.post_id = p.id and s.read_at < p_read_before)
    order by q.position limit p_limit
  ) page;
  return items;
end;
$$;

/* Saved ('bookmarked') or read ('read') posts, most recent first. Offset paging: these lists are short. */
create function public.saved_page(p_kind text, p_offset integer default 0, p_limit integer default 20)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare items jsonb;
begin
  if not public.is_allowed_reader() then raise exception 'Private account required' using errcode = '42501'; end if;
  if p_kind is null or p_kind not in ('bookmarked','read') then raise exception 'Invalid list'; end if;
  if p_limit is null or p_limit < 1 or p_limit > 50 or p_offset is null or p_offset < 0 or p_offset > 100000 then raise exception 'Invalid page'; end if;
  select coalesce(jsonb_agg(page.row order by page.n),'[]'::jsonb) into items from (
    select row_number() over (order by case when p_kind = 'read' then s.read_at else s.updated_at end desc, p.id) as n,
      public.post_json(p) as row
    from public.user_post_state s join public.post p on p.id = s.post_id
    where s.user_id = auth.uid() and p.status in ('sample','published')
      and case when p_kind = 'read' then s.read_at is not null else s.bookmarked end
    order by n offset p_offset limit p_limit
  ) page;
  return items;
end;
$$;

revoke all on function public.post_json(public.post), public.feed_page(text,integer,timestamptz),
  public.saved_page(text,integer,integer) from public, anon;
grant execute on function public.post_json(public.post), public.feed_page(text,integer,timestamptz),
  public.saved_page(text,integer,integer) to authenticated;

commit;
