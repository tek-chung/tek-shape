-- Phase 4h: the feed refills itself. Each run the engine tops the feed up to its target and also ranks the
-- next posts waiting (the reserve). When the reader reaches the end of the feed, the app draws from the
-- reserve at once, in the engine's order, instead of waiting up to three hours for the next run. Additive.
begin;

create table public.feed_reserve (
  user_id uuid not null references auth.users(id) on delete cascade,
  post_id text not null references public.post(id) on delete cascade,
  rank integer not null check (rank >= 1),
  slot text not null default 'favourite' check (slot in ('favourite','explore','stretch')),
  ranked_at timestamptz not null default now(),
  primary key (user_id, post_id)
);
create index feed_reserve_order on public.feed_reserve(user_id, rank);
-- Written by the engine only; the reader reaches it solely through feed_top_up.
alter table public.feed_reserve enable row level security;
revoke all on public.feed_reserve from anon, authenticated;
grant all on public.feed_reserve to service_role;

/*
 * Move up to p_count posts from the reader's reserve into their feed, best first, and return how many moved.
 * Security definer, because the reader cannot otherwise write to the feed; it acts only on the caller's own
 * rows, only on published and checked posts not already in the feed, and takes the same lock as append_feed
 * so positions never collide with a run appending at the same moment.
 */
create function public.feed_top_up(p_count integer) returns integer
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
    select fr.post_id, fr.slot from public.feed_reserve fr join public.post p on p.id = fr.post_id
    where fr.user_id = uid and p.status = 'published' and p.verification_status = 'source_checked'
      and not exists (select 1 from public.feed_queue q where q.user_id = uid and q.post_id = fr.post_id)
    order by fr.rank limit p_count
  loop
    next_position := next_position + 1;
    insert into public.feed_queue(user_id, post_id, position, slot) values (uid, r.post_id, next_position, r.slot);
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
