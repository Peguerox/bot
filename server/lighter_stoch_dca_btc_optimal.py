"""
Worker 2 -- "OPTIMAL" settings. Real-money Lighter BTC stochastic bot.

All logic lives in stoch_bot_core; this file is settings only. Worker 2 is the reference
config the other two workers are measured against, so change it only deliberately.
"""
from stoch_bot_core import BotConfig, run_bot

CONFIG = BotConfig(
    name="OPTIMAL (worker 2)",
    table_state="lighter_btc_optimal_state",
    table_trades="lighter_btc_optimal_trades",
    table_runs="lighter_btc_optimal_runs",
    stoch_window=5,
    tp_pct=0.10,
    sl_pct=0.11,
    entry_lo=25, entry_hi=75,
    reversal_lo=25, reversal_hi=75,
)

if __name__ == "__main__":
    run_bot(CONFIG)
