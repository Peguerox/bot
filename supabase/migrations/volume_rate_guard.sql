-- Volume-rate guard -- 2026-10-08. Run in the Supabase SQL Editor.
-- Direct request: "if 20% we dont take the trade and wait for the next signal" -- backtested
-- against real Worker 1 trades: blocking entries where |volume_rate_pct| (volume's own %
-- change vs the prior candle, max over the trailing 5 closed candles so there's genuine lead
-- time before entry, no same-candle lookahead) exceeds 20% lifted win rate 66%->70% and roughly
-- doubled net PnL on the surviving trades.
--
-- live_volume_rate_pct: the guard's own reading, written every tick regardless of whether it's
-- enabled -- same "watch before choosing" pattern as live_volume_wiggle_ratio.
-- override_volume_rate_guard_threshold: NULL means off (no guard). A fresh entry is blocked
-- (and only a fresh entry -- never an exit) when the live reading exceeds this threshold.
-- override_volume_rate_guard_enabled: separate on/off switch, same contract as the wiggle
-- lock's own enabled flag -- NULL/true means on, false means off, independent of the threshold.
-- override_volume_rate_guard_lookback: how many trailing closed candles to take the max
-- reading over (compiled default 5, matches the backtest).
-- See BotConfig.volume_rate_guard_threshold / StochBot._update_volume_rate_guard.
ALTER TABLE public.lighter_btc_initial_state
  ADD COLUMN IF NOT EXISTS live_volume_rate_pct DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS override_volume_rate_guard_threshold DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS override_volume_rate_guard_enabled BOOLEAN,
  ADD COLUMN IF NOT EXISTS override_volume_rate_guard_lookback INTEGER;

ALTER TABLE public.lighter_btc_optimal_state
  ADD COLUMN IF NOT EXISTS live_volume_rate_pct DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS override_volume_rate_guard_threshold DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS override_volume_rate_guard_enabled BOOLEAN,
  ADD COLUMN IF NOT EXISTS override_volume_rate_guard_lookback INTEGER;

ALTER TABLE public.lighter_stoch_dca_btc_state
  ADD COLUMN IF NOT EXISTS live_volume_rate_pct DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS override_volume_rate_guard_threshold DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS override_volume_rate_guard_enabled BOOLEAN,
  ADD COLUMN IF NOT EXISTS override_volume_rate_guard_lookback INTEGER;

-- RLS/anon-read policies already exist on all three tables -- new columns are covered
-- automatically, no new policy needed.
