"""
Worker 3 -- "REVERSAL GUARD + SESSION BREAKER". Real-money Lighter BTC stochastic bot.

All logic lives in stoch_bot_core; this file is settings only. Identical to Worker 1's
strategy (window 5, 25/75, TP 0.10%/SL 0.11%, reversal_guard_seconds=120) -- the ONLY
difference is session_drawdown_stop_pct=0.4, isolating that one variable as a live A/B
against Worker 1.

History: pure ER filter, then regime switch, then pure ER-fade (window 6) -- none of these
beat plain fade-only (Worker 2) or Worker 1's reversal guard in live trading or backtests.

2026-09-23: cloned Worker 1's winning config and added a session drawdown breaker. The day
splits into 3 fixed 8h sessions (11am-7pm ET, 7pm-3am ET, 3am-11am ET). Once a session has
been realized-profitable at least once, if it gives back 0.4% of total account equity from
that session's own peak, new entries stop for the rest of THAT session (existing positions
still manage normally to TP/SL/reversal-guard) -- re-arms fresh at the next session boundary.
Calibrated against one real crashed session (max drawdown 1.00%, ended -0.522%) vs one real
good session (max post-profit drawdown 0.2491%) on 2026-09-22/23: 0.4% never triggered on the
good session and caught the bad one early (~00:27 into it), avoiding roughly half its eventual
loss. Single example of each -- this is a live test, not a settled parameter.
"""
from stoch_bot_core import BotConfig, run_bot

CONFIG = BotConfig(
    name="REVERSAL GUARD + SESSION BREAKER (worker 3)",
    worker_id="worker3",
    table_state="lighter_stoch_dca_btc_state",
    table_trades="lighter_stoch_dca_btc_trades",
    table_runs="lighter_stoch_dca_btc_runs",
    stoch_window=5,
    tp_pct=0.10,
    sl_pct=0.11,
    entry_lo=25, entry_hi=75,
    reversal_lo=25, reversal_hi=75,
    reversal_guard_seconds=120,
    session_drawdown_stop_pct=0.4,
    schema_has_position_bands=True,
    # Price-tick logging: backup writer. Takes over the moment Worker 2 goes quiet.
    tick_log_defers_to=["worker2"],
)

if __name__ == "__main__":
    run_bot(CONFIG)
