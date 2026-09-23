-- Provider-aware budget for the content engine.
--
-- The original reserve_content_call assumed a paid provider: it rejected a zero
-- cost, so free tiers could never run. It also kept one call counter for the
-- day, but each free tier has its own quota. This replaces both:
--   * calls are capped per provider, per day;
--   * spend is capped across all providers, per day;
--   * a zero-cost call is valid, and a zero daily budget means free calls only.
--
-- Additive, so it applies cleanly whether or not 202609230001 has already run.
begin;

alter table public.content_budget drop constraint content_budget_pkey;
alter table public.content_budget
  add column provider text not null default 'unspecified' check (provider ~ '^[a-z0-9-]{1,40}$');
alter table public.content_budget add primary key (day, provider);

drop function public.reserve_content_call(numeric, numeric, integer);

create function public.reserve_content_call(
  p_provider text, p_cost numeric, p_daily_limit numeric, p_call_limit integer
) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if p_provider is null or p_provider !~ '^[a-z0-9-]{1,40}$'
    or p_cost is null or p_cost < 0
    or p_daily_limit is null or p_daily_limit < 0
    or p_call_limit is null or p_call_limit < 1 then
    raise exception 'Invalid budget';
  end if;
  -- Serialise reservations for the day so concurrent runners cannot overshoot the shared spend cap.
  perform pg_advisory_xact_lock(hashtextextended('content_budget:' || current_date::text, 0));
  insert into public.content_budget(day, provider) values (current_date, p_provider) on conflict do nothing;
  if (select coalesce(sum(reserved_usd), 0) from public.content_budget where day = current_date) + p_cost > p_daily_limit then
    raise exception 'Daily content budget exhausted';
  end if;
  update public.content_budget set reserved_usd = reserved_usd + p_cost, calls = calls + 1
    where day = current_date and provider = p_provider and calls < p_call_limit;
  if not found then raise exception 'Daily call limit reached for %', p_provider; end if;
end;
$$;
revoke all on function public.reserve_content_call(text, numeric, numeric, integer) from public, anon, authenticated;
grant execute on function public.reserve_content_call(text, numeric, numeric, integer) to service_role;

commit;
