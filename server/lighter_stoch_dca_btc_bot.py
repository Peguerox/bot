"""
Worker 3 -- "PURE ER FADE". Real-money Lighter BTC stochastic bot.

All logic lives in stoch_bot_core; this file is settings only.

History: started as a pure ER *filter* (skip entries when ER is too trend-like), then a
regime *switch* (fade in chop, follow the trend with a wider band when ER(6)>0.75). Neither
the switch's trend-follow leg (Worker 3) nor its inverted variant (Worker 1) beat plain
fade-only in the live A/B or in a 1,092-combo tick-validated parameter sweep -- Worker 1 was
reconfigured off regime-switch entirely on 2026-09-23 (see its own file).

2026-09-23: replaced with a much simpler idea tested independently of all that stochastic
machinery -- no stochastic entries at all, ER is the ONLY signal, and instead of following a
detected trend it fades it (bets on reversal), exiting via TP/SL only (no reversal exit).
Swept ER window 2-20 on 14.3 hours of real recorded ticks + the 1.4s execution-latency model:
windows 2-9 were consistently profitable, window 6 was the best balance of sample size and
edge (56 trades, 62.5% win rate, +1.524% total). Single-session data, real money is the actual
test.
"""
from stoch_bot_core import BotConfig, run_bot

CONFIG = BotConfig(
    name="PURE ER FADE (worker 3, window 6)",
    worker_id="worker3",
    table_state="lighter_stoch_dca_btc_state",
    table_trades="lighter_stoch_dca_btc_trades",
    table_runs="lighter_stoch_dca_btc_runs",
    stoch_window=5,  # unused -- pure_trend_fade skips the stochastic signal entirely
    tp_pct=0.10,
    sl_pct=0.10,
    entry_lo=25, entry_hi=75,
    reversal_lo=25, reversal_hi=75,
    er_period=6,
    er_max=0.75,
    trend_invert_direction=True,  # fade the detected trend, don't follow it
    pure_trend_fade=True,
    schema_has_position_bands=True,
    # Price-tick logging: backup writer. Takes over the moment Worker 2 goes quiet.
    tick_log_defers_to=["worker2"],
)

if __name__ == "__main__":
    run_bot(CONFIG)
