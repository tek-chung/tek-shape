-- Phase 4d: the taste model's inputs and outputs. Additive.
--   * "Opened the original" becomes its own signal.
--   * Each queued post remembers why it was placed (favourite, explore, stretch), so the feed can grade itself.
--   * The reader can steer fields and subtopics (More / Less / Snooze) from the Map.
--   * The engine saves a snapshot of the model (niches, pauses, report card) for the Map to show.
begin;

alter table public.user_post_state add column opened_at timestamptz;
alter table public.feed_queue add column slot text not null default 'legacy'
  check (slot in ('legacy','favourite','explore','stretch'));

create table public.topic_preference (
  user_id uuid not null references auth.users(id) on delete cascade,
  scope text not null check (scope in ('field','subtopic')),
  key text not null check (length(key) between 1 and 160),
  choice text not null check (choice in ('more','less','snooze')),
  until timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, scope, key)
);
alter table public.topic_preference enable row level security;
revoke all on public.topic_preference from anon, authenticated;
grant select, insert, update, delete on public.topic_preference to authenticated;
grant select on public.topic_preference to service_role;
create policy own_preferences on public.topic_preference for all to authenticated
  using (user_id = (select auth.uid()) and public.is_allowed_reader())
  with check (user_id = (select auth.uid()) and public.is_allowed_reader());

create table public.taste_snapshot (
  user_id uuid primary key references auth.users(id) on delete cascade,
  computed_at timestamptz not null default now(),
  model jsonb not null check (jsonb_typeof(model) = 'object')
);
alter table public.taste_snapshot enable row level security;
revoke all on public.taste_snapshot from anon, authenticated;
grant select on public.taste_snapshot to authenticated;
grant all on public.taste_snapshot to service_role;
create policy own_snapshot on public.taste_snapshot for select to authenticated
  using (user_id = (select auth.uid()) and public.is_allowed_reader());

-- save_post gains the one-way `opened` flag (tapping through to the original article).
create or replace function public.save_post(p_post_id text, p_patch jsonb) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if jsonb_typeof(p_patch) <> 'object' or p_patch - array['rating','bookmarked','expanded','seen','read','opened'] <> '{}'::jsonb then
    raise exception 'Invalid post patch';
  end if;
  if (p_patch ? 'bookmarked' and jsonb_typeof(p_patch->'bookmarked') <> 'boolean')
    or (p_patch ? 'expanded' and jsonb_typeof(p_patch->'expanded') <> 'boolean')
    or (p_patch ? 'seen' and p_patch->'seen' <> 'true'::jsonb)
    or (p_patch ? 'read' and p_patch->'read' <> 'true'::jsonb)
    or (p_patch ? 'opened' and p_patch->'opened' <> 'true'::jsonb)
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
    opened_at = case when p_patch ? 'opened' then coalesce(opened_at,now()) else opened_at end,
    deeper_opened_at = case when p_patch->>'expanded' = 'true' then coalesce(deeper_opened_at,now()) else deeper_opened_at end,
    updated_at = now()
  where user_id = auth.uid() and post_id = p_post_id;
end;
$$;

-- reading_state returns openedAt too (otherwise as in 202609230001).
create or replace function public.reading_state() returns jsonb
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
      'firstSeenAt',s.first_seen_at,'readAt',s.read_at,'deeperOpenedAt',s.deeper_opened_at,'openedAt',s.opened_at
    )) from public.user_post_state s where s.user_id = auth.uid()),'{}'::jsonb),
    'total', (select count(*) from public.feed_queue q join public.post c on c.id=q.post_id where q.user_id=auth.uid() and c.status in ('sample','published'))
  ) into result from public.reading_progress p where p.user_id = auth.uid();
  if result is null then raise exception 'Reading state unavailable' using errcode = 'P0002'; end if;
  return result;
end;
$$;

/*
 * Steer a field or subtopic. p_choice null clears the steer. A snooze lasts 30 days. Subtopic keys are
 * "<field>::<subtopic in lower case>", as the engine writes them.
 */
create function public.set_topic_preference(p_scope text, p_key text, p_choice text) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if not public.is_allowed_reader() then raise exception 'Private account required' using errcode = '42501'; end if;
  if p_scope is null or p_scope not in ('field','subtopic') or p_key is null or length(p_key) not between 1 and 160
    or (p_scope = 'field' and p_key !~ '^[a-z0-9-]{1,60}$')
    or (p_scope = 'subtopic' and p_key !~ '^[a-z0-9-]{1,60}::') then raise exception 'Invalid topic'; end if;
  if p_choice is null then
    delete from public.topic_preference where user_id = auth.uid() and scope = p_scope and key = p_key;
    return;
  end if;
  if p_choice not in ('more','less','snooze') then raise exception 'Invalid choice'; end if;
  insert into public.topic_preference(user_id, scope, key, choice, until, updated_at)
  values (auth.uid(), p_scope, p_key, p_choice, case when p_choice = 'snooze' then now() + interval '30 days' end, now())
  on conflict (user_id, scope, key) do update set choice = excluded.choice, until = excluded.until, updated_at = now();
end;
$$;

-- Everything the Map needs about taste in one call: the latest snapshot and the reader's current steers.
create function public.taste_view() returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
begin
  if not public.is_allowed_reader() then raise exception 'Private account required' using errcode = '42501'; end if;
  return jsonb_build_object(
    'snapshot', (select t.model from public.taste_snapshot t where t.user_id = auth.uid()),
    'preferences', coalesce((select jsonb_agg(jsonb_build_object('scope',p.scope,'key',p.key,'choice',p.choice,'until',p.until))
      from public.topic_preference p where p.user_id = auth.uid() and (p.until is null or p.until > now())), '[]'::jsonb));
end;
$$;

revoke all on function public.set_topic_preference(text,text,text), public.taste_view() from public, anon;
grant execute on function public.set_topic_preference(text,text,text), public.taste_view() to authenticated;

commit;
