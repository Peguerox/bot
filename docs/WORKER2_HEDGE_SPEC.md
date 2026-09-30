# Worker 2 hedge — FROZEN WORKING SPEC (v1)

**This is the reference build. It works. Restore to this if an experiment breaks the bot.**

Frozen 2026-09-30 at commit tag `hedge-v1-working`. Every value below was read out of the live
`BotConfig` objects at freeze time, not transcribed from memory.

> **Restore procedure** (nothing else needed — no migration, no data change):
> ```
> git checkout hedge-v1-working -- server/lighter_hedge_dual_leg.py server/stoch_bot_core.py
> git commit -m "Restore hedge to the frozen v1 working spec"
> git push origin main          # Render redeploys both legs
> ```
> Then on the dashboard: **Close Both → Reset → ON**. The DB schema already supports this build.
> Verify with `cd server && python3 test_core.py` — **445 tests must pass**.

---

## 1. What this strategy is

One Render process (`server/lighter_hedge_dual_leg.py`) runs **two `StochBot` instances
concurrently** under `asyncio.gather`, each driving its **own real Lighter sub-account**:

| leg | direction | account | state table | trades table |
|---|---|---|---|---|
| LONG | always long | Worker 2's | `lighter_btc_optimal_state` | `lighter_btc_optimal_trades` |
| SHORT | always short | Worker 3's (`WORKER3_LIGHTER_*` env) | `lighter_stoch_dca_btc_state` | `lighter_stoch_dca_btc_trades` |

Both legs enter **together**, in opposite directions, same size. The loser is cut fast. The winner
rides. Both re-enter only once **both** are flat. One switch controls both.

Worker 3's own Render service is **suspended** — its sub-account is driven entirely from here.
Reverting to standalone = re-enable that service, disable this one. Both original single-account
files are untouched and still work.

---

## 2. The exact numbers (both legs identical unless stated)

> **Exits are now DB-driven.** `override_sl_pct` / `override_profit_lock_trigger` /
> `override_profit_lock_trail` on the state rows override the values below and are edited from the
> dashboard (no deploy). NULL = use the config. **Live values are what the DB says, not this file.**
> Both legs are always written together — unequal exits break the breakeven floor.

**Live as of 2026-09-30 15:00: SL 0.06 / trigger 0.10 / trail 0.02.**

```
market_index          = 1          (BTC)
size_decimals         = 5          price_decimals = 1
tick_seconds          = 0.5

fixed_direction       = "long" / "short"
fixed_leg_usd         = 10.0       EQUAL on both legs
pressure_bias_enabled = False      NO size tilt

stoch_window          = 5
entry_lo / entry_hi   = 25 / 75
require_pressure_to_enter = True

sl_pct                = 0.03       the cut
tp_pct                = 0.10       UNUSED (disable_literal_tp = True)
disable_literal_tp    = True

profit_lock_enabled       = True
profit_lock_trigger_pct   = 0.05
profit_lock_trail_pct     = 0.01
breakeven_floor_enabled   = True
breakeven_floor_arm_margin_pct = 0.01

cycle_partner_table   = the OTHER leg's state table
single_instance_lock  = True
pressure_signal_owner = True on LONG only, absent on SHORT

schema_has_profit_lock    = True
schema_has_breakeven_floor = True
schema_has_live_signal    = True on LONG only
schema_has_position_bands = False   (MUST stay False — see §5.1)

self_lock_enabled / use_joint_adaptive / stoch_turn_exit_enabled /
book_opposition_exit_enabled / require_fresh_signal /
red_exit_burns_signal / profit_lock_burns_signal   = all False
tick_log_defers_to / trade_flow_log_defers_to / unified_market_data_table = None
```

Core constants (`stoch_bot_core.py`): `LOCK_REFRESH_EVERY=5.0`, `LOCK_STALE_AFTER=20.0`,
`CYCLE_READY_TTL=3.0`, `CYCLE_CLEARED_TTL=5.0`, `EMERGENCY_COOLDOWN=60.0`,
`EMERGENCY_REPEAT_WINDOW=3600.0`, `EMERGENCY_REPEAT_LIMIT=3`, `POSITION_TTL=3.0`,
`TICK_WATCHDOG=180.0`, `HEARTBEAT_EVERY=300.0`.

