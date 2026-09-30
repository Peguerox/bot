"""
Hedge bot -- two fixed-direction legs, one process, two sub-accounts. 2026-09-29, direct
request: "we have 2 useless bots in worker 2 and 3 we could use... one worker with the 2
sub accounts... you only have to rewrite 1 of the workers since the other one is going to be
turned off."

Backtested first (real Lighter BTC tick data, ~29h): enter both long and short simultaneously
whenever flat, cut the losing leg at a fixed threshold, let the winning leg ride a profit-lock
trail. Threshold sweep found 0.03% clearly best (124 cycles, 90.3% win rate, +2.55% return,
beating both always-long and always-short over the same window -- not just averaging them);
0.02% was too tight to get enough cycles, 0.05% was pure noise (711 "cycles" in 29h). See
that session's chat history for the full sweep.

2026-09-30, real bug fixed same day: the first live version let each leg re-enter independently
the instant IT alone went flat, with zero awareness of the other leg -- so the leg that got cut
could keep re-entering and re-losing several times while the other side was still riding its
original trade, backwards from what was actually backtested (both enter TOGETHER, a cut leg
WAITS, both re-enter together only once the winning leg also finishes). Fixed with
cycle_partner_table (new BotConfig field, stoch_bot_core.py): each leg's fresh entry is blocked
unless its partner's own `side` is also currently null. Verified with dedicated tests
(t_cycle_partner_gate_blocks_entry_until_partner_also_flat,
t_cycle_partner_gate_fails_closed_on_read_error in test_core.py) before trusting it live.

Architecture: this single process runs TWO independent StochBot instances concurrently
(asyncio.gather), each managing its own real sub-account -- Worker 2's account trades the LONG
leg, Worker 3's account trades the SHORT leg. Worker 3's own Render service is suspended once
this is confirmed stable; its sub-account is now driven entirely from here. Reverting is just
re-enabling Worker 3's own service and disabling this dual-leg one -- no data migration, no
credential changes, both original single-account files are untouched and still work standalone.

Each leg uses `fixed_direction` (see BotConfig.fixed_direction's docstring in
stoch_bot_core.py) -- no stochastic signal at all, always tries to be in position on its one
fixed side whenever flat. Deliberately built on the SAME lean settings validated live on
Worker 2 tonight (no self-lock, no require_fresh_signal, no signal-burn gates -- those all
exist to stop a bot from repeatedly chasing one stale directional read, which is meaningless
here since there's no directional read to begin with, just "always try to be in").

Exit stack, both legs identical:
- SL 0.03% (the backtested cut threshold).
- No literal TP (disable_literal_tp=True) -- profit_lock_trail is the only take-profit path.
- profit_lock_trigger_pct=0.03 / profit_lock_trail_pct=0.01 (2026-09-30, direct request, real
  gap found and fixed same day): originally 0.05, but with SL at 0.03, a leg that peaked below
  0.05% and reversed had ZERO protection until it hit its own -0.03% SL -- meaning a cycle
  could end with BOTH legs losing instead of the intended one-wins/one-loses-small. Arming at
  the SAME level the other leg gets cut means the winning leg locks in protection the moment
  it's ahead of where the loser would be stopped out, then keeps trailing up naturally as
  price improves (peak-tracking already ratchets up on its own, no new mechanism needed for
  that part). This is a NEW, not-yet-backtested combination relative to the validated 0.05/0.01
  numbers -- noted so that isn't forgotten either. True partial position scaling (the
  backtest's "lock half, trail the remaining half") is still NOT built; this remains a
  full-exit-only approximation of that.
- No self-lock, no book-opposition, no stoch-turn (all need use_joint_adaptive, which these
  legs don't use -- no volatility-adaptive formula, just the fixed SL/trail above).

Sizing: each leg trades its own account's full equity per entry, same convention every other
bot in this fleet already uses (leg_usd = seed_usd + realized_pnl_usd, see try_enter's caller
in stoch_bot_core.py) -- nothing hedge-specific needed there.

Credentials: Worker 2's leg reads the standard LIGHTER_ACCOUNT_INDEX/LIGHTER_API_KEY_INDEX/
LIGHTER_API_PRIVATE_KEY env vars already set on this Render service (unchanged). Worker 3's
leg reads WORKER3_LIGHTER_ACCOUNT_INDEX/WORKER3_LIGHTER_API_KEY_INDEX/
WORKER3_LIGHTER_API_PRIVATE_KEY -- new, distinctly-named env vars added to this same service
so one process can hold two full credential sets at once without a name collision (see
StochBot.run()'s new optional credential-override parameters in stoch_bot_core.py).

No migration needed -- both lighter_btc_optimal_state and lighter_stoch_dca_btc_state already
have every column this config touches (position bands not needed since use_joint_adaptive is
off; profit_lock_peak_pct already exists on both from earlier work tonight).
"""
import asyncio
import faulthandler
import os
from stoch_bot_core import BotConfig, StochBot

