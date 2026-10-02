-- T-Mixer phase 5b: the Briefing ring and Echo cards (SPEC §2, amended 6 Oct 2026). Additive; apply after
-- 202610050001.
--   * briefing: today's news, chosen and ordered by the engine each run (one post per story), shown as rings
--     above the feed and gone after a day. Posts in it are kept out of the feed meanwhile.
--   * Echo cards: an insight the reader valued, brought back after about 2, 7, 21 and 60 days with the insight
--     hidden until tapped. The reader says whether they remembered it; remembering moves it to the next
--     interval, forgetting repeats the current one two days later. No scores, no streaks.
begin;

create table public.briefing (
  user_id uuid not null references auth.users(id) on delete cascade,
  post_id text not null references public.post(id) on delete cascade,
  rank integer not null check (rank between 1 and 10),
  prepared_at timestamptz not null default now(),
  primary key (user_id, post_id)
);
alter table public.briefing enable row level security;
revoke all on public.briefing from anon, authenticated;
grant select on public.briefing to authenticated;
grant all on public.briefing to service_role;
create policy own_briefing on public.briefing for select to authenticated
  using (user_id = (select auth.uid()) and public.is_allowed_reader());

create table public.echo_answer (
  user_id uuid not null references auth.users(id) on delete cascade,
  post_id text not null references public.post(id) on delete cascade,
  stage smallint not null check (stage between 0 and 3),
  remembered boolean not null,
  answered_at timestamptz not null default now()
);
create index echo_answer_post on public.echo_answer(user_id, post_id, answered_at desc);
alter table public.echo_answer enable row level security;
revoke all on public.echo_answer from anon, authenticated;
grant select on public.echo_answer to authenticated;
grant select on public.echo_answer to service_role;
create policy own_echoes on public.echo_answer for select to authenticated
  using (user_id = (select auth.uid()) and public.is_allowed_reader());

/*
 * Where each valued post stands: how many times it has been remembered (its stage, 0–4) and when it is next
 * due. Valued: read, not rated Not interesting, and saved, rated More or Harder, or its deeper explanation
 * opened; full posts only (an excerpt has no insight to recall).
 */
create function public.echo_schedule(p_user uuid)
returns table(post_id text, stage integer, due_at timestamptz)
language sql stable security invoker set search_path = '' as $$
  with valued as (
    select s.post_id, s.read_at from public.user_post_state s join public.post p on p.id = s.post_id
    where s.user_id = p_user and s.read_at is not null and s.rating is distinct from 'uninteresting'
      and (s.bookmarked or s.rating in ('more','harder') or s.deeper_opened_at is not null)
      and p.status in ('sample','published') and p.kind = 'post'
  ), answers as (
    select a.post_id, count(*) filter (where a.remembered) as remembered, max(a.answered_at) as last_at,
      (array_agg(a.remembered order by a.answered_at desc))[1] as last_remembered
    from public.echo_answer a where a.user_id = p_user group by a.post_id
  )
  select v.post_id, coalesce(a.remembered, 0)::integer,
    coalesce(a.last_at, v.read_at) + case
      when a.last_remembered is false then interval '2 days'
      else (array[interval '2 days', interval '7 days', interval '21 days', interval '60 days'])[coalesce(a.remembered, 0) + 1] end
  from valued v left join answers a on a.post_id = v.post_id
  where coalesce(a.remembered, 0) < 4;
$$;
revoke all on function public.echo_schedule(uuid) from public, anon, authenticated;

-- Up to p_limit echoes due now, longest overdue first, as feed posts plus their stage.
create function public.echo_due(p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare uid uuid := auth.uid();
begin
  if uid is null or not exists (select 1 from public.allowed_reader a where a.user_id = uid) then
    raise exception 'Private account required' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 10 then raise exception 'Invalid count'; end if;
  return coalesce((select jsonb_agg(public.post_json(p) || jsonb_build_object('echoStage', e.stage) order by e.due_at)
    from (select * from public.echo_schedule(uid) where due_at <= now() order by due_at limit p_limit) e
    join public.post p on p.id = e.post_id), '[]'::jsonb);
end;
$$;

-- Record an answer to a due echo. Refused when the post is not due, so a double tap cannot skip a stage.
create function public.echo_answer(p_post_id text, p_remembered boolean) returns integer
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); current_stage integer;
begin
  if uid is null or not exists (select 1 from public.allowed_reader a where a.user_id = uid) then
    raise exception 'Private account required' using errcode = '42501';
  end if;
  if p_post_id is null or p_remembered is null then raise exception 'Invalid answer'; end if;
  select e.stage into current_stage from public.echo_schedule(uid) e where e.post_id = p_post_id and e.due_at <= now();
  if current_stage is null then raise exception 'Not due'; end if;
  insert into public.echo_answer(user_id, post_id, stage, remembered) values (uid, p_post_id, current_stage, p_remembered);
  return current_stage + case when p_remembered then 1 else 0 end;
end;
$$;
revoke all on function public.echo_due(integer), public.echo_answer(text, boolean) from public, anon;
grant execute on function public.echo_due(integer), public.echo_answer(text, boolean) to authenticated;

commit;
