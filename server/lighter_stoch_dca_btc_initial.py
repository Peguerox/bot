"""
Worker 1 -- "REVERSAL GUARD". Real-money Lighter BTC stochastic bot.

All logic lives in stoch_bot_core; this file is settings only. Same as Worker 2's plain
fade-only strategy (window 5, 25/75, TP 0.10%/SL 0.11%, no regime switch) -- the ONLY
difference is reversal_guard_seconds=120, isolating that one variable as a live A/B against
Worker 2.

2026-09-23: dropped the regime-switch/trend-follow experiment. Neither Worker 1 (inverted
trend) nor Worker 3 (normal trend) was outperforming plain fade-only in the live A/B or in a
1,092-combo tick-validated parameter sweep over the same data -- plain fade-only (matching
Worker 2) was the best performer found. Replaced with a different, independently validated
idea instead: a 120-second minimum position age before an opposite-side signal can close/
reverse it (TP/SL still fire immediately, unaffected). Tested against 14,842 real recorded
ticks + the 1.4s execution-latency model (calibrated earlier against real Worker 2 trades to
within ~0.17 percentage points): 162->157 trades, 62.96%->64.97% win rate, +1.698%->+2.304%
total (a ~36% relative improvement), driven by fewer premature reversals (62->56) converting
into more real TPs (51->54). Single 11.3-hour bull-market session -- a live A/B is the next
real test, not proof across regimes.

schema_has_position_bands stays True (not because this bot uses regime-switch anymore, but
because its table already has the position_tp_pct/position_sl_pct columns from when it did --
this makes sure the leftover trend-band value on the currently-open position gets cleared
properly on its next close instead of silently lingering forever).
"""
from stoch_bot_core import BotConfig, run_bot

CONFIG = BotConfig(
    name="REVERSAL GUARD (worker 1)",
    worker_id="worker1",
    table_state="lighter_btc_initial_state",
    table_trades="lighter_btc_initial_trades",
    table_runs="lighter_btc_initial_runs",
    stoch_window=5,
    tp_pct=0.10,
    sl_pct=0.11,
    entry_lo=25, entry_hi=75,
    reversal_lo=25, reversal_hi=75,
    reversal_guard_seconds=120,
    schema_has_position_bands=True,
    # Price-tick logging: last resort. Only writes if both Worker 2 and Worker 3 are quiet.
    tick_log_defers_to=["worker2", "worker3"],
)

if __name__ == "__main__":
    run_bot(CONFIG)
