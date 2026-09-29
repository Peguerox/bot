-- Consolidated cleanup, 2026-09-29 -- run in the Supabase SQL editor once the database has
-- recovered from the statement-timeout incident. Bundles two already-prepared DROP migrations
-- that were written earlier this session but never actually run, plus two small leftover
-- unused columns. Nothing here is used by any bot's current code -- all three of these
-- mechanisms were already fully abandoned before today.

-- 1. lighter_btc_trade_flow: fully retired 2026-09-27, 423K dead rows, nothing writes to it.
drop table if exists lighter_btc_trade_flow;

-- 2. Worker 3's tight-TP self-lock paper test: abandoned same day it was built (2026-09-26),
--    "I was completely wrong, this bot is not generating any money." Paper-only, no real money.
drop table if exists lighter_btc_tight_tp_paper_trades;

alter table lighter_stoch_dca_btc_state
  drop column if exists tight_paper_side,
  drop column if exists tight_paper_entry_price,
  drop column if exists tight_paper_entry_time,
  drop column if exists tight_paper_consecutive_tps,
  drop column if exists tight_real_locked,
  drop column if exists tight_sim_side,
  drop column if exists tight_sim_entry_price,
  drop column if exists tight_sim_entry_time;

-- 3. Worker 2 leftover columns from two abandoned same-day experiments (2026-09-29): the
--    entry-confirmation book filter and the min-volatility gate, both replaced same day by the
--    joint-adaptive/self-lock pivot. Unused by current code, harmless but no reason to keep.
alter table lighter_btc_optimal_state
  drop column if exists entry_confirmation_last,
  drop column if exists min_vol_pct_last;

-- 4. Order-book depth snapshots: confirmed not needed going forward (direct request) -- this
--    was the single biggest contributor to the write load (full book depth on a fast cadence).
--    Keeps the "trade" rows (executed trade prints) in the same table, which still have
--    research value and are much smaller per-row. Logger itself is permanently off now
--    (Worker 3's unified_market_data_table), so this table won't refill with more book rows.
delete from lighter_stoch_dca_btc_market_data where kind = 'book';
