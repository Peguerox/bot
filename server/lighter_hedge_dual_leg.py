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

2026-09-30, audit of this file after "worker 2 is the main issue": two independent bugs were
each making a cycle net-negative no matter the win rate, and both are fixed.
  1. The SHORT leg's real stop was 0.0909%, not the configured 0.03%. stoch_bot_core.py read
     position_sl_pct off the state row unguarded, while every WRITE to that column is gated behind
     schema_has_position_bands (False here) -- so the leg honoured a value left in
     lighter_stoch_dca_btc_state by the retired Worker 3 joint-adaptive strategy that owned the
     table before this pivot. Price up therefore meant the long trailed out for a small win while
     the short bled ~3x further than designed. Fixed by guarding the read; the stale values are
     also nulled by lighter_hedge_worker2_audit_fixes.sql and cleared by the Reset button.
  2. The profit-lock trigger had been lowered to 0.03 with a 0.01 trail, which scalped the winner
     out at ~+0.02% while the loser kept the full -0.03%. Reverted to 0.05 and the real gap it was
     trying to close is now handled by breakeven_floor_enabled. See the exit stack below.

2026-09-30, second session, after watching the above run live for the first time -- two more:
  3. The legs desynced and traded NAKED. cycle_partner_table is a plain DB read, which enforced
     only "a cut leg waits" and never "both enter together": whichever leg polled first entered and
     the other was then blocked by it, so one beat of skew put them permanently out of phase, each
     opening a lone $10 directional leg. Replaced by an in-process barrier shared through
     main()'s cycle_hub -- both legs are in one event loop, so the decision is now made once for
     both, atomically. See StochBot._cycle_gate_clear_to_enter.
  4. The breakeven floor pinned every cycle to exactly zero. See breakeven_floor_arm_margin_pct in
     the exit stack below.
