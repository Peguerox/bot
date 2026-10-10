"""
Worker 4 -- exact clone of Worker 1, for a live A/B control test.

2026-10-10, direct request: before testing any real variable (Escalated SL, etc.) between two
live bots, the user wants a pure control first -- two IDENTICAL configs trading the same market
at the same time, to see how much two instances of literally the same strategy diverge just from
real fill/timing noise. If they track closely, that's the baseline "noise band" any future A/B
test (Worker 1 vs Worker 4 with one setting changed) needs to beat before a difference is
considered real signal rather than luck.

Every setting below is copied verbatim from lighter_stoch_dca_btc_initial.py as of commit
3e86a5d (2026-10-09, HTF alignment block). Do not let this file drift from Worker 1 without
updating this docstring to say what was changed and why -- the whole point is that any future
divergence is deliberate, not accidental.

Runs on its own Render service (the previously-suspended "Worker 3" service, repurposed) with
its own sub-account (Lighter account index 281474976476916, funded 2026-10-10, $45 seed) and its
own Supabase tables (lighter_btc_worker4_state/trades/runs -- see
supabase/migrations/lighter_btc_worker4_schema.sql). Reads the plain, unprefixed
LIGHTER_ACCOUNT_INDEX/LIGHTER_API_KEY_INDEX/LIGHTER_API_PRIVATE_KEY env vars, same convention as
Worker 1's own standalone service -- this bot is the only process on its service, so there's no
need for the hedge's WORKER3_LIGHTER_*-prefixed pattern (that prefix exists only because the
hedge's two legs share one process).

schedule_rules_bot_key is "worker1" (not a new "worker4" key) so this clone is governed by the
exact same Master Schedule rules as Worker 1 -- any schedule-driven override applies identically
to both, which is required for a fair control comparison.
"""
from stoch_bot_core import BotConfig, run_bot

_FULL_WEEKDAY_HOURS = [0, 1, 4, 9, 10, 12, 15, 16, 17, 18, 19, 20, 21]
_WEEKDAY_SCHEDULE = {
    0: [4, 9, 10, 12, 15, 16, 17, 18, 19, 20, 21],
    1: _FULL_WEEKDAY_HOURS,
    2: _FULL_WEEKDAY_HOURS,
    3: _FULL_WEEKDAY_HOURS,
    4: _FULL_WEEKDAY_HOURS,
    5: [0, 1],
    6: [],
}

CONFIG = BotConfig(
    name="PLAIN STOCHASTIC, WEEKEND BLOCKED (worker 4, clone of worker1)",
    worker_id="worker4",
    table_state="lighter_btc_worker4_state",
    table_trades="lighter_btc_worker4_trades",
    table_runs="lighter_btc_worker4_runs",
    stoch_window=5,
    tp_pct=0.10,
    sl_pct=0.06,
    entry_lo=25, entry_hi=75,
    reversal_lo=25, reversal_hi=75,
    reversal_guard_seconds=None,
    trading_hours_utc=None,
    schema_has_position_bands=True,
    self_lock_enabled=False,
    schema_has_self_lock=True,
    schema_has_live_signal=True,
    self_lock_reversal_counts_as_win=True,
    self_lock_require_tp_in_streak=False,
    self_lock_no_tp_fallback_wins=None,
    self_lock_tp_unlocks_instantly=True,
    self_lock_loss_decrements_streak=True,
    hour_open_requires_self_lock=True,
    self_lock_hour_open_requires_tp=True,
    intrabar_dispersion_pause_at=None,
    intrabar_dispersion_window=5,
    require_fresh_signal=True,
    profit_lock_burns_signal=True,
    red_exit_burns_signal=True,
    schema_has_profit_lock=True,
    profit_lock_enabled=True,
    profit_lock_trigger_pct=0.03,
    zebra_index_min=None,
    zebra_index_max=None,
    zebra_index_window=5,
    color_balance_index_min=65.0,
    color_balance_index_max=75.0,
    color_balance_index_window=5,
    index_exit_on_green=False,
    volume_regime_switch_threshold=4.0,
    volume_regime_switch_window=10,
    flip_signal_min_trend_len=3,
    flip_signal_min_size_pct=None,
    flip_signal_min_body_pct=0.005,
    volume_jump_ratio=3.0,
    volume_jump_lookback=10,
    volume_jump_pause_seconds=1800.0,
    profit_lock_trail_pct=0.03,
    disable_literal_tp=True,
    tick_log_defers_to=["worker2", "worker3"],
    trade_flow_log_defers_to=None,
    native_stop_loss_enabled=True,
    native_take_profit_enabled=True,
    escalated_sl_enabled=True,
    single_instance_lock=True,
    entry_settle_seconds=10.0,
    schema_has_exit_overrides=True,
    schema_has_regime_overrides=True,
    htf_alignment_block_available=True,
    schedule_rules_enabled=True,
    schedule_rules_bot_key="worker1",
    schema_has_schedule_metrics=True,
    schema_has_schedule_rule_tracking=True,
    schema_has_entry_features=True,
    saving_lock_arm_frac_of_sl=None,
    saving_lock_exit_pct=0.0,
    post_reversal_cooldown_seconds=120.0,
)

if __name__ == "__main__":
    run_bot(CONFIG)
