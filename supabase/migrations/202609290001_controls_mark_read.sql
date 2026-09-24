-- Phase 4f: tapping any control on a post counts as reading it, whichever version of the app sent the
-- tap, and posts rated, saved, expanded or opened before that rule are marked read now, so they leave
-- the feed at the next sitting and are listed under Read. Additive; safe to run more than once.
begin;

-- As in 202609270001, except that a rating, a save, the deeper explanation or the original also records
-- the read. The first read time stands. `seen` alone still does not count.
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
    read_at = case when p_patch ?| array['read','rating','bookmarked','expanded','opened'] then coalesce(read_at,now()) else read_at end,
    opened_at = case when p_patch ? 'opened' then coalesce(opened_at,now()) else opened_at end,
    deeper_opened_at = case when p_patch->>'expanded' = 'true' then coalesce(deeper_opened_at,now()) else deeper_opened_at end,
    updated_at = now()
  where user_id = auth.uid() and post_id = p_post_id;
end;
$$;

-- Touched before the rule: read as of the earliest moment on record (the deeper explanation or the
-- original if opened, otherwise the last change, which is when the rating or save was made).
update public.user_post_state
  set read_at = least(updated_at, deeper_opened_at, opened_at)
  where read_at is null
    and (rating is not null or bookmarked or expanded or deeper_opened_at is not null or opened_at is not null);

commit;