Neither was visible on the dashboard, because its cycle list paired the Nth long with the Nth
short by index and truncated to the shorter list -- so the unpaired naked leg was silently dropped
and it looked like trades were not being recorded. Now paired by entry time, with any unpartnered
leg shown as UNHEDGED rather than hidden.
Also: single_instance_lock added (Render runs two copies of this process during every deploy, and
nothing previously stopped both from entering -- the zombie double-entry), and the shared pressure
signal is now published every tick instead of only at the owner leg's own entry, which used to let
the follower leg size off the previous cycle's reading.

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
- WIDENED 2026-09-30 to sl 0.06 / trigger 0.10 / trail 0.03, from 0.03 / 0.05 / 0.01.
  Direct request during the US-market open, when volatility spiked and the double-loss rate hit 30%
  live ("both legs are losing every time... the whiplash is hitting the stop at -0.03 and then
  whiplashing and hitting the other one too"). Confirmed against real ticks before deploying, on
  BOTH the full 8 days and today's volatile window: the old 0.03/0.05/0.01 is a statistically
  significant LOSER (-$2.02 over 4880 cycles, 5.98 sigma -- not noise), and widening the stop cuts
  whipsaw double-kills roughly in half (23.1% -> 14.7% over 8 days; 30.1% -> 14.7% today). At these
  values the 8-day result is -$0.38 at 1.15 sigma, i.e. no longer distinguishable from breakeven,
  and today's window is positive (+$0.00012/cycle vs -$0.00084 on the old settings).

  The mechanism is causal rather than curve-fit: a wider stop survives a reversal that would
  otherwise stop out BOTH legs, and the improvement is monotonic in stop width across every
  combination tested. The cost is frequency -- roughly half the cycles, since each one lasts longer.
  Wider still (0.10/0.14/0.04) tested flatter yet, but trades too rarely to learn from quickly.

  The previously-frozen pair below is kept for reference and is what tag hedge-v1-working restores.
- HISTORICAL: profit_lock_trigger_pct=0.05 / profit_lock_trail_pct=0.01 (the backtested pair).
  Briefly lowered to a 0.03 trigger earlier on 2026-09-30 to close a real protection gap (a leg
  that peaked below 0.05% and reversed had nothing under it but its own -0.03% SL, so a cycle
  could end with BOTH legs losing). REVERTED the same day after an audit: at a 0.03 trigger the
  winner armed at +0.03% and was then stopped by the 0.01% trail on the very next wiggle -- 0.01%
  of BTC at $83k is ~$8.30, inside ordinary tick noise -- so it booked ~+0.02% while the loser was
  still allowed the full -0.03%. That is roughly -0.01% per cycle, i.e. structurally negative
  REGARDLESS of win rate, and it matches the reported symptom exactly ("the important leg every
  time will close and we stay with the bad leg"). The trigger change fixed the gap by destroying
  the edge.
- breakeven_floor_enabled=True (2026-09-30, direct request) -- the correct fix for that same gap,
  from the other direction: once the OTHER leg has been cut, this leg's profit is never allowed to
  slide back below the level that makes the cycle break even (reason "BREAKEVEN_LOCK"). Between
  breakeven and +0.05% it is the only protection; above +0.05% the trail normally fires first.
  breakeven_floor_arm_margin_pct=0.01 is load-bearing, learned the hard way in this feature's very
  first live session: a symmetric hedge puts the winner at ~+X% at the exact instant the loser is
  cut at -X%, so a floor at X% with no margin armed precisely where the winner already stood and
  the next tick of noise closed it. Every cycle then netted dead zero (long +0.00286 / short
  -0.00298; long +0.00395 / short -0.00356) -- guaranteeing breakeven also guarantees never
  profiting. With the margin the floor stays dormant until the winner clears it by the trail width
  ("at 0.04, lock 0.03"), so it protects a genuine reversal instead of capping every winner. The
  level is computed from the partner's realized DOLLARS over this leg's own notional, not
  hardcoded, because pressure_bias can size the legs $15/$5 and +0.03% on a $5 winner does not
  offset -0.03% on a $15 loser. See BotConfig.breakeven_floor_enabled's docstring.
  NEW and not yet backtested on top of the validated 0.05/0.01 + 0.03 numbers -- noted so that
  isn't forgotten. True partial position scaling (the backtest's "lock half, trail the remaining
  half") is still NOT built; this remains a full-exit-only approximation of that.
- No self-lock, no book-opposition, no stoch-turn (all need use_joint_adaptive, which these
  legs don't use -- no volatility-adaptive formula, just the fixed SL/trail above).

Sizing: a fixed $10 per leg (fixed_leg_usd), EQUAL on both sides -- direct request, same $ per leg
regardless of either sub-account's balance.

2026-09-30, direct correction: the legs are $10/$10 and pressure_bias_enabled is OFF on both.
7cfe5ef had read the 2026-09-29 request ("we need some signal so there is pressure some where, the
stochastic 25/75 is good enough") as licence to make the leg SIZES unequal -- $15 for whichever
side K favoured, $5 for the other. That was never asked for: the request was for a signal to see,
not for a 3:1 directional tilt. It also silently disabled the breakeven floor in one direction, as
a $5 winner needs +0.09% to offset a $15 loser's -0.03% while the profit-lock trail exits at
~0.05%, so a cycle whose winner was the small leg could never be brought back to even.

The K value is still computed by the owner leg and shown on the dashboard -- it is a readout, and
no longer changes anything. The machinery below is left in place (disabled) rather than deleted so
a deliberate, requested version of it can be switched back on without rebuilding it.

HISTORICAL, describing the now-disabled tilt: pressure_bias_enabled tilts each leg's size using ONE
shared stochastic K
(entry_lo=25/entry_hi=75) -- fixed_direction's own entry/exit logic never looks at it, this is
purely a sizing tilt on top. ONE signal only, computed by exactly one leg: LONG_CONFIG has
pressure_signal_owner=True, so the long leg alone calls compute_stoch_signal() and publishes it
into main()'s shared_pressure_hub EVERY TICK (corrected 2026-09-30: it used to publish only at its
own entry moment, so whichever leg reached its entry code first won a race and the follower could
size off the previous cycle's reading, or None right after boot); the short leg only ever reads
(direct correction, 2026-09-29 -- an earlier version had each leg computing and merging its own
independent reading, needless complexity for what's one strategy with one signal). Whichever
direction that one signal favors, both legs still always enter together as always
(cycle_partner_table untouched) -- the signal only changes how much each leg risks that cycle:
bigger ($10+$5=$15) for whichever leg the signal agrees with, smaller ($10-$5=$5, floored at
pressure_bias_min_usd=$2) for the other, unchanged ($10) when K sits in the neutral 25-75 zone.
New, not-yet-backtested on top of the validated 0.03%-cut numbers -- noted so that isn't
forgotten either. See BotConfig.pressure_bias_enabled/pressure_signal_owner's docstrings in
stoch_bot_core.py and _pressure_biased_leg_usd for the exact mechanics.

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
    tp_pct=0.10, sl_pct=0.06,  # sl_pct is the real, live value here (use_joint_adaptive off)
    fixed_leg_usd=10.0,  # direct request: same $ per leg, not the account's full balance
    # 2026-09-29, direct request: bias size off the raw stochastic K -- see the module
    # docstring's "Sizing" section and BotConfig.pressure_bias_enabled's docstring.
    # 2026-09-30, direct correction: BACK TO $10/$10. 7cfe5ef turned the requested 25/75 signal
    # into a 3:1 SIZE tilt ($15 favoured leg / $5 other) that was never asked for -- the request
    # was for a signal to look at, not for unequal legs. The tilt also quietly broke the breakeven
    # floor: a $5 winner must make +0.09% to offset a $15 loser's -0.03%, but the profit-lock trail
    # exits at ~0.05%, so whenever the small leg was the winner the cycle could not be brought back
    # to even and the floor never got the chance to fire. Equal legs keep the hedge delta-neutral
    # and keep breakeven reachable from either side.
    # The K value is still computed and shown on the dashboard (schema_has_live_signal +
    # pressure_signal_owner below) -- it is a readout now, and changes nothing about size.
    pressure_bias_enabled=False,
    # 2026-09-30, direct request -- what the 25/75 was for all along: only OPEN a cycle when the
    # stochastic is at an extreme, i.e. when there is real pressure behind the move. Without this
    # a fixed_direction leg enters every single time it is flat, including in flat chop where
    # neither side travels far enough to reach the 0.05% trail and both legs just grind. Gates
    # WHEN a cycle opens, never which way -- both legs still enter together, both sides.
    require_pressure_to_enter=True,
    pressure_signal_owner=True,  # this leg computes the ONE shared signal; short just reads it
    # 2026-09-30, direct request: show the live K value on the dashboard. Column already exists
    # on lighter_btc_optimal_state from an earlier experiment -- no migration needed.
    schema_has_live_signal=True,
    debug_verbose_tick=False,  # off -- faulthandler below only fires if actually stuck
    # 2026-09-30, direct request, correcting a real bug: this leg will NOT re-enter on its
    # own just because it went flat -- it waits until the SHORT leg (lighter_stoch_dca_btc_
    # state) is also flat, so both legs enter together and a cut leg can't repeatedly re-lose
    # while the other side is still running. See BotConfig.cycle_partner_table's docstring.
    cycle_partner_table="lighter_stoch_dca_btc_state",
    disable_literal_tp=True,
    profit_lock_enabled=True,
    # 2026-09-30, reverted from 0.03 back to the backtested 0.05 after an audit: at 0.03 the
    # winner armed at +0.03% and was stopped by the 0.01% trail on the next wiggle (~$8 on BTC,
    # pure noise), booking ~+0.02% while the loser was allowed the full -0.03% -- roughly
    # -0.01% per cycle, negative regardless of win rate. The "protection gap" the 0.03 change
    # was meant to close (a leg peaking under the trigger with nothing but its own SL beneath
    # it) is now closed properly by breakeven_floor_enabled below instead.
    profit_lock_trigger_pct=0.10,
    profit_lock_trail_pct=0.03,
    schema_has_profit_lock=True,
    # 2026-09-30, direct request: once the OTHER leg has been cut, never let this leg's profit
    # slide back below the level that makes the cycle even. Between breakeven and +0.05% this is
    # the only protection; above +0.05% the trail above normally fires first. Derived from the
    # partner's realized dollars, so it stays correct when pressure_bias_usd sizes the legs
    # unequally -- see BotConfig.breakeven_floor_enabled's docstring.
    breakeven_floor_enabled=True,
    schema_has_breakeven_floor=True,
    # 2026-09-30: Render does not stop the old container before starting the new one, so every
    # deploy briefly runs two copies of this process -- and with nothing stopping them, both could
    # see "flat, partner flat, enter" and each place a real order (the zombie double-entry
    # incident). Only the instance holding the lock on this leg's own state row takes new entries;
    # exits are never gated on it. See BotConfig.single_instance_lock.
    single_instance_lock=True,
    # 2026-09-30, direct request: retune the exits from the dashboard without a deploy, and show
    # the live volatility they have to cope with. Volatility ran 0.048% through the quiet hours
    # and 0.117% at the US open the same day -- 2.4x -- and no single stop is right across that.
    # Manual levers first, so the best value per regime is found by observation before any
    # adaptive rule is committed to. NULL columns simply fall back to the values above.
    schema_has_exit_overrides=True,
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
    tp_pct=0.10, sl_pct=0.06,
    fixed_leg_usd=10.0,  # direct request: same $ per leg, not the account's full balance
    # 2026-09-29, direct request: bias size off the raw stochastic K -- see the module
    # docstring's "Sizing" section and BotConfig.pressure_bias_enabled's docstring.
    # 2026-09-30, direct correction: BACK TO $10/$10. 7cfe5ef turned the requested 25/75 signal
    # into a 3:1 SIZE tilt ($15 favoured leg / $5 other) that was never asked for -- the request
    # was for a signal to look at, not for unequal legs. The tilt also quietly broke the breakeven
    # floor: a $5 winner must make +0.09% to offset a $15 loser's -0.03%, but the profit-lock trail
    # exits at ~0.05%, so whenever the small leg was the winner the cycle could not be brought back
    # to even and the floor never got the chance to fire. Equal legs keep the hedge delta-neutral
    # and keep breakeven reachable from either side.
    # The K value is still computed and shown on the dashboard (schema_has_live_signal +
    # pressure_signal_owner below) -- it is a readout now, and changes nothing about size.
    pressure_bias_enabled=False,
    # 2026-09-30, direct request -- what the 25/75 was for all along: only OPEN a cycle when the
    # stochastic is at an extreme, i.e. when there is real pressure behind the move. Without this
    # a fixed_direction leg enters every single time it is flat, including in flat chop where
    # neither side travels far enough to reach the 0.05% trail and both legs just grind. Gates
    # WHEN a cycle opens, never which way -- both legs still enter together, both sides.
    require_pressure_to_enter=True,
    debug_verbose_tick=False,  # off -- faulthandler below only fires if actually stuck
    # Reciprocal of the long leg's gate above -- waits for lighter_btc_optimal_state (the
    # LONG leg) to also be flat before re-entering.
    cycle_partner_table="lighter_btc_optimal_state",
    disable_literal_tp=True,
    profit_lock_enabled=True,
    # 2026-09-30, reverted from 0.03 back to the backtested 0.05 after an audit: at 0.03 the
    # winner armed at +0.03% and was stopped by the 0.01% trail on the next wiggle (~$8 on BTC,
    # pure noise), booking ~+0.02% while the loser was allowed the full -0.03% -- roughly
    # -0.01% per cycle, negative regardless of win rate. The "protection gap" the 0.03 change
    # was meant to close (a leg peaking under the trigger with nothing but its own SL beneath
    # it) is now closed properly by breakeven_floor_enabled below instead.
    profit_lock_trigger_pct=0.10,
    profit_lock_trail_pct=0.03,
    schema_has_profit_lock=True,
    # 2026-09-30, direct request: once the OTHER leg has been cut, never let this leg's profit
    # slide back below the level that makes the cycle even. Between breakeven and +0.05% this is
    # the only protection; above +0.05% the trail above normally fires first. Derived from the
    # partner's realized dollars, so it stays correct when pressure_bias_usd sizes the legs
    # unequally -- see BotConfig.breakeven_floor_enabled's docstring.
    breakeven_floor_enabled=True,
    schema_has_breakeven_floor=True,
    # 2026-09-30: Render does not stop the old container before starting the new one, so every
    # deploy briefly runs two copies of this process -- and with nothing stopping them, both could
    # see "flat, partner flat, enter" and each place a real order (the zombie double-entry
    # incident). Only the instance holding the lock on this leg's own state row takes new entries;
    # exits are never gated on it. See BotConfig.single_instance_lock.
    single_instance_lock=True,
    # 2026-09-30, direct request: retune the exits from the dashboard without a deploy, and show
    # the live volatility they have to cope with. Volatility ran 0.048% through the quiet hours
    # and 0.117% at the US open the same day -- 2.4x -- and no single stop is right across that.
    # Manual levers first, so the best value per regime is found by observation before any
    # adaptive rule is committed to. NULL columns simply fall back to the values above.
    schema_has_exit_overrides=True,
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
    # 2026-09-29, direct correction ("only one signal is read by one of the legs... both go in
    # automatically"): ONE signal, period. LONG_CONFIG.pressure_signal_owner=True makes the long
    # leg the sole computer; it publishes into this shared dict, the short leg only ever reads
    # it -- see _pressure_biased_leg_usd's docstring.
    shared_pressure_hub = {"signal": None}
    long_bot.pressure_signal_hub = shared_pressure_hub
    short_bot.pressure_signal_hub = shared_pressure_hub
    # 2026-09-30, real bug: cycle_partner_table alone (a plain DB read of "is the other leg flat?")
    # enforced only "a cut leg waits", never "both enter together" -- whichever leg polled first
    # entered, the other then saw it holding and refused, and from one beat of skew onward the two
    # ping-ponged permanently, each opening a NAKED single leg while the other sat blocked. Seen
    # live at 05:06:24. Both legs share one process and one event loop, so the decision is made
    # once for both, atomically, in StochBot._cycle_gate_clear_to_enter instead.
    shared_cycle_hub = StochBot.new_cycle_hub([LONG_CONFIG.worker_id, SHORT_CONFIG.worker_id])
    long_bot.cycle_hub = shared_cycle_hub
    short_bot.cycle_hub = shared_cycle_hub
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
