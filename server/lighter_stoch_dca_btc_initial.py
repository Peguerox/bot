"""
Worker 1 -- "REGIME SWITCH (window 9)". Real-money Lighter BTC stochastic bot.

All logic lives in stoch_bot_core; this file is settings only. Same regime-switch strategy
as Worker 3, differing only in stoch_window (9 here vs 5 on Worker 3) -- a live A/B of that
one variable, matching how Worker 1 vs Worker 2 tested window on the plain fade-only
strategy. Worker 2 stays on the plain fade-only strategy as the unrelated baseline.

Regime switch: ER(6) <= 0.75 -> chop, fade the stochastic extreme (TP 0.10% / SL 0.11%).
ER(6) > 0.75 -> trending, trade WITH the last 6 candles' net direction instead, with its
own wider TP/SL (0.30% / 0.30%) so a real move has room to be captured instead of getting
stopped out by a band sized for chop. Backtested on a 3.5-day, 5000-candle sample
(/tmp/er_regime_switch.py, 2026-09-22): window 9 reached +6.85% total (+2.50%/+4.00%
split-sample) vs window 5's +3.11% (+0.41%/+2.48%) on the same search.
"""
from stoch_bot_core import BotConfig, run_bot

CONFIG = BotConfig(
    name="REGIME SWITCH (worker 1, window 9)",
    worker_id="worker1",
    table_state="lighter_btc_initial_state",
    table_trades="lighter_btc_initial_trades",
    table_runs="lighter_btc_initial_runs",
    stoch_window=9,
    tp_pct=0.10,
    sl_pct=0.11,
    entry_lo=25, entry_hi=75,
    reversal_lo=25, reversal_hi=75,
    er_period=6,
    er_max=0.75,
    trend_tp_pct=0.30,
    trend_sl_pct=0.30,
    # Price-tick logging: last resort. Only writes if both Worker 2 and Worker 3 are quiet.
    tick_log_defers_to=["worker2", "worker3"],
)

if __name__ == "__main__":
    run_bot(CONFIG)
