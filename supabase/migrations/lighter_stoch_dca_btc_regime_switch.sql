-- The regime-switch strategy needs to remember which TP/SL each open position was entered
-- with, since a "fade" leg (chop) and a "trend" leg (regime switch) use different widths.
-- Nullable, defaults null so a row with no open position (or a position entered before
-- this migration ran) just falls back to the bot's default TP/SL in code.
--
-- Worker 1 and Worker 3 both run the regime-switch strategy (different stoch_window, live
-- A/B) and both need this. Worker 2 stays on the plain fade-only strategy and never writes
-- these columns, but adding them there too is harmless if it's ever switched over later.

alter table lighter_btc_initial_state
  add column if not exists position_tp_pct double precision;
alter table lighter_btc_initial_state
  add column if not exists position_sl_pct double precision;

alter table lighter_stoch_dca_btc_state
  add column if not exists position_tp_pct double precision;
alter table lighter_stoch_dca_btc_state
  add column if not exists position_sl_pct double precision;
