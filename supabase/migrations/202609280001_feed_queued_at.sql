-- Phase 4e: what is new since your last visit. Each feed item says when it joined your feed, and
-- feed_summary counts the arrivals. Additive: feed_page is otherwise unchanged from 202609250001.
begin;

create or replace function public.feed_page(p_after_id text default null, p_limit integer default 8, p_read_before timestamptz default now())
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
    select q.position, public.post_json(p) || jsonb_build_object('queuedAt', q.queued_at) as row
    from public.feed_queue q join public.post p on p.id = q.post_id
    where q.user_id = auth.uid() and q.position > after_position and p.status in ('sample','published')
      and not exists (select 1 from public.user_post_state s
        where s.user_id = auth.uid() and s.post_id = p.id and s.read_at < p_read_before)
    order by q.position limit p_limit
  ) page;
  return items;
end;
$$;

/*
 * How many unread posts wait in the feed, and how many of them joined it after p_since (the reader's
 * previous visit), with the first such post, so the app can say "3 new posts" and jump to them without
 * loading the whole feed.
 */
create function public.feed_summary(p_read_before timestamptz, p_since timestamptz) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare result jsonb;
begin
  if not public.is_allowed_reader() then raise exception 'Private account required' using errcode = '42501'; end if;
  if p_read_before is null or p_since is null then raise exception 'Invalid window'; end if;
  with unread as (
    select q.post_id, q.position, q.queued_at
    from public.feed_queue q join public.post p on p.id = q.post_id
    where q.user_id = auth.uid() and p.status in ('sample','published')
      and not exists (select 1 from public.user_post_state s
        where s.user_id = auth.uid() and s.post_id = q.post_id and s.read_at < p_read_before)
  )
  select jsonb_build_object(
    'unread', (select count(*) from unread),
    'arrivals', (select count(*) from unread where queued_at > p_since),
    'firstArrival', (select post_id from unread where queued_at > p_since order by position limit 1))
  into result;
  return result;
end;
$$;
revoke all on function public.feed_summary(timestamptz, timestamptz) from public, anon;
grant execute on function public.feed_summary(timestamptz, timestamptz) to authenticated;

commit;