---

## 3. How a cycle runs, step by step

1. **Both legs flat.** Each tick (0.5s) the LONG leg — the signal owner — computes stochastic %K
   from the last 5 *closed* 1-min candles and publishes it to a shared in-process hub.
2. **Pressure check.** A cycle may open only while `K < 25` or `K > 75`. In the neutral band
   nothing happens — long flat stretches are correct, not a hang. The signal decides **WHEN**,
   never which way.
3. **Barrier.** Each leg that wants in declares readiness in a shared dict. Only when **both** are
   ready simultaneously are both cleared. A granted clearance is honoured even if pressure
   disappears a tick later (§5.4). Neither leg can ever enter alone.
4. **Entry.** Long buys at the ask, short sells at the bid, $10 each. Each entry is confirmed
   against the exchange before being recorded.
5. **Exits**, checked every tick against the opposing touch (long vs bid, short vs ask):
   - **SL** at −0.03% → that leg is cut and **waits**.
   - **Profit-lock trail**: arms at +0.05%, then exits if price gives back 0.01% from the peak.
   - **Breakeven floor**: once the partner is flat *at a loss*, the floor is the % that exactly
     offsets that loss on **this leg's own notional** (dollars, never a hardcoded %). It stays
     **dormant until the winner clears it by 0.01%**, then exits there — "at 0.04, lock 0.03".
   - No literal TP. Ever.
6. **Cycle ends** when both legs are flat. Only then can the next one open.

---

## 4. Why each number is what it is — DO NOT change without reading this

| setting | why |
|---|---|
| `sl_pct = 0.03` | Backtested (~29h, 124 cycles, 90.3% win) as the best cut threshold. |
| `profit_lock_trigger_pct = 0.05` | The validated value. Lowered to 0.03 once: the winner armed at +0.03% and the 0.01% trail (~$8.30 of BTC — noise) stopped it at ~+0.02% while the loser kept the full −0.03%. ≈ **−0.01%/cycle, negative at any win rate.** |
| `breakeven_floor_arm_margin_pct = 0.01` | **Load-bearing.** A symmetric hedge puts the winner at ≈+X% the instant the loser is cut at −X%, so a zero-margin floor arms exactly where the winner already is and fires on the first tick of noise — pinning **every** cycle to exactly zero (observed: long +0.00286 / short −0.00298). |
| `fixed_leg_usd = 10.0`, equal | Unequal legs break the floor: a $5 winner needs +0.09% to offset a $15 loser's −0.03%, but the trail exits at ~0.05%, so it can never get there. |
| `pressure_bias_enabled = False` | The 25/75 request was for a **signal**, never a size tilt. A $15/$5 tilt was added once unasked and silently disabled the floor one way round. |
| `require_pressure_to_enter = True` | Without it a `fixed_direction` leg opens a cycle *every* time it is flat, including in chop where neither side can reach the trail. |
| `schema_has_position_bands = False` | These legs never *write* `position_tp_pct`/`position_sl_pct`, so they must never *read* them — the table holds a stale `0.0909` from a retired strategy. |
| `single_instance_lock = True` | Render runs two containers for ~30–60s on every deploy. |
| `LOCK_STALE_AFTER=20` vs `REFRESH=5` | Too tight caused a real crash-loop. The lock has its **own** timer and must not ride `HEARTBEAT_EVERY` (300s). |

---

## 5. The safety machinery (every one exists because of a real incident)

**5.1 — Schema flags gate reads AND writes.** A bot that does not write a column must not read it.
Cost when violated: the short leg ran a **0.0909% stop instead of 0.03%** for an unknown period.

**5.2 — Never guess at a fill.** If an order is placed and the exchange then cannot be read, the
outcome is **UNKNOWN**, not "no fill". Entries are blocked until a read succeeds; the failure
counter is *not* incremented (blindness is not evidence of failure). Cost when violated: a WAF
CAPTCHA blackout produced **3× size on both accounts, unmanaged for 3.7 hours**.

