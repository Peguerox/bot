# Live bot bugs — what happened, why, and the checklist for the next bot

Real incidents from building the live bots on Binance Global/US, kept here so the next
bot gets checked against these before going live, not after.

## 1. Stale-price order placement race (hit this 3 times, in 3 different shapes)

**Pattern:** a price is fetched once at the top of a run, then used several `await`s later
(after a DB write, a cancel call, a network round-trip) to place an order. By the time the
order reaches Binance, price has moved — and Binance rejects the order outright instead of
accepting something that no longer makes sense.

**Where it actually happened:**
- **SOL OCO Global, OCO placement (`-2010 relationship of prices... not correct`):** TP/SL
  were computed from the original fill price. If price fell past the SL level before the OCO
  could be placed, Binance rejected it — and since the retry used the *same* stale fill price
  every time, it failed identically forever, sitting unprotected for 5+ minutes.
- **SOL OCO Global, re-entry (`-2010 would immediately match and take`):** after an SL closed
  a trade, the bot reused the `book.bid` snapshot from the top of that same run to place the
  next entry. By placement time price had moved enough to cross the spread, and a maker-only
  order can't do that. Self-healed next cycle (no position was ever opened), so low severity —
  but same root cause.
- **SOL Trail Global, trail-up + initial stop (`-2010 stop price would trigger immediately`):**
  worst version of this bug. The trail-up step fetches live price, computes a new stop 0.1%
  below it, then does cancel-old + place-new. If price drops during that gap, the new stop is
  already breached before it's placed and gets rejected — and there was **no fallback at all**,
  so the position sat with zero orders on the exchange until a manual market-sell fixed it.

**Checklist for next time:**
- [ ] Any order placement that happens more than one `await` after its price was fetched needs
      a rejection fallback, not just a happy path.
- [ ] The fallback is always the same: if a resting order gets rejected because price already
      moved past it, **don't retry the same calculation** — exit/enter at market immediately.
- [ ] Never let a retry reuse a stale, already-invalidated price. If the first attempt failed
      because price moved, the second attempt needs a *fresh* price or it will just fail again.

## 2. Env var collision risk — `BINANCE_API_KEY_EU`

