# Worker 2 hedge rebuild + Worker 1 hours analysis — 2026-09-30

Handoff doc. Written at the end of a long session that fixed several real money bugs. Read the
"Do not change without asking" list before touching anything.

## The fleet, as it actually is

| | file | tables | status |
|---|---|---|---|
| Worker 1 | `server/lighter_stoch_dca_btc_initial.py` | `lighter_btc_initial_*` | LIVE, real money |
| Worker 2 | `server/lighter_hedge_dual_leg.py` | `lighter_btc_optimal_*` (long) + `lighter_stoch_dca_btc_*` (short) | LIVE, real money, drives **two** sub-accounts from one process |
| Worker 3 | — | — | Render service **suspended**; its sub-account is driven by Worker 2 |

`server/stoch_bot_core.py` (~3.8k lines) holds all shared logic. Each `lighter_*.py` is settings
only. Tests: `cd server && python3 test_core.py` (needs the Supabase env vars) — **443 passing**.

---

## Worker 2 — current strategy

Both legs enter **together**, $10 each, equal. Loser cut at SL 0.03%. Winner has no literal TP —
profit-lock trail (arms +0.05%, trails 0.01% behind peak) with a breakeven floor beneath it. Both
re-enter only once **both** are flat. A cycle opens only while the 25/75 stochastic shows pressure.

### Why each number is what it is

- **SL 0.03%** — backtested (~29h, 124 cycles, 90.3% win) as the best cut threshold.
- **profit-lock trigger 0.05% / trail 0.01%** — the validated pair. It was briefly lowered to a
  0.03 trigger, which **inverted the edge**: the winner armed at +0.03% and the 0.01% trail (~$8.30
  of BTC) stopped it on the next wiggle for ~+0.02%, while the loser still got the full −0.03%.
  ≈ −0.01%/cycle, negative regardless of win rate. **Do not lower the trigger again.**
- **`breakeven_floor_arm_margin_pct = 0.01`** — load-bearing. A symmetric hedge puts the winner at
  ≈+X% at the instant the loser is cut at −X%, so a floor armed with zero margin fires immediately
  on noise and pins **every** cycle to exactly zero (observed live: long +0.00286 / short −0.00298).
  The margin keeps the floor dormant until the winner clears it — "at 0.04, lock 0.03".
- **$10 / $10, `pressure_bias_enabled=False`** — the 25/75 request was for a *signal*, never a size
  tilt. A previous $15/$5 tilt also silently disabled the floor one way round: a $5 winner needs
  +0.09% to offset a $15 loser's −0.03%, but the trail exits at ~0.05%, so it could never get there.
- **`require_pressure_to_enter`** — a `fixed_direction` leg otherwise opens a cycle *every* time it
  is flat, including in chop where neither side can reach the trail. Gates **when**, never which way.

---

## Bugs fixed this session (all had cost or could have)

1. **Short leg's stop was 0.0909%, not 0.03%.** `tick()` read `position_sl_pct` from the state row
   unguarded, while every *write* is gated behind `schema_has_position_bands` (False on both hedge
   legs). It honoured a value the retired Worker 3 strategy left in the shared table. → **A
   `schema_has_*` flag must gate the READ as well as the WRITE.**
2. **Profit-lock trigger 0.03** — see above.
3. **Legs desynced into naked single legs.** `cycle_partner_table` is a plain DB read: it enforced
   "a cut leg waits" but never "both enter together", so one beat of skew made them ping-pong, each
   trading alone. Replaced by an in-process barrier (`_cycle_gate_clear_to_enter`) — both legs share
   one event loop, so the decision is made once, atomically.
4. **A granted clearance was thrown away.** The barrier released both legs; the long entered; 0.3s
   later the short re-checked pressure, found K had drifted, and discarded a clearance it already
   held. The long ran **naked for 96 seconds**. A clearance is now the authorisation and is not
   re-litigated.
5. **WAF blackout stacked 3× size.** Lighter's CloudFront WAF returned CAPTCHA (405) to Render's IP;
   every position read failed; each failure was booked as "no fill" and retried. All three orders
   filled. Both accounts held 3× intended size, unmanaged, for ~3.7 hours. `confirm_fill` now
   distinguishes "read fine, nothing there" from "could not read", and an unreadable exchange blocks
   further entries without burning the circuit breaker. **This WAF issue recurs — expect it.**
6. **Close Both did nothing when it mattered.** It began `if side is null: clear flag and return`,
   so it no-op'd in exactly the orphan case. It now checks the exchange, adopts, and closes.
7. **No single-instance lock.** Render runs two containers for ~30–60s on every deploy and nothing
   stopped both entering. `lock_owner`/`lock_heartbeat` now gate **entries only, never exits**.
8. **One bad read condemned a live position.** `confirm_fill(want_nonzero=False)` returned True on
   the **first** read showing flat — `tries` meant "chances to SEE flat", never "times it must
   AGREE". Both legs booked a close that had not happened, re-entered on top of the live position
   and reached 2× size. The tell was two external closes reporting **+0.00323 then −0.00323**,
   exactly equal and opposite — collateral noise, not two real closes. Now `require_consecutive=3`
   on the reconcile path.