**5.3 — Never condemn a live position on one read.** The external-close reconcile requires **3
consecutive reads agreeing** that the position is gone. Cost when violated: both legs booked a
close that had not happened and re-entered on top of live positions → 2× size. The tell was two
external closes reporting **+0.00323 then −0.00323**, exactly equal and opposite.

**5.4 — A granted cycle clearance is not re-litigated.** Once the barrier releases both legs, both
enter regardless of what the signal does in the next 0.3s. Cost when violated: the long ran
**naked for 96 seconds**.

**5.5 — Entries gate on the lock; exits never do.** An instance that loses the lock must still be
able to protect a position it already opened.

**5.6 — A transient oversize pauses, it does not halt.** `emergency_flatten` flattens
unconditionally, then pauses entries 60s so **both** legs resume together. Only 3 occurrences in an
hour hard-disable. Cost when violated: one leg disabled, its partner left on, hedge stuck half-open
waiting for a partner that could never come.

**5.7 — Every close writes a trade row**, including `emergency_flatten`. A missing row makes a
hedged cycle *look* unhedged on the dashboard.

**5.8 — Fail-closed on entry, fail-soft on exit.** Unknown partner state blocks an entry; unknown
partner state never forces a close.

---

## 6. Controls

**Close Both → Reset → ON**, in that order.

- **ON/OFF** blocks new entries only; it never closes anything. Sets both legs together.
- **Close Both** sets `close_requested` on both rows. The route never touches the exchange (the
  signing SDK is Python-only); the worker closes through its own tested path, checking the
  **exchange** rather than its own state — it will find and flatten a position the row does not
  know about. Always visible, never refused on bot state.
- **Reset** wipes history and folds PnL into `seed_usd`. **Refuses while any leg is open.** Also
  clears `consecutive_entry_failures`, which sticks at 3 after a breaker trip and would otherwise
  re-disable the bot on its first entry.

Dashboard: `⏳ … still running` = cycle in flight, normal. Red **UNHEDGED** = a leg traded with no
partner — **real problem, investigate**.

---

## 7. Known truths about this strategy

- **It has not been proven profitable.** An 8-day backtest over 253k real ticks is negative at every
  stochastic threshold and at all 45 SL × trigger × trail combinations tested.
- **The deciding number is the double-loss rate.** Both legs can never win; 23% of backtested cycles
  had *both* lose (price stabs one way, stops one leg, reverses, stops the other). Live has run
  ~11.5%. Near 11% → profitable. Near 23% → not.
- **Per-cycle stdev is $0.00485.** One sigma is ±$0.025 over 26 cycles, ±$0.108 over 500. **Do not
  draw conclusions before ~500 cycles.** Two samples so far (+$0.0255/26 and −$0.0150/10) are both
  inside one sigma — they mean nothing individually.
- **The stop is bot-side, not exchange-side.** There is no resting stop order. Real exposure is the
  full notional, not the stop distance.
- **The legs sit on separate sub-accounts** — P&L nets between them, margin does not.

---

## 8. Tuning: what the data actually says

**Measured live, 2026-09-30 at 0.16% volatility, SL 0.06:**

```
avg winner   +0.1154%      avg loser   -0.0704%      ratio 1.64:1
```

Losers overshoot the stop by ~0.019% (execution latency + market close). Budget for it: the real
loss is always ~SL + 0.02.

**The whole strategy reduces to one number.** With that win/loss ratio:

```
one wins / one loses :  +0.115 - 0.070  =  +0.045%
both lose            :  -0.070 x 2      =  -0.141%
=> profitable while the double-loss rate stays under ~24%
```

Observed 13–18% at these settings. That is the margin. **Track the double-loss rate, not the P&L** —
it converges far faster.

**Do NOT tighten the stop.** Tested on 8 days and on the volatile window; tighter is worse on both:

