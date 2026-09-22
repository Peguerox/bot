"""
Worker 3 -- "ER FILTER" settings. Real-money Lighter BTC stochastic bot.

All logic lives in stoch_bot_core; this file is settings only. Identical to Worker 2 except
for the Efficiency Ratio trend filter -- it is the live A/B test of that one variable.

ER = |net move| / total path length over ER_PERIOD closed candles: near 1 means a clean
directional trend, near 0 means chop. Entries are skipped when ER exceeds er_max, on the
theory that a mean-reversion signal should not fade a real breakout. Reversal re-entries
deliberately bypass the filter, matching how the backtest was run.

ER(18)<=0.3 was picked from a one-day backtest and later proved not robust: on a 3.5-day,
5000-candle sample it ranked 772nd of 1368 combos tested and was net negative in the first
half of that sample. ER(34)<=0.2 -- longer lookback, tighter threshold -- was the only
top-ranked config that stayed net positive in BOTH halves of a split-sample check, so it
replaced ER(18)<=0.3 on 2026-09-22. Fewer entries than the old setting (773 vs 802 trades
in the search sample), but the ones it skips are disproportionately the bad ones. Still a
single-symbol backtest on one exchange's candles -- keep validating against the live A/B.
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
    er_period=34,
    er_max=0.2,
)

if __name__ == "__main__":
    run_bot(CONFIG)
