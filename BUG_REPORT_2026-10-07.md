# Bug Report — 2026-10-07 audit (hedge + Master Schedule + Worker 1)

All findings come from the live `*_runs` / `*_trades` / `*_state` tables and the deployed
source. Times are UTC. Status reflects the audit's fix commit.

## Summary

| # | Bug | Money impact | Status |
|---|-----|--------------|--------|
| 1 | Late-visible fill counted as failure → circuit breaker tripped on entries that worked | Long leg stopped trading | **Fixed** |
| 2 | Re-entry right after a "no fill" doubled the position | 2x short, emergency flatten | **Fixed** |
| 3 | Tripped leg still joined the cycle barrier → partner entered alone | 3 UNHEDGED short cycles | **Fixed** |
| 4 | Schedule re-enabled the breaker-tripped leg every ~30s (fight loop) | Log spam, feeds #3 | **Fixed** |
| 5 | `confirm_fill` retries cut 6→3 earlier the same day (my change) | Direct cause of #2, worsened #1 | **Reverted** |
| 6 | SL=100% ("no stop") sent a $0 native stop, rejected 579× in 2h | Request spam → WAF | **Fixed** |
| 7 | Dashboard "Currently governing" ignored "Don't touch" | Showed Rule 3 for hedge | **Fixed** |
| 8 | Draft rule showed dangling "Wiggle ≤" | Display only | **Fixed** |
| — | Lighter WAF rate-limiting (405 HTML, `x-amzn-waf-ac`) | Slow/failed reads | External; mitigated |
| — | `close_incomplete` with `remaining_qty: 0.0` | None — PnL matches to the cent | Not a bug |
| — | Duplicate identical `closed` logs | None — deploy overlap logs twice | Not a bug |
| — | `tick_watchdog_timeout` on all 3 bots at 07:25 Oct 6 | Watchdog recovered | External stall |

## The sequence that broke the hedge (02:47–02:58)

```
02:47:04  new instances start (my tries 6->3 change goes live)
02:48:18  LONG enter_no_fill (fail 1)   02:48:22 LONG adopted_orphan  <- it DID fill
02:48:51  LONG enter_no_fill (fail 2)   02:48:55 LONG adopted_orphan  <- filled
02:49:39  LONG enter_no_fill (fail 3)   02:49:43 LONG adopted_orphan  <- filled
02:51:25  LONG entry_circuit_breaker (counter never reset by the adoptions)
02:51:27  SHORT entered alone  -> UNHEDGED (long declared ready, then bailed)
02:56:46  schedule re-enables LONG -> 02:56:48 breaker trips again (repeats x4)
02:56:49  SHORT enter_no_fill (late fill)  02:56:52 SHORT entered AGAIN
02:56:55  SHORT oversize_detected 0.00024 vs 0.00012 -> emergency flatten
02:57:59  SHORT entered alone again -> UNHEDGED SL
```

## Fixes (server/stoch_bot_core.py unless noted)

1. **`entry_settle_seconds`** (new `BotConfig` field, 10s in all 3 live configs): after an
   unconfirmed entry, no new entry (normal or reversal) until the window passes, so a late fill
   is adopted, never doubled.
2. **Orphan adoption resets `consecutive_entry_failures` to 0** and clears the settle window.
3. **Breaker + equity checks moved before the cycle barrier**; a tripped leg withdraws instead
   of declaring readiness, so its partner is never released alone.
4. **`_apply_schedule_rules` won't turn ON a bot with `consecutive_entry_failures >= 3`.**
   Recovery is the panel's Reset (it already zeroes the counter).
5. **`confirm_fill` back to `tries=6`.**
6. **`NO_STOP_SL_PCT = 50`**: an SL at/above this sends no native stop order.
7. **`app/page.tsx`**: "Currently governing" skips rules whose `{bot}_enabled` is null; rule
   condition text treats a blank draft input as "no bound".

New regression tests replay each incident and fail against the pre-fix code
(verified): late-visible fill doubling, adoption + counter reset, settle expiry, tripped breaker
releasing a naked partner, schedule re-enabling a tripped bot, SL=100% native spam.
1092/1092 worker checks pass; TypeScript clean.

## Known risks still open (decisions for the user, not bugs)

- **Genuine single-leg no-fill after the barrier releases both legs** still leaves the other
  leg in alone until it exits. Every "no fill" traced today turned out to be a late fill, so
  this is rare, but it is possible. Option: when one leg's entry is confirmed empty after the
  settle window, auto-close the partner.
- **SL ≥ 50% means no stop at all**, internal or exchange-side. With bigger money this is the
  single largest risk setting on the panel.
- **WAF rate-limiting is on Lighter's side.** We back off correctly; very fast cycling (every
  20-90s, two legs) is what provokes it.
- Schedule rule gaps: if no rule matches for a bot, it turns OFF. That's by design; check
  coverage before relying on it.