LONG_CONFIG = BotConfig(
    name="HEDGE LONG LEG (worker 2 account)",
    worker_id="worker2",
    table_state="lighter_btc_optimal_state",
    table_trades="lighter_btc_optimal_trades",
    table_runs="lighter_btc_optimal_runs",
    # Unused while fixed_direction is set -- no stochastic signal computed at all -- left at
    # harmless reference values, required fields with no default.
    stoch_window=5, entry_lo=25, entry_hi=75, reversal_lo=25, reversal_hi=75,
    fixed_direction="long",
    tp_pct=0.10, sl_pct=0.03,  # sl_pct is the real, live value here (use_joint_adaptive off)
    fixed_leg_usd=10.0,  # direct request: same $ per leg, not the account's full balance
    debug_verbose_tick=False,  # off -- faulthandler below only fires if actually stuck
    # 2026-09-30, direct request, correcting a real bug: this leg will NOT re-enter on its
    # own just because it went flat -- it waits until the SHORT leg (lighter_stoch_dca_btc_
    # state) is also flat, so both legs enter together and a cut leg can't repeatedly re-lose
    # while the other side is still running. See BotConfig.cycle_partner_table's docstring.
    cycle_partner_table="lighter_stoch_dca_btc_state",
    disable_literal_tp=True,
    profit_lock_enabled=True,
    profit_lock_trigger_pct=0.03,
    profit_lock_trail_pct=0.01,
    schema_has_profit_lock=True,
    require_fresh_signal=False,
    red_exit_burns_signal=False,
    profit_lock_burns_signal=False,
    self_lock_enabled=False,
    use_joint_adaptive=False,
    stoch_turn_exit_enabled=False,
    book_opposition_exit_enabled=False,
    tick_log_defers_to=None,
    trade_flow_log_defers_to=None,
    unified_market_data_table=None,
)

SHORT_CONFIG = BotConfig(
    name="HEDGE SHORT LEG (worker 3 account)",
    worker_id="worker3",
    table_state="lighter_stoch_dca_btc_state",
    table_trades="lighter_stoch_dca_btc_trades",
    table_runs="lighter_stoch_dca_btc_runs",
    stoch_window=5, entry_lo=25, entry_hi=75, reversal_lo=25, reversal_hi=75,
    fixed_direction="short",
    tp_pct=0.10, sl_pct=0.03,
    fixed_leg_usd=10.0,  # direct request: same $ per leg, not the account's full balance
    debug_verbose_tick=False,  # off -- faulthandler below only fires if actually stuck
    # Reciprocal of the long leg's gate above -- waits for lighter_btc_optimal_state (the
    # LONG leg) to also be flat before re-entering.
    cycle_partner_table="lighter_btc_optimal_state",
    disable_literal_tp=True,
    profit_lock_enabled=True,
    profit_lock_trigger_pct=0.03,
    profit_lock_trail_pct=0.01,
    schema_has_profit_lock=True,
    require_fresh_signal=False,
    red_exit_burns_signal=False,
    profit_lock_burns_signal=False,
    self_lock_enabled=False,
    use_joint_adaptive=False,
    stoch_turn_exit_enabled=False,
    book_opposition_exit_enabled=False,
    tick_log_defers_to=None,
    trade_flow_log_defers_to=None,
    unified_market_data_table=None,
)


async def main():
    long_bot = StochBot(LONG_CONFIG)
    short_bot = StochBot(SHORT_CONFIG)
    await asyncio.gather(
        long_bot.run(),  # default credentials: this service's own LIGHTER_* env vars
        short_bot.run(
            account_index=int(os.environ["WORKER3_LIGHTER_ACCOUNT_INDEX"]),
            api_key_index=int(os.environ["WORKER3_LIGHTER_API_KEY_INDEX"]),
            api_private_key=os.environ["WORKER3_LIGHTER_API_PRIVATE_KEY"],
        ),
    )


if __name__ == "__main__":
    # Temporary diagnostic (2026-09-30, from external review): dumps every thread's real
    # Python stack trace every 30s from a separate watchdog thread, independent of the asyncio
    # event loop -- catches a genuine synchronous block even in cases where tick_watchdog_timeout
    # (which relies on asyncio.wait_for, itself not a hard deadline against a truly blocking
    # call) never fires. Doesn't change any trading logic. Remove once the freeze is found.
    faulthandler.enable()
    faulthandler.dump_traceback_later(30, repeat=True)
    try:
        asyncio.run(main())
    finally:
        faulthandler.cancel_dump_traceback_later()
