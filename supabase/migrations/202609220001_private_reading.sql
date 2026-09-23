-- No personal identities or reading data belong in this migration.
create table public.allowed_reader (
  singleton boolean primary key default true check (singleton),
  user_id uuid not null unique references auth.users(id) on delete cascade
);
alter table public.allowed_reader enable row level security;
revoke all on public.allowed_reader from anon, authenticated;
grant select on public.allowed_reader to authenticated;
create policy own_membership on public.allowed_reader for select to authenticated using (user_id = (select auth.uid()));

-- The access gate, stated once. Callers must not rely on allowed_reader's own RLS
-- to scope an unqualified `exists` — a second policy added later would silently
-- widen that to "any row anywhere". This function is explicit about the user.
create function public.is_allowed_reader() returns boolean
language sql stable security invoker set search_path = '' as $$
  select exists (select 1 from public.allowed_reader a where a.user_id = (select auth.uid()));
$$;
revoke all on function public.is_allowed_reader() from public, anon;
grant execute on function public.is_allowed_reader() to authenticated;

-- Content. Seeded out of band with the service role; the reader has select only.
create table public.post (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  topic text not null check (length(topic) between 1 and 60),
  title text not null check (length(title) between 1 and 200),
  explanation text[] not null check (array_length(explanation,1) between 1 and 20),
  insight text not null check (length(insight) between 1 and 400),
  deeper text not null check (length(deeper) between 1 and 4000),
  source_label text check (length(source_label) between 1 and 200),
  source_url text check (source_url ~ '^https://' and length(source_url) <= 2000),
  -- 'sample' is illustrative content; 'published' is reviewed editorial content.
  status text not null default 'draft' check (status in ('draft','sample','published')),
  published_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint source_is_whole check ((source_label is null) = (source_url is null))
);
-- The feed's sort order, and the index the cursor walks.
create index post_feed_order on public.post(published_at desc, id desc) where status in ('sample','published');
alter table public.post enable row level security;
revoke all on public.post from anon, authenticated;
grant select on public.post to authenticated;
create policy readable_content on public.post for select to authenticated using (public.is_allowed_reader());

create table public.reading_progress (
  user_id uuid primary key references auth.users(id) on delete cascade,
  -- How many posts had been paged in, so a reload can restore the same depth.
  loaded_count integer not null default 0 check (loaded_count between 0 and 5000),
  position_post_id text references public.post(id) on delete set null,
  position_offset double precision not null default 0 check (position_offset between -2000 and 10000),
  updated_at timestamptz not null default now()
);
create table public.user_post_state (
  user_id uuid not null references auth.users(id) on delete cascade,
  post_id text not null references public.post(id) on delete cascade,
  rating text check (rating in ('more','uninteresting','harder')),
  bookmarked boolean not null default false,
  expanded boolean not null default false,
  first_seen_at timestamptz,
  read_at timestamptz,
  deeper_opened_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id,post_id)
);
create index saved_posts on public.user_post_state(user_id,updated_at desc) where bookmarked;
alter table public.reading_progress enable row level security;
alter table public.user_post_state enable row level security;
revoke all on public.reading_progress, public.user_post_state from anon, authenticated;
grant select, insert, update on public.reading_progress, public.user_post_state to authenticated;
create policy private_progress on public.reading_progress for all to authenticated
  using (user_id = (select auth.uid()) and public.is_allowed_reader())
  with check (user_id = (select auth.uid()) and public.is_allowed_reader());
create policy private_posts on public.user_post_state for all to authenticated
  using (user_id = (select auth.uid()) and public.is_allowed_reader())
  with check (user_id = (select auth.uid()) and public.is_allowed_reader());

create function public.reading_state() returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare result jsonb;
begin
  if not public.is_allowed_reader() then raise exception 'Private account required' using errcode = '42501'; end if;
  insert into public.reading_progress(user_id) values (auth.uid()) on conflict do nothing;
  select jsonb_build_object(
    'loadedCount', p.loaded_count,
    'position', case when p.position_post_id is null then null else jsonb_build_object('postId',p.position_post_id,'offset',p.position_offset) end,
    'posts', coalesce((select jsonb_object_agg(s.post_id,jsonb_build_object(
      'rating',s.rating,'bookmarked',s.bookmarked,'expanded',s.expanded,
      'firstSeenAt',s.first_seen_at,'readAt',s.read_at,'deeperOpenedAt',s.deeper_opened_at
    )) from public.user_post_state s where s.user_id = auth.uid()),'{}'::jsonb),
    'total', (select count(*) from public.post c where c.status in ('sample','published'))
  ) into result from public.reading_progress p where p.user_id = auth.uid();
  -- The insert above guarantees a row; fail loudly rather than returning JSON null to the client.
  if result is null then raise exception 'Reading state unavailable' using errcode = 'P0002'; end if;
  return result;
