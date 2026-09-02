alter table public.sol_oco_us_state  enable row level security;
alter table public.sol_oco_us_trades enable row level security;
alter table public.sol_oco_us_runs   enable row level security;
alter table public.sol_ladder_state  enable row level security;
alter table public.sol_ladder_trades enable row level security;
alter table public.sol_ladder_runs   enable row level security;

create policy "anon_read" on public.sol_oco_us_state  for select to anon using (true);
create policy "anon_read" on public.sol_oco_us_trades for select to anon using (true);
create policy "anon_read" on public.sol_oco_us_runs   for select to anon using (true);
create policy "anon_read" on public.sol_ladder_state  for select to anon using (true);
create policy "anon_read" on public.sol_ladder_trades for select to anon using (true);
create policy "anon_read" on public.sol_ladder_runs   for select to anon using (true);
