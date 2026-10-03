-- T-Mixer phase 5c: Dear T. The reader writes what they want more or less of, in their own words ("Dear T, less
-- AI news this week, more Byzantine history"), for 1, 3 or 7 days. The next engine run turns each request into
-- a few steers (field or subtopic; more, less or pause) that apply until the request expires or is removed.
-- After Threads' Dear Algo (February 2026) and Instagram's Your Algorithm. Additive; apply after 202610060001.
begin;

create table public.dear_t (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  text text not null check (length(text) between 3 and 280),
  days smallint not null check (days in (1, 3, 7)),
  status text not null default 'pending' check (status in ('pending', 'applied', 'failed')),
  steers jsonb not null default '[]' check (jsonb_typeof(steers) = 'array' and jsonb_array_length(steers) <= 8),
  note text check (length(note) <= 200),
  created_at timestamptz not null default now(),
  applied_at timestamptz,
  until timestamptz not null
);
create index dear_t_active on public.dear_t(user_id, until desc);
alter table public.dear_t enable row level security;
revoke all on public.dear_t from anon, authenticated;
grant select on public.dear_t to authenticated;
grant all on public.dear_t to service_role;
create policy own_requests on public.dear_t for select to authenticated
  using (user_id = (select auth.uid()) and public.is_allowed_reader());

-- Send a request: at most five running at once, so steering stays a light touch.
create function public.dear_t_send(p_text text, p_days integer) returns uuid
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); new_id uuid;
begin
  if uid is null or not exists (select 1 from public.allowed_reader a where a.user_id = uid) then
    raise exception 'Private account required' using errcode = '42501';
  end if;
  if p_text is null or length(trim(p_text)) not between 3 and 280 then raise exception 'Write between 3 and 280 characters'; end if;
  if p_days is null or p_days not in (1, 3, 7) then raise exception 'Choose 1, 3 or 7 days'; end if;
  if (select count(*) from public.dear_t d where d.user_id = uid and d.until > now() and d.status <> 'failed') >= 5 then
    raise exception 'Five requests are running already';
  end if;
  insert into public.dear_t(user_id, text, days, until) values (uid, trim(p_text), p_days, now() + make_interval(days => p_days))
  returning id into new_id;
  return new_id;
end;
$$;

-- Remove a request early: its steers stop at the next run.
create function public.dear_t_remove(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid();
begin
  if uid is null or not exists (select 1 from public.allowed_reader a where a.user_id = uid) then
    raise exception 'Private account required' using errcode = '42501';
  end if;
  delete from public.dear_t d where d.id = p_id and d.user_id = uid;
end;
$$;
revoke all on function public.dear_t_send(text, integer), public.dear_t_remove(uuid) from public, anon;
grant execute on function public.dear_t_send(text, integer), public.dear_t_remove(uuid) to authenticated;

commit;
