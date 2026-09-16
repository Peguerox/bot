-- Template for a new bot's Supabase tables. Copy this, rename the tables, fill in the real
-- columns. Every section below is required -- skipping the publication or RLS lines is exactly
-- what broke the SOL/BTC Participation bot's dashboard on first deploy (2026-09-16): the backend
-- worked, but the anon client the dashboard uses got zero rows back silently, with no error.
--
-- Checklist before you consider a new bot's schema "done":
--   [ ] state / trades / runs tables created
--   [ ] ALTER PUBLICATION supabase_realtime ADD TABLE -- for all three (dashboard live-updates)
--   [ ] ENABLE ROW LEVEL SECURITY -- for all three
--   [ ] CREATE POLICY "anon_read" ... for select to anon -- for all three (public dashboard read)
--   [ ] Apply via the Supabase SQL Editor (no exec_sql RPC in this project)

create table if not exists public.BOTNAME_state (
  id integer primary key default 1,
  enabled boolean not null default false
  -- ... strategy-specific columns ...
);
insert into public.BOTNAME_state (id) values (1) on conflict (id) do nothing;

create table if not exists public.BOTNAME_trades (
  id bigserial primary key
  -- ... trade columns ...
);

create table if not exists public.BOTNAME_runs (
  id bigserial primary key,
  run_at timestamptz not null default now(),
  data jsonb
);

alter publication supabase_realtime add table public.BOTNAME_state;
alter publication supabase_realtime add table public.BOTNAME_trades;
alter publication supabase_realtime add table public.BOTNAME_runs;

alter table public.BOTNAME_state  enable row level security;
alter table public.BOTNAME_trades enable row level security;
alter table public.BOTNAME_runs   enable row level security;

create policy "anon_read" on public.BOTNAME_state  for select to anon using (true);
create policy "anon_read" on public.BOTNAME_trades for select to anon using (true);
create policy "anon_read" on public.BOTNAME_runs   for select to anon using (true);
