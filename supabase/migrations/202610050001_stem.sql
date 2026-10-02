-- T-Mixer phase 3: choose your stem. A field can be marked as one of the reader's deep fields ("stem"), at most
-- three, from the Map; the mixer gives those fields about a third of every batch. Additive; apply after
-- 202610040001.
begin;

alter table public.topic_preference drop constraint if exists topic_preference_choice_check;
alter table public.topic_preference add constraint topic_preference_choice_check
  check (choice in ('more','less','snooze','stem'));

-- As in 202609270001, plus "stem": fields only, three at most. Changing a stem field to another choice frees
-- its place; choosing the same field again is not a fourth.
create or replace function public.set_topic_preference(p_scope text, p_key text, p_choice text) returns void
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
  if p_choice not in ('more','less','snooze','stem') then raise exception 'Invalid choice'; end if;
  if p_choice = 'stem' and p_scope <> 'field' then raise exception 'Only a field can be part of the stem'; end if;
  if p_choice = 'stem' and (select count(*) from public.topic_preference
      where user_id = auth.uid() and choice = 'stem' and not (scope = p_scope and key = p_key)) >= 3 then
    raise exception 'Three stem fields at most';
  end if;
  insert into public.topic_preference(user_id, scope, key, choice, until, updated_at)
  values (auth.uid(), p_scope, p_key, p_choice, case when p_choice = 'snooze' then now() + interval '30 days' end, now())
  on conflict (user_id, scope, key) do update set choice = excluded.choice, until = excluded.until, updated_at = now();
end;
$$;
revoke all on function public.set_topic_preference(text,text,text) from public, anon;
grant execute on function public.set_topic_preference(text,text,text) to authenticated;

commit;
