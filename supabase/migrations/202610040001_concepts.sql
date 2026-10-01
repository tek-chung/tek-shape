-- T-Mixer phase 1b: the concept graph behind depth ladders. Additive; apply after 202610030001.
--   * Each post can name the concepts it assumes (prerequisites), as well as those it teaches (concept_ids).
--   * Concept tags that mean the same thing ("quantum-theory", "quantum-mechanics") are folded into one
--     canonical concept, found by the understanding model, so "already familiar" and "the next step" are
--     judged per idea rather than per spelling. Engine-only tables, as in 202610030001.
begin;

alter table public.post add column assumes text[] not null default '{}' check (cardinality(assumes) <= 8);

create table public.concept (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  label text not null check (length(label) between 1 and 120),
  model text not null check (length(model) between 1 and 120),
  vec text not null check (length(vec) between 1 and 2000),
  updated_at timestamptz not null default now()
);

-- Every tag seen, canonical ones included (as their own alias), pointing at its canonical concept.
create table public.concept_alias (
  alias text primary key check (alias ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  concept_id text not null references public.concept(id) on delete cascade,
  similarity real check (similarity between -1 and 1),
  updated_at timestamptz not null default now()
);
create index concept_alias_concept on public.concept_alias(concept_id);

alter table public.concept enable row level security;
alter table public.concept_alias enable row level security;
revoke all on public.concept, public.concept_alias from anon, authenticated;
grant all on public.concept, public.concept_alias to service_role;

commit;
