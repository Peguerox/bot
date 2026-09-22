"""
Worker 1 -- "REGIME SWITCH, INVERTED TREND". Real-money Lighter BTC stochastic bot.

All logic lives in stoch_bot_core; this file is settings only. Same settings as Worker 3
(window 5, ER(6)>0.75, trend TP/SL 0.30%/0.30%) -- the ONLY difference is
trend_invert_direction=True, isolating that one variable as a live A/B against Worker 3.

2026-09-22: this bot previously ran the regime-switch strategy at window 9 as an A/B against
Worker 3's window 5. Reconfigured after live data showed trend-regime entries losing on both
workers (W1: 34 trades, 41.2% win rate, -0.28 total; W3: 38 trades, 42.1% win rate, -0.28
total) while fade-regime entries stayed near breakeven (52-55% win rate) -- consistent with
the lagging ER(6) trend confirmation catching moves right as they exhaust and reverse
(observed directly in two live examples around 23:00-23:13 UTC). Testing whether fading the
"confirmed trend" instead of following it does better. Not backtested first -- live A/B only.
"""
from stoch_bot_core import BotConfig, run_bot

CONFIG = BotConfig(
    name="REGIME SWITCH, INVERTED TREND (worker 1)",
    worker_id="worker1",
    table_state="lighter_btc_initial_state",
    table_trades="lighter_btc_initial_trades",
    table_runs="lighter_btc_initial_runs",
    stoch_window=5,
    tp_pct=0.10,
    sl_pct=0.11,
    entry_lo=25, entry_hi=75,
    reversal_lo=25, reversal_hi=75,
    er_period=6,
    er_max=0.75,
    trend_tp_pct=0.30,
    trend_sl_pct=0.30,
    trend_invert_direction=True,
    # Price-tick logging: last resort. Only writes if both Worker 2 and Worker 3 are quiet.
    tick_log_defers_to=["worker2", "worker3"],
)

if __name__ == "__main__":
    run_bot(CONFIG)
