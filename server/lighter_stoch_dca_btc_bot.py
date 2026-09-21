"""
Worker 3 -- "ER FILTER" settings. Real-money Lighter BTC stochastic bot.

All logic lives in stoch_bot_core; this file is settings only. Identical to Worker 2 except
for the Efficiency Ratio trend filter -- it is the live A/B test of that one variable.

ER = |net move| / total path length over ER_PERIOD closed candles: near 1 means a clean
directional trend, near 0 means chop. Entries are skipped when ER exceeds er_max, on the
theory that a mean-reversion signal should not fade a real breakout. Reversal re-entries
deliberately bypass the filter, matching how the backtest was run. A grid sweep over
period 3-30 x threshold 0.20-0.90 on real BTC candles put ER(18) <= 0.3 at the top, but
that is a single day of data -- treat it as unproven until the live A/B says otherwise.
"""
from stoch_bot_core import BotConfig, run_bot

CONFIG = BotConfig(
    name="ER FILTER (worker 3)",
    table_state="lighter_stoch_dca_btc_state",
    table_trades="lighter_stoch_dca_btc_trades",
    table_runs="lighter_stoch_dca_btc_runs",
    stoch_window=5,
    tp_pct=0.10,
    sl_pct=0.11,
    entry_lo=25, entry_hi=75,
    reversal_lo=25, reversal_hi=75,
    er_period=18,
    er_max=0.3,
)

if __name__ == "__main__":
    run_bot(CONFIG)