9. **A transient oversize halted the strategy, asymmetrically.** `emergency_flatten` set
   `enabled=False` permanently, and only on the leg that tripped — so the hedge sat half-on, its
   partner waiting for a leg that could never come. A first occurrence now flattens and pauses 60s
   (both legs resume together); 3 within an hour still hard-disable, keeping the 20× guard.
10. **`emergency_flatten` wrote no trade row**, so a flattened leg vanished from history — which is
    how a properly hedged cycle displayed as UNHEDGED. It now logs `EMERGENCY_FLATTEN`.

---

## Does the hedge actually make money? Backtest says no.

`research/hedge-sweep/` (gitignored, local) replays **8 days of real ticks** (253k rows,
`lighter_btc_price_ticks`, 09-22→09-30) through the same exit stack.

| gate | cycles | net $ | $/cycle |
|---|---|---|---|
| none | 6266 | −2.37 | −0.00038 |
| 25/75 | 4880 | −2.02 | −0.00041 |
| 10/90 | 3456 | −1.21 | −0.00035 |
| 5/95 | 2688 | −0.86 | −0.00032 |

**Every gate loses, and the loss per cycle is flat** — a tighter gate just trades less. All 45
combinations of SL × trigger × trail tested were also negative.

**The cause is the whipsaw.** Both legs can never win (structurally), and 23% of cycles have *both*
lose — price stabs one way, stops one leg, reverses, stops the other:

```
one wins / one loses   77%   +$0.0018   =  +$6.72
BOTH lose (whipsaw)    23%   −$0.0077   =  −$8.73
                                           ─────────
                                           −$0.00038 per cycle
```

Normal cycles genuinely earn; the whipsaws cost more. Spread is *not* the problem (median 0.0005%).

**Caveats:** the backtest samples every ~2.7s (live runs 0.5s) and builds 1-min candles from tick
mids rather than Lighter's real candlesticks — both matter for whether a 0.01% trail catches a peak,
so it may be pessimistic. Live double-loss rate has run 11.5% vs the backtest's 23%.

**That double-loss rate is the number that decides the strategy.** Near 11% → profitable. Near 23% →
not. Everything else is downstream.

### Evaluation criteria — how to judge it

Per-cycle stdev is **$0.00485**. One sigma:

| cycles | 1σ |
|---|---|
| 26 | ±$0.025 |
| 100 | ±$0.049 |
| 500 | ±$0.108 |

**Do not draw conclusions before ~500 cycles (~20h).** Two samples already seen — +$0.0255/26 cycles
(+1.03σ) and −$0.0150/10 cycles (−0.98σ) — are both noise, despite feeling like a win then a loss.

---

## Worker 1 — trading hours analysis (the question asked this session)

**Recommendation: change nothing. The data cannot support adding or removing any hour.**

494 trades, 09-24 → 09-30, net **−$0.0096**. Per-trade mean −$0.00002, **stdev $0.08142**.
One sigma on a 25-trade hour bucket is **±$0.41** — larger than almost every hour's entire net.

A config change on 09-27 21:01 (`eceee05`) splits the sample, so each hour is scored in both windows;
only agreement across both means anything:

| UTC | ET | pre n/net | post n/net | verdict |
|---|---|---|---|---|
| 1 | 9pm | 23 / −0.52 | 20 / −0.00 | negative both — **1.0σ** |
| 9 | 5am | 24 / −0.20 | 3 / −0.35 | negative both, thin |
| 10 | 6am | 22 / +0.16 | 17 / +0.42 | positive both — **1.1σ** |
| 16 | 12pm | 26 / +0.60 | 11 / +0.09 | positive both — **1.4σ** |
| 17 | 1pm | 27 / +0.34 | 15 / +0.11 | positive both — **0.8σ** |
| 12, 15, 18, 19, 20 | — | — | — | sign flips between windows |

**Nothing exceeds 1.4σ.** The apparently-worst hours (UTC 1, 9) and best (10, 16, 17) are all inside
noise. Acting on them would be refitting the schedule to randomness — the same trap the file's own
docstring warns about ("several of these hours have as few as ~20 trades behind them").

**How much data would settle it:** to resolve a $0.01/trade edge against stdev $0.081 needs
~260 trades *per hour*. At ~25 trades/hour per 6 days that is **~2 months**. Revisit then, not sooner.

One genuinely useful observation, though also not significant (0.6σ): under the **current** config
Worker 1 is +$0.589 over 145 trades, versus −$0.598 over 349 before 09-27. The config change looks
more consequential than any hour choice — worth watching before touching the schedule.

### Worker 1 self-lock rule — broken twice, now pinned

**2 wins of any kind unlock, OR 1 literal TP unlocks on its own.** That is
`self_lock_require_tp_in_streak=False` + `self_lock_tp_unlocks_instantly=True`. Making a literal TP
*mandatory* leaves the bot locked out forever on non-TP greens (seen live, stuck on 4 greens).

