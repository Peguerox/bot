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
> Verify with `cd server && python3 test_core.py` — **458 tests must pass as of 2026-09-30 23:35** (this number grows over time; check the actual output, not this line).

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

**Live values are DB-driven and change often (see the note above) -- check `override_sl_pct` etc directly, do not trust any specific number written here. As of 2026-09-30 23:35: SL 0.05 / trigger 0.08 / trail 0.02, coin=SOL, pressure gate OFF, 10s min_cycle_gap_seconds (see §13).**

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

## 12. SOL experiment (2026-09-30, later in the session)

Switched the hedge from BTC to SOL -- "if the Solana trading is better, we can just use Solana."
Same bot, same two sub-accounts, same strategy logic. Only 3 config fields actually depend on the
coin (checked the whole core file):

```
             BTC              SOL (now live)
market_index      1                2
price_decimals    1                3
size_decimals     5                3
fixed_leg_usd    10.0             12.0   (bumped: Lighter's min_quote_amount is $10 on
                                           both coins, so $10 had zero margin)
```

Values pulled directly from Lighter's `/orderBooks` endpoint, not guessed. Table names
(`lighter_btc_optimal_*` etc.) and the dashboard panel are UNCHANGED on purpose -- "btc" in the
table names is now a historical label, not a description of what's trading.

