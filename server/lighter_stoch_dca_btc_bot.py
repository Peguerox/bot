"""
Worker 3 -- "REGIME SWITCH" settings. Real-money Lighter BTC stochastic bot.

All logic lives in stoch_bot_core; this file is settings only.

History: started as a pure ER *filter* (skip entries when ER is too trend-like). Two
versions of that were tried and abandoned after larger backtests -- ER(18)<=0.3 ranked
772nd of 1368 combos on a 3.5-day sample and was net negative in half of it; ER(34)<=0.2
fixed that (positive in both halves) but only reached +1.15% on the same sample, barely
better than doing nothing during the trend.

2026-09-22: replaced with a regime SWITCH instead of a filter. Blocking a real trend just
means missing the whole move. Trading it in the trend's own direction, with its own wider
TP/SL, captures it instead:

  - ER(6) <= 0.75  -> chop. Fade the stochastic extreme as normal, TP 0.10% / SL 0.11%.
  - ER(6) >  0.75  -> trending. Trade WITH the direction of the last 6 candles' net move
    instead of fading the stochastic, TP 0.30% / SL 0.30% (needs room to actually ride a
    real move instead of getting stopped out by the same tight band built for chop).

Kept at window 5 here specifically to A/B against Worker 1, which runs this exact same
regime-switch strategy at window 9 -- window 9 backtested stronger (+6.85% vs this
config's +3.11% on the same 3.5-day sample) but the live comparison is the real test.
Grid search + split-sample check on 5000 real BTC candles: /tmp/er_regime_switch.py
(2026-09-22).

Still a single-symbol backtest on one exchange's candles, and this is a structurally
different strategy from Worker 2's (which stays on plain fade-only as the baseline), not
a parameter tweak -- keep validating against the live A/B, especially through a real
NYSE-open trend event.
"""
from stoch_bot_core import BotConfig, run_bot

CONFIG = BotConfig(
    name="REGIME SWITCH (worker 3, window 5)",
    worker_id="worker3",
    table_state="lighter_stoch_dca_btc_state",
    table_trades="lighter_stoch_dca_btc_trades",
    table_runs="lighter_stoch_dca_btc_runs",
    stoch_window=5,
    tp_pct=0.10,
    sl_pct=0.11,
    entry_lo=25, entry_hi=75,
    reversal_lo=25, reversal_hi=75,
    er_period=6,
    er_max=0.75,
    trend_tp_pct=0.30,
    trend_sl_pct=0.30,
    # Price-tick logging: backup writer. Takes over the moment Worker 2 goes quiet.
    tick_log_defers_to=["worker2"],
)

if __name__ == "__main__":
    run_bot(CONFIG)