| SL (trigger .10 / trail .02) | 8-day $/cyc | today $/cyc | double-loss |
|---|---|---|---|
| 0.04 | −0.00030 | +0.00003 | 20.9% |
| 0.05 | −0.00036 | +0.00069 | 15.0% |
| **0.06 (live)** | −0.00028 | +0.00051 | 13.4% |
| 0.07 | −0.00009 | +0.00097 | 9.2% |

0.07 tests better but is **not** recommended: with slippage the real loss becomes ~0.09 against a
~0.115 winner, which cuts the breakeven double-loss rate from 24% to ~13% — barely above the 9%
observed. 0.06 keeps a much wider cushion. Wider stops help because a tighter band is easier for
one reversal to take out both legs; at 0.04 the ~0.02 slippage is half the intended loss and the
stop stops meaning anything.

## 9. No volatility formula yet — and why not

Volatility ranged **0.0195% to 0.2300%** in one week (>10x). The obvious move is to scale the exits
with it. **The data does not support a formula.** Bucketing the 8 days by volatility and finding the
best exits per bucket gives:

| regime | "best" | sigma | cycles |
|---|---|---|---|
| calm <0.035% | 0.14/0.20/0.06 | 1.32 | 61 |
| mid 0.035–0.06% | 0.20/0.28/0.08 | 0.61 | 130 |
| high 0.06–0.10% | 0.14/0.20/0.06 | 1.25 | 260 |
| extreme >0.10% | 0.06/0.10/0.03 | 1.75 | 293 |

The optimum **jumps around with no pattern** (0.14 → 0.20 → 0.14 → 0.06). If volatility genuinely
drove the right stop it would move monotonically. Nothing reaches significance — 28 cells tested,
best 1.75σ, which is what chance produces. **Fitting a rule to this would be overfitting**, the same
error as the 3am-ET hour closure and the $15/$5 tilt.

What IS robust: wider stops cut the double-loss rate monotonically in *every* regime. It just does
not reliably convert to profit. Deriving a real formula needs ~500 cycles per bucket (currently
60–300) — weeks of data. Until then the manual levers exist so the right value per regime can be
found by observation.

## 10. Known open issue: lock does not gate exits

The single-instance lock gates **entries only**. During a deploy both instances therefore manage the
same position, which on 2026-09-30 produced a double-booked close (`closed` then
`resolved_externally`, same pnl 2s apart) and `invalid nonce` errors — two processes signing with
one API key collide, and a collision can make a *close* order fail.

**Proposed fix (not implemented):** gate all order placement on holding the lock. The old instance
manages until it dies; the lock goes stale in 20s so a dead owner's position is picked up quickly.
Cleaner than the current guaranteed collision.

**Until then: never deploy while the bot is trading.** This was violated twice in one session and
caused both incidents.

## 11. Next planned change: compounding

Designed and agreed with the user, **not built**. Full spec — formula, why the two reported
percentages never converge, implementation sketch, open decisions and timing — is in
`docs/session_2026-09-30_worker2_hedge_rebuild.md` under "Planned, not built: compounding".

Headline: `leg_usd = (20 + combined realized PnL) / 2`, both legs always equal, compounds down as
well as up. **Do not enable until the double-loss rate confirms the edge** — compounding multiplies
a negative edge just as readily as a positive one.

## 12. Rules for changing anything

1. **Tag first.** Experiments go on a branch or after a fresh tag. `hedge-v1-working` must keep
   pointing at this build.
2. **`t_live_configs_match_their_stated_rules` must keep passing.** It pins $10/$10, no size tilt,
   SL 0.03, trigger 0.05, the floor, the pressure gate and the lock — every one of which was
   changed unrequested at some point and cost money.
3. **Never deploy while it is trading.** Render redeploys everything on every push and forces a lock
   handover mid-cycle.
4. **One change at a time, then wait for 500 cycles.** Anything less cannot be distinguished from
   noise.
5. **Do not redesign the strategy to fix the 23% whipsaw without deciding it explicitly.** Test
   against `research/hedge-sweep/` first.
