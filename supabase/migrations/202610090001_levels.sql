-- The difficulty scale (SPEC §3, src/data/levels.json). Records which version of the scale graded each post:
-- null for posts graded before the scale was written down, so `regrade` can bring them onto it. Additive;
-- apply after 202610080001.
begin;

alter table public.post add column level_scale smallint check (level_scale between 1 and 100);

commit;