`lib/binance.ts` resolves credentials as `BINANCE_API_KEY_EU ?? BINANCE_API_KEY`, but every
signed function in that file still hits `api.binance.us`. Setting `BINANCE_API_KEY_EU` (e.g.
thinking it's "the Global key") would silently redirect every US bot's authenticated calls to
use Global credentials against the US endpoint — instant auth failure across every bot sharing
that file. Caught before it happened this time.

**Checklist:** before adding a new exchange/account integration, grep for any existing env var
whose name is *suggestively similar* to the new one, and check what actually consumes it via
`??` fallback chains — don't assume a plausible-sounding name is unclaimed.

## 3. Dashboard drift after a numeric config change

Raised `HARD_CAP_USD` from $20 to $100 in the trigger code and DB seed, but missed: the
aggregate return% divisor (`initial: 20` in the summary table), the panel's own `INITIAL`
constant (feeding its PnL chart), the description text ("$20 REAL"), and the confirm-dialog
text ("hard-capped at $20"). Dashboard showed ~5x inflated returns until caught.

**Checklist:** after changing any numeric constant that's duplicated across trigger code + DB
seed + dashboard strings, `grep -rn` for the *old* value across the whole repo, not just the
file you meant to change.

## 4. IP whitelist — CIDR notation silently didn't work

Pasting `3.40.0.32/27` directly into Binance's IP-restriction field didn't take effect the way
expected. Had to fall back to enumerating and pasting all 32 individual IPs.

**Checklist:** don't assume an exchange's IP whitelist UI accepts CIDR — verify with a small
test first, or just default to individual IPs when time is tight. Also: Trigger.dev projects
can have **multiple regions with different static IP ranges** (we had 3) — verify which one is
actually in use with a real diagnostic task instead of assuming the default region is correct.

## 5. Test-script bug (not a bot bug, but wasted a cycle)

A one-off diagnostic script sent the same params in both the URL query string and the POST
body, causing Binance to reject with `-1101 Duplicate values for parameter 'symbol'`.

**Checklist:** signed POST helpers send params in exactly one place — body only, matching the
existing `lib/binance*.ts` pattern. Never both.

## 6. Stop-limit buffer silently guaranteed a taker fee on every exit

**Pattern:** a `STOP_LOSS_LIMIT` sell had its limit leg priced with a small buffer *below* the
trigger price ("so it has a real chance to fill during a fast move"). That buffer means the
limit order lands below wherever the market already is the instant it triggers — which crosses
the book and fills as **taker** every single time, not "when the market's moving fast." This
went unnoticed for a long time because the buy side (`LIMIT_MAKER`) really was always free, so
"fees are basically zero" looked true from the entry side alone.

**Where it happened:** SOL Trail Global and SOL OCO Global, both real money. Confirmed via real
`/myTrades` fill data — 0/41 recent SL exits came back `isMaker: true`; every one paid 0.1%
taker. On a strategy whose entire edge is a ~0.1% band, that fee was eating the edge outright.

**Fix:** set the limit leg *exactly* at the stop price (no buffer). A plain trigger then rests
at the current market level and fills as maker. Trade-off: removing the buffer reintroduces a
small chance the triggered order doesn't fill immediately (see #7).

**Checklist for next time:**
- [ ] Any `STOP_LOSS_LIMIT` (or equivalent) sell: check whether the limit price sits *below* the
      stop price "for safety." If it does, that's a standing taker-fee guarantee, not a safety
      margin — verify with real `/myTrades` `isMaker`/`commission` fields, don't assume from the
      order type name.
- [ ] Don't conclude "fees are ~0" from the entry side only — check every leg (entry *and* exit)
      independently. A maker-only entry says nothing about the exit's fee.

## 7. PnL tracked gross proceeds, not net-of-commission

**Pattern:** trade PnL used `cummulativeQuoteQty` straight off the exit order as "USD out." That
field is gross proceeds *before* commission — not what actually lands in the account. Combined
with #6, every tracked trade silently overstated its real result by the fee amount, so the
dashboard could show breakeven/small-win while the real balance was shrinking.

**Fix:** added `getNetSellProceeds(symbol, orderId, quoteAsset, grossQty)` (`lib/binance-global.ts`)
— pulls `/myTrades` for the order and nets out whatever commission was actually charged in the
quote asset. Every exit path (normal stop fill, market-exit fallback, phantom-stop exit) now
records `netProceeds` instead of the raw gross value.

**Checklist for next time:** any bot that records "USD out" from an order response should net
it through real fill data, not the order's own gross quantity field — do this from day one,
don't wait for a "wait, are we actually losing money?" moment to notice.

## 8. Removing a fee-guaranteeing buffer reintroduces a "phantom stop" risk

Direct consequence of fixing #6: once the stop-limit's price sits exactly at the trigger instead
of a bit below it, it's no longer *guaranteed* to cross the book and fill instantly — it can
trigger and then just rest, unfilled, if the market doesn't come back to that exact level. A bot
that only checks "did it fill?" once a minute could leave a position exposed to further downside
for a full minute without noticing.

**Fix:** track the live tick price during monitoring and, if the order isn't `FILLED` but price
has clearly traded through the stop by some margin (`STUCK_STOP_PCT`, currently 0.02%), treat it
as stuck and force a market exit instead of waiting. Added to both the WebSocket-chase bot
(checked every `FILL_CHECK_MS`) and the plain poll-based OCO bot (checked once per run, since it
has no WS chase — this one matters more there, given the longer gap between checks).

**Checklist for next time:** any change that removes a "make sure it fills" buffer needs an
explicit "did it actually fill?" watchdog added in the same change, not as a follow-up — the two
are a pair, not independent fixes.

## 9. A run chaining two "slow" phases back-to-back can exceed `maxDuration`

**Pattern:** a single 1-min run has multiple points that can each independently take a long
time (e.g. a ~50s WebSocket monitoring burst, or a ~40s poll waiting for an order to fill). Each
one alone fits comfortably under a 55s `maxDuration` budget — but if a run hits *two* of them in
sequence (e.g. a chase burst closes the position, and the same run immediately re-enters and
starts polling for that new fill), the combined time can blow past the limit. The platform kills
the run mid-flight: any live orders already placed stay live (fine), but the run's own final log
write never happens (log entry silently missing) and any dependent step queued after the kill
point (e.g. placing a protective stop right after a fill) doesn't happen until the next tick
notices instead.

**Where it happened:** SOL Trail Global — a chase burst's emergency exit fired ~17s into a run,
the same run immediately placed a new entry and started polling for its fill, and the combined
run ran past 55s and got killed. The position was briefly (~10s) unprotected until the next
tick's normal fill-check caught it and placed the stop.

**Fix:** track elapsed time from the top of the run (`runStartMs`) and skip/defer any subsequent
slow phase (starting a chase burst, or polling for a just-placed order's fill) if the run has
already used more than a small cutoff of its budget — let the next 1-min tick pick it up instead
of risking a compounding timeout. Safe to defer in both cases: a resting stop protects an open
position regardless of whether this tick's chase runs, and a resting buy has nothing to protect
yet.

**Checklist for next time:**
- [ ] Any task with more than one potentially-slow phase (polling loops, WS bursts, retries)
      needs to reason about *combined* worst-case duration across all phases that could fire in
      the same invocation, not just each phase's own cap in isolation.
- [ ] Track elapsed time from the top of the run and gate later slow phases on it — cheap to add,
      and the deferred work is safe to hand to the next tick as long as whatever's already live
      (orders, positions) doesn't depend on this run finishing to stay protected.
- [ ] A run that got silently killed leaves no error in your own logs by definition — if trade
      activity doesn't line up with a logged run, suspect this before anything else.

---

## The general rule this all points to

Every real bug tonight was some version of **"a value fetched at time T was used to place an
order at time T+n, and reality moved in between."** The fix is never a better calculation —
it's always: *detect that reality moved, and fall back to acting at the current price instead
of retrying a now-invalid plan.* Any new bot that places orders based on a snapshot taken
earlier in the same run needs this fallback built in from the start, not added after an
incident.
