begin;

alter table public.post
  add column content_type text not null default 'evergreen' check (content_type in ('news','evergreen')),
  add column subtopic text not null default '' check (length(subtopic) <= 100),
  add column difficulty integer not null default 1 check (difficulty between 1 and 5),
  add column concept_ids text[] not null default '{}',
  add column event_date date,
  add column article_date timestamptz,
  add column verification_status text not null default 'unreviewed' check (verification_status in ('unreviewed','source_checked')),
  add column sources jsonb not null default '[]' check (jsonb_typeof(sources) = 'array'),
  add column reviewed_at timestamptz,
  add column editorial_note text,
  add constraint published_evidence check (status <> 'published' or (
    verification_status = 'source_checked' and reviewed_at is not null
    and cardinality(concept_ids) > 0 and jsonb_array_length(sources) > 0
    and editorial_note is not null
  ));

-- Drafts and pipeline artefacts are never readable through a reader's token.
drop policy readable_content on public.post;
create policy readable_content on public.post for select to authenticated
  using (public.is_allowed_reader() and status in ('sample','published'));

create table public.content_candidate (
  id text primary key,
  payload jsonb not null,
  evidence jsonb not null,
  checks jsonb not null,
  status text not null check (status in ('held','checked','published')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  review_note text
);
create table public.content_run (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running','completed','failed')),
  metrics jsonb not null default '{}'
);
create table public.content_budget (
  day date primary key,
  reserved_usd numeric not null default 0 check (reserved_usd >= 0),
  calls integer not null default 0
);
alter table public.content_candidate enable row level security;
alter table public.content_run enable row level security;
alter table public.content_budget enable row level security;
revoke all on public.content_candidate, public.content_run, public.content_budget from anon, authenticated;
grant all on public.content_candidate, public.content_run, public.content_budget to service_role;
grant select, insert, update on public.post to service_role;
grant select on public.allowed_reader, public.user_post_state to service_role;

create function public.reserve_content_call(p_cost numeric, p_daily_limit numeric, p_call_limit integer) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if p_cost is null or p_cost <= 0 or p_daily_limit is null or p_daily_limit <= 0
    or p_call_limit is null or p_call_limit < 1 then raise exception 'Invalid budget'; end if;
  insert into public.content_budget(day) values (current_date) on conflict do nothing;
  update public.content_budget set reserved_usd = reserved_usd + p_cost, calls = calls + 1
    where day = current_date and reserved_usd + p_cost <= p_daily_limit and calls < p_call_limit;
  if not found then raise exception 'Daily content budget exhausted'; end if;
end;
$$;
revoke all on function public.reserve_content_call(numeric,numeric,integer) from public, anon, authenticated;
grant execute on function public.reserve_content_call(numeric,numeric,integer) to service_role;

create table public.feed_queue (
  user_id uuid not null references auth.users(id) on delete cascade,
  post_id text not null references public.post(id) on delete cascade,
  position bigint not null check (position > 0),
  queued_at timestamptz not null default now(),
  primary key (user_id,post_id),
  unique (user_id,position)
);
alter table public.feed_queue enable row level security;
revoke all on public.feed_queue from anon, authenticated;
grant select on public.feed_queue to authenticated;
grant all on public.feed_queue to service_role;
create policy own_queue on public.feed_queue for select to authenticated
  using (user_id = (select auth.uid()) and public.is_allowed_reader());

-- Freeze the existing collection in its current order, preserving reading anchors.
insert into public.feed_queue(user_id,post_id,position)
select a.user_id,p.id,row_number() over (partition by a.user_id order by p.published_at desc,p.id desc)
from public.allowed_reader a cross join public.post p where p.status in ('sample','published');

create function public.append_feed(p_user_id uuid, p_ids text[]) returns integer
language plpgsql security invoker set search_path = '' as $$
declare next_position bigint; item text; added integer := 0;
begin
  if p_ids is null or cardinality(p_ids) > 100 then raise exception 'Invalid queue batch'; end if;
  if not exists (select 1 from public.allowed_reader where user_id = p_user_id) then raise exception 'Unknown reader'; end if;
  -- Concurrent runners may append, but can never assign the same position.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,0));
  select coalesce(max(position),0) into next_position from public.feed_queue where user_id = p_user_id;
  foreach item in array p_ids loop
    if exists (select 1 from public.post where id = item and status = 'published' and verification_status = 'source_checked')
      and not exists (select 1 from public.feed_queue where user_id = p_user_id and post_id = item) then
      next_position := next_position + 1;
      insert into public.feed_queue(user_id,post_id,position) values(p_user_id,item,next_position);
      added := added + 1;
    end if;
  end loop;
  return added;
