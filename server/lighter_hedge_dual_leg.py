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

2026-10-01: BTC -> SOL -> ETH -> back to BTC, same session. Both alt-coin experiments were
tried live and dropped ("tried everything with worker 2 in ethereum and solana, let's go back
to btc") -- this file is now byte-for-byte the pre-SOL build (restored via
`git checkout hedge-v2-btc-before-sol -- server/lighter_hedge_dual_leg.py`: market_index back to
1/price_decimals 1/size_decimals 5, fixed_leg_usd back to $10, require_pressure_to_enter back to
True, min_cycle_gap_seconds's hypertrading-test value of 10.0 dropped back to the 0.0 default)
with exactly two things re-added on top, both coin-independent and explicitly requested to
survive the revert: native_stop_loss_enabled and schema_has_cycle_id. See their own comments
below for what each does.
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
    # User-authorized experimental market environment monitor, 2026-10-02.
    # No stochastic entry gate: green permits the original always-paired strategy.
    environment_entry_gate_enabled=False,  # User request: no environment filters; retain research readings.
    environment_er_pause_below=0.15,
    environment_er_resume_at=0.15,  # User requested one ER switch; no hysteresis.
    environment_vol_max_pct=0.045,
    environment_vol_window=10,
    environment_er_window=15,
    environment_signal_owner=True,
    hedge_entry_filters=True,
    hedge_entry_filter_owner=True,
    # 2026-10-01, direct request ("give it another try... let's get the same settings"): FULL
    # REVERT of every strategy/economics setting to the exact original from 2026-09-29 (commit
    # 8469702, the config that ran 124 cycles at 90.3% win / +2.55% in the original backtest and
    # was "insane" live before 2+ days of tuning): tp_pct/sl_pct 0.10/0.03, profit_lock trigger/
    # trail 0.05/0.01, NO entry gate at all (require_pressure_to_enter=False -- always try to be
    # in position on both sides whenever flat, exactly as originally built), NO breakeven floor
    # (didn't exist yet), NO color-balance index gate. Every later strategy tweak -- the pressure
    # gate, the dispersion experiments, the color-balance index (both directions), the breakeven
    # floor and its fixed-0.03% variant, the wider 0.06 SL -- is removed.
    #
    # Kept deliberately, NOT reverted: these are correctness/infra fixes for real bugs found
    # live, not economics changes, and reverting them would reintroduce the bugs they fixed.
    #   - cycle_partner_table + main()'s cycle_hub: without this, the two legs can desync and
    #     each trade naked, unhedged (observed live 2026-09-30 05:06:24).
    #   - single_instance_lock: without this, a Render deploy's old+new container overlap can
    #     double-enter (the zombie double-entry incident).
    #   - native_stop_loss_enabled: a real exchange-side stop fires more precisely than our own
    #     0.5s poll (software-caught stops measured 0.004-0.016 points worse) -- this changes
    #     EXECUTION QUALITY, not the strategy itself; the configured SL level is unchanged.
    #   - schema_has_cycle_id / schema_has_entry_features: dashboard pairing and hover-only
    #     documentation, no effect on any trading decision.
    tp_pct=0.10, sl_pct=0.03,
    fixed_leg_usd=10.0,  # direct request: same $ per leg, not the account's full balance
    pressure_bias_enabled=False,
    require_pressure_to_enter=False,  # REVERTED: no entry gate, always try to be in when flat
    pressure_signal_owner=True,  # harmless readout only now -- K no longer gates anything
    schema_has_live_signal=True,
    debug_verbose_tick=False,
    cycle_partner_table="lighter_stoch_dca_btc_state",  # KEPT -- see note above
    disable_literal_tp=True,
    profit_lock_enabled=True,
    profit_lock_trigger_pct=0.05,  # REVERTED to the original backtested pair
    profit_lock_trail_pct=0.01,
    schema_has_profit_lock=True,
    breakeven_floor_enabled=False,  # REVERTED -- did not exist in the original
    fixed_partner_cut_floor_pct=None,
    schema_has_breakeven_floor=False,
    partner_cut_arms_trail_immediately=False,
    profit_lock_respects_breakeven_floor=False,
    color_balance_index_min=None,  # REVERTED -- no index gate, either direction
    color_balance_index_max=None,
    color_balance_index_invert=False,
    color_balance_index_window=5,
    single_instance_lock=True,  # KEPT -- see note above
    native_stop_loss_enabled=True,  # KEPT -- see note above
    schema_has_cycle_id=True,  # KEPT -- dashboard pairing only
    schema_has_exit_overrides=True,  # dashboard levers still work; values reset to match below
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
    schema_has_entry_features=True,  # KEPT -- hover documentation only
    # Volume-jump guard, 2026-10-03 ("build the same guard for worker 2") -- same values, same
    # reasoning as Worker 1's (compute_volume_jump_ratio's docstring): 3.0x is the 95th
    # percentile of a 14,773-candle sample, picked with margin below the real incident that
    # motivated it; 1800s (30 min) because elevated volume near funding-settlement windows can
    # take up to an hour to fully revert, found while researching Worker 1's own incident.
    # Blocks NEW paired cycles only via _volume_jump_allows_cycle (_wants_new_cycle), never an
    # exit -- fixed_direction legs never consult entry_signal, so the ordinary Worker 1
    # mechanism (nulling entry_signal) has nothing to act on here; see that method's docstring.
    # schema_has_regime_overrides=True only enables override reads (live ratio/pause/clear --
    # see _update_volume_jump_guard); it does NOT touch the regime-switch-threshold machinery
    # fixed_direction bots never reach (regime_vol_threshold stays None, this config never sets
    # volume_regime_switch_threshold and nothing writes override_volume_switch_threshold here).
    volume_jump_ratio=3.0,
    volume_jump_lookback=10,
    volume_jump_pause_seconds=1800.0,
    schema_has_regime_overrides=True,
    # 2026-10-04, direct request: the master schedule panel that drives both this bot and
    # Worker 1 from one place, by hour and/or live ER/volume/wiggle/rate conditions. "hedge"
    # says which half of each shared rule applies to this leg -- both legs read the SAME rules
    # row independently and apply the same "hedge" settings object, same reasoning as every
    # other both-legs-identical override. Requires bot_schedule_rules.sql.
    schedule_rules_enabled=True,
    schedule_rules_bot_key="hedge",
    # 2026-10-05, bug fix: this leg never published its own volume/wiggle, so the dashboard's
    # "Currently governing" box fell back to Worker 1's readings -- wrong whenever Worker 1 is
    # off. Requires bot_schedule_live_metrics.sql.
    schema_has_schedule_metrics=True,
)

