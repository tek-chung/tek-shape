-- T-Mixer phase 5d: Tracks. Up to ten fields pinned from the Map, each a filter on the Latest tab: everything
-- new in that field, newest first, unranked (after X's Lists and pinned timelines). Additive; apply after
-- 202610070001.
begin;

create table public.track (
  user_id uuid not null references auth.users(id) on delete cascade,
  field text not null check (field ~ '^[a-z0-9-]{1,60}$'),
  created_at timestamptz not null default now(),
  primary key (user_id, field)
);
alter table public.track enable row level security;
revoke all on public.track from anon, authenticated;
grant select on public.track to authenticated;
grant all on public.track to service_role;
create policy own_tracks on public.track for select to authenticated
  using (user_id = (select auth.uid()) and public.is_allowed_reader());

-- Pin (p_on true) or unpin a field. Ten at most.
create function public.set_track(p_field text, p_on boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid();
begin
  if uid is null or not exists (select 1 from public.allowed_reader a where a.user_id = uid) then
    raise exception 'Private account required' using errcode = '42501';
  end if;
  if p_field is null or p_field !~ '^[a-z0-9-]{1,60}$' or p_on is null then raise exception 'Invalid track'; end if;
  if not p_on then
    delete from public.track t where t.user_id = uid and t.field = p_field;
    return;
  end if;
  if (select count(*) from public.track t where t.user_id = uid and t.field <> p_field) >= 10 then
    raise exception 'Ten tracks at most';
  end if;
  insert into public.track(user_id, field) values (uid, p_field) on conflict do nothing;
end;
$$;
revoke all on function public.set_track(text, boolean) from public, anon;
grant execute on function public.set_track(text, boolean) to authenticated;

commit;
