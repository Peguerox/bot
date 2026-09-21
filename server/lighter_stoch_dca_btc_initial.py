"""
Worker 1 -- "INITIAL" settings. Real-money Lighter BTC stochastic bot.

All logic lives in stoch_bot_core; this file is settings only. Identical to Worker 2 except
for the stochastic window (9 vs 5) -- it is the live A/B test of that one variable, so keep
everything else in lockstep with the OPTIMAL config.
"""
from stoch_bot_core import BotConfig, run_bot

CONFIG = BotConfig(
    name="INITIAL (worker 1)",
    table_state="lighter_btc_initial_state",
    table_trades="lighter_btc_initial_trades",
    table_runs="lighter_btc_initial_runs",
    stoch_window=9,
    tp_pct=0.10,
    sl_pct=0.11,
    entry_lo=25, entry_hi=75,
    reversal_lo=25, reversal_hi=75,
)

if __name__ == "__main__":
    run_bot(CONFIG)