**One real bug this caused, now fixed:** the dashboard's hedge panel computed unrealized % against
`ocoBtcPrice` (hardcoded to Lighter market_id=1/BTC) -- so a real SOL entry (~$180) got compared
against BTC's price (~$84k), showing +70657%/-70661% on the open legs. The bot's own real exits
were never affected (they read price from the bot's own WS feed, tied to `cfg.market_index`) --
display-only bug. Fixed with a separate `hedgeCoinPrice` state fetched from market_id=2, wired only
to the hedge panel; Worker 1 (still real BTC) and the dormant Worker 3 display are untouched.

### Reverting to BTC if SOL doesn't work out

```
git checkout hedge-v2-btc-before-sol -- server/lighter_hedge_dual_leg.py server/test_core.py
git commit -m "Revert hedge to BTC"
git push origin main
```
Then on the dashboard: **Close Both -> Reset -> ON**. No migration needed, same DB schema.

`hedge-v2-btc-before-sol` is the tuned BTC build right before the SOL switch (SL 0.06 baseline,
all this session's safety fixes, 10-min volatility). `hedge-v1-working` (older, same day) is BTC
with the ORIGINAL untuned 0.03/0.05/0.01 exits -- prefer v2 for a revert, not v1.

**Note:** reverting only restores `server/lighter_hedge_dual_leg.py` and `server/test_core.py` --
it does NOT touch `app/page.tsx`, so the `hedgeCoinPrice`/SOL-price-fetch fix stays in place either
way (harmless for BTC -- it just fetches an unused SOL price alongside the BTC one).

## 13. Hypertrading test (2026-09-30, same session, after the SOL switch)

Direct request: turn off the 25/75 pressure gate ("don't delete it, just turn it off, enter at any
moment"), add a fixed pause after a leg goes flat before it may re-enter ("once you finish a trade
wait 10 seconds then another trade") -- purpose is faster cycle throughput to test the strategy,
not a permanent behaviour change.

```
require_pressure_to_enter = False   (both legs; was True)
min_cycle_gap_seconds     = 10.0    (both legs; new field, default 0.0 for every other bot)
```

`min_cycle_gap_seconds` tracks the exact tick each leg's own `side` goes from open to None
(`self._went_flat_at`), and withholds that leg's cycle-barrier readiness until the gap elapses --
see `_cycle_gap_elapsed()`. Gates entries only, confirmed with a direct test that it never delays
an exit. Both legs must always agree on both these fields (pinned as a cross-leg check, same as
market_index/size_decimals/fixed_leg_usd) -- a mismatch would let one leg declare barrier readiness
on a different cadence than its partner.

**To revert to the pressure-gated, non-hypertrading behaviour:** set both back to
`require_pressure_to_enter=True`, `min_cycle_gap_seconds=0.0` (or just delete the line, since 0.0
is the default) on both LONG_CONFIG and SHORT_CONFIG.

## 14. OPEN, DISPUTED ISSUE -- read this before touching SL/exit code again

**Symptom the user reported, twice:** the panel shows an open leg's unrealized loss already PAST
the configured `override_sl_pct` (e.g. showing -0.062% while SL=0.05%) while the position is still
open. User's read: the stop-loss is not actually firing at the configured level -- a real, serious
bug. **The user explicitly rejected the explanation below and does not consider this resolved.**
Next agent: do not just re-assert the same explanation -- verify it fresh, or find the real cause.

**What I checked and found (2026-09-30, this session):**
- The bot's REAL exit check reads price from its own live WebSocket order book, ticked every 0.5s
  (`stoch_bot_core.py`, the `tick()` loop) -- completely independent of the dashboard.
- The dashboard's displayed price (`hedgeCoinPrice` in `app/page.tsx`) comes from a single REST
  fetch to Lighter's `/orderBookOrders`, called only inside `load()` -- and `load()` only runs once
  on page mount and again on a debounced DB-change trigger. **There is no continuous polling timer
  refreshing that price.** (Confirmed by reading the code directly: the fetch is inside `load()`,
  the only unconditional call to `load()` is on mount, `app/page.tsx` ~line 2783.)
- I pulled the actual trade that matched the second report: entered 118.135, closed via real SL at
  actual move -0.123% (SL was 0.05%, so ~0.073% overshoot -- see the entry below on why SOL's
  overshoot is bigger than BTC's). The runs log showed no watchdog timeout, no position-read
  failures, no gap in heartbeats during that position's life -- the tick loop was healthy
  throughout. The close happened correctly according to the bot's own log.
- Conclusion offered: the panel's displayed "-0.062%, still open" was a STALE snapshot (old price,
  correctly-still-open position), not evidence the live position had actually breached -0.05% and
  failed to close. The bot's own real-time check would have closed it already if its own price had
  crossed -0.05%; the close event for that exact cycle is in the log and happened correctly.

**Why the user is not satisfied, and what's still genuinely open:**
- This explanation has not been verified against a live, reproduced case where the SAME price
  (bot's WS price at the same instant) was checked against BOTH what the dashboard showed AND what
  the bot's own tick logged, at the same moment in time. It is an inference from two different data
  sources read at different times, not a side-by-side proof.
- SOL's overshoot-past-SL is measurably larger than BTC's (0.073% vs 0.02-0.03% typical) -- this
  part is solid, real, and separately worth acting on (SOL may need a wider SL than BTC to protect
  the same real dollar amount). But it does NOT by itself explain a report of "-0.062% while SL is
  0.05% and STILL OPEN" -- overshoot explains a bigger-than-expected LOSS AT CLOSE, not a position
  sitting open past its stop.

**What to actually do next time this is reported:**
1. Get the EXACT timestamp the user is looking at the panel.
2. Pull `lighter_btc_optimal_runs`/`lighter_stoch_dca_btc_runs` for that leg in a tight window
   around that timestamp -- look specifically for whether a `closed` event exists slightly BEFORE
   or AFTER that timestamp (staleness) vs whether the position was genuinely still open with no
   close event anywhere nearby despite price data showing it should have closed (a real bug).
3. Pull the bot's own tick-level view if possible (heartbeat `ob_age`/`candle_age` right at that
   moment) to rule out a stalled feed on the BOT's side, not just the dashboard's.
4. Only THEN state a conclusion -- don't re-assert the dashboard-staleness read without doing 1-3
   fresh, since that explanation was already given once and rejected.

## 15. Rules for changing anything

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
