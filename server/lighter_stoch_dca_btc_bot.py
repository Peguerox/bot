"""
Worker 3 -- "SELF-LOCK". Real-money Lighter BTC stochastic bot.

All logic lives in stoch_bot_core; this file is settings only. Base strategy is Worker 2's
plain fade-only (window 5, 25/75, TP 0.10%/SL 0.11%, no session breaker, no volatility gate)
plus a 120s reversal guard -- Worker 3 has been the deliberately lower-commitment slot for
trying a new mechanism each round, unlike Worker 1's more settled config.

History: pure ER filter, then regime switch, then pure ER-fade, then a session drawdown
breaker (blind cooldown), then an entry volatility gate (single-candle true range % pause/
resume) -- none of these beat plain fade-only decisively enough to keep. See
[[project_worker3_prior_config_blind_breaker]] for the breaker's exact config if we ever want
it back.

2026-09-24, third iteration: the volatility gate is dropped too. Real data showed it detected
real spikes correctly but then continued trading through most of them anyway (about half of
all pause episodes blocked nothing at all, because market volatility and the stochastic
signal aren't synchronized -- a spike with no live signal at that exact moment is a pause that
does nothing). Replaced with a mechanism that reacts to OUR OWN outcomes instead of the raw
market:

1. Base signal is Worker 2's: no session breaker, no volatility gate, plus a 120s reversal
   guard (added after a same-day real-data check specifically on this mechanism -- see below).
   Real trading starts unlocked.
2. The instant a REAL position closes via SL (not REVERSAL -- SL specifically, the genuine
   adverse-move signal), real order placement locks immediately.
3. While locked, the bot keeps trading the identical signal (120s guard included) on a
   continuous internal PAPER shadow -- same TP/SL/reversal logic, real market prices, zero
   real money, zero real orders.
4. Two CONSECUTIVE paper TPs unlock real trading again (a paper SL in between resets that
   count back to zero -- needs two in a row, not two total).
5. The unlock is same-tick: if a live entry signal already exists at the exact moment the 2nd
   paper TP closes, real trading enters on it immediately, not on a delay waiting for a fresh
   signal to form separately.

The logic is proving the market is tradeable again by actually trading through it on paper,
not by guessing from a timer (the old session breaker) or a volatility reading (the gate this
replaces) -- both of those react to conditions that don't necessarily correlate with whether
THIS strategy specifically would do well right now.

Reversal guard: backtested (quote-replay, real recorded ticks/candles, both the real position
and the paper shadow using the identical guard) specifically for this mechanism, not assumed
from Worker 1's result in a different context -- no guard gave +1.14% return / $0.176 max
drawdown over 46h; adding 120s gave +2.18% / $0.235 max drawdown. Return nearly doubled for a
modest drawdown increase.

schema_has_self_lock=True (migrated 2026-09-24) persists the lock state and paper shadow's
position across a restart, for the same reason every other gate on this table has needed it --
Render redeploys every service on any push, and an active lock or in-progress paper position
shouldn't silently reset.
"""
from stoch_bot_core import BotConfig, run_bot

CONFIG = BotConfig(
    name="SELF-LOCK (worker 3)",
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
    self_lock_enabled=True,
    schema_has_self_lock=True,
    schema_has_position_bands=True,
    # Price-tick logging: backup writer. Takes over the moment Worker 2 goes quiet.
    tick_log_defers_to=["worker2"],
)

if __name__ == "__main__":
    run_bot(CONFIG)
