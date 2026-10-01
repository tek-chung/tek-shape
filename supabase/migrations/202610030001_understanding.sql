-- T-Mixer phase 1: the understanding layer. Additive; apply after 202610020001.
-- Each post's meaning as a vector (from a small local model; see scripts/content/understand.mjs) and the
-- idea clusters built from them. Engine-only: the reader's token can read neither, for now.
-- Vectors are stored as base64 signed bytes rather than pgvector: one reader's catalogue is small enough to
-- compare in the engine, and the tests' in-memory Postgres needs no extension.
begin;

create table public.post_vec (
  post_id text primary key references public.post(id) on delete cascade,
  model text not null check (length(model) between 1 and 120),
  dims smallint not null check (dims between 16 and 1024),
  vec text not null check (length(vec) between 1 and 2000),
  cluster integer check (cluster >= 0),
  updated_at timestamptz not null default now()
);
create index post_vec_cluster on public.post_vec(cluster);

create table public.idea_cluster (
  id integer primary key check (id >= 0),
  model text not null check (length(model) between 1 and 120),
  centroid text not null check (length(centroid) between 1 and 2000),
  size integer not null default 0 check (size >= 0),
  label text check (length(label) <= 120),
  updated_at timestamptz not null default now()
);

alter table public.post_vec enable row level security;
alter table public.idea_cluster enable row level security;
revoke all on public.post_vec, public.idea_cluster from anon, authenticated;
grant all on public.post_vec, public.idea_cluster to service_role;

commit;
