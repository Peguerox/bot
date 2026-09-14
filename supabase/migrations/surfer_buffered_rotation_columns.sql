-- Adds the two columns the buffered SOL/BTC rotation strategy needs (anchor + peak ratio) that
-- the old RSI+EMA+trailing strategy never used. Old columns (armed_for_sol, armed_for_btc,
-- best_pct) are left in place, just unused now -- no data loss, no migration risk on the live
-- table, and it keeps a path back to the archived old strategy trivial.
alter table public.surfer_state add column if not exists anchor numeric;
alter table public.surfer_state add column if not exists peak numeric;
