-- Worker 4: exact clone of Worker 1, new sub-account, for a live A/B control test (2026-10-10).
-- Clones lighter_btc_initial_*'s full current schema (including every column added by every
-- later migration) rather than hand-listing columns, so this starts from the real, current
-- shape of Worker 1's tables, not an out-of-date hand-written copy.
create table if not exists public.lighter_btc_worker4_state (like public.lighter_btc_initial_state including all);
create table if not exists public.lighter_btc_worker4_trades (like public.lighter_btc_initial_trades including all);
create table if not exists public.lighter_btc_worker4_runs   (like public.lighter_btc_initial_runs   including all);

-- Real collateral on worker4's sub-account as of 2026-10-10 (freshly funded, never traded).
insert into public.lighter_btc_worker4_state (id, seed_usd) values (1, 45.00)
  on conflict (id) do nothing;

alter table public.lighter_btc_worker4_state  enable row level security;
alter table public.lighter_btc_worker4_trades enable row level security;
alter table public.lighter_btc_worker4_runs   enable row level security;

create policy "anon_read" on public.lighter_btc_worker4_state  for select to anon using (true);
create policy "anon_read" on public.lighter_btc_worker4_trades for select to anon using (true);
create policy "anon_read" on public.lighter_btc_worker4_runs   for select to anon using (true);

alter publication supabase_realtime add table public.lighter_btc_worker4_state;
alter publication supabase_realtime add table public.lighter_btc_worker4_trades;
alter publication supabase_realtime add table public.lighter_btc_worker4_runs;