end;
$$;
revoke all on function public.append_feed(uuid,text[]) from public, anon, authenticated;
grant execute on function public.append_feed(uuid,text[]) to service_role;

create or replace function public.reading_page(
  p_after_published_at timestamptz default null, p_after_id text default null, p_limit integer default 8
) returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare items jsonb; after_position bigint := 0;
begin
  if not public.is_allowed_reader() then raise exception 'Private account required' using errcode = '42501'; end if;
  if p_limit is null or p_limit < 1 or p_limit > 50 then raise exception 'Invalid page size'; end if;
  if (p_after_published_at is null) <> (p_after_id is null) then raise exception 'Invalid cursor'; end if;
  -- Keep the existing client cursor contract, but resolve its stable ID to queue order.
  if p_after_id is not null then
    select position into after_position from public.feed_queue where user_id = auth.uid() and post_id = p_after_id;
    if after_position is null then raise exception 'Unknown queue cursor'; end if;
  end if;
  select coalesce(jsonb_agg(page.row order by page.position),'[]'::jsonb) into items from (
    select q.position,jsonb_build_object(
      'id',p.id,'topic',p.topic,'title',p.title,'explanation',p.explanation,'insight',p.insight,'deeper',p.deeper,
      'source',case when p.source_url is null then null else jsonb_build_object('label',p.source_label,'url',p.source_url) end,
      'publishedAt',p.published_at,'status',p.status,'contentType',p.content_type,'subtopic',p.subtopic,
      'difficulty',p.difficulty,'conceptIds',p.concept_ids,'eventDate',p.event_date,
      'sources',p.sources,'reviewedAt',p.reviewed_at,'articleDate',p.article_date
    ) as row
    from public.feed_queue q join public.post p on p.id=q.post_id
    where q.user_id=auth.uid() and q.position > after_position and p.status in ('sample','published')
    order by q.position limit p_limit
  ) page;
  return items;
end;
$$;

create function public.publish_candidate(p_id text, p_note text) returns text
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
    content_type,subtopic,difficulty,concept_ids,event_date,verification_status,sources,reviewed_at,editorial_note,article_date)
  values(c.id,p->>'topic',p->>'title',array(select jsonb_array_elements_text(p->'explanation')),
    p->>'insight',p->>'deeper','published',now(),p->>'contentType',p->>'subtopic',(p->>'difficulty')::integer,
    array(select jsonb_array_elements_text(p->'conceptIds')),nullif(p->>'eventDate','')::date,
    'source_checked',p->'sources',now(),p_note,(p->>'articleDate')::timestamptz);
  update public.content_candidate set status='published',reviewed_at=now(),review_note=p_note where id=p_id;
  return c.id;
end;
$$;
revoke all on function public.publish_candidate(text,text) from public, anon, authenticated;
grant execute on function public.publish_candidate(text,text) to service_role;

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
      'firstSeenAt',s.first_seen_at,'readAt',s.read_at,'deeperOpenedAt',s.deeper_opened_at
    )) from public.user_post_state s where s.user_id = auth.uid()),'{}'::jsonb),
    'total', (select count(*) from public.feed_queue q join public.post c on c.id=q.post_id where q.user_id=auth.uid() and c.status in ('sample','published'))
  ) into result from public.reading_progress p where p.user_id = auth.uid();
  -- The insert above guarantees a row; fail loudly rather than returning JSON null to the client.
  if result is null then raise exception 'Reading state unavailable' using errcode = 'P0002'; end if;
  return result;
end;
$$;


commit;
