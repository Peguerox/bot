"""
Worker 3 -- "ENTRY VOLATILITY GUARD". Real-money Lighter BTC stochastic bot.

All logic lives in stoch_bot_core; this file is settings only. Same base strategy as Worker
2's plain fade-only (window 5, 25/75, TP 0.10%/SL 0.11%).

History: pure ER filter, then regime switch, then pure ER-fade (window 6), then a session
drawdown breaker (blind fixed cooldown, 45min then 20min) -- none of these beat plain
fade-only (Worker 2) decisively enough to keep. Worker 3 has been the deliberately
lower-commitment slot for trying a new mechanism each round, unlike Worker 1's more settled
config -- see [[project_lighter_btc_3worker_comparison]].

2026-09-24: replaced the session breaker entirely with a different mechanism, proposed and
backtested by a separate agent working from the same real recorded tick/candle data this
project already uses. Instead of tracking PnL drawdown, this gates purely on raw market
volatility:

1. At each completed 1-min candle, compute true range % = 100 * max(high-low,
   abs(high-prev_close), abs(low-prev_close)) / close -- true range (not just high-low)
   catches a candle that opens on a gap even if its own span is narrow.
2. Pause new entries (including the reopening leg of a reversal) once TR% >= 0.15%.
3. Resume only once a later completed candle comes in at or under TR% <= 0.1125% -- a
   deliberately LOWER bar than the pause threshold, so it doesn't flap on/off right at one
   boundary. No fixed cooldown on top -- resumes the moment a calm candle prints.
4. Reversal-driven CLOSE (not reopen) requires 180s minimum position age (was 120s) --
   longer than before, on the same reasoning as the original guard: a fresh position
   shouldn't get flipped by noise, and the wider margin held up better in the backtest.
5. TP/SL and the reversal close leg are NEVER gated by any of this -- risk management always
   runs regardless of whether entries are paused.

Backtested (quote-replay, real recorded ticks/candles, execution-latency modeled) on ~25h of
data: return +0.20% -> +1.59%, max drawdown 2.59% -> 1.27%, stop count 124 -> 93, paused ~6%
of the time (median pause ~2 minutes, not a fixed lockout). Walk-forward validated on a held-
out later block (not just fit-and-reported on the same window): +1.88% vs Worker 2's +1.18%
on that block alone. Full report + implementation reference delivered directly, not committed
to this repo -- this file is the applied config, tuned to match.

Known limitation, disclosed in that report and worth remembering: under combined execution
stress (wider spread, extra slippage, slower fills, delayed reversal re-entry) the modeled
edge nearly disappears (-1.23%, though still better than Worker 2's -2.47% under the same
stress) -- this is the same tight-margin fee/slippage sensitivity this project has run into
before (TP/SL of 0.10%/0.11% leaves very little room). Live result is the real test.

schema_has_entry_vol_gate=True (migrated 2026-09-24) persists the pause state across a
restart, for the same reason schema_has_session_breaker existed -- Render redeploys every
service on any push, and an active pause shouldn't silently reset.
"""
from stoch_bot_core import BotConfig, run_bot

CONFIG = BotConfig(
    name="ENTRY VOLATILITY GUARD (worker 3)",
    worker_id="worker3",
    table_state="lighter_stoch_dca_btc_state",
    table_trades="lighter_stoch_dca_btc_trades",
    table_runs="lighter_stoch_dca_btc_runs",
    stoch_window=5,
    tp_pct=0.10,
    sl_pct=0.11,
    entry_lo=25, entry_hi=75,
    reversal_lo=25, reversal_hi=75,
    reversal_guard_seconds=180,  # was 120 -- widened per the new strategy's own backtest
    entry_vol_pause_at_pct=0.15,
    entry_vol_resume_at_pct=0.1125,
    schema_has_entry_vol_gate=True,
    schema_has_position_bands=True,
    # Price-tick logging: backup writer. Takes over the moment Worker 2 goes quiet.
    tick_log_defers_to=["worker2"],
)

if __name__ == "__main__":
    run_bot(CONFIG)