---

## Do not change without asking

Pinned by `t_live_configs_match_their_stated_rules` — if you change these, that test fails, and that
is deliberate. Every one was altered at some point without being requested, and each cost money:

- hedge legs **$10 / $10**, `pressure_bias_enabled=False`
- `sl_pct=0.03`, `profit_lock_trigger_pct=0.05`
- `breakeven_floor_enabled=True` with a **non-zero** arm margin
- `single_instance_lock=True`, `require_pressure_to_enter=True`
- Worker 1: `self_lock_require_tp_in_streak=False`, `self_lock_tp_unlocks_instantly=True`

**Also:** do not redesign the strategy to fix the 23% whipsaw without the user deciding. Test any
idea against `research/hedge-sweep/` first. Untested ideas, in rough order of promise: don't cut the
loser at a fixed SL; re-enter a cut leg rather than waiting; or enter only the side pressure favours.

**And:** do not deploy while it is trading. Render redeploys every service on every push and forces a
lock handover mid-cycle. Six deploys during a live session made one noisy window unreadable.

## Planned, not built: compounding

Agreed in principle, **not implemented**. Two separate figures must be reported, because they never
converge — each sub-account needs a cushion beyond what it trades, precisely because one leg runs
ahead of the other:

- **Total equity** — what is actually in both accounts. Its % is the honest account return.
- **Exposed capital** — what is on the table in a cycle ($20 today). This is what compounds, and
  its % is what the strategy is really earning.

Sizing rule: `leg_usd = exposed / 2`, both legs **always equal** — unequal legs break the breakeven
floor (a $5 winner cannot offset a $15 loser before the trail exits it). Compounds **down** as well
as up. Buffer should be a **fixed ratio**, not fixed dollars: the stop is bot-side, not
exchange-side, so the real exposure is the full notional, and the cushion must not thin as size
grows. Note the two sub-account balances drift apart over time even with equal sizing — periodic
manual rebalancing between them will eventually be needed.

### The formula

```
exposed  = 20 + combined realized PnL     (both legs' realized, summed)
leg_usd  = exposed / 2                    (identical on both legs, ALWAYS)
buffer   = account collateral - exposed   (left alone, absorbs per-leg drift)
```

Start $10/$10. Make $2 -> exposed $22 -> **$11/$11**. Lose $2 -> exposed $18 -> **$9/$9**.
Confirmed by the user: compound **down** as well as up.

Worked through with the user as "$12 and $10 -> 11 and 11" — i.e. each leg takes half of the
*combined* pool, never its own account balance.

### Why the two percentages never converge

An earlier claim that they would was **wrong** and was corrected by the user: each sub-account needs
a cushion beyond what it trades, precisely because one leg runs ahead of the other. Deploy the whole
equity and a losing leg has nothing absorbing the drift. So exposed stays permanently below equity,
and both numbers must be shown separately. Today: ~$39.7 equity, $20 exposed, ~50% utilisation —
which means any return quoted against equity **understates the real one by ~2x**.

Note the panel is currently inconsistent about this: the cycle rows already divide by deployed
capital (correct), while the COMBINED EQUITY pill divides by total equity (understates 2x).

### Implementation sketch

1. `BotConfig`: `compound_enabled`, `compound_base_usd=20.0`, `compound_step_pct=10.0`,
   `compound_max_utilisation=0.5`.
2. Exposed capital computed from the **shared in-process hub** both legs already use — no extra DB
   reads, and it guarantees both legs read the same number in the same tick.
3. Cap each leg against its own account collateral so an entry can never be rejected for margin.
4. Panel: split the equity pill into **Equity** and **Exposed**, each with its own %.
5. Tests: equal legs at every level, compounds down, step threshold respected, cap binds correctly,
   breakeven floor still solvable at any size.

### Open decisions

- **Resize every cycle, or in steps?** Steps (e.g. only on a >=10% move in exposed) while still
  measuring — constantly changing size makes a 500-cycle sample harder to read, since each cycle's
  dollar result is scaled differently.
- **Floor at $10?** User said no — let it compound down.

### Timing

**Do not enable until the edge is established.** Compounding multiplies whatever edge exists,
including a negative one. Build it shipped-off behind `compound_enabled=False`, flip it when the
double-loss rate confirms the strategy is on the right side of the 24% line.

## Operating notes

- Controls are **Close Both → Reset → ON**, in that order. Reset refuses while a leg is open.
- `consecutive_entry_failures` sticks at 3 after a circuit-breaker trip; **Reset clears it**, or the
  bot disables itself again on the first entry.
- A red **UNHEDGED** row means a leg traded with no partner — a real problem, report it. `⏳ … still
  running` is normal (cycle in flight).
- Migration `supabase/migrations/lighter_hedge_worker2_audit_fixes.sql` has been applied.
- Deploy: `git push origin main` (Render, batch commits) + `npx vercel --prod --yes --scope scrivano`.
