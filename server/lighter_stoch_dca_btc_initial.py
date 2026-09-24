"""
Worker 1 -- "REVERSAL GUARD + SMART SESSION BREAKER". Real-money Lighter BTC stochastic bot.

All logic lives in stoch_bot_core; this file is settings only. Same base strategy as Worker 2's
plain fade-only (window 5, 25/75, TP 0.10%/SL 0.11%) plus reversal_guard_seconds=120 -- the
same live A/B against Worker 2 as before, now with a session drawdown breaker added on top.

History: regime-switch/trend-follow (both directions) underperformed plain fade-only in the
live A/B and a 1,092-combo tick-validated sweep -- replaced 2026-09-23 with the 120s reversal
guard (36% relative improvement, tick+latency validated). Worker 3 then got a session drawdown
breaker with a blind fixed cooldown; real data the same day showed a genuine gap -- an ER(6)-
style "is this a clean trend" check stayed under 0.75 at every window from 6-45 candles during
a real grinding decline that kept stopping out fade entries. Net DIRECTION was the reliable
signal there, not ER's trend-cleanliness measure.

Worker 1 gets a "smart resume" instead: after the base cooldown, resuming also requires recent
realized volatility (5-min range %) to be back under session_breaker_calm_range_pct -- not just
"stopped moving the same way," since crypto rarely reverts to a pre-crash level, it just
consolidates wherever it landed. If it still fails, resume is deferred and re-checked every
session_breaker_recheck_min instead of resuming blind.

Threshold/cooldown/recheck swept together (4 thresholds x 5 cooldowns x 2 recheck intervals)
against 28 hours of our own real recorded ticks (including the -1.86% crash on 2026-09-23):
0.15%/15min/10min recheck won clearly -- 179 trades, 65.9% win, +$0.321 vs baseline's 409
trades, 59.4% win, +$0.148. Tighter than Worker 3's blind-cooldown calibration (0.25%/45min) on
purpose: a false trip costs little when resume is smart (clears almost immediately once real
conditions are checked), while missing a real crash costs a lot -- that asymmetry pushes the
optimal threshold tighter than the fixed-cooldown version's calibration.

2026-09-23, later same day: originally shipped with an AND-gate (direction AND volatility both
required). Live data showed that was too strict -- only 7 trades and -0.05% equity in a stretch
where Worker 2 and Worker 3 each ran 50 trades at +0.87%/+0.78% with no breaker slowing them
down. Dropped the direction leg entirely; volatility alone is the gate now.

2026-09-24: fixed calm_range_pct=0.20 dropped in favor of session_breaker_adaptive_calm --
resume now requires volatility back to whatever it was AT the moment this specific trip
happened, not a fixed global number. Real trade data over a 6.5h live window (tick+latency
replayed, not just backtested) showed the fixed 0.20% threshold was actually the worse
config of three tested here: no breaker at all beat it (+0.62% vs +0.53%), and adaptive beat
both (+0.86%) with a materially higher win rate (67.3% vs 59.6%) on the same trip count (4) --
3 of those 4 real trips had trip-moment volatility already below 0.20%, meaning the fixed rule
was often demanding calmer conditions than even existed at the crash. Cooldown/recheck timing
(15min / 10min) re-confirmed via the same real data as still the best of 5/10/15min tested.

schema_has_position_bands stays True from the earlier regime-switch era (clears a leftover
trend-band value on close instead of leaving it stuck). schema_has_session_breaker=True is new
(migrated 2026-09-23) -- without it the breaker still works but resets on every restart,
proven costly on Worker 3 (an unrelated frontend-only deploy restarts every backend service,
since Render redeploys everything on any push, and that wiped an active cooldown twice before
persistence existed).
"""
from stoch_bot_core import BotConfig, run_bot

CONFIG = BotConfig(
    name="REVERSAL GUARD + SMART SESSION BREAKER (worker 1)",
    worker_id="worker1",
    table_state="lighter_btc_initial_state",
    table_trades="lighter_btc_initial_trades",
    table_runs="lighter_btc_initial_runs",
    stoch_window=5,
    tp_pct=0.10,
    sl_pct=0.11,
    entry_lo=25, entry_hi=75,
    reversal_lo=25, reversal_hi=75,
    reversal_guard_seconds=120,
    session_drawdown_stop_pct=0.15,
    session_breaker_cooldown_min=15.0,
    session_breaker_recheck_min=10.0,
    session_breaker_direction_window=None,  # dropped 2026-09-23: real data (7 trades, -0.05%
    # equity vs W2/W3's 50 trades at +0.87%/+0.78% over the same stretch) showed the AND-gate
    # (direction + volatility both required) kept it paused far longer than the market actually
    # warranted. Volatility alone is the gate now.
    session_breaker_calm_range_pct=None,  # unused now -- see session_breaker_adaptive_calm
    session_breaker_adaptive_calm=True,  # 2026-09-24: resume once volatility is back to
    # whatever it was AT trip time, not a fixed number. Beat both the fixed 0.20% threshold
    # and no breaker at all on real tick+latency-replayed data (+0.86% vs +0.53% vs +0.62%).
    schema_has_session_breaker=True,
    schema_has_position_bands=True,
    # Price-tick logging: last resort. Only writes if both Worker 2 and Worker 3 are quiet.
    tick_log_defers_to=["worker2", "worker3"],
)

if __name__ == "__main__":
    run_bot(CONFIG)
