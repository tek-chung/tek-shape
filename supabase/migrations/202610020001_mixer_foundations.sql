-- T-Mixer phase 0: foundations for the redesigned recommender. Additive; apply after 202610010001.
--   1. The engine looks up the sources it has already drafted instead of loading every draft ever made,
--      which would have stopped it at 20,000 candidates (about three months of drafting).
--   2. Each post can carry the reading time spent on it (dwell), the strongest implicit signal X and
--      Instagram use, and the one T lacked.
--   3. Every placement in the feed or the reserve records why it was made and by which ranker, so the feed
--      can explain itself later and rankers can be compared on what they actually placed.
begin;

-- 1. Drafted sources, looked up rather than loaded whole ------------------------------------------------

alter table public.content_candidate
  add column source_url text generated always as (evidence->0->>'url') stored,
  add column source_publisher text generated always as (evidence->0->>'publisher') stored;
create index content_candidate_source_url on public.content_candidate(source_url);
create index content_candidate_publisher_time on public.content_candidate(source_publisher, created_at desc);

/*
 * Which of these source URLs need no new draft: drafted already, unless the draft was held before
 * p_retry_before (held drafts are retried once they are old enough, as before).
 */
create function public.drafted_sources(p_urls text[], p_retry_before timestamptz) returns table(url text)
language plpgsql stable security invoker set search_path = '' as $$
begin
  if p_urls is null or cardinality(p_urls) > 5000 then raise exception 'Invalid source list'; end if;
  return query select distinct c.source_url from public.content_candidate c
    where c.source_url = any(p_urls) and (c.status <> 'held' or p_retry_before is null or c.created_at > p_retry_before);
end;
$$;

-- When each publisher (as credited on the candidate) was last drafted: one row per publisher.
create function public.drafted_publishers() returns table(publisher text, last_drafted timestamptz)
language sql stable security invoker set search_path = '' as $$
  select c.source_publisher, max(c.created_at) from public.content_candidate c
  where c.source_publisher is not null group by c.source_publisher;
$$;

-- Candidate counts for `status`: by status, and excerpts saved per publisher.
create function public.candidate_summary() returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'byStatus', coalesce((select jsonb_object_agg(s.status, s.n) from
      (select c.status, count(*) n from public.content_candidate c group by c.status) s), '{}'::jsonb),
    'excerpts', coalesce((select jsonb_object_agg(e.publisher, e.n) from
      (select coalesce(c.source_publisher, '?') publisher, count(*) n from public.content_candidate c
       where c.payload->>'kind' = 'excerpt' group by 1) e), '{}'::jsonb));
$$;

revoke all on function public.drafted_sources(text[], timestamptz), public.drafted_publishers(), public.candidate_summary()
  from public, anon, authenticated;
grant execute on function public.drafted_sources(text[], timestamptz), public.drafted_publishers(), public.candidate_summary()
  to service_role;

-- 2. Reading time -----------------------------------------------------------------------------------------

alter table public.user_post_state
  add column dwell_ms bigint not null default 0 check (dwell_ms between 0 and 86400000);

/*
 * As in 202609290001, plus `dwell`: milliseconds the post was in view, 1 to 600,000 per report, added to
 * the total (capped at a day). Dwell alone is not reading, and does not count as a change to the post, so
 * it leaves updated_at alone: the taste model dates evidence by it and the Library is ordered by it.
 */
