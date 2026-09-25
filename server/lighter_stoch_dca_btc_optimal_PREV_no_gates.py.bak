"""
Worker 2 -- "OPTIMAL" settings. Real-money Lighter BTC stochastic bot.

All logic lives in stoch_bot_core; this file is settings only. Worker 2 is the reference
config the other two workers are measured against, so change it only deliberately.
"""
from stoch_bot_core import BotConfig, run_bot

CONFIG = BotConfig(
    name="OPTIMAL (worker 2)",
    worker_id="worker2",
    table_state="lighter_btc_optimal_state",
    table_trades="lighter_btc_optimal_trades",
    table_runs="lighter_btc_optimal_runs",
    stoch_window=5,
    tp_pct=0.10,
    sl_pct=0.11,
    entry_lo=25, entry_hi=75,
    reversal_lo=25, reversal_hi=75,
    # Price-tick logging: primary writer (trades most, so it's up most reliably). Worker 3
    # takes over if this one goes quiet, Worker 1 as last resort. See stoch_bot_core.py.
    tick_log_defers_to=[],
    tick_log_prune=True,
)

if __name__ == "__main__":
    run_bot(CONFIG)