SHORT_CONFIG = BotConfig(
    name="HEDGE SHORT LEG (worker 3 account)",
    worker_id="worker3",
    table_state="lighter_stoch_dca_btc_state",
    table_trades="lighter_stoch_dca_btc_trades",
    table_runs="lighter_stoch_dca_btc_runs",
    stoch_window=5, entry_lo=25, entry_hi=75, reversal_lo=25, reversal_hi=75,
    fixed_direction="short",
    environment_entry_gate_enabled=False,  # User request: no environment filters; retain research readings.
    environment_er_pause_below=0.15,
    environment_er_resume_at=0.15,  # User requested one ER switch; no hysteresis.
    environment_vol_max_pct=0.045,
    environment_vol_window=10,
    environment_er_window=15,
    environment_signal_owner=False,  # Both legs use the long owner's single reading.
    hedge_entry_filters=True,
    # See LONG_CONFIG's docstring -- full revert to the 2026-09-29 original, infra/correctness
    # fixes kept.
    tp_pct=0.10, sl_pct=0.03,
    fixed_leg_usd=10.0,  # direct request: same $ per leg, not the account's full balance
    pressure_bias_enabled=False,
    require_pressure_to_enter=False,  # REVERTED: no entry gate, always try to be in when flat
    debug_verbose_tick=False,
    cycle_partner_table="lighter_btc_optimal_state",  # KEPT -- see LONG_CONFIG's note
    disable_literal_tp=True,
    profit_lock_enabled=True,
    profit_lock_trigger_pct=0.05,  # REVERTED to the original backtested pair
    profit_lock_trail_pct=0.01,
    schema_has_profit_lock=True,
    breakeven_floor_enabled=False,  # REVERTED -- did not exist in the original
    fixed_partner_cut_floor_pct=None,
    schema_has_breakeven_floor=False,
    partner_cut_arms_trail_immediately=False,
    profit_lock_respects_breakeven_floor=False,
    color_balance_index_min=None,  # REVERTED -- no index gate, either direction
    color_balance_index_max=None,
    color_balance_index_invert=False,
    color_balance_index_window=5,
    single_instance_lock=True,  # KEPT -- see LONG_CONFIG's note
    native_stop_loss_enabled=True,  # KEPT -- see LONG_CONFIG's note
    schema_has_cycle_id=True,  # KEPT -- dashboard pairing only
    schema_has_exit_overrides=True,  # dashboard levers still work; values reset to match below
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
    schema_has_entry_features=True,  # KEPT -- hover documentation only
    # Volume-jump guard -- see LONG_CONFIG's docstring. Same values on both legs (the settings
    # route writes overrides identically to both state tables); each leg computes its own ratio
    # independently from its own candle feed, same as every other per-leg gate here -- the
    # existing cycle barrier (_cycle_gate_clear_to_enter) already absorbs any timing disagreement
    # between the two legs, same as it does for every other entry condition.
    volume_jump_ratio=3.0,
    volume_jump_lookback=10,
    volume_jump_pause_seconds=1800.0,
    schema_has_regime_overrides=True,
    # See LONG_CONFIG's docstring -- same shared rules row, "hedge" settings object.
    schedule_rules_enabled=True,
    schedule_rules_bot_key="hedge",
    schema_has_schedule_metrics=True,
)


async def main():
    long_bot = StochBot(LONG_CONFIG)
    short_bot = StochBot(SHORT_CONFIG)
    # 2026-09-29, direct correction ("only one signal is read by one of the legs... both go in
    # automatically"): ONE signal, period. LONG_CONFIG.pressure_signal_owner=True makes the long
    # leg the sole computer; it publishes into this shared dict, the short leg only ever reads
    # it -- see _pressure_biased_leg_usd's docstring.
    shared_environment_hub = {"allowed": False}
    long_bot.environment_hub = shared_environment_hub
    short_bot.environment_hub = shared_environment_hub
    shared_pressure_hub = {"signal": None}
    long_bot.pressure_signal_hub = shared_pressure_hub
    short_bot.pressure_signal_hub = shared_pressure_hub
    shared_entry_hub = {"allowed": False}
    long_bot.hedge_entry_hub = shared_entry_hub
    short_bot.hedge_entry_hub = shared_entry_hub
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