create or replace function public.save_post(p_post_id text, p_patch jsonb) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if jsonb_typeof(p_patch) <> 'object' or p_patch - array['rating','bookmarked','expanded','seen','read','opened','dwell'] <> '{}'::jsonb then
    raise exception 'Invalid post patch';
  end if;
  if (p_patch ? 'bookmarked' and jsonb_typeof(p_patch->'bookmarked') <> 'boolean')
    or (p_patch ? 'expanded' and jsonb_typeof(p_patch->'expanded') <> 'boolean')
    or (p_patch ? 'seen' and p_patch->'seen' <> 'true'::jsonb)
    or (p_patch ? 'read' and p_patch->'read' <> 'true'::jsonb)
    or (p_patch ? 'opened' and p_patch->'opened' <> 'true'::jsonb)
    or (p_patch ? 'dwell' and case when jsonb_typeof(p_patch->'dwell') = 'number'
          then (p_patch->>'dwell')::numeric % 1 <> 0 or (p_patch->>'dwell')::numeric not between 1 and 600000
          else true end)
    or (p_patch ? 'rating' and p_patch->'rating' <> 'null'::jsonb
        and (jsonb_typeof(p_patch->'rating') <> 'string'
             or p_patch->>'rating' not in ('more','uninteresting','harder')))
    then raise exception 'Invalid state value'; end if;
  insert into public.user_post_state(user_id,post_id) values(auth.uid(),p_post_id) on conflict do nothing;
  update public.user_post_state set
    rating = case when p_patch ? 'rating' then p_patch->>'rating' else rating end,
    bookmarked = case when p_patch ? 'bookmarked' then (p_patch->>'bookmarked')::boolean else bookmarked end,
    expanded = case when p_patch ? 'expanded' then (p_patch->>'expanded')::boolean else expanded end,
    first_seen_at = case when p_patch ? 'seen' then coalesce(first_seen_at,now()) else first_seen_at end,
    read_at = case when p_patch ?| array['read','rating','bookmarked','expanded','opened'] then coalesce(read_at,now()) else read_at end,
    opened_at = case when p_patch ? 'opened' then coalesce(opened_at,now()) else opened_at end,
    deeper_opened_at = case when p_patch->>'expanded' = 'true' then coalesce(deeper_opened_at,now()) else deeper_opened_at end,
    dwell_ms = case when p_patch ? 'dwell' then least(86400000, dwell_ms + (p_patch->>'dwell')::bigint) else dwell_ms end,
    updated_at = case when p_patch ? 'dwell' and p_patch - 'dwell' = '{}'::jsonb then updated_at else now() end
  where user_id = auth.uid() and post_id = p_post_id;
end;
$$;

-- 3. Why each post was placed -----------------------------------------------------------------------------

alter table public.feed_queue
  add column reasons jsonb check (reasons is null or (jsonb_typeof(reasons) = 'object' and length(reasons::text) <= 2000)),
  add column ranker text check (ranker is null or length(ranker) between 1 and 40);
alter table public.feed_reserve
  add column reasons jsonb check (reasons is null or (jsonb_typeof(reasons) = 'object' and length(reasons::text) <= 2000)),
  add column ranker text check (ranker is null or length(ranker) between 1 and 40);

-- As in 202610010001, carrying the reasons and ranker from the reserve into the feed.
create or replace function public.feed_top_up(p_count integer) returns integer
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); next_position bigint; moved integer := 0; r record;
begin
  if uid is null or not exists (select 1 from public.allowed_reader a where a.user_id = uid) then
    raise exception 'Private account required' using errcode = '42501';
  end if;
  if p_count is null or p_count < 1 or p_count > 30 then raise exception 'Invalid count'; end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text, 0));
  select coalesce(max(position), 0) into next_position from public.feed_queue where user_id = uid;
  for r in
    select fr.post_id, fr.slot, fr.reasons, fr.ranker from public.feed_reserve fr join public.post p on p.id = fr.post_id
    where fr.user_id = uid and p.status = 'published' and p.verification_status = 'source_checked'
      and not exists (select 1 from public.feed_queue q where q.user_id = uid and q.post_id = fr.post_id)
    order by fr.rank limit p_count
  loop
    next_position := next_position + 1;
    insert into public.feed_queue(user_id, post_id, position, slot, reasons, ranker)
      values (uid, r.post_id, next_position, r.slot, r.reasons, r.ranker);
    moved := moved + 1;
  end loop;
  delete from public.feed_reserve fr where fr.user_id = uid
    and exists (select 1 from public.feed_queue q where q.user_id = uid and q.post_id = fr.post_id);
  return moved;
end;
$$;
revoke all on function public.feed_top_up(integer) from public, anon;
grant execute on function public.feed_top_up(integer) to authenticated;

commit;