end;
$$;

-- One page of the feed, newest first. The cursor is the last row the client holds;
-- passing null starts from the top. Keyset paging, so inserts never shift a page.
create function public.reading_page(
  p_after_published_at timestamptz default null,
  p_after_id text default null,
  p_limit integer default 8
) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare items jsonb;
begin
  if not public.is_allowed_reader() then raise exception 'Private account required' using errcode = '42501'; end if;
  if p_limit is null or p_limit < 1 or p_limit > 50 then raise exception 'Invalid page size'; end if;
  if (p_after_published_at is null) <> (p_after_id is null) then raise exception 'Invalid cursor'; end if;
  select coalesce(jsonb_agg(page.row order by page.published_at desc, page.id desc), '[]'::jsonb)
  into items from (
    select c.published_at, c.id, jsonb_build_object(
      'id', c.id, 'topic', c.topic, 'title', c.title,
      'explanation', c.explanation, 'insight', c.insight, 'deeper', c.deeper,
      'source', case when c.source_url is null then null
                else jsonb_build_object('label',c.source_label,'url',c.source_url) end,
      'publishedAt', c.published_at
    ) as row
    from public.post c
    where c.status in ('sample','published')
      and (p_after_published_at is null or (c.published_at, c.id) < (p_after_published_at, p_after_id))
    order by c.published_at desc, c.id desc
    limit p_limit
  ) page;
  return items;
end;
$$;

-- Patch only fields changed on this device, preserving concurrent unrelated changes.
create function public.save_post(p_post_id text, p_patch jsonb) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if jsonb_typeof(p_patch) <> 'object' or p_patch - array['rating','bookmarked','expanded','seen','read'] <> '{}'::jsonb then
    raise exception 'Invalid post patch';
  end if;
  if (p_patch ? 'bookmarked' and jsonb_typeof(p_patch->'bookmarked') <> 'boolean')
    or (p_patch ? 'expanded' and jsonb_typeof(p_patch->'expanded') <> 'boolean')
    or (p_patch ? 'seen' and p_patch->'seen' <> 'true'::jsonb)
    or (p_patch ? 'read' and p_patch->'read' <> 'true'::jsonb)
    -- Rating is validated here as well as by the column constraint, so a bad value
    -- returns this function's error rather than a raw check violation.
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
    read_at = case when p_patch ? 'read' then coalesce(read_at,now()) else read_at end,
    deeper_opened_at = case when p_patch->>'expanded' = 'true' then coalesce(deeper_opened_at,now()) else deeper_opened_at end,
    updated_at = now()
  where user_id = auth.uid() and post_id = p_post_id;
end;
$$;

create function public.save_progress(p_loaded_count integer, p_post_id text, p_offset double precision) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if p_loaded_count is null or p_loaded_count < 0 or p_loaded_count > 5000 or p_offset is null then
    raise exception 'Invalid reading position';
  end if;
  insert into public.reading_progress(user_id) values(auth.uid()) on conflict do nothing;
  -- A call that carries no position is paging in more posts, not clearing where you were:
  -- leave position_post_id and position_offset untouched in that case.
  update public.reading_progress set
    loaded_count = greatest(loaded_count, p_loaded_count),
    position_post_id = coalesce(p_post_id, position_post_id),
    position_offset = case when p_post_id is null then position_offset else p_offset end,
    updated_at = now()
  where user_id = auth.uid();
end;
$$;
revoke all on function public.reading_state(), public.reading_page(timestamptz,text,integer),
  public.save_post(text,jsonb), public.save_progress(integer,text,double precision) from public, anon;
grant execute on function public.reading_state(), public.reading_page(timestamptz,text,integer),
  public.save_post(text,jsonb), public.save_progress(integer,text,double precision) to authenticated;
