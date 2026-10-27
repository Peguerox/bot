"""
REAL-MONEY LIT/USDC grid bot (2026-10-18, direct request after Worker 4's BTC stochastic clone
had a bad weekend). Places real resting LIMIT orders on Lighter's LIT/USDC spot market
(market_id 2049) and tracks them durably. Reuses the pure grid math already proven in
server/lit_grid_paper.py (level_of, compute_order_size_lit, levels_for_drawdown) and the
websocket price feed (LiveBook) -- only the EXECUTION layer here is new, not the decision math.

THE CORE SAFETY REQUIREMENT (direct user request, stated explicitly before any of this was
built): a durable log of every real order, with a stable ID and the ACTUAL filled price, that
survives a restart -- so the bot never ends up holding LIT with no record of what it cost.

FOURTH-PASS FIXES (2026-10-18), from a third independent audit, each confirmed against this code
before fixing:

  - P1: the one-shot allowance (max_open_buys/lifetime_buy_count) could be exceeded after a
    crash between sending an order and persisting the counter -- those two writes were not
    atomic. The counter is now reserved with a conditional (optimistic-concurrency) PATCH
    BEFORE the order is ever sent, so an ambiguous send is already counted against the
    allowance, and a concurrent/restarted instance can never double-spend the same slot.
  - P1: flatten_all() could place a duplicate market sell for a level whose PREVIOUS flatten
    attempt's sell was still unresolved (not yet terminal) -- current_holdings() only looked at
    status='filled' rows, so an in-flight sell's real (possibly partial) execution was invisible.
    Sells now count toward holdings the moment they have ANY recorded filled_qty, terminal or
    not (buys deliberately still wait for terminal -- a conscious, asymmetric choice: a
    still-resting buy is not yet "ours" to manage, but a sell's execution is real money already
    gone the moment it's recorded). flatten_all() also now refuses to place a new sell for any
    level that still has an unresolved resting sell, reporting incomplete instead.
  - P1: a cancel's SDK ack (`cancel_order_row` returning True) was being treated as "confirmed
    cancelled" by callers -- it only means the request was SENT. The spacing-change gate now
    reconciles and re-checks real resting state before advancing internal_spacing_pct, and the
    sell-vs-buy conflict path cancels the conflicting buy and defers placing the sell to the
    NEXT tick (after reconciliation has a chance to confirm it's actually gone) instead of
    placing it in the same breath as an unconfirmed cancel.
  - P1: current_holdings() queried without pagination, so a long-running bot could eventually
    exceed PostgREST's default row cap and silently lose track of old inventory. Both the buy
    and sell queries now paginate to completion.
  - P1: losing the single-instance lock mid-tick was not detected -- _touch_lock_heartbeat's
    conditional write returning zero rows (another instance now owns it) was silently ignored,
    and the dethroned instance kept believing it still held the lock and kept sending orders.
    It now clears self._lock_held the moment a heartbeat write matches zero rows, and every
    order-placing loop checks it after each action and stops immediately if lost.
  - P2: the real cash figure used for the spending cap could be up to 60s stale (the balance
    refresh interval) even though a buy had JUST been confirmed filled by reconciliation this
    same tick. reconcile_pending_orders() now returns the net USDC delta from whatever it just
    confirmed, and tick() applies that delta to the in-memory cash figure immediately whenever
    the periodic real-balance refresh didn't ALSO run this same tick (avoiding double-counting).
  - P2: the same-price buy/sell conflict check matched by a RECOMPUTED display level, which
    could differ from a resting buy's own real stored level even at the exact same price. It now
    compares real integer price ticks directly, never a recomputed level.
  - P2: a terminal partial fill below the 1.00 LIT minimum had no exit path (clamp_order_size
    refuses it, forever) -- flatten now logs this distinctly (`flatten_dust_stuck`) instead of
    looking like an ordinary unresolved retry, so it's visible as something needing a manual
    decision rather than silently stuck.
  - P2: an order absent from the exchange's own lookup (account_orders has a finite history
    window) used to be silently skipped with no visibility. Now logs a distinct warning once an
    unresolved order has been missing for longer than a generous threshold.
  - P2: the active window recentered from the live price every tick with no hysteresis, so a
    resting buy sitting right at a boundary could get cancelled before ever having a chance to
    fill, wasting a one-shot allowance slot on nothing. The window center now reuses the same
    guard-banded level_of(..., reference=...) already proven in the paper bot, so pure
    boundary noise no longer shifts it.
  - The settings route had no way to actually CLEAR max_open_buys back to "no cap" (continuous
    production mode) -- null/undefined/empty were all treated as "leave unchanged". Submitting
    0 now explicitly means "remove the cap".

FIFTH-PASS FIXES (2026-10-18), from a fourth independent audit, each confirmed against this code
before fixing, plus a new feature (direct request):

  - P1: flatten_all() never checked the lock mid-flight -- its cancel/sell loops had no
    _lock_held guard at all, and market_sell_level() never touched the heartbeat. A dethroned
    worker could keep flattening after a handover, racing the replacement worker over the same
    inventory. Both loops now bail (and log flatten_aborted_lock_lost) the moment the lock is
    lost; the new lock-holder picks the same flatten_requested flag up on its own next tick.
  - P1: the lock heartbeat failed OPEN on a network error (an exception on the PATCH just
    returned, leaving _lock_held True) -- now fails CLOSED, consistent with every other check in
    this file. The heartbeat check also moved from AFTER each real order action to BEFORE it:
    checking after the fact let exactly one action slip through per lock-loss event (e.g. a long
    current_holdings() scan outlasting the lease before the next heartbeat caught it).
  - P2: a same-tick cash correction (see fourth-pass P2-7) only ever lived in a local variable --
    the NEXT tick's get_state() returned the stale pre-fill balance again, since nothing wrote
    the corrected figure back. It's now persisted immediately so it survives into the next tick.
  - P2: reconcile_pending_orders()'s own initial query was still a single unpaginated sb() call
    -- holdings/resting-orders were paginated last round, this exact same query was missed. Now
    uses sb_paginate() like everything else.
  - P2: an order missing from the exchange's own lookup past the stale threshold was logged but
    never gated anything -- new entries kept being placed elsewhere while that uncertainty sat
    unresolved. reconcile_pending_orders() now reports this back and tick() pauses new entries
    (never exits) the same way a real balance divergence already does.

PROFIT ALLOCATION (direct request, 2026-10-18): realized profit (computed the same way the paper
bot already does -- (sell_fill_price - cost_basis_at_time_of_sale) * qty, on every sell fill) is
credited to exactly one of three durable buckets, selected by `profit_mode` (never the bot's own
choice -- user-set only, like every other toggle):

  - 'rest' (default): profit just accumulates in profit_bucket_rest_usd. No effect on trading --
    it's the user's to withdraw from the real exchange account whenever they want.
  - 'cover_drop': profit accumulates in profit_bucket_cover_drop_usd. maintain_window() spends
    from it -- on top of the ordinary capital_usd ceiling, never replacing it -- only once a buy's
    cost would otherwise exceed what's left of the base capital_usd budget, letting the window
    keep buying further down than the original budget alone would allow. Spent dollars are
    deducted from the bucket as they're used.
  - 'compound': profit accumulates in profit_bucket_compound_usd. Folded into the sizing basis
    (capital_usd + this bucket, mirroring the paper bot's compounding_basis = capital_usd +
    bot_profit_usd) the next time order_size_lit is recomputed, producing a bigger order size.
    Unlike cover_drop this is never spent/decremented by that use -- it keeps growing as more
    profit lands in it, same as the paper bot's bot_profit_usd never shrinking from market swings.

Switching `profit_mode` only changes where NEWLY-realized profit gets credited going forward.
Money already sitting in a bucket is never moved to a different bucket on a mode switch -- it
stays earmarked for that bucket's own purpose (cover_drop still gets spent covering a drop,
compound still inflates sizing) regardless of which mode is currently selected; only crediting
new profit is mode-gated, spending an existing balance is not.

SIXTH-PASS FIXES (2026-10-18), from a fifth independent audit, each confirmed against this code
before fixing -- all concentrated in the profit-allocation feature's accounting, plus one
cash-accounting gap that predates it:

  - A cash-delta correction (fifth-pass P2) was only ever persisted AFTER the price check and
    the balance-divergence check -- a missing price, or anything else that returned early,
    silently skipped the write, permanently losing a correction that can never be recomputed
    once its order has already left the reconcilable (OPEN_STATUSES) set. Now persisted
    immediately after reconciliation, before anything that could return early, and fails CLOSED
    (pauses entries) if that persist write itself fails.
  - tick() selectively patched only usdc_balance onto its local state copy instead of re-reading
    fresh -- a profit-bucket credit that reconciliation had JUST written moments earlier was
    invisible to maintain_window()'s spend check later the SAME tick, so a cover_drop-funded buy
    could overwrite (not just fail to see) a same-tick credit. tick() now always re-reads state
    fresh after reconciliation, for every field, not just cash.
  - A rejected buy's cost was charged against cover_drop (and the base budget) exactly the same
    as an accepted one -- place_grid_order()'s return value was never checked. A confirmed
    rejection (a clean `None` return) is no longer charged; an ambiguous send (still returns a
    row id) is still charged, deliberately conservative, same philosophy as the one-shot
    allowance counter.
  - Compounding inflated the SIZING basis (capital_usd + profit_bucket_compound_usd) but the
    SPENDING ceiling only ever used capital_usd (plus cover_drop) -- a bigger order size just
    consumed the old, unexpanded budget sooner instead of the compound bucket actually funding
    more depth. The spending ceiling now folds in the same compound bucket the sizing basis uses.
  - cover_drop money, once spent funding a buy, never came back when that position was later
    sold -- the bucket just kept draining on every reuse even though the real exchange cash had
    already returned. Each buy's ledger row now records exactly how much of its own cost was
    drawn from the bucket (`funded_from_bucket_usd`); current_holdings() tracks a blended
    bucket-funded cost alongside the ordinary cost basis, and a sell now returns that fill's
    share of it to profit_bucket_cover_drop_usd -- on top of, and independent of, whatever
    profit_mode governs the newly-realized profit itself. This makes cover_drop properly
    revolving across repeated drops instead of a one-shot allowance.
  - A sell's profit/principal was credited to its bucket in the SAME pass that marked it
    'filled' -- if that credit write failed, the exception was logged and never retried, since a
    filled row drops out of every future reconcile scan by definition. The credit amount and its
    destination bucket are now recorded on the sell's own row ATOMICALLY with its 'filled'
    status (one PATCH, one SQL statement); a separate, idempotent _flush_uncredited_profit() step
    -- re-run every single tick regardless of whether anything new reconciled -- scans
    specifically for filled sells not yet credited and retries until it durably succeeds, so a
    restart or a transient write failure can no longer lose or duplicate a credit.
  - A multi-price partial fill (e.g. a market sell sweeping through several book levels) computed
    its cash/profit delta as new_qty_increment * overall_average_price -- not the real proceeds
    of just the new increment when per-fill prices differ. Cumulative filled_quote is now
    persisted alongside filled_qty, and every delta is computed from quote-amount deltas
    directly (new_quote - prior_quote), never qty-times-average-price.
  - Crediting the compound bucket now also clears the cached order_size_lit, so new profit
    actually triggers a resize at the very next tick instead of sitting inert until an unrelated
    settings change -- "startup" was never actually a recompute trigger (order_size_lit is
    persisted; a fresh process never clears it), a documentation inaccuracy in the prior
    writeup, corrected here along with the mechanism itself.

SEVENTH-PASS REDESIGN (2026-10-18), from a sixth independent audit: three of its four findings
were separate symptoms of ONE root cause -- the sixth pass's profit buckets were a MUTABLE
counter, spent in one write and credited back in another, with no way to keep the two in sync
across a partial failure. Rather than patch each symptom again, the mutable counter is gone:

  - [was P1] Retrying the sixth pass's credit flush could double-apply a credit if the
    "mark credited" write failed, or its response was lost, after the bucket update had already
    committed -- two separate writes for one logical operation, no way to make the pair atomic
    over plain REST PATCHes. There is no separate "mark credited" step anymore to go out of sync.
  - [was P2] A confirmed, zero-fill cancellation never released the coverage it had reserved --
    nothing ever un-tagged it, so repeated cancel/replace cycles (the window-chasing behavior
    kept on purpose, see v5) could drain cover_drop while the real exchange cash sat untouched.
  - [was P1] A failed bucket-deduction write (separate from the order's own funded_from_bucket_usd
    tag) left the bucket at its original amount; when that buy later sold, the sixth pass's
    principal-return step still credited the tagged amount back, producing a false credit for
    money that was never actually taken out.

  profit_bucket_rest_usd / _compound_usd / _cover_drop_usd are now PURE DERIVED values,
  recomputed by _bucket_balances() every tick and written back purely for display -- never
  mutated by a spend or a return. rest/compound are simply the sum of realized_profit_usd
  (recorded durably on each sell row, atomic with its own 'filled' status, unchanged from sixth
  pass) routed to that destination. cover_drop is that same sum, MINUS money currently reserved
  by a still-unresolved buy (status in OPEN_STATUSES -- a CONFIRMED cancellation moves a row out
  of this set with nothing extra to write, which is exactly what makes a cancelled buy's
  reservation release itself for free) and MINUS money tied up in inventory that hasn't sold yet
  (current_holdings()'s bucket_cost_total, which already shrinks the moment that inventory
  sells -- so cover_drop's spendable room rises back up on its own, no "return principal" step
  to get out of sync). bucket_principal_return_usd and profit_credited are no longer written;
  the columns are left in place (never drop a column retroactively) but are simply unused.

  The remaining [P1] finding -- a per-row reconciliation write failure could raise uncaught out
  of reconcile_pending_orders() entirely, losing every OTHER row's already-computed cash delta
  THIS pass, permanently, since a row whose write DID succeed is now 'filled' and drops out of
  every future scan -- is fixed directly: each row's PATCH is now in its own try/except, and a
  row's contribution to usdc_delta is only counted once its own write is confirmed. The SAME
  class of loss existed in the spacing-change branch, which called reconcile_pending_orders()
  a second time and discarded its returned delta outright; both call sites (and flatten_all's
  three) now run their delta through one shared _apply_usdc_delta() helper.

  funded_from_bucket_usd is tagged against the FULL requested order size at placement time;
  current_holdings() now scales it by filled_qty/size when attributing bucket-funded cost to a
  position, so an order that only partially filled before the rest was cancelled doesn't
  attribute the WHOLE intended reservation to a position that's actually smaller.

EIGHTH-PASS CHANGES (2026-10-18), two direct-request behavior changes plus four findings from a
seventh independent audit:

  - Window-chasing removed entirely (direct request): a resting buy used to get cancelled the
    moment price drifted close enough that its OWN level fell outside the window's current top
    edge -- even though price had never actually reached its real limit price. Repeated
    cancel/replace cycles like this could burn through a one-shot allowance (when one is set)
    with zero real fills ever happening -- nothing bought, nothing to sell, and no slots left to
    try again. A resting buy is now cancelled ONLY by an explicit spacing change or a flatten,
    never by the window simply moving. The window still governs where NEW buys get placed each
    tick; it no longer un-places existing ones.
  - Cold-start initial fill (direct request): the resting-limit ladder only ever fills if price
    drifts down into it, which might never happen -- a fresh (or freshly reset) bot could sit at
    zero inventory indefinitely. The very first time this bot has never filled a buy and
    currently holds nothing, `levels_up` lots worth of size are bought immediately with a REAL
    MARKET order, subject to the exact same budget/allowance/bucket-funding checks as an
    ordinary buy -- `levels_down` plays NO role in a cold start; it still governs only the
    ongoing resting-ladder depth, exactly as before, so the two are fully independent. The
    instant any buy has ever filled, every subsequent buy -- including refilling a level that
    later sells back to empty -- goes through the normal resting-limit ladder again, unaffected,
    governed by levels_down as always. The budget check for a cold-start buy uses the real LIVE
    price (what will actually be paid), not each level's theoretical grid price, which would
    have understated the real cost for the deeper levels. See NINTH-PASS FIX below for how the
    cold-start lots and the ladder are placed on an anchored grid.
  - [P1] A reconcile row-write failure could mean the write actually committed and only the
    HTTP response was lost -- not that nothing happened. Treating that as "definitely not
    persisted" (previous pass's assumption) left the bot's cash/holdings view silently wrong
    with no pause. A row-write exception now also fails closed: it pauses new entries and resets
    the balance-refresh timer so the very next tick forces a fresh, authoritative check instead
    of waiting out the normal interval on a cache that might already be stale.
  - [P1] check_balance_divergence() advanced its own refresh timer BEFORE persisting the fresh
    balance it had just read -- if that save failed, the next tick's throttle check believed a
    refresh had just succeeded and skipped doing a real one, trusting old cash with the pause
    flag still false. The save is now inside the same guarded block as the read, and the timer
    only advances once that save has actually succeeded.
  - [P2] funded_from_bucket_usd was written in a SEPARATE PATCH after the order's own row was
    already created -- if that second write failed, the order was real and open but its
    reservation was invisible to _bucket_balances(), letting the derived "available" figure
    overstate what was actually free. It's now included in the SAME insert that creates the
    order's ledger row in the first place, for both the ordinary ladder and the cold-start path.
  - [P2] The base capital_usd budget was being charged for the FULL cost of every holding and
    resting buy, including the share that was actually funded by cover_drop -- the same dollar
    was then subtracted a SECOND time from cover_drop's own derived figure, double-charging it
    against both budgets. capital_committed for the base budget now excludes each holding's and
    resting buy's bucket-funded share (tracked via the same funded_from_bucket_usd/
    bucket_cost_total this file already maintains), so a position entirely funded by profit no
    longer eats into the user's own configured capital_usd at all.

NINTH-PASS FIX (2026-10-18), from a real live incident on the very first time the bot was ever
turned on: `levels_up=5` placed FIVE SEPARATE market buys at cold start, one per nominal level.
A market order ignores the "level" price entirely -- it just buys at whatever price the book
offers right now -- so all five filled within a few cents of each other instead of 0.125%
apart. Their sell targets (cost * (1+spacing%)) are derived from that real cost, so all five
collapsed onto the SAME real price tick. The bot then tried to rest five separate sell orders
on that one tick: the exchange's own POST_ONLY handling cancelled several of them outright, one
filled for a few cents of dust, and the rest only separated once real price had drifted far
enough -- visible live as a burst of cancel/replace noise and a ladder gap of ~0.8% instead of
0.125% between the cold-start holdings and the first resting buy below them.
A first fix (one combined market order) removed the collision but still left a hole: grid lines
were fixed to a global scale (anchored at $1.00) unrelated to the start price, and the first
buy sat one extra line down -- live, price 2.8790 had its first buy at 2.8701 (-0.31%) and its
sell at 2.8844 (+0.19%). Final fix (direct request: "5 up, 15 down, each 0.125%"): the grid is
anchored at the price the bot starts at (state.grid_anchor_price, written on cold start), so
every line is anchor * (1+spacing)^n. Cold start market-buys levels_up lots, one order each,
held at lines 0..levels_up-1; each lot held at line L sells at line L+1 (never below cost),
giving sells at exactly +1..+levels_up spacings. The buy ladder starts at the highest free line
at or below price, giving buys at exactly -1..-levels_down spacings. A run with no anchor keeps
the old behavior.
Trailing up (direct request: "5 up + 15 down = 20 orders all the time"): whenever fewer than
levels_up lots are held (sells filled on a rise), the missing lots are market-bought onto the
lines just above the highest held one, so their sells land at the new top; the grid bottom
moves up with the top and the lowest buys are cancelled. Trailing down: buys always sit on
the levels_down lines directly below the lowest held lot (or below price when nothing is held),
so as buys fill on a drop one new buy is added at the bottom; each filled buy gets its sell one
line up. A held line is never bought again until its sell fills. Buys are paid from capital
first; only once capital is used up does the cover-drop bucket pay -- with both used up the bot
logs no_funds_for_buy once and waits.

TENTH PASS (2026-10-18/19, live fixes after the first real trading day):
  - In-flight trailing-up market buys are marked order_kind='market' on their row and counted by
    that mark. Price-based checks (row band above market, line above the buy ladder) went stale
    in a fast rise: the bot held 9 lots against levels_up=5. Tick-by-tick replays of a very fast
    rise and drop are in the tests.
  - New orders go in nearest to price first, alternating sell/buy (limit sells are queued and
    merged with the buy ladder); market sells/cancels stay immediate, trailing buys last.
  - drawdown_coverage_pct: each tick, how far price can drop while the bot can still keep buying
    (deepest buy on the book + lines the free money can still pay for); shown on the dashboard's
    Cover-Drop box.
  - Investment > real account value refuses the cold start (the dashboard refuses too).
  Last audit (2026-10-19 ~00:10 UTC): ledger LIT matched the exchange, every order on a grid
  line, no doubles, none on the wrong side of price, 0 rejections in 3h. Known, unfixed: brief
  balance-divergence pauses around fills (longest 26s); lowest buys cancelled/re-placed as the
  window trails; in very fast rises some trailing lots get market-sold back at about cost.

Nothing in this codebase has placed a real LIMIT order before this (stoch_bot_core.py's
place_order only ever sends MARKET orders; native SL/TP are the only conditional orders that
exist). The Lighter SDK (lighter.SignerClient.create_order) supports real ORDER_TYPE_LIMIT with
ORDER_TIME_IN_FORCE_POST_ONLY -- used here specifically because Lighter's maker fee on this pair
is confirmed 0%, so POST_ONLY guarantees every fill is a maker fill.

Precision (confirmed live against Lighter's own orderBooks endpoint for market 2049): price to 4
decimals, size to 2 decimals, hard minimum 1.00 LIT per order. clamp_order_size() refuses
(returns None) rather than ever place an undersized order.

Real balance: this account has margin_mode="enabled" -- a per-asset `balance` field reads
0.000000 even with real funds present; the actual usable amount sits in `margin_balance`
(confirmed live). Still unverified for a real LIT asset entry (zero held so far).

Starts disabled, max_open_buys defaults to 1. Nothing here ever places a real order until
enabled=true is set from the dashboard -- explicitly the user's call.
"""
import asyncio
import collections
import contextlib
import math
import os
import time
import json as jsonlib
from datetime import datetime, timedelta, timezone

import aiohttp
import lighter

import grid_engine
from lit_grid_paper import (
    level_of, compute_order_size_lit, levels_for_drawdown, LiveBook, _price_sum_for_levels,
    STREAM_URL, BOOK_MAX_AGE, BOOK_WS_RECONNECT_AFTER,
)

SUPABASE_URL = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
LIGHTER_URL = "https://mainnet.zklighter.elliot.ai"

MARKET_ID = 2049  # LIT/USDC spot
TABLE_STATE = "lighter_lit_grid_live_state"
TABLE_ORDERS = "lighter_lit_grid_live_orders"
TABLE_RUNS = "lighter_lit_grid_live_runs"

PRICE_DECIMALS = 4
SIZE_DECIMALS = 2
MIN_BASE_AMOUNT = 1.00

TICK_EVERY = 2.0
ROWS_CACHE_RELOAD_S = 900.0    # full re-read of the ledger rows (holdings + profits) at least this often
COMPOUND_RESIZE_MIN_LIT = 0.01  # new compound profit resizes orders once it adds >= 0.01 LIT per order
NEAR_BOOK_GAP_ALERT_S = 10.0  # dashboard: a missing order next to price for this long = gap alarm
SLOW_EVERY = 15.0             # v2: profit buckets / tier refresh, after the reaction orders
REACT_MIN_INTERVAL = 0.5      # v2: at most one tick this often when woken by an order change
REST_TIMEOUT = 8.0
ORDER_TIMEOUT = 12.0
# Minimum gap between cancel-all attempts during a grid reset (one tx each, see reset_grid).
GRID_RESET_CANCEL_RETRY_S = 10.0
# Exchange requests per minute shared by every bot in this process (Worker 3 and Worker 4 are
# sub-accounts of one wallet; Lighter meters a standard account at 60/min per wallet). Kept under
# the cap so a burst from one bot can never trip the limit for both.
REQUEST_BUDGET_PER_MIN = 40.0
# A pending row absent from the exchange this long, confirmed by a successful full read, was never
# placed (or is already gone) -- resolved instead of blocking its slot. Lighter shows new orders
# 3-4s late, so 60s is far past any honest delay.
GHOST_RESOLVE_S = 60.0
# Engine v2 (grid_engine.py): reconcile + book read at most this often (each is one read);
# orders sent recently and not yet visible are not re-sent for INFLIGHT_S; a price that was
# rejected for a non-rate-limit reason is not retried for REJECT_COOLDOWN_S; one batch carries at
# most BATCH_MAX transactions; a diff wanting more than BULK_CANCEL cancels uses one cancel-all
# instead; trailing-up market buys are spaced at least TRAIL_COOLDOWN_S apart.
RECONCILE_EVERY = 5.0
# Account-orders websocket (2026-10-22): the book of OUR orders pushed by Lighter, so the bot sees
# its orders without spending the 60/min request limit on reads. REST stays as the check on it.
ORDERS_WS_RECONCILE_EVERY = 2.0     # reconcile cadence while the feed is trusted (no request cost)
ORDERS_WS_PING_EVERY = 20.0         # Lighter closes a socket silent for 2 minutes
ORDERS_WS_MAX_SILENCE = 50.0        # no frame (pong included) this long = feed not trusted
ORDERS_WS_RENEW_EVERY = 8 * 60.0    # reconnect with a fresh auth token (tokens live 10 minutes)
ORDERS_WS_VERIFY_EVERY = 60.0       # one REST read a minute cross-checks the feed
ORDERS_WS_DISTRUST_S = 300.0        # after a mismatch, REST only for this long
ORDERS_WS_SETTLE_S = 5.0            # an order changed this recently may differ between the two
INFLIGHT_S = 12.0
REJECT_COOLDOWN_S = 60.0
REJECT_RETRY_S = 4.0          # first refusal in a rejected batch: retry after this, not the full cooldown
BATCH_MAX = 20
BULK_CANCEL = 8
LOW_BUDGET_SLOTS = 8   # below this many request slots left, only the reaction orders go out
TRAIL_COOLDOWN_S = 10.0
VISIBILITY_GRACE_S = 6.0        # a just-sent order is not visible to any read before this
SETTLE_S = 30.0                 # a just-vanished order may explain a balance mismatch this long
AUTH_TOKEN_LIFETIME_S = 10 * 60
AUTH_TOKEN_REFRESH_MARGIN_S = 60.0
LOCK_REFRESH_EVERY = 5.0
LOCK_STALE_AFTER = 30.0
RATE_LIMIT_BACKOFF_START = 15.0
RATE_LIMIT_BACKOFF_MAX = 60.0  # Lighter documents a 60s static firewall cooldown
BALANCE_RECONCILE_EVERY = 30.0
BALANCE_DIVERGENCE_TOLERANCE_LIT = 0.03
# Dynamic drawdown (toggle `dynamic_dd_enabled`, 2026-10-19 research in
# research/lit-dynamic-drawdown-2026-10-19/): Drawdown follows how far price is below its
# high -- <5% -> 10, 5-10% -> 20, 10-20% -> 40, >20% -> 99.9, same gates both ways.
# The last gate was 80 until 2026-10-23 (direct request): past a 20% fall the remaining cash is
# spread down to 0.1% of the high, so the bot can never run out of cash whatever the coin does
# (costs ~20% smaller orders in that gate only -- lines near zero are nearly free to fund).
DYNAMIC_DD_BASE = 10.0
DYNAMIC_DD_GATES = ((5.0, 20.0), (10.0, 40.0), (20.0, 99.9))
OPEN_STATUSES = ("pending", "open", "cancel_requested")
# Gate-dependent spacing growth (toggle `gate_spacing_growth_enabled`, 2026-10-21 research in
# research/lit-dynamic-drawdown-2026-10-19/lit_gate_spacing.py): spacing widens to
# base x (1, 2, 3, 4) across the four dynamic-drawdown tiers (10/20/40/80 on today's gates),
# i.e. the SAME step as the starting spacing itself, not a fixed percentage-point amount --
# a fixed step only ever looked good because it happened to be tuned around one particular
# starting spacing. Confirmed on both LIT's and ZEC's own data, at every starting spacing
# tested: it earns more AND (the bigger reason) fixes orders collapsing below the exchange
# minimum deep in a drawdown when starting tight -- real LIT data showed a flat 0.125% grid
# unable to place any order 67.6% of the way through a recent 31-day window.
DYNAMIC_DD_TIER_ORDER = (DYNAMIC_DD_BASE,) + tuple(t for _, t in DYNAMIC_DD_GATES)
# Curve sizing (toggle `curve_enabled`, 2026-10-25, owner's formula -- research in
# research/lit-curve-spacing-2026-10-25/FORMULAS.md): every new buy is sized at its own price,
#   size(p) = floor + (B - R)/W * ((p - F)/(P - F))^n      [LIT]
# P = the curve's top (price at switch-on, moved up at every new top), F = P x 0.001 (a 99.9% fall),
# R = floor x the sum of every line price from P down to F, W = sum of p x ((p - F)/(P - F))^n over
# the same lines, B = cash for new buys at the last (re)plan + profit added since. Most money right
# below the top, shrinking smoothly to the floor, no gaps down to F. Only one sizing mode is ever on:
# curve beats dynamic if both flags are somehow set.
CURVE_FLOOR_FRAC = 0.001
# Curve mode only: a resting, unfilled buy more than 25% off its curve size is cancelled and placed
# again at the right size (the one-time swap at switch-on). Small drifts (profit, a new top) keep it.
CURVE_REPLACE_FRAC = 0.25
# Mirror shape (`curve_peak_pct`, 2026-10-27, owner's choice for the fresh-capital bot): the same
# curve, but its biggest orders sit `peak`% below the top instead of at it -- the dollars at a price
# that is g below the peak equal the plain curve's dollars at g below the top, on both sides. 0 =
# the plain curve (byte-for-byte the old sizes). Research: research/lit-plan-50k-2026-10-27/.
# Crash reserve (`reserve_enabled`): `reserve_share_pct` of every profit made since it was switched
# on (or last deployed) is kept as idle USDC -- never sized into the curve, never spent by a buy.
# When price is `reserve_deploy_pct`% below the curve's top, the reserve is released and the curve
# re-planned at that price with all free cash. Held lots keep their own sells. On LIT and HYPE this
# kept the grid earning through the crash (HYPE -66%: no month under $600).
RESERVE_MIN_DEPLOY_USD = 1.0
TERMINAL_STATUS_SUBSTRINGS = ("cancel", "reject", "expir")
PAGE_SIZE = 500
# Re-anchored line numbers start this far past every line number already in the ledger.
REANCHOR_LEVEL_MARGIN = 2000
# How long an order can sit unresolved (absent from the exchange's own lookup) before this is
# logged distinctly rather than silently retried forever (external audit finding -- Lighter's
# account_orders endpoint has a finite history window, so a long enough outage can genuinely
# lose visibility into an order's real fate).
UNRESOLVED_ORDER_STALE_AFTER_S = 3600.0
PROFIT_MODES = ("rest", "cover_drop", "compound")
PROFIT_BUCKET_COLUMN = {
    "rest": "profit_bucket_rest_usd",
    "cover_drop": "profit_bucket_cover_drop_usd",
    "compound": "profit_bucket_compound_usd",
}


class ExchangeLimiter:
    """One request budget and one backoff for every bot in the process (2026-10-22). Both bots
    draw from the same wallet's limit, so one bot's 429 must slow both -- per-instance backoff let
    Worker 4 keep firing while Worker 3 was already rate-limited, extending the lockout for both."""

    def __init__(self, per_minute=REQUEST_BUDGET_PER_MIN):
        # A sliding 60s window, not a token bucket: a full bucket plus a minute of refill let 80
        # requests through in one minute against Lighter's 60 (found by the engine simulator).
        self.capacity = int(per_minute)
        self._sent = collections.deque()
        self.backoff_until = 0.0
        self.backoff_s = RATE_LIMIT_BACKOFF_START

    def blocked(self):
        return time.time() < self.backoff_until

    def try_take(self, n=1):
        if self.blocked():
            return False
        now = time.time()
        while self._sent and now - self._sent[0] >= 60.0:
            self._sent.popleft()
        if len(self._sent) + n > self.capacity:
            return False
        self._sent.extend([now] * n)
        return True

    def room(self):
        """Slots left in the current 60s window (0 while backing off)."""
        if self.blocked():
            return 0
        now = time.time()
        while self._sent and now - self._sent[0] >= 60.0:
            self._sent.popleft()
        return max(0, self.capacity - len(self._sent))

    def take_up_to(self, n):
        """As many of n slots as the window has room for (0 while backing off)."""
        if self.blocked():
            return 0
        now = time.time()
        while self._sent and now - self._sent[0] >= 60.0:
            self._sent.popleft()
        k = max(0, min(int(n), self.capacity - len(self._sent)))
        self._sent.extend([now] * k)
        return k

    def hit(self):
        self.backoff_until = time.time() + self.backoff_s
        self.backoff_s = min(self.backoff_s * 2, RATE_LIMIT_BACKOFF_MAX)

    def ok(self):
        self.backoff_s = RATE_LIMIT_BACKOFF_START


SHARED_LIMITER = ExchangeLimiter()


def round_price(price):
    return round(price, PRICE_DECIMALS)


def round_size(qty):
    return round(qty, SIZE_DECIMALS)


def clamp_order_size(qty):
    sized = round_size(qty)
    if sized < MIN_BASE_AMOUNT:
        return None
    return sized


def price_to_int(price):
    return int(round(price * (10 ** PRICE_DECIMALS)))


def size_to_int(qty):
    return int(round(qty * (10 ** SIZE_DECIMALS)))


def _order_fill_amounts(order):
    filled_base = float(getattr(order, "filled_base_amount", 0) or 0)
    filled_quote = float(getattr(order, "filled_quote_amount", 0) or 0)
    if filled_base <= 0:
        return 0.0, None
    return filled_base, filled_quote / filled_base


def _order_is_terminal(order):
    remaining = getattr(order, "remaining_base_amount", None)
    if remaining is not None and float(remaining) <= 0:
        return True
    status = str(getattr(order, "status", "") or "").lower()
    return any(p in status for p in TERMINAL_STATUS_SUBSTRINGS)


def _chunks(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def cover_for_tier(tier):
    """How much further (as a % of CURRENT price, not the original high) this tier's grid needs
    to extend -- the exact same value _dynamic_order_size already used inline before 2026-10-22,
    pulled out here so both the sizing code and the spacing-multiplier formula below share one
    definition. The base tier's own cover is just its own tier value (no gate drop to net out).
    An unrecognized tier (toggle just switched on, nothing recorded yet, or a bad value) is
    treated as the base tier -- the safe/inert default, same philosophy as the old flat
    multiplier's fallback."""
    if tier == DYNAMIC_DD_BASE:
        return DYNAMIC_DD_BASE
    gate = next((g for g, t in DYNAMIC_DD_GATES if t == tier), None)
    if gate is None:
        return DYNAMIC_DD_BASE
    return max(tier - gate, 1.0) / (1 - gate / 100)


BASE_COVER = cover_for_tier(DYNAMIC_DD_BASE)


def capital_corrected_spacing_multiplier(tier, available_usdc, base_capital_usdc):
    """Replaces the old flat 1/2/3/4x table (2026-10-22, direct request after an external audit's
    Section 4 refinement): spacing scales as sqrt(cover(tier)/cover(base)) so per-trade profit
    stays roughly constant across gates instead of swinging 2-2.5x the way the flat multiplier
    did -- derived from the real sizing math, profit_per_trade ~= capital x spacing^2 / cover
    (verified against live data in research/lit-constant-profit-spacing-2026-10-22/PROPOSAL.md).
    The extra sqrt(base_capital/available) term corrects the remaining ~4-8% drift from cash
    actually depleting a little by the time a deeper gate activates -- base_capital_usdc (K0) is
    the cash recorded the last time the bot was at the base tier, available_usdc (Kg) is the cash
    available right now. Backtested (not just derived) against 124 days of real LIT 1-min candles
    in research/lit-dynamic-vs-static-2026-10-22/sim.py: beats both the flat multiplier and no
    dynamic spacing at all on profit, end equity, and max drawdown, for both bots' real
    capital/spacing settings. An unrecognized tier (toggle just switched on, nothing recorded
    yet) is treated as the base tier: multiplier 1, the safe/inert default."""
    cover = cover_for_tier(tier)
    K0 = float(base_capital_usdc) if base_capital_usdc is not None else max(float(available_usdc), 1e-9)
    # Floor Kg at a quarter of K0 and cap the result at 1x-4x (independent audit, 2026-10-22): an
    # available-cash reading near zero at a tier switch used to blow the multiplier up to ~10^6.
    Kg = max(float(available_usdc), 0.25 * K0, 1e-9)
    return min(max(math.sqrt((cover / BASE_COVER) * (K0 / Kg)), 1.0), 4.0)


DEESCALATE_HYSTERESIS_PTS = 1.0


def dynamic_dd_tier_for_drop(drop, old_tier):
    """Which dynamic-drawdown tier applies for this drop%, hysteresis-aware (2026-10-22, real
    incident: with gate_spacing_growth_enabled on, price sitting right on a gate boundary flipped
    tiers back and forth every 40-95 seconds for hours -- Worker 4 flipped 10<->20 at least 11
    times in ~4 hours as drop chopped between 4.92% and 6.38% around the 5% gate, each flip
    forcing a full cancel-and-reanchor of the whole grid under gate_spacing_growth_enabled; that
    same day a spacing-change cancel got stuck on one vanished order and blocked Worker 3 for
    4.8 hours straight.

    Escalating to a DEEPER tier still reacts instantly at the raw gate -- that's the safety
    response, no reason to ever delay it. De-escalating back to a SHALLOWER tier requires drop
    to have retreated to (the gate that got us into the current tier) minus
    DEESCALATE_HYSTERESIS_PTS, not just back under that gate by any amount. 1 point is sized from
    the real data above: the chop stayed at or above 4.92%, so gate-1 (4.0% for the 5% gate)
    clears the lowest dip actually seen with real margin, not an arbitrary guess. Only the ONE
    gate that produced the current tier is checked -- a big genuine move (e.g. drop falling
    straight from 25% to 3% in one tick) still de-escalates all the way through in one step,
    never stepping down one tier at a time."""
    tier = DYNAMIC_DD_BASE
    for gate, t in DYNAMIC_DD_GATES:
        if drop >= gate:
            tier = t
    if old_tier is None or tier >= old_tier:
        return tier
    old_gate = next((g for g, t in DYNAMIC_DD_GATES if t == old_tier), None)
    if old_gate is not None and drop >= old_gate - DEESCALATE_HYSTERESIS_PTS:
        return old_tier
    return tier


def sizing_mode(state):
    """'curve', 'dynamic' or 'flat' (both off). Only one is ever in force."""
    if state.get("curve_enabled"):
        return "curve"
    if state.get("dynamic_dd_enabled"):
        return "dynamic"
    return "flat"


def curve_weight(px, P, F, n, peak=0.0):
    """The curve's shape at `px` (LIT per unit of k). peak=0: ((p - F)/(P - F))^n. peak>0 (mirror):
    the price is mirrored around the peak (g below or above it -> g below the top) and the plain
    curve's dollars there are bought at px. Above the top counts as the top; below F, zero."""
    px = min(px, P)
    if px <= F:
        return 0.0
    if peak <= 0:
        return ((px - F) / (P - F)) ** n
    pm = P * (1 - abs((1 - px / P) - peak))
    if pm <= F:
        return 0.0
    return ((pm - F) / (P - F)) ** n * pm / px


def curve_plan(top_price, anchor_log, step, n, floor_lit, peak=0.0):
    """R and W of the curve over every grid line from the line at/below `top_price` down to
    F = top x 0.001. Pure; ~5,500 lines at 0.125%, a few ms."""
    F = top_price * CURVE_FLOOR_FRAC
    ln = grid_engine.line_at_or_below(top_price, anchor_log, step)
    P = grid_engine.line_price(anchor_log, ln, step)
    R = W = 0.0
    lines = 0
    while True:
        p = grid_engine.line_price(anchor_log, ln, step)
        if p <= F:
            break
        R += floor_lit * p
        W += p * curve_weight(p, P, F, n, peak)
        lines += 1
        ln -= 1
    return {"P": P, "F": F, "R": R, "W": W, "n": n, "floor": floor_lit, "lines": lines, "peak": peak}


def curve_size(px, plan, budget):
    """Unrounded LIT for a buy at `px`. Above the top counts as the top; below F, the floor."""
    k = max(0.0, (budget - plan["R"]) / plan["W"]) if plan["W"] > 0 else 0.0
    return plan["floor"] + k * curve_weight(px, plan["P"], plan["F"], plan["n"], plan.get("peak", 0.0))


def effective_spacing_pct(state):
    """The spacing actually used for new grid lines this tick: the dashboard's spacing_pct,
    widened by the persisted gate_spacing_multiplier_value while gate_spacing_growth_enabled AND
    dynamic_dd_enabled are both on and a multiplier has already been recorded. Any one of those
    false (or nothing recorded yet): the plain dashboard value, unchanged -- byte-for-byte old
    behavior. Reads a PERSISTED value (2026-10-22, replacing a pure tier->multiplier lookup)
    because capital_corrected_spacing_multiplier() needs live cash figures only available where
    _dynamic_order_size already computes them -- it's stored there, read here. Same ~1-tick
    (~2s) delay as before: a gate switch that happens this same tick is picked up next tick, which
    only delays the resulting re-anchor by one tick; never a correctness or safety issue (see
    maintain_window's own call site)."""
    base = float(state["spacing_pct"])
    if not state.get("gate_spacing_growth_enabled") or sizing_mode(state) != "dynamic":
        return base
    mult = state.get("gate_spacing_multiplier_value")
    if mult is None:
        return base
    return base * float(mult)


def holdings_from_rows(buys, sells):
    """Per-level held qty / average cost / cover-drop cost from filled buys and the sells that
    close them (see LitGridLive._compute_holdings for the accounting rules)."""
    events_by_level = {}
    for b in (buys or []):
        requested_size = float(b.get("size") or 0)
        fill_ratio = (float(b["filled_qty"] or 0) / requested_size) if requested_size > 1e-12 else 1.0
        events_by_level.setdefault(b["level"], []).append(
            ("buy", b["id"], float(b["filled_qty"] or 0), float(b["filled_price"] or 0),
             float(b.get("funded_from_bucket_usd") or 0) * min(1.0, fill_ratio)))
    for s in (sells or []):
        lvl = s.get("closes_level")
        if lvl is None:
            continue
        events_by_level.setdefault(lvl, []).append(
            ("sell", s["id"], float(s["filled_qty"] or 0), None, None))
    holdings = {}
    for lvl, events in events_by_level.items():
        events.sort(key=lambda e: e[1])
        qty = 0.0
        cost_total = 0.0
        bucket_cost_total = 0.0
        for kind, _id, ev_qty, ev_price, ev_bucket_cost in events:
            if kind == "buy":
                cost_total += ev_qty * ev_price
                bucket_cost_total += ev_bucket_cost
                qty += ev_qty
            else:
                if qty > 1e-12:
                    avg = cost_total / qty
                    avg_bucket = bucket_cost_total / qty
                    take = min(ev_qty, qty)
                    cost_total -= take * avg
                    bucket_cost_total -= take * avg_bucket
                    qty -= take
        if qty > 1e-9:
            holdings[lvl] = {"qty": qty, "cost": cost_total / qty, "bucket_cost_total": bucket_cost_total}
    return holdings


def open_segments(buys, sells):
    """Per held level, the (row id, kind) events making up the position still held there: every
    event after the last point that level's running quantity was back to zero. Same walk as
    holdings_from_rows (a sell with nothing held is a no-op there, so it is no part of a lot)."""
    events = {}
    for b in buys:
        events.setdefault(b["level"], []).append((b["id"], "buy", float(b["filled_qty"] or 0)))
    for s in sells:
        if s.get("closes_level") is not None:
            events.setdefault(s["closes_level"], []).append((s["id"], "sell", float(s["filled_qty"] or 0)))
    out = {}
    for lvl, evs in events.items():
        evs.sort()
        qty, seg = 0.0, []
        for rid, kind, q in evs:
            if kind == "buy":
                qty += q
                seg.append((rid, kind))
            elif qty > 1e-12 and q > 0:
                qty -= min(q, qty)
                seg.append((rid, kind))
            if qty <= 1e-9:
                seg = []
        if qty > 1e-9:
            out[lvl] = seg
    return out


def plan_reanchor_log(buys, sells, all_levels, price, new_spacing_pct, merge=False):
    """plan_reanchor for engine v2: the anchor is returned as ln(anchor), so line prices are
    exp(anchor_log + line*step) and there is no overflow limit at any spacing -- v1's
    price / exp(offset*step) refused past offset*step > 600, and every re-anchor adds ~2000 lines,
    so Worker 4 was a few re-anchors (or one spacing >= ~1.76%) away from cancelling its whole book
    and then refusing to rebuild (independent audit, 2026-10-22). Returns
    (anchor_log, {row_id: (column, new_line)}, {old_level: new_line}) or None if unsafe."""
    step = math.log(1 + new_spacing_pct / 100.0)
    offset = max((abs(int(x)) for x in all_levels), default=0) + REANCHOR_LEVEL_MARGIN
    # Every lot keeps its own line (no merging): a merged line averages the lots' costs, and a sell
    # already resting for the cheaper lot could then fill below that new average (simulator,
    # 2026-10-22). v1's plan_reanchor still merges.
    planned = _reanchor_moves(buys, sells, offset, price, step, merge=merge)
    if planned is None:
        return None
    moves, mapping = planned
    return math.log(price) - offset * step, moves, mapping


def _reanchor_moves(buys, sells, offset, price, step, merge=True):
    """Each held lot goes to the new line nearest its cost. With `merge`, lots may share a line
    when the shared line's average-cost walk gives exactly the lots' own total qty and cost (true
    whenever one lot's past partial sells all came before the other lot's buys) -- the caller must
    have an empty book (no sell resting for one lot that could fill against the merged average).
    A line that cannot take the lot: the nearest other one, either way, whose next line (the sell)
    is still at or above the lot's cost (2026-10-26: collisions used to go only upward, and on the
    real ledger a 0.25% change put 167 of 169 lots 2+ spacings above cost, up to 175)."""
    held = holdings_from_rows(buys, sells)
    segs = open_segments(buys, sells)
    placed, moves, mapping = {}, {}, {}
    if any(not segs.get(l) for l in held):
        return None
    buy_by_id = {b["id"]: b for b in buys}
    sell_by_id = {x["id"]: x for x in sells}
    is_dust = lambda l: clamp_order_size(held[l]["qty"]) is None
    has_sells_of = lambda l: any(kind == "sell" for _, kind in segs[l])

    def fits(line, lvl):
        lots = placed.get(line, []) + [lvl]
        if len(lots) == 1:
            return True
        if not merge:
            return False
        bs = [dict(buy_by_id[rid], level=line) for l in lots for rid, k in segs[l] if k == "buy"]
        ss = [dict(sell_by_id[rid], closes_level=line) for l in lots for rid, k in segs[l] if k == "sell"]
        h = holdings_from_rows(bs, ss).get(line)
        q = sum(held[l]["qty"] for l in lots)
        c = sum(held[l]["qty"] * held[l]["cost"] for l in lots)
        bc = sum(held[l]["bucket_cost_total"] for l in lots)
        return (h is not None and abs(h["qty"] - q) < 1e-6 and abs(h["qty"] * h["cost"] - c) < 1e-6
                and abs(h["bucket_cost_total"] - bc) < 1e-6)

    # Partly-sold lots first (fewest lines they can share), then by cost.
    for lvl in sorted(held, key=lambda l: (is_dust(l), not has_sells_of(l), held[l]["cost"], l)):
        exact = math.log(held[lvl]["cost"] / price) / step
        nearest = offset + round(exact)
        line, k = nearest, 0
        while line + 1 - offset < exact - 1e-9 or not fits(line, lvl):
            k += 1
            line = nearest + (k + 1) // 2 if k % 2 else nearest - k // 2
        placed.setdefault(line, []).append(lvl)
        mapping[lvl] = line
        for rid, kind in segs[lvl]:
            moves[rid] = ("level" if kind == "buy" else "closes_level", line)
    after = holdings_from_rows(
        [dict(b, level=moves[b["id"]][1]) if b["id"] in moves else b for b in buys],
        [dict(s, closes_level=moves[s["id"]][1]) if s["id"] in moves else s for s in sells])
    tot = lambda H, f: sum(f(h) for h in H.values())
    for f, tol in ((lambda h: h["qty"], 1e-6), (lambda h: h["qty"] * h["cost"], 0.01),
                   (lambda h: h["bucket_cost_total"], 0.01)):
        if abs(tot(held, f) - tot(after, f)) > tol:
            return None
    return moves, mapping


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def _parse_iso(s):
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except Exception:
        return None


class OrdersFeed:
    """Our own orders on this market, as Lighter pushes them over the account_orders websocket
    channel (2026-10-22). Every message is applied as an upsert by client_order_index -- correct
    whether Lighter sends the full list or only what changed -- and the first message on a
    connection replaces everything (the snapshot). Trusted only while frames keep arriving and
    no REST cross-check has disagreed with it recently; otherwise callers fall back to REST."""

    def __init__(self):
        self.orders = {}          # client_order_index -> order (same attributes as the REST model)
        self.changed_at = {}      # client_order_index -> when this feed last changed it
        self.synced_at = 0.0      # this connection's snapshot arrived
        self.frame_at = 0.0       # any frame (updates and pongs)
        self.verified_at = 0.0    # a REST read last agreed with it
        self.distrust_until = 0.0
        self.seq = 0              # bumps on every message that changed an order
        try:
            self.changed = asyncio.Event()   # wakes the tick loop the moment an order changes
        except RuntimeError:
            self.changed = None

    def live(self, now=None):
        now = time.time() if now is None else now
        return (self.synced_at > 0 and now - self.frame_at < ORDERS_WS_MAX_SILENCE
                and now >= self.distrust_until)

    def trusted(self, now=None):
        """Live AND a REST read has agreed with it since this connection's snapshot -- a feed
        nobody has checked yet is never acted on."""
        return self.live(now) and self.verified_at >= self.synced_at

    def reset(self):
        self.orders, self.changed_at, self.synced_at, self.verified_at = {}, {}, 0.0, 0.0

    def apply(self, orders, snapshot, now=None):
        now = time.time() if now is None else now
        if snapshot:
            self.orders, self.changed_at = {}, {}
        for raw in orders:
            o = raw if not isinstance(raw, dict) else _order_ns(raw)
            co = int(o.client_order_index)
            self.orders[co] = o
            self.changed_at[co] = now
        if snapshot:
            self.synced_at = now
        self.frame_at = now
        if orders or snapshot:
            self.seq += 1
            if self.changed is not None:
                self.changed.set()
        # Terminal orders are kept 10 minutes (reconcile reads their fills), then dropped.
        for co in [c for c, o in self.orders.items()
                   if _order_is_terminal(o) and now - self.changed_at.get(c, now) > 600]:
            self.orders.pop(co, None)
            self.changed_at.pop(co, None)

    def active(self):
        return [o for o in self.orders.values() if not _order_is_terminal(o)]

    def lookup(self, co):
        return self.orders.get(int(co))

    def recently_changed(self, co, now=None):
        now = time.time() if now is None else now
        return now - self.changed_at.get(int(co), -1e18) < ORDERS_WS_SETTLE_S


def _order_ns(d):
    """A websocket order dict as an object with the REST model's attribute names."""
    import types as _types
    return _types.SimpleNamespace(
        client_order_index=int(d.get("client_order_index") or 0),
        order_index=d.get("order_index"),
        is_ask=bool(d.get("is_ask")),
        price=d.get("price"),
        status=d.get("status"),
        remaining_base_amount=(d.get("remaining_base_amount")
                               if d.get("remaining_base_amount") is not None or str(d.get("status")) != "filled"
                               else "0"),
        filled_base_amount=d.get("filled_base_amount"),
        filled_quote_amount=d.get("filled_quote_amount"),
        initial_base_amount=d.get("initial_base_amount"),
    )


class LitGridLive:
    def __init__(self, http: aiohttp.ClientSession, table_state=TABLE_STATE,
                 table_orders=TABLE_ORDERS, table_runs=TABLE_RUNS, tag=""):
        # Table names and a log tag are constructor params (not the bare module constants used
        # directly, as before) so one process can run more than one instance against different
        # Lighter sub-accounts/Supabase tables at once (2026-10-21, direct request: twin Worker
        # 3/Worker 4 LIT grids on one Render service, same pattern as lighter_hedge_dual_leg.py's
        # two StochBot instances) -- every in-class reference below reads self.TABLE_* now.
        # Calling LitGridLive(http) with no overrides is byte-for-byte Worker 4's old behavior.
        self.http = http
        self.TABLE_STATE, self.TABLE_ORDERS, self.TABLE_RUNS = table_state, table_orders, table_runs
        self._tag = tag
        self._lock_id = f"{os.environ.get('RENDER_INSTANCE_ID', 'local')}:lit-grid-live{tag}"
        self._lock_held = False
        self._lock_checked_at = 0.0
        self._lock_blocked_logged = False
        self._last_level = None
        self._dust_logged = set()
        self.live = LiveBook(MARKET_ID)
        self._book_ws_connected_at = 0.0
        self.client = None
        self.account_index = None
        self._order_api = None
        self._account_api = None
        self._auth_token = None
        self._auth_token_expiry_at = 0.0
        self._last_balance_check = 0.0
        self._balance_paused = False
        self._holdings_cache = None
        self._holdings_cache_on = False
        # Exchange-request backoff (2026-10-22, real incident): place_grid_order/cancel_order_row
        # each catch their own errors and never raise, so a 429/nonce storm never reached
        # _run_tick_loop's own backoff -- the spacing-change cancel loop just retried every tick
        # forever, hammering the exchange and extending its own rate limit instead of letting it
        # clear. See _exchange_rate_limited()'s docstring.
        self._limiter = SHARED_LIMITER
        self._last_cancel_all_at = 0.0
        self._snapshot = None           # last successful full read of resting orders (engine v2)
        self._snapshot_at = 0.0
        self._last_reconcile_at = 0.0
        self._inflight = {}             # (side, price_int) -> sent_at
        self._missing_since = {}        # client_order_index -> first time a read did not show it
        self._started_at_dt = datetime.now(timezone.utc)
        self._rows_cache = None
        self._last_slow_at = 0.0
        self._gap_since = None
        self._reconciled_seq = -1
        self._v2_active = False
        self._orders_feed = None        # OrdersFeed, set when the websocket task runs
        self._last_rest_snapshot_at = 0.0
        self._reject_until = {}         # (side, price_int) -> retry_after
        self._reject_count = {}         # (side, price_int) -> consecutive refusals
        self._last_trail_at = 0.0
        self._engine_snapshot_at = 0.0  # the read the engine last acted on (one action per read)

    # ── Supabase ─────────────────────────────────────────────────────────────────────────────
    async def sb(self, method, path, body=None):
        url = f"{SUPABASE_URL}/rest/v1/{path}"
        headers = {
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "Content-Type": "application/json",
        }
        if method in ("POST", "PATCH"):
            headers["Prefer"] = "return=representation"
        async with self.http.request(method, url, json=body, headers=headers,
                                      timeout=aiohttp.ClientTimeout(total=8.0)) as resp:
            text = await resp.text()
            if resp.status >= 400:
                raise RuntimeError(f"supabase {resp.status} on {method} {path}: {text[:200]}")
            return jsonlib.loads(text) if text else None

    async def sb_paginate(self, path):
        """Fetches ALL rows matching a query, paginating past PostgREST's default row cap
        (external audit fix P1-5: an unpaginated query could silently truncate inventory
        history on a long-running bot)."""
        out = []
        offset = 0
        sep = "&" if "?" in path else "?"
        while True:
            page = await self.sb("GET", f"{path}{sep}limit={PAGE_SIZE}&offset={offset}")
            if not page:
                break
            out.extend(page)
            if len(page) < PAGE_SIZE:
                break
            offset += PAGE_SIZE
        return out

    async def get_state(self):
        rows = await self.sb("GET", f"{self.TABLE_STATE}?id=eq.1")
        return rows[0]

    async def update_state(self, patch):
        await self.sb("PATCH", f"{self.TABLE_STATE}?id=eq.1", patch)

    async def update_state_optional(self, patch):
        """Dashboard-only fields (2026-10-23: compound_resize, near_book). Written on their own so
        a column whose migration has not run yet can never break the trading tick."""
        try:
            await self.update_state(patch)
        except Exception as e:
            if not getattr(self, "_optional_state_warned", False):
                self._optional_state_warned = True
                await self.log_run("dashboard_field_write_failed", {"fields": sorted(patch), "error": str(e)[:160]})

    def _compound_step_usd(self, state, price):
        """Compound dollars that add COMPOUND_RESIZE_MIN_LIT to every order at the current sizing
        depth: 0.01 LIT x the price sum of all the lines the cash is spread over (same cover math
        as _dynamic_order_size). ~$25 at the 99.9% gate, ~$6.60 at 40% with LIT near $3.10."""
        spacing = effective_spacing_pct(state)
        if sizing_mode(state) == "dynamic":
            stored = state.get("dynamic_dd_high")
            high = max(float(stored), price) if stored else price
            drop = max(0.0, (1 - price / high) * 100)
            tier = state.get("dynamic_dd_tier")
            tier = float(tier) if tier is not None else DYNAMIC_DD_BASE
            cover = max(tier - drop, 1.0) / (1 - drop / 100)
        else:
            cover = float(state.get("drawdown_pct") or DYNAMIC_DD_BASE)
        return COMPOUND_RESIZE_MIN_LIT * _price_sum_for_levels(price, spacing, levels_for_drawdown(spacing, cover))

    def _compound_resize_due(self, state, compound_now, price):
        """Direct request (2026-10-24, replacing the 2026-10-23 "+0.2% of the Investment" step):
        new compound profit resizes the orders as soon as it is enough to make every order at least
        0.01 LIT (the exchange's size step) bigger -- a smaller resize would round to the same size.
        That's ~once a day at the 99.9% gate and every 1-2 hours at 40%. A resize only changes the
        size of NEW orders (no cancels, no exchange requests). Reads the compound bucket only; never
        writes any bucket. The baseline is persisted in compound_resize when that column exists,
        otherwise kept in memory (first sight = baseline, nothing resizes)."""
        rec = state.get("compound_resize") or {}
        base = rec.get("compound_usd") if isinstance(rec, dict) else None
        if base is None:
            base = getattr(self, "_compound_base", None)
        if base is None:
            self._compound_base = float(compound_now or 0)
            self._compound_base_unsaved = True   # stored for the panel ("next resize at $...")
            return False
        step = self._compound_step_usd(state, price)
        return float(compound_now or 0) - float(base) >= max(step, 0.01)

    async def _note_compound_resize(self, state, compound_now, step_usd=None):
        self._compound_base = float(compound_now or 0)
        size = state.get("order_size_lit")
        rec = {"at": now_iso(), "compound_usd": round(float(compound_now or 0), 6),
               "capital_usd": float(state.get("capital_usd") or 0),
               "step_usd": round(step_usd, 2) if step_usd is not None else None,
               "order_size_lit": round(float(size), 4) if size is not None else None}
        await self.log_run("compound_resize", rec)
        await self.update_state_optional({"compound_resize": rec})
        state["compound_resize"] = rec

    async def log_run(self, action, detail):
        print(f"[lit-grid-live{self._tag}:{action}] {detail}", flush=True)
        try:
            await self.sb("POST", self.TABLE_RUNS, {"action": action, "detail": detail})
        except Exception as e:
            print(f"  (lit-grid-live log_run failed: {e})", flush=True)

    # ── Order ledger ─────────────────────────────────────────────────────────────────────────
    @staticmethod
    def _is_rate_limit_error(msg):
        """Signals to slow down: 429/405 from the rate limiter or WAF, and "invalid nonce" (after a
        refused send, or two instances overlapping during a deploy). Matches the transport markers
        only -- a price like 3.4290 in an error message must never read as a rate limit. Any OTHER
        rejection (bad price, insufficient funds) is a real decision, not a pacing problem."""
        m = str(msg)
        return ("(429)" in m or "Too Many Requests" in m or "(405)" in m or "Not Allowed" in m
                or "invalid nonce" in m.lower())

    async def _resync_nonce(self, hard):
        """The SDK only repairs its optimistic nonce on a BadRequestException. A 429/405 or a
        timeout escapes that handler with the nonce already advanced, so the next transaction was
        guaranteed to fail with "invalid nonce". Soft: roll back one (the request was refused).
        Hard: re-read the next nonce from the exchange (a timeout may or may not have landed)."""
        nm = getattr(self.client, "nonce_manager", None)
        if nm is None:
            return
        for key in list(getattr(nm, "api_keys_list", []) or []):
            try:
                if hard:
                    await nm.async_hard_refresh_nonce(key)
                else:
                    nm.acknowledge_failure(key)
            except Exception as e:
                await self.log_run("nonce_resync_failed", {"error": str(e)[:200]})

    async def _on_send_exception(self, e):
        """Shared handling for an exception out of any signed send. Returns True if it was a
        rate-limit refusal (definitely not placed), False if the outcome is unknown."""
        if "invalid nonce" in str(e).lower():
            await self._resync_nonce(hard=True)
            return True
        if self._is_rate_limit_error(str(e)):
            self._register_exchange_rate_limit()
            await self._resync_nonce(hard=False)
            return True
        await self._resync_nonce(hard=True)
        return False

    def _take_request(self):
        """Budget gate for every exchange request (reads and sends). False = skip this one now."""
        return self._limiter.try_take()

    def _register_exchange_rate_limit(self):
        self._limiter.hit()

    def _register_exchange_success(self):
        self._limiter.ok()

    async def _rest_net(self, withdrawn):
        sells = await self._profit_rows()
        gross = sum(float(s.get("realized_profit_usd") or 0) for s in (sells or [])
                    if (s.get("profit_bucket_destination") or "profit_bucket_rest_usd") == "profit_bucket_rest_usd")
        return gross - float(withdrawn or 0)

    async def _bucket_balances(self, rest_withdrawn=0.0):
        """PURE DERIVED balances (external audit fix, seventh pass -- replaces the sixth pass's
        mutable spend/credit counter entirely, which had THREE separate non-atomicity bugs found
        by the same audit round: a retry could double-apply a credit if the "mark credited"
        write failed or its response was lost after the bucket update had already committed; a
        confirmed cancellation never released an unfilled buy's reservation, since nothing ever
        un-tagged it; and a failed bucket-deduction write (separate from the order's own
        funded_from_bucket_usd tag) meant a later sell's "return principal" step credited money
        that was never actually taken out. All three were symptoms of one root cause: a mutable
        counter, spent in one write and credited back in another, with no way to keep the two in
        sync across a partial failure.

        There is no mutable counter anymore. rest/compound are simply the sum of
        realized_profit_usd (recorded durably on each sell row, atomic with its own 'filled'
        status -- unchanged from sixth pass) routed to that destination. cover_drop is that same
        sum, MINUS whatever is currently tied up: money reserved by a still-unresolved buy
        (status in OPEN_STATUSES -- a CONFIRMED cancellation moves a row out of this set
        automatically, with nothing extra to write, which is exactly what makes a cancelled
        buy's reservation release itself for free) and money tied up in inventory that hasn't
        sold yet (current_holdings()'s bucket_cost_total, which already shrinks automatically
        the moment that inventory sells -- so cover_drop's spendable room rises back up on its
        own, with no separate 'return principal' step to get out of sync)."""
        sells = await self._profit_rows()
        gross = {"profit_bucket_rest_usd": 0.0, "profit_bucket_cover_drop_usd": 0.0,
                 "profit_bucket_compound_usd": 0.0}
        for s in (sells or []):
            dest = s.get("profit_bucket_destination") or "profit_bucket_rest_usd"
            gross[dest] = gross.get(dest, 0.0) + float(s.get("realized_profit_usd") or 0)
        open_buys = await self.sb_paginate(
            f"{self.TABLE_ORDERS}?side=eq.buy&status=in.({','.join(OPEN_STATUSES)})"
            f"&select=funded_from_bucket_usd")
        reserved = sum(float(r.get("funded_from_bucket_usd") or 0) for r in (open_buys or []))
        holdings = await self.current_holdings()
        held_bucket_cost = sum(h.get("bucket_cost_total", 0.0) for h in holdings.values())
        gross["profit_bucket_cover_drop_usd"] = round(
            max(0.0, gross["profit_bucket_cover_drop_usd"] - reserved - held_bucket_cost), 8)
        # Rest minus what the user recorded as withdrawn ("Withdrew $" on the panel).
        gross["profit_bucket_rest_usd"] = round(
            max(0.0, gross["profit_bucket_rest_usd"] - float(rest_withdrawn or 0)), 8)
        gross["profit_bucket_compound_usd"] = round(gross["profit_bucket_compound_usd"], 8)
        return gross

    async def _fetch_active_orders_list(self, auth):
        """Every order resting on the exchange for this account/market, or None if the read
        failed or the request budget is spent. A failed read must never look like "nothing
        resting": reset_grid treats an empty list as proof the book is clear, and reconcile only
        resolves a missing row when this read succeeded.

        While the account_orders websocket is trusted it answers for free; a REST read still runs
        once every ORDERS_WS_VERIFY_EVERY and is compared with it -- any disagreement (beyond
        orders that changed in the last few seconds) logs and distrusts the feed for a while."""
        feed = self._orders_feed
        now = time.time()
        if (feed is not None and feed.trusted(now)
                and now - self._last_rest_snapshot_at < ORDERS_WS_VERIFY_EVERY):
            orders = feed.active()
            self._snapshot, self._snapshot_at = orders, now
            return orders
        if not self._take_request():
            return None
        try:
            resp = await asyncio.wait_for(
                self._order_api.account_active_orders(
                    authorization=auth, account_index=self.account_index, market_id=MARKET_ID,
                    _request_timeout=REST_TIMEOUT,
                ),
                timeout=REST_TIMEOUT + 2.0,
            )
        except Exception as e:
            if self._is_rate_limit_error(str(e)):
                self._register_exchange_rate_limit()
            await self.log_run("active_orders_read_failed", {"error": str(e)[:200]})
            return None
        orders = list(resp.orders or [])
        self._snapshot, self._snapshot_at = orders, time.time()
        self._last_rest_snapshot_at = time.time()
        if feed is not None and feed.live():
            rest_cos = {int(o.client_order_index) for o in orders}
            ws_cos = {int(o.client_order_index) for o in feed.active()}
            differ = {co for co in rest_cos ^ ws_cos if not feed.recently_changed(co)}
            # A fill or cancel can reach REST a moment before the websocket (or the other way):
            # one disagreement is re-checked on the very next read, and only the SAME orders
            # disagreeing twice distrust the feed (the first version distrusted it on any single
            # difference and fell back to slow REST for 5 minutes -- simulator, 2026-10-23).
            prev = getattr(self, "_ws_differ", set())
            if differ and (differ & prev):
                feed.distrust_until = time.time() + ORDERS_WS_DISTRUST_S
                self._ws_differ = set()
                await self.log_run("orders_ws_mismatch", {"only_rest": sorted(rest_cos - ws_cos)[:10],
                                                          "only_ws": sorted(ws_cos - rest_cos)[:10]})
            elif differ:
                self._ws_differ = differ
                self._last_rest_snapshot_at = 0.0     # re-check on the next read
                self._snapshot = orders               # this cycle acts on REST
            else:
                self._ws_differ = set()
                # They agree: the feed is verified, and the fresher of the two (REST lags new
                # orders by seconds).
                if feed.verified_at < feed.synced_at:
                    await self.log_run("orders_ws_verified", {"orders": len(ws_cos)})
                feed.verified_at = time.time()
                orders = feed.active()
                self._snapshot = orders
        return orders

    async def _cancel_all_on_exchange(self, context):
        """ONE cancel-all transaction for this sub-account (it trades nothing but this grid), at
        most every GRID_RESET_CANCEL_RETRY_S and inside the request budget. Cancelling one signed
        request per order is what tripped the rate limit on 2026-10-22. True if sent cleanly."""
        if not await self._touch_lock_heartbeat():
            return False
        if time.time() - self._last_cancel_all_at < GRID_RESET_CANCEL_RETRY_S:
            return False
        if not self._take_request():
            return False
        self._last_cancel_all_at = time.time()
        try:
            _tx, _resp, err = await asyncio.wait_for(
                self.client.cancel_all_orders(
                    time_in_force=self.client.CANCEL_ALL_TIF_IMMEDIATE, timestamp_ms=0),
                timeout=ORDER_TIMEOUT,
            )
        except Exception as e:
            await self._on_send_exception(e)
            _resp, err = None, str(e)
        code = getattr(_resp, "code", 200)
        if not err and code != 200:
            err = f"send_tx code {code}: {getattr(_resp, 'message', '')}"
        if err:
            if self._is_rate_limit_error(str(err)):
                self._register_exchange_rate_limit()
            await self.log_run(f"{context}_cancel_all_failed", {"error": str(err)[:200]})
            return False
        self._register_exchange_success()
        return True

    async def reset_grid(self, profit_mode=None, route=None):
        """Clean re-anchor (grid_reset_requested, 2026-10-22). The spacing-change re-anchor
        cancels one order per signed request -- 60+ on Worker 3, which tripped Lighter's rate
        limit twice that day and left both bots stuck -- and it can only cancel orders the ledger
        knows about, so orphans left on the exchange by ambiguous sends were never cleaned up.
        This uses ONE cancel-all transaction instead, then rebuilds from the ledger:

          1. While the exchange still shows resting orders: send one cancel-all (at most every
             GRID_RESET_CANCEL_RETRY_S, respecting the 429 backoff) and wait for the next tick.
          2. Once the exchange shows nothing resting: reconcile, so any fill that landed before
             the cancel is recorded with its real price; every ledger row still open after that
             is provably not resting, so it is closed as cancelled.
          3. Force a fresh real-balance check. If ledger LIT != real LIT, stop and log -- never
             re-anchor on top of a ledger that doesn't match the account.
          4. Re-anchor at the current price with plan_reanchor (held lots keep their real cost;
             their sells are placed by maintain_window at cost + spacing or higher -- never
             below cost), then clear the flag. The next tick rebuilds the whole ladder.

        Never places or sells anything itself. Returns without side effects on any read failure;
        the flag stays set, so the next tick simply resumes where this one stopped."""
        if not await self._touch_lock_heartbeat():
            return
        auth = self._get_auth_token()
        active = await self._fetch_active_orders_list(auth)
        if active is None:
            return
        if active:
            if await self._cancel_all_on_exchange("grid_reset"):
                await self.log_run("grid_reset_cancel_all_sent", {"active_orders": len(active)})
            return

        ok, delta, _stale = await self.reconcile_pending_orders(profit_mode=profit_mode, route=route)
        await self._apply_usdc_delta(delta)
        if not ok:
            return
        # Rows the exchange no longer shows but reconcile could not settle yet (younger than
        # GHOST_RESOLVE_S, i.e. maybe a fill Lighter has not published) are waited on, never
        # force-closed: closing one that actually filled would lose that LIT from the ledger.
        leftover = await self.sb_paginate(
            f"{self.TABLE_ORDERS}?status=in.({','.join(OPEN_STATUSES)})&select=id")
        if leftover:
            return
        self._holdings_cache = None

        self._last_balance_check = 0.0
        balance_ok, refreshed = await self.check_balance_divergence()
        if not refreshed:
            return
        if not balance_ok:
            if not getattr(self, "_reset_balance_logged", False):
                self._reset_balance_logged = True
                await self.log_run("grid_reset_blocked_balance_mismatch", {})
            return
        self._reset_balance_logged = False

        price = await self.fetch_current_price()
        if price is None:
            return
        state = await self.get_state()
        spacing_pct = effective_spacing_pct(state)
        detail = {"price": price, "spacing": spacing_pct}
        buys, sells = await self._holdings_rows()
        all_rows = await self.sb_paginate(f"{self.TABLE_ORDERS}?select=id,level,closes_level&order=id.asc")
        all_levels = [r[k] for r in all_rows for k in ("level", "closes_level") if r.get(k) is not None]
        # Book empty and every open row settled: lots may share a line (no resting sell can fill
        # against a merged average), which keeps them next to their cost at a wider spacing.
        plan = plan_reanchor_log(buys, sells, all_levels, price, spacing_pct, merge=True)
        if plan is None:
            await self.log_run("grid_reset_reanchor_blocked", detail)
            return
        anchor_log, moves, mapping = plan
        # Through the journal (audit 2026-10-22): a crash between row moves replays the same
        # moves on the next tick instead of leaving a lot split across two line numbers.
        journal = {"anchor_log": anchor_log, "spacing": spacing_pct, "price": price,
                   "moves": {str(rid): [col, line] for rid, (col, line) in moves.items()},
                   "extra": {"grid_reset_requested": False}}
        await self.update_state({"reanchor_journal": journal})
        await self._apply_reanchor_journal(journal)
        detail.update({"anchor_log": anchor_log, "lots_moved": len(mapping)})
        await self.log_run("grid_reset_completed", detail)

    async def reconcile_pending_orders(self, profit_mode=None, route=None):
        """Checks every non-terminal ledger row against the exchange's own account_orders().
        Returns (all_ok, usdc_delta, has_stale_unresolved): all_ok is True only if every batch
        was successfully read; usdc_delta is the net REAL cash impact (negative for buys,
        positive for sells) of whatever just newly became terminal-with-a-fill THIS pass, so
        callers can apply it to an otherwise-stale cached balance immediately (external audit fix
        P2-7); has_stale_unresolved is True if any order has been missing from the exchange's own
        lookup for longer than UNRESOLVED_ORDER_STALE_AFTER_S -- callers use this to pause new
        entries (never exits) the same way a real balance divergence already does (external audit
        fix, fifth pass -- a stale-unresolved order used to only be logged, never gated anything).

        Realized profit on a sell fill -- computed from the REAL incremental quote-amount delta
        (new cumulative filled_quote minus prior), never qty-times-average-price, which can be
        wrong the moment a multi-partial fill crosses more than one price (external audit fix,
        sixth pass) -- is recorded directly on that sell's own row, atomically with its status
        write; _bucket_balances() (seventh pass) is what actually turns these into a bucket
        figure, by always re-deriving it rather than mutating a running counter. The cost basis
        is read via current_holdings() ONCE per pass, before this pass's own PATCHes change it.

        Each row's own PATCH write is now isolated in its own try/except (external audit fix,
        seventh pass): a failure on ONE row used to raise uncaught out of this whole function,
        losing every other row's already-computed usdc_delta THIS pass -- and since a row whose
        write succeeded is now 'filled' (dropped from every future OPEN_STATUSES scan), that
        delta could never be recovered later either. A row's contribution to usdc_delta is only
        counted once its OWN write is confirmed; an uncounted row is simply recomputed correctly
        on the next pass, since its filled_qty was never actually persisted."""
        pending = await self.sb_paginate(
            f"{self.TABLE_ORDERS}?status=in.({','.join(OPEN_STATUSES)})&select=*&order=id.asc")
        if not pending:
            # Still read the book: engine v2 acts only on a fresh read, and orders the ledger
            # does not know about (orphans) can be resting even when nothing is open here.
            await self._fetch_active_orders_list(self._get_auth_token())
            return True, 0.0, False
        self._holdings_cache = None
        holdings_before = None
        if any(r["side"] == "sell" for r in pending):
            holdings_before = await self.current_holdings()
        auth = self._get_auth_token()
        all_ok = True
        usdc_delta = 0.0
        has_stale_unresolved = False
        now = datetime.now(timezone.utc)
        active_by_co = None
        # Rest cap (2026-10-20): in rest mode, once Rest (net of withdrawals) reaches the cap,
        # new profit goes to the chosen overflow bucket instead. A whole trade's profit goes to
        # one bucket, so Rest can end a few cents over the cap.
        route = route or {}
        rest_cap = route.get("cap")
        overflow_col = PROFIT_BUCKET_COLUMN.get(route.get("overflow")) if route.get("overflow") in ("compound", "cover_drop") else None
        capped = profit_mode in (None, "rest") and overflow_col is not None and rest_cap is not None and float(rest_cap) > 0
        rest_now = None
        # One full read of what is resting (2026-10-22): rows still on the book are answered by it
        # (including partial fills), and only rows that LEFT the book -- normally zero or one per
        # pass -- need a per-order lookup. v1 looked up every open row every tick (5 requests per
        # tick on Worker 3, ~210/min across both bots), the main load behind that day's 429s.
        feed = self._orders_feed
        if feed is not None and feed.live() and not feed.trusted() and self._limiter.blocked():
            # A reconnected feed normally waits for a REST read to agree with it; while REST is
            # cooling down after a 429, the ledger can vouch instead: every order it knows is on
            # the book (old enough to be visible) is in the feed, and the feed shows nothing the
            # ledger does not know.
            grace = now - timedelta(seconds=VISIBILITY_GRACE_S)
            settled = {int(r["client_order_index"]) for r in pending
                       if r.get("exchange_order_id") is not None and r.get("order_kind") != "market"
                       and (_parse_iso(r.get("placed_at")) or now) < grace}
            ws_cos = {int(o.client_order_index) for o in feed.active()}
            open_cos_all = {int(r["client_order_index"]) for r in pending}
            if settled <= ws_cos and ws_cos <= open_cos_all:
                feed.verified_at = time.time()
                await self.log_run("orders_ws_verified", {"orders": len(ws_cos), "by": "ledger"})
        snapshot = await self._fetch_active_orders_list(auth)
        active_by_co = ({int(o.client_order_index): o for o in snapshot}
                        if snapshot is not None else None)
        missing = [r for r in pending
                   if active_by_co is None or int(r["client_order_index"]) not in active_by_co]
        # A row sent moments ago is not visible yet anywhere; looking it up only spends budget
        # (half of all requests in the simulator). It is looked up once it is old enough.
        young = {int(r["client_order_index"]) for r in missing
                 if _parse_iso(r.get("placed_at")) is not None
                 and _parse_iso(r.get("placed_at")) > now - timedelta(seconds=VISIBILITY_GRACE_S)}
        missing = [r for r in missing if int(r["client_order_index"]) not in young]
        open_cos = {int(r["client_order_index"]) for r in pending}
        for co in [c for c in self._missing_since if c not in open_cos]:
            del self._missing_since[co]
        lookup_by_co, lookup_failed = {}, set()
        # The websocket also pushes each order's final state (filled, cancelled) with its fill
        # amounts: a row it knows is answered by it, at no request cost.
        feed = self._orders_feed
        if feed is not None and feed.trusted() and active_by_co is not None:
            for r in missing:
                o = feed.lookup(r["client_order_index"])
                if o is not None:
                    lookup_by_co[int(r["client_order_index"])] = o
            missing = [r for r in missing if int(r["client_order_index"]) not in lookup_by_co]
        for chunk in _chunks(missing, 20):
            chunk_cos = {int(r["client_order_index"]) for r in chunk}
            if not self._take_request():
                all_ok = False
                lookup_failed |= chunk_cos
                continue
            try:
                resp = await asyncio.wait_for(
                    self._order_api.account_orders(
                        authorization=auth,
                        client_order_indexes=",".join(str(c) for c in sorted(chunk_cos)),
                        account_index=self.account_index, _request_timeout=REST_TIMEOUT,
                    ),
                    timeout=REST_TIMEOUT + 2.0,
                )
            except Exception as e:
                if self._is_rate_limit_error(str(e)):
                    self._register_exchange_rate_limit()
                await self.log_run("reconcile_read_failed", {"error": str(e)[:200]})
                all_ok = False
                lookup_failed |= chunk_cos
                continue
            lookup_by_co.update({int(o.client_order_index): o for o in (resp.orders or [])})
        for batch in (pending,):
            for r in batch:
                co = int(r["client_order_index"])
                o = (active_by_co or {}).get(co) or lookup_by_co.get(co)
                if o is None and co in young:
                    continue
                if o is None:
                    placed_at = _parse_iso(r.get("placed_at"))
                    age = (now - placed_at).total_seconds() if placed_at else 0.0
                    missing_since = self._missing_since.setdefault(co, time.time())
                    missing_for = time.time() - missing_since
                    # Stale only when the exchange was actually asked and did not show it: a row
                    # whose read was skipped (budget) or failed is unknown, not stale (live
                    # 2026-10-22: skipped lookups paused new buys on both bots).
                    if (age > UNRESOLVED_ORDER_STALE_AFTER_S and active_by_co is not None
                            and co not in lookup_failed):
                        await self.log_run("order_unresolved_stale", {"row_id": r["id"], "age_s": age})
                        has_stale_unresolved = True
                    # Absent from a SUCCESSFUL full read and from its own lookup, well past any
                    # honest visibility delay: it is not resting, whatever its fate (refused,
                    # cancelled, never placed). Resolving it frees the slot; v1 waited an hour,
                    # during which the ghost blocked a real order (2026-10-22). Never claims a fill:
                    # if one secretly happened, check_balance_divergence (real balance is ground
                    # truth) catches it and pauses new entries. Never resolved on a failed read.
                    # Resolved only after a full GHOST_RESOLVE_S of being missing, timed from when
                    # it was FIRST seen missing -- not from placement (audit 2026-10-22: a sell that
                    # rested for hours, then filled, was marked rejected the moment it left the
                    # book, losing the fill). A row the exchange never showed (no
                    # exchange_order_id) is a ghost after GHOST_RESOLVE_S; one it did show keeps
                    # v1's one-hour rule.
                    limit_age = (GHOST_RESOLVE_S if r.get("exchange_order_id") is None
                                 else UNRESOLVED_ORDER_STALE_AFTER_S)
                    # A row written by a process that has since restarted, and never seen by the
                    # exchange, was most likely never sent (the old process died between writing
                    # it and sending): resolved after 12s instead of 60 -- it blocked its lot or
                    # line for over a minute after a deploy (audit 2026-10-23).
                    from_before_restart = (r.get("exchange_order_id") is None and placed_at is not None
                                           and placed_at <= self._started_at_dt
                                           and age > 2 * VISIBILITY_GRACE_S)
                    if (active_by_co is not None and co not in lookup_failed
                            and ((age > limit_age and missing_for > GHOST_RESOLVE_S) or from_before_restart)):
                        try:
                            await self.sb("PATCH", f"{self.TABLE_ORDERS}?id=eq.{r['id']}",
                                           {"status": "rejected", "error": "vanished_from_exchange_lookup"})
                            await self.log_run("order_vanished_marked_rejected", {"row_id": r["id"], "age_s": age})
                        except Exception as e:
                            await self.log_run("reconcile_row_write_failed", {"row_id": r["id"], "error": str(e)[:200]})
                            all_ok = False
                    continue
                self._missing_since.pop(co, None)
                filled_qty, filled_price = _order_fill_amounts(o)
                filled_quote = float(getattr(o, "filled_quote_amount", 0) or 0)
                terminal = _order_is_terminal(o)
                status_raw = str(getattr(o, "status", "") or "").lower()
                prev_filled_qty = float(r.get("filled_qty") or 0)
                prev_filled_quote = float(r.get("filled_quote") or 0)
                patch = {"exchange_order_id": o.order_index}
                row_usdc_delta = 0.0
                if filled_qty > 0:
                    patch["filled_qty"] = filled_qty
                    patch["filled_price"] = filled_price
                    patch["filled_quote"] = filled_quote
                    # Only the NEWLY-confirmed portion since the last reconciliation pass counts
                    # toward this call's cash delta -- a row can be reconciled more than once
                    # while a partial fill is still in progress. delta_quote is the REAL dollar
                    # amount exchanged for just this increment -- never delta_qty * (overall
                    # average) price, which is wrong the moment per-fill prices differ.
                    delta_qty = max(0.0, filled_qty - prev_filled_qty)
                    delta_quote = max(0.0, filled_quote - prev_filled_quote)
                    if delta_qty > 0:
                        signed = -1.0 if r["side"] == "buy" else 1.0
                        row_usdc_delta = signed * delta_quote
                        if r["side"] == "sell" and r.get("closes_level") is not None and holdings_before:
                            basis = holdings_before.get(r["closes_level"])
                            if basis and basis["qty"] > 1e-12:
                                profit_delta = delta_quote - delta_qty * basis["cost"]
                                patch["realized_profit_usd"] = round(
                                    float(r.get("realized_profit_usd") or 0) + profit_delta, 8)
                                if not r.get("profit_bucket_destination"):
                                    dest = PROFIT_BUCKET_COLUMN.get(profit_mode, "profit_bucket_rest_usd")
                                    if capped:
                                        if rest_now is None:
                                            rest_now = await self._rest_net(route.get("withdrawn"))
                                        if rest_now >= float(rest_cap):
                                            dest = overflow_col
                                        else:
                                            rest_now += patch["realized_profit_usd"]
                                    patch["profit_bucket_destination"] = dest
                if terminal:
                    patch["status"] = "filled" if filled_qty > 0 else (
                        "cancelled" if any(p in status_raw for p in TERMINAL_STATUS_SUBSTRINGS) else "rejected")
                    if filled_qty > 0:
                        patch["filled_at"] = now_iso()
                else:
                    patch["status"] = "open"
                # Skip the write (and its log line) when nothing about this order changed since
                # the last pass -- rewriting every resting row every tick made a tick take ~11s
                # with ~20 open orders, delaying fill detection. An unchanged row can't carry a
                # cash delta (that needs filled_qty to have moved), so nothing is lost.
                changed = (
                    patch["status"] != r.get("status")
                    or str(r.get("exchange_order_id")) != str(patch["exchange_order_id"])
                    or ("filled_qty" in patch
                        and abs(float(r.get("filled_qty") or 0) - patch["filled_qty"]) > 1e-12)
                    or ("filled_quote" in patch
                        and abs(float(r.get("filled_quote") or 0) - patch["filled_quote"]) > 1e-9)
                )
                if not changed:
                    continue
                try:
                    await self.sb("PATCH", f"{self.TABLE_ORDERS}?id=eq.{r['id']}", patch)
                    self._rows_cache_note(r, patch)
                except Exception as e:
                    # The write may have actually committed and only the HTTP response was
                    # lost -- NOT proof that nothing persisted (external audit fix, eighth
                    # pass). Fails closed: pauses new entries and forces the very next tick to
                    # run a fresh, authoritative balance check instead of trusting a cache that
                    # might already be wrong, rather than just logging and moving on.
                    await self.log_run("reconcile_row_write_failed", {"row_id": r["id"], "error": str(e)[:200]})
                    all_ok = False
                    self._balance_paused = True
                    self._rows_cache = None
                    self._last_balance_check = 0.0
                    continue
                usdc_delta += row_usdc_delta
                await self.log_run("reconciled_order", {
                    "row_id": r["id"], "raw_status": status_raw, "terminal": terminal,
                    "computed_filled_qty": filled_qty, "computed_filled_price": filled_price,
                })
        self._holdings_cache = None
        return all_ok, usdc_delta, has_stale_unresolved

    async def real_balances(self):
        auth = self._get_auth_token()
        resp = await asyncio.wait_for(
            self._account_api.account(by="index", value=str(self.account_index),
                                       _headers={"authorization": auth} if auth else None,
                                       _request_timeout=REST_TIMEOUT),
            timeout=REST_TIMEOUT + 2.0,
        )
        acct = resp.accounts[0] if getattr(resp, "accounts", None) else resp
        usdc, lit = 0.0, 0.0
        for asset in (getattr(acct, "assets", None) or []):
            symbol = getattr(asset, "symbol", None)
            # margin_balance is only meaningful when that asset's margin_mode is "enabled"
            # (USDC here). For a non-margin asset (LIT: margin_mode "disabled") margin_balance
            # is always 0 and `balance` is the full amount held, locked_balance being the part
            # of it already resting in sell orders -- confirmed live 2026-10-18 (balance=12.96,
            # locked_balance=12.96 while holding exactly 12.96 LIT).
            if getattr(asset, "margin_mode", None) == "enabled":
                total = float(getattr(asset, "margin_balance", None) or 0)
            else:
                total = float(asset.balance or 0)
            if symbol == "LIT":
                lit = total
            elif symbol == "USDC":
                usdc = total
        return usdc, lit

    async def _read_balance_for_check(self):
        """Engine v2: the real balance read BEFORE this tick's reconcile, so every fill the balance
        already shows has left the book by the time the ledger is compared -- either recorded by
        that reconcile or tracked as settling. None if not due or not readable now."""
        if time.time() - self._last_balance_check < BALANCE_RECONCILE_EVERY:
            return None
        if not self._take_request():
            return None
        try:
            return await self.real_balances()
        except Exception as e:
            await self.log_run("balance_check_failed", {"error": str(e)[:200]})
            return None

    async def check_balance_divergence(self, confirm=False, pre_read=None):
        """Returns (safe_to_trade, did_refresh). did_refresh tells the caller whether this call
        actually re-read the real exchange balance (vs. returning the cached pause-state because
        the periodic interval hadn't elapsed) -- callers use it to know whether a locally-tracked
        cash delta is still needed on top (external audit fix P2-7).

        The fresh balance's SAVE is inside the same guarded block as its READ, and the refresh
        timer only advances once that save has actually succeeded (external audit fix, eighth
        pass): advancing the timer first meant a failed save left the next tick believing a
        refresh had just succeeded, so it skipped doing a real one and kept trusting stale cash
        with the pause flag still false."""
        now = time.time()
        if now - self._last_balance_check < BALANCE_RECONCILE_EVERY:
            return not self._balance_paused, False
        if confirm and pre_read is None:
            # v2 compares only a balance read before the reconcile (see _read_balance_for_check).
            return not self._balance_paused, False
        if pre_read is None and not self._take_request():
            return not self._balance_paused, False
        try:
            holdings = await self.current_holdings()
            # A resting buy that has PARTLY filled already put real LIT in the account, but
            # holdings only count a buy once it's fully filled -- count those partial fills
            # here too, or one partial fill pauses the whole grid (live, 2026-10-18 20:30).
            open_buy_fills = await self.sb_paginate(
                f"{self.TABLE_ORDERS}?side=eq.buy&status=in.({','.join(OPEN_STATUSES)})"
                f"&filled_qty=not.is.null&select=filled_qty")
            real_usdc, real_lit = pre_read if pre_read is not None else await self.real_balances()
            await self.update_state({"usdc_balance": real_usdc, "lit_balance": real_lit})
        except Exception as e:
            await self.log_run("balance_check_failed", {"error": str(e)[:200]})
            self._balance_paused = True
            return False, False
        self._last_balance_check = now
        ledger_lit = (sum(h["qty"] for h in holdings.values())
                      + sum(float(r.get("filled_qty") or 0) for r in (open_buy_fills or [])))
        diverged = abs(ledger_lit - real_lit) > BALANCE_DIVERGENCE_TOLERANCE_LIT
        if confirm:
            # Engine v2 (2026-10-22): a fill moves the real balance at once but reaches the ledger a
            # few seconds later, so one mismatched reading is usually a fill in flight. Pause only
            # if the mismatch is still there on a second reading ~2 reconcile passes later; while
            # unsure or paused, re-check that soon instead of waiting the full interval.
            # An order that just left the book with its fill not yet in the lookup explains a
            # mismatch by itself: stay unsure (no pause) until reconcile has resolved it.
            # Bounded: a row missing for longer than SETTLE_S no longer excuses a mismatch.
            settling = any(time.time() - t0 < SETTLE_S for t0 in self._missing_since.values())
            # Confirmed only by the SAME mismatch seen again: if the ledger or the real balance
            # moved in between, fills are still arriving and the new reading starts over (two
            # different fills a few seconds apart used to "confirm" each other and pause buys for
            # 20s -- simulator on the real books, 2026-10-23).
            reading = (round(ledger_lit, 6), round(real_lit, 6))
            pending = getattr(self, "_divergence_pending", None)
            if diverged and not self._balance_paused and (settling or pending != reading):
                self._divergence_pending = reading
                self._last_balance_check = now - BALANCE_RECONCILE_EVERY + 2 * RECONCILE_EVERY
                return True, True
            self._divergence_pending = None
            if diverged:
                self._last_balance_check = now - BALANCE_RECONCILE_EVERY + 2 * RECONCILE_EVERY
        if diverged and not self._balance_paused:
            await self.log_run("balance_divergence_paused",
                                {"ledger_lit": ledger_lit, "real_lit": real_lit})
        elif not diverged and self._balance_paused:
            await self.log_run("balance_divergence_cleared",
                                {"ledger_lit": ledger_lit, "real_lit": real_lit})
        if diverged:
            # A confirmed mismatch re-reads the ledger fresh on the next check instead of trusting
            # the in-memory copy (reloaded only every ROWS_CACHE_RELOAD_S, 2026-10-24).
            self._rows_cache = None
        self._balance_paused = diverged
        return not diverged, True

    # ── Auth ─────────────────────────────────────────────────────────────────────────────────
    def _get_auth_token(self):
        now = time.time()
        if self._auth_token is not None and now < self._auth_token_expiry_at - AUTH_TOKEN_REFRESH_MARGIN_S:
            return self._auth_token
        token, err = self.client.create_auth_token_with_expiry()
        if err:
            return None
        self._auth_token = token
        self._auth_token_expiry_at = now + AUTH_TOKEN_LIFETIME_S
        return self._auth_token

    # ── Single-instance lock ─────────────────────────────────────────────────────────────────
    async def acquire_lock(self):
        now = time.time()
        if now - self._lock_checked_at < LOCK_REFRESH_EVERY:
            return self._lock_held
        self._lock_checked_at = now
        stale_before = datetime.now(timezone.utc).timestamp() - LOCK_STALE_AFTER
        stale_iso = datetime.fromtimestamp(stale_before, tz=timezone.utc).isoformat().replace("+00:00", "Z")
        guard = (f"or=(lock_owner.is.null,lock_heartbeat.is.null,"
                 f"lock_owner.eq.{self._lock_id},lock_heartbeat.lt.{stale_iso})")
        try:
            rows = await self.sb(
                "PATCH", f"{self.TABLE_STATE}?id=eq.1&{guard}",
                {"lock_owner": self._lock_id, "lock_heartbeat": now_iso()},
            )
        except Exception as e:
            was_held = self._lock_held
            self._lock_held = False
            if was_held:
                await self.log_run("instance_lock_refresh_failed", {"error": str(e)[:200]})
            return False
        if rows:
            if not self._lock_held:
                await self.log_run("instance_lock_acquired", {"lock_id": self._lock_id})
            self._lock_held = True
            self._lock_blocked_logged = False
            return True
        self._lock_held = False
        if not self._lock_blocked_logged:
            self._lock_blocked_logged = True
            await self.log_run("instance_lock_busy", {"lock_id": self._lock_id})
        return False

    async def release_lock(self):
        if not self._lock_held:
            return
        self._lock_held = False
        try:
            await self.sb("PATCH", f"{self.TABLE_STATE}?id=eq.1&lock_owner=eq.{self._lock_id}",
                           {"lock_owner": None, "lock_heartbeat": None})
        except Exception:
            pass

    async def _touch_lock_heartbeat(self):
        """Refreshes (or verifies) heartbeat ownership and returns whether this instance still
        holds the lock. Called BEFORE every real exchange action (external audit fix, fifth
        pass): checking only AFTER the fact let exactly one action slip through per lock-loss
        event. An unverifiable heartbeat (a network error on the PATCH itself) now fails CLOSED
        -- treated as lock lost -- instead of silently leaving _lock_held True, consistent with
        every other safety check in this file (previously it failed open here, the one
        exception)."""
        if not self._lock_held:
            return False
        try:
            rows = await self.sb("PATCH", f"{self.TABLE_STATE}?id=eq.1&lock_owner=eq.{self._lock_id}",
                                  {"lock_heartbeat": now_iso()})
        except Exception as e:
            self._lock_held = False
            await self.log_run("instance_lock_heartbeat_unverifiable", {"error": str(e)[:200]})
            return False
        if not rows:
            self._lock_held = False
            await self.log_run("instance_lock_lost_mid_tick", {"lock_id": self._lock_id})
            return False
        return True

    # ── Live price ───────────────────────────────────────────────────────────────────────────
    async def fetch_current_price(self):
        return self.live.best_mid()

    async def _book_ws_session(self):
        ws = lighter.WsClient(
            order_book_ids=[MARKET_ID], account_ids=[],
            on_order_book_update=self.live.on_order_book_update,
            ws_url=STREAM_URL,
        )
        self._book_ws_connected_at = time.time()
        await ws.run_async()

    async def _orders_ws_session(self, feed):
        """One account_orders connection: subscribe with a fresh auth token, apply every message,
        ping so Lighter keeps it open, and close after ORDERS_WS_RENEW_EVERY (token lifetime)."""
        token = self._get_auth_token()
        if not token:
            raise RuntimeError("no auth token for the orders websocket")
        channel = f"account_orders/{MARKET_ID}/{self.account_index}"
        opened = time.time()
        async with self.http.ws_connect(STREAM_URL, heartbeat=None, max_msg_size=0) as ws:
            await ws.send_json({"type": "subscribe", "channel": channel, "auth": token})
            first = True
            last_ping = time.time()
            while time.time() - opened < ORDERS_WS_RENEW_EVERY:
                if time.time() - last_ping >= ORDERS_WS_PING_EVERY:
                    await ws.send_json({"type": "ping"})
                    last_ping = time.time()
                try:
                    msg = await ws.receive(timeout=5.0)
                except asyncio.TimeoutError:
                    continue
                if msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.CLOSING, aiohttp.WSMsgType.ERROR):
                    raise RuntimeError(f"orders websocket closed ({msg.type})")
                if msg.type != aiohttp.WSMsgType.TEXT:
                    continue
                data = jsonlib.loads(msg.data)
                kind = str(data.get("type") or "")
                if kind == "pong" or kind == "ping":
                    feed.frame_at = time.time()
                    if kind == "ping":
                        await ws.send_json({"type": "pong"})
                    continue
                if "error" in data or kind == "error":
                    raise RuntimeError(f"orders websocket error: {str(data)[:200]}")
                if "account_orders" not in kind and "account_orders" not in str(data.get("channel") or ""):
                    feed.frame_at = time.time()
                    continue
                orders = (data.get("orders") or {}).get(str(MARKET_ID)) or []
                feed.apply(orders, snapshot=first or kind.startswith("subscribed"))
                first = False

    async def run_orders_ws_forever(self):
        """Keeps the account_orders feed connected for the life of the process. Any failure just
        leaves the feed untrusted (the bot reads REST meanwhile) and reconnects."""
        feed = OrdersFeed()
        self._orders_feed = feed
        failures = 0
        while True:
            try:
                await self._orders_ws_session(feed)
                failures = 0
            except Exception as e:
                failures += 1
                if failures in (1, 5) or failures % 50 == 0:
                    await self.log_run("orders_ws_reconnect", {"error": str(e)[:200], "failures": failures})
            feed.reset()
            await asyncio.sleep(min(30.0, 1.0 * failures))

    async def run_book_ws_forever(self):
        while True:
            task = asyncio.create_task(self._book_ws_session())
            try:
                while not task.done():
                    await asyncio.sleep(2.0)
                    quiet_since = max(self.live.updated_at, self._book_ws_connected_at)
                    age = time.time() - quiet_since
                    if age > BOOK_WS_RECONNECT_AFTER:
                        await self.log_run("book_ws_watchdog_reconnect", {"ob_age": round(age, 1)})
                        break
                if task.done() and not task.cancelled():
                    exc = task.exception()
                    if exc is not None:
                        await self.log_run("book_ws_disconnected", {"error": str(exc)[:300]})
            except Exception as e:
                await self.log_run("book_ws_supervisor_error", {"error": str(e)[:300]})
            finally:
                task.cancel()
                with contextlib.suppress(BaseException):
                    await task
            await asyncio.sleep(1.0)

    # ── Holdings ─────────────────────────────────────────────────────────────────────────────
    async def current_holdings(self):
        # Within one tick the holdings are computed once and reused (they were rebuilt from
        # the full ledger 3-4 times per tick). Only a reconcile pass can change them -- it's
        # the only writer of fills -- and it drops the cache before and after its writes.
        if getattr(self, "_holdings_cache_on", False) and self._holdings_cache is not None:
            return dict(self._holdings_cache)
        holdings = await self._compute_holdings()
        if getattr(self, "_holdings_cache_on", False):
            self._holdings_cache = holdings
            return dict(holdings)
        return holdings

    async def _compute_holdings(self):
        """Running, quantity-aware balance per level, paginated (external audit fix P1-5).

        Buys only count once status='filled' (a deliberate, documented choice: a still-resting
        buy isn't "ours" to manage yet). Sells count the moment they have ANY recorded
        filled_qty, terminal or not (external audit fix P1-2/P1-3): a sell's execution is real
        money gone the instant it's recorded, whether or not the rest of that order is still
        working -- treating it as invisible until terminal is what let flatten try to re-sell
        inventory a still-open prior sell had already partially or fully sold.

        Also walks a SECOND blended total alongside the ordinary cost basis: how much of each
        level's current cost came from the cover_drop bucket (`funded_from_bucket_usd`, recorded
        on the buy row at placement time), reduced proportionally on a partial sell exactly like
        the cost basis itself (external audit fix, sixth pass -- cover_drop money spent on a buy
        never came back when that position was later sold; this is what lets cover_drop's
        spendable room rise back up once it does, per _bucket_balances()). funded_from_bucket_usd
        is tagged against the FULL requested order size, so a buy that only partially filled
        before the rest was cancelled has its tag scaled down by filled_qty/size here (external
        audit fix, seventh pass) -- otherwise a partial fill would attribute the WHOLE intended
        reservation to a position that's actually smaller than what was reserved for."""
        buys, sells = await self._holdings_rows()
        return holdings_from_rows(buys, sells)

    async def _holdings_rows(self):
        """The rows holdings are built from. Kept in memory and updated by reconcile's own fill
        writes (the only writer of fills), with a full re-read every ROWS_CACHE_RELOAD_S as a
        safety net (manual SQL edits, anything missed) -- re-reading ~2,800 rows took ~1s and ran
        twice before every reaction order (measured live, 2026-10-23). Anything that moves lots
        between lines (re-anchor, reset) drops the cache."""
        c = getattr(self, "_rows_cache", None)
        if c is not None and time.time() - c["at"] < ROWS_CACHE_RELOAD_S:
            return ([c["buys"][k] for k in sorted(c["buys"])], [c["sells"][k] for k in sorted(c["sells"])])
        buys = await self.sb_paginate(
            f"{self.TABLE_ORDERS}?status=eq.filled&side=eq.buy"
            f"&select=id,level,filled_qty,filled_price,size,funded_from_bucket_usd&order=id.asc")
        sells = await self.sb_paginate(
            f"{self.TABLE_ORDERS}?side=eq.sell&closes_level=not.is.null&filled_qty=not.is.null&select=id,closes_level,filled_qty&order=id.asc")
        profits = await self.sb_paginate(
            f"{self.TABLE_ORDERS}?side=eq.sell&realized_profit_usd=not.is.null"
            f"&select=id,realized_profit_usd,profit_bucket_destination&order=id.asc")
        buys, sells = buys or [], sells or []
        self._rows_cache = {"at": time.time(), "buys": {r["id"]: r for r in buys},
                            "sells": {r["id"]: r for r in sells},
                            "profits": {r["id"]: r for r in (profits or [])}}
        return buys, sells

    def _rows_cache_note(self, row, patch):
        """Reconcile just wrote `patch` to `row`: mirror it into the in-memory rows."""
        c = getattr(self, "_rows_cache", None)
        if c is None:
            return
        m = dict(row, **patch)
        if m.get("side") == "buy" and m.get("status") == "filled":
            c["buys"][m["id"]] = {k: m.get(k) for k in ("id", "level", "filled_qty", "filled_price",
                                                       "size", "funded_from_bucket_usd")}
        elif (m.get("side") == "sell" and m.get("closes_level") is not None
              and m.get("filled_qty") is not None):
            c["sells"][m["id"]] = {k: m.get(k) for k in ("id", "closes_level", "filled_qty")}
        if m.get("side") == "sell" and m.get("realized_profit_usd") is not None:
            c["profits"][m["id"]] = {k: m.get(k) for k in ("id", "realized_profit_usd", "profit_bucket_destination")}

    async def _profit_rows(self):
        """Sells with a realized profit, kept in the same in-memory ledger copy as the holdings
        (2026-10-24: re-reading every sell ever made every 15s grew ~700 rows a day). Reconcile --
        the only writer of realized_profit_usd -- mirrors its writes into the cache; a full
        re-read every ROWS_CACHE_RELOAD_S is the safety net."""
        await self._holdings_rows()
        return list(self._rows_cache["profits"].values())

    async def resting_orders_by_level(self):
        rows = await self.sb_paginate(
            f"{self.TABLE_ORDERS}?status=in.({','.join(OPEN_STATUSES)})&select=*")
        by_level = {}
        for r in (rows or []):
            by_level.setdefault(r["level"], []).append(r)
        return by_level

    # ── One-shot allowance, reserved atomically BEFORE a buy is ever sent ──────────────────────
    def _funding(self, state, holdings, resting):
        """Money the next buy may spend: (resting_buy_cost, base_capital_remaining,
        available_usdc). Shared by the buy ladder and the dynamic-drawdown sizing so both
        use the exact same figure."""
        resting_buy_cost = sum(
            float(r["limit_price"]) * float(r["size"])
            for rows in resting.values() for r in rows if r["side"] == "buy"
        )
        # The base budget now excludes each holding's/resting buy's own bucket-funded share
        # (external audit fix, eighth pass): charging the FULL cost of a position that was
        # actually funded by cover_drop against capital_usd double-counted that same dollar,
        # since _bucket_balances() already subtracts it from cover_drop's own derived figure.
        resting_buy_bucket_cost = sum(
            float(r.get("funded_from_bucket_usd") or 0)
            for rows in resting.values() for r in rows if r["side"] == "buy"
        )
        real_usdc = float(state.get("usdc_balance") or 0)
        holdings_cost = sum(h["qty"] * h["cost"] for h in holdings.values())
        holdings_bucket_cost = sum(h.get("bucket_cost_total", 0.0) for h in holdings.values())
        capital_committed_base_only = (
            (holdings_cost - holdings_bucket_cost) + (resting_buy_cost - resting_buy_bucket_cost)
        )
        # Compound bucket folded into the SPENDING ceiling too, not just the sizing basis
        # above (external audit fix, sixth pass: a bigger order size from compounding used
        # to just consume the old, unexpanded budget sooner instead of the compound bucket
        # actually funding more depth -- the two bases must agree).
        compound_bucket = float(state.get("profit_bucket_compound_usd") or 0)
        base_capital_remaining = max(
            0.0, (float(state["capital_usd"]) + compound_bucket) - capital_committed_base_only)
        # Cover-drop bucket extends the ceiling ON TOP OF that, never replacing it -- only
        # reached once the (compound-inclusive) base budget is exhausted (direct request,
        # profit allocation feature). state["profit_bucket_cover_drop_usd"] is this tick's
        # freshly-DERIVED figure (tick() computes it via _bucket_balances() before calling
        # here) -- there is no separate decrement to write at the end of this loop anymore
        # (external audit fix, seventh pass): available_usdc below is the single running
        # total that already correctly shrinks by each buy's full cost regardless of which
        # sub-budget it's attributed to, and the per-buy funded_from_bucket_usd tag (written
        # atomically with the order itself, external audit fix eighth pass) is the only
        # durable fact _bucket_balances() needs to derive the post-spend figure correctly on
        # the very next tick. The real-cash ceiling below always uses the FULL resting cost
        # regardless of attribution -- real cash doesn't care which sub-budget funded it.
        cover_drop_bucket = float(state.get("profit_bucket_cover_drop_usd") or 0)
        available_usdc = min(real_usdc - resting_buy_cost, base_capital_remaining + cover_drop_bucket)
        # Crash reserve: idle cash until it is deployed -- no buy may spend it.
        available_usdc -= self._reserve_usd(state)
        return resting_buy_cost, base_capital_remaining, available_usdc

    async def _dynamic_order_size(self, state, price, spacing_pct, holdings, resting):
        """Order size under the dynamic drawdown toggle. The high starts at the price when the
        toggle is switched on and follows every new high. On each gate change the size is
        recomputed from the money ACTUALLY spendable now (not the full Investment): that cash
        is spread over every line from price down to tier% below the high -- the research's
        "B" sizing, which never ran out of money where sizing on the full Investment did."""
        stored = state.get("dynamic_dd_high")
        high = max(float(stored), price) if stored else price
        patch = {}
        if not stored or high > float(stored):
            patch["dynamic_dd_high"] = high
        drop = max(0.0, (1 - price / high) * 100)
        size = state.get("order_size_lit")
        old_tier = state.get("dynamic_dd_tier")
        tier = dynamic_dd_tier_for_drop(drop, float(old_tier) if old_tier is not None else None)
        # tier_changed (not just "size is missing") gates the spacing-multiplier bookkeeping
        # below -- real incident, 2026-10-22: order_size_lit gets cleared for lots of reasons
        # that have nothing to do with the tier (a compound-profit credit, a settings change, a
        # manual fix), and capital_corrected_spacing_multiplier depends on LIVE cash, unlike the
        # old flat 1/2/3/4x table which depended only on the tier. Recomputing it on every one of
        # those unrelated resizes produced a slightly different spacing EVERY time, each one
        # triggering its own full cancel-and-reanchor even while staying in the exact same tier --
        # Worker 4 got stuck in back-to-back reanchors this way within minutes of deploy. The
        # multiplier (and K0) must only ever change on a REAL tier transition.
        tier_changed = old_tier is None or float(old_tier) != tier
        if size is None or tier_changed:
            _, _, available = self._funding(state, holdings, resting)
            cover = max(tier - drop, 1.0) / (1 - drop / 100)
            size = compute_order_size_lit(max(available, 0.0), price, spacing_pct,
                                          levels_for_drawdown(spacing_pct, cover))
            patch.update({"dynamic_dd_tier": tier, "order_size_lit": size})
            # Spacing-multiplier bookkeeping for gate_spacing_growth_enabled (2026-10-21/22,
            # replacing the old flat 1/2/3/4x table with capital_corrected_spacing_multiplier --
            # see its own docstring). K0 (dynamic_dd_base_capital_usd) is the cash available the
            # last time the bot was at the base tier, refreshed every time it returns there; the
            # multiplier is computed and persisted here, ONLY on a real tier change, for
            # effective_spacing_pct to read on a later tick -- same ~1-tick-delay design the
            # feature always had, never computed live from a tier lookup anymore.
            if tier_changed and state.get("gate_spacing_growth_enabled"):
                k0 = state.get("dynamic_dd_base_capital_usd")
                if tier == DYNAMIC_DD_BASE or k0 is None:
                    k0 = available
                mult = capital_corrected_spacing_multiplier(tier, available, k0)
                patch.update({"dynamic_dd_base_capital_usd": k0, "gate_spacing_multiplier_value": mult})
            await self.log_run("dynamic_drawdown_switch", {
                "from": old_tier, "to": tier, "high": round(high, 5), "drop_pct": round(drop, 2),
                "available_usdc": round(available, 2), "order_size_lit": round(size, 4)})
        if patch:
            await self.update_state(patch)
            state.update(patch)
        return clamp_order_size(float(size))

    # ── Curve sizing (curve_enabled) ────────────────────────────────────────────────────────────
    @staticmethod
    def _curve_profit(state):
        return (float(state.get("profit_bucket_compound_usd") or 0)
                + float(state.get("profit_bucket_cover_drop_usd") or 0))

    def _curve_plan_cached(self, state, anchor_log, step):
        n = float(state.get("curve_n") or 10)
        floor = float(state.get("curve_floor_lit") or 1)
        peak = max(0.0, float(state.get("curve_peak_pct") or 0)) / 100.0
        key = (float(state["curve_top"]), anchor_log, step, n, floor, peak)
        cache = getattr(self, "_curve_cache", None)
        if cache is None or cache[0] != key:
            cache = (key, curve_plan(key[0], anchor_log, step, n, floor, peak))
            self._curve_cache = cache
        return cache[1]

    @staticmethod
    def _reserve_share(state):
        """Fraction of new profit the crash reserve keeps. 0 while it is off, or switched on but
        not started yet (its base is set on the next curve tick)."""
        if (sizing_mode(state) != "curve" or not state.get("reserve_enabled")
                or state.get("reserve_profit_base_usd") is None):
            return 0.0
        pct = state.get("reserve_share_pct")
        return min(1.0, max(0.0, float(100 if pct is None else pct) / 100.0))

    def _reserve_usd(self, state):
        """Idle USDC held for a crash: share x profit made since the reserve started / last deployed."""
        share = self._reserve_share(state)
        if share <= 0:
            return 0.0
        return share * max(0.0, self._curve_profit(state) - float(state["reserve_profit_base_usd"]))

    @staticmethod
    def _reserve_deploy_price(state):
        top = state.get("curve_top")
        if top is None:
            return None
        pct = state.get("reserve_deploy_pct")
        return float(top) * (1 - float(30 if pct is None else pct) / 100.0)

    def _curve_budget(self, state):
        """B = cash for new buys at the last (re)plan + profit (compound + cover-drop) added since,
        minus the share the crash reserve keeps."""
        base = float(state.get("curve_profit_base_usd") or 0)
        added = max(0.0, self._curve_profit(state) - base)
        return float(state.get("curve_cash_usd") or 0) + (1.0 - self._reserve_share(state)) * added

    async def _curve_sizer(self, state, price, anchor_log, step, holdings, resting):
        """Returns size_at(px) -> clamped LIT for a buy at px. (Re)plans when the curve has no top
        yet (switch-on) or price is a full line above the top: top = price, cash = money for new
        buys now (available + what resting buys hold -- they belong to the curve too). Held LIT is
        never counted as cash; each lot keeps its own sell. Crash reserve on: also re-plans when
        price reaches the deploy level. Only what brings the curve's cash back to its size at the
        last top (reserve_target_cash_usd) is released; any extra stays for the next leg down
        (owner, 2026-10-27). No target recorded yet: all of it."""
        top = state.get("curve_top")
        if state.get("reserve_enabled") and state.get("reserve_profit_base_usd") is None:
            # Reserve just switched on: it starts empty; profit already in the budget stays there.
            profit = self._curve_profit(state)
            patch = {"reserve_profit_base_usd": profit}
            if top is not None:
                patch["curve_cash_usd"] = self._curve_budget(state)
                patch["curve_profit_base_usd"] = profit
                patch["reserve_target_cash_usd"] = patch["curve_cash_usd"]
            await self.update_state(patch)
            state.update(patch)
            await self.log_run("reserve_started", {"profit_base_usd": round(profit, 2)})
        deployed = None
        if top is not None and state.get("reserve_enabled"):
            reserve = self._reserve_usd(state)
            deploy_px = self._reserve_deploy_price(state)
            amount = reserve
            target = state.get("reserve_target_cash_usd")
            if reserve >= RESERVE_MIN_DEPLOY_USD and price <= deploy_px and target is not None:
                resting_buy_cost, _, available = self._funding(state, holdings, resting)
                amount = min(reserve, max(0.0, float(target) - (available + resting_buy_cost)))
            if reserve >= RESERVE_MIN_DEPLOY_USD and price <= deploy_px and amount >= RESERVE_MIN_DEPLOY_USD:
                deployed = amount
                kept = reserve - amount
                # What stays: share x (profit - base) = kept.
                base = self._curve_profit(state) - kept / self._reserve_share(state)
                patch = {"reserve_profit_base_usd": base,
                         "reserve_deploys": int(state.get("reserve_deploys") or 0) + 1,
                         "reserve_last_deploy_at": now_iso()}
                await self.update_state(patch)
                state.update(patch)
        if top is None or deployed is not None or price >= float(top) * math.exp(step):
            resting_buy_cost, _, available = self._funding(state, holdings, resting)
            cash = max(0.0, available + resting_buy_cost)
            patch = {"curve_top": price, "curve_cash_usd": cash,
                     "curve_profit_base_usd": self._curve_profit(state)}
            if deployed is None and state.get("reserve_enabled"):
                patch["reserve_target_cash_usd"] = cash      # the size a deploy refills to
            await self.update_state(patch)
            state.update(patch)
            plan = self._curve_plan_cached(state, anchor_log, step)
            if deployed is not None:
                await self.log_run("reserve_deployed", {
                    "reserve_usd": round(deployed, 2), "kept_usd": round(self._reserve_usd(state), 2),
                    "target_cash_usd": state.get("reserve_target_cash_usd"),
                    "old_top": top, "price": round(price, 5), "cash_usd": round(cash, 2)})
            await self.log_run("curve_replan", {
                "top": round(price, 5), "previous_top": top, "cash_usd": round(cash, 2),
                "n": plan["n"], "floor_lit": plan["floor"], "peak_pct": round(plan["peak"] * 100, 2),
                "reserve_usd": round(self._reserve_usd(state), 2),
                "top_size_lit": round(curve_size(plan["P"], plan, cash), 4)})
            await self._publish_curve_state(state, price, anchor_log, step)
        plan = self._curve_plan_cached(state, anchor_log, step)
        budget = self._curve_budget(state)
        return lambda px: clamp_order_size(curve_size(px, plan, budget))

    async def _publish_curve_state(self, state, price, anchor_log=None, step=None):
        """Panel readout for the Curve pill (writes curve_state)."""
        if state.get("curve_top") is None:
            return
        if anchor_log is None:
            anchor_log = self._anchor_log(state)
            step = math.log(1 + effective_spacing_pct(state) / 100.0)
        if anchor_log is None:
            return
        plan = self._curve_plan_cached(state, anchor_log, step)
        budget = self._curve_budget(state)
        nxt = grid_engine.line_at_or_below(price, anchor_log, step)
        if grid_engine.line_price(anchor_log, nxt, step) >= price:
            nxt -= 1
        next_px = grid_engine.line_price(anchor_log, nxt, step)
        size = lambda px: round(curve_size(px, plan, budget), 2)
        rec = {"at": now_iso(), "top": round(plan["P"], 5), "bottom": round(plan["F"], 6),
               "n": plan["n"], "floor_lit": plan["floor"], "lines": plan["lines"],
               "budget_usd": round(budget, 2), "cash_at_plan_usd": round(float(state.get("curve_cash_usd") or 0), 2),
               "floor_reserve_usd": round(plan["R"], 2),
               "next_buy_price": round(next_px, 4), "next_buy_size": size(next_px),
               "size_top": size(plan["P"]), "size_10": size(plan["P"] * 0.9), "size_20": size(plan["P"] * 0.8),
               "size_30": size(plan["P"] * 0.7), "size_50": size(plan["P"] * 0.5),
               "peak_pct": round(plan["peak"] * 100, 2)}
        if state.get("reserve_enabled"):
            rec["reserve_usd"] = round(self._reserve_usd(state), 2)
            rec["reserve_deploy_price"] = round(self._reserve_deploy_price(state), 5)
            rec["reserve_deploys"] = int(state.get("reserve_deploys") or 0)
            rec["reserve_share_pct"] = round(self._reserve_share(state) * 100, 1)
            if state.get("reserve_target_cash_usd") is not None:
                rec["reserve_target_cash_usd"] = round(float(state["reserve_target_cash_usd"]), 2)
        await self.update_state_optional({"curve_state": rec})
        state["curve_state"] = rec

    # ── Engine v2: desired-state order management (grid_engine.py) ───────────────────────────
    def _next_co_idx(self):
        """Unique client_order_index per order. Deriving it from the current millisecond gave two
        orders created in the same millisecond the same id (found by the engine simulator,
        2026-10-22: a trailing market buy and the first batched order collided, and the fill was
        credited to the wrong row). Strictly increasing within the process, still seeded from the
        clock so a restart does not reuse a recent id."""
        co = max(int(time.time() * 1000) % 500_000_000, getattr(self, "_last_co_idx", 0) + 1)
        self._last_co_idx = co
        feed = getattr(self, "_orders_feed", None)
        if feed is not None:
            feed.changed_at.setdefault(co, time.time())   # just sent: may show on REST before the feed
        return co

    def _anchor_log(self, state):
        a = state.get("grid_anchor_log")
        if a is not None:
            return float(a)
        p = state.get("grid_anchor_price")
        if p is not None and float(p) > 0:
            return math.log(float(p))
        return None

    def _actual_from_snapshot(self):
        out = []
        for o in self._snapshot or []:
            side = "sell" if getattr(o, "is_ask", False) else "buy"
            try:
                price = float(getattr(o, "price"))
            except (TypeError, ValueError):
                continue
            try:
                remaining = float(getattr(o, "remaining_base_amount", None) or 0)
            except (TypeError, ValueError):
                remaining = 0.0
            out.append({"side": side, "price": price, "order_index": getattr(o, "order_index", None),
                        "client_order_index": int(getattr(o, "client_order_index", 0) or 0),
                        "remaining": remaining})
        return out

    async def _send_batch(self, cancels, creates, anchor_log, step, lead=()):
        """ONE signed request: `lead` creates first (the reaction orders right above and below
        price -- direct request: the gap a fill just opened is filled before anything else), then
        cancels, then the remaining creates. Ledger rows for creates are written before sending.
        A rate-limit refusal or a non-200 reply rejects them all (nothing was placed); a timeout
        leaves them pending, and reconcile settles each against the real book. When the request
        budget is short the batch is cut from the END, so the lead orders always go first."""
        lead = list(lead)
        if not cancels and not creates and not lead:
            return 0
        if not await self._touch_lock_heartbeat():
            return 0
        # Each transaction inside a batch counts against the wallet's limit (live 2026-10-22: two
        # 20-tx batches a few seconds apart drew 429s).
        cancels = [o for o in cancels if o.get("order_index") is not None]
        room = self._limiter.take_up_to(len(lead) + len(cancels) + len(creates))
        if room == 0:
            return 0
        lead = lead[:room]
        cancels = cancels[:max(0, room - len(lead))]
        creates = creates[:max(0, room - len(lead) - len(cancels))]
        nm = getattr(self.client, "nonce_manager", None)
        key = (getattr(nm, "api_keys_list", None) or [None])[0]
        tx_types, tx_infos, rows = [], [], []
        lock = nm.lock(key) if nm is not None else None
        if lock is not None:
            await lock.acquire()
        try:
            async def next_nonce():
                if nm is None:
                    return -1
                _, n = await nm.async_next_nonce(key)
                return n
            async def sign_create(w):
                co_idx = self._next_co_idx()
                level = (w.line if w.side == "buy"
                         else int(round((math.log(w.price) - anchor_log) / step)))
                inserted = await self.sb("POST", self.TABLE_ORDERS, {
                    "level": level, "side": w.side, "client_order_index": co_idx,
                    "status": "pending", "limit_price": w.price, "size": w.size,
                    "placed_at": now_iso(), "closes_level": w.closes_line,
                    "funded_from_bucket_usd": round(w.funded or 0.0, 8)})
                n = await next_nonce()
                tx_type, tx_info, _h, err = self.client.sign_create_order(
                    MARKET_ID, co_idx, size_to_int(w.size), price_to_int(w.price),
                    int(w.side == "sell"), self.client.ORDER_TYPE_LIMIT,
                    self.client.ORDER_TIME_IN_FORCE_POST_ONLY, nonce=n, api_key_index=key)
                if err:
                    await self.sb("PATCH", f"{self.TABLE_ORDERS}?id=eq.{inserted[0]['id']}",
                                   {"status": "rejected", "error": str(err)[:200]})
                    await self._resync_nonce(hard=True)
                    return False
                rows.append((inserted[0]["id"], w))
                tx_types.append(tx_type)
                tx_infos.append(tx_info)
                return True

            async def abandon(reason):
                # Nothing is sent: the rows already written for this batch were never placed --
                # resolve them now rather than leaving them to block their lines as ghosts.
                for rid, _w in rows:
                    await self.sb("PATCH", f"{self.TABLE_ORDERS}?id=eq.{rid}",
                                   {"status": "rejected", "error": ("not sent: " + reason)[:200]})
                await self.log_run("engine_sign_failed", {"error": reason[:200]})
                return 0

            for w in lead:
                if not await sign_create(w):
                    return await abandon("sign failed")
            for o in cancels:
                n = await next_nonce()
                tx_type, tx_info, _h, err = self.client.sign_cancel_order(
                    MARKET_ID, int(o["order_index"]), nonce=n, api_key_index=key)
                if err:
                    await self._resync_nonce(hard=True)
                    return await abandon(str(err))
                tx_types.append(tx_type)
                tx_infos.append(tx_info)
            for w in creates:
                if not await sign_create(w):
                    return await abandon("sign failed")
            if not tx_types:
                return 0
            try:
                resp = await asyncio.wait_for(self.client.send_tx_batch(tx_types, tx_infos),
                                              timeout=ORDER_TIMEOUT)
                err = None
                code = getattr(resp, "code", 200)
                if code != 200:
                    err = f"send_tx_batch code {code}: {getattr(resp, 'message', '')}"
            except Exception as e:
                err = str(e)
                refused = self._is_rate_limit_error(err)
                # A nonce error is ours to repair (re-read the nonce), not a reason to slow BOTH
                # bots down for 15s through the shared limiter (audit 2026-10-23).
                if refused and "invalid nonce" not in err.lower():
                    self._register_exchange_rate_limit()
                await self._resync_nonce(hard=True)
                if not refused:
                    await self.log_run("engine_batch_unknown", {"error": err[:200], "txs": len(tx_types)})
                    for rid, w in rows:
                        self._inflight[(w.side, price_to_int(w.price))] = time.time()
                    return 0
            if err:
                if self._is_rate_limit_error(err) and "invalid nonce" not in err.lower():
                    self._register_exchange_rate_limit()
                await self._resync_nonce(hard=True)
                for rid, w in rows:
                    await self.sb("PATCH", f"{self.TABLE_ORDERS}?id=eq.{rid}",
                                   {"status": "rejected", "error": ("batch: " + err)[:200]})
                    if not self._is_rate_limit_error(err):
                        # One bad transaction rejects the whole batch, so a single refusal says
                        # little about each order: a short pause first, the full cooldown only
                        # for an order refused twice in a row (audit 2026-10-23: one rejected
                        # batch kept the buy right below price off the book for 60s).
                        key = (w.side, price_to_int(w.price))
                        self._reject_count[key] = self._reject_count.get(key, 0) + 1
                        pause = REJECT_COOLDOWN_S if self._reject_count[key] >= 2 else REJECT_RETRY_S
                        self._reject_until[key] = time.time() + pause
                await self.log_run("engine_batch_rejected", {"error": err[:200], "txs": len(tx_types)})
                return 0
        finally:
            if lock is not None:
                lock.release()
        self._register_exchange_success()
        now = time.time()
        for rid, w in rows:
            await self.sb("PATCH", f"{self.TABLE_ORDERS}?id=eq.{rid}", {"status": "open"})
            self._inflight[(w.side, price_to_int(w.price))] = now
            self._reject_count.pop((w.side, price_to_int(w.price)), None)
        await self.log_run("engine_batch_sent", {
            "cancels": len(tx_types) - len(rows), "creates": len(rows),
            "quota_remaining": getattr(resp, "volume_quota_remaining", None)})
        return len(tx_types)

    async def engine_cycle(self, state, price, entries_allowed=True):
        """One desired-state pass: target ladder (grid_engine.plan_orders) vs the real book
        (last successful full read), every difference sent in one batch. Never acts without a
        successful read -- an unknown book is never assumed empty."""
        # Act once per FRESH read of the book: between reads the engine cannot see what its last
        # batch did, and acting again would re-send the same cancels and creates.
        if self._snapshot is None or self._snapshot_at <= self._engine_snapshot_at:
            return
        self._engine_snapshot_at = self._snapshot_at
        spacing_pct = effective_spacing_pct(state)
        step = math.log(1 + spacing_pct / 100.0)
        holdings = await self.current_holdings()
        resting = await self.resting_orders_by_level()
        active = {lv: h for lv, h in holdings.items() if clamp_order_size(h["qty"]) is not None}

        anchor_log = self._anchor_log(state)
        if anchor_log is None:
            if not entries_allowed:
                return
            anchor_log = math.log(price)
            await self.update_state({"grid_anchor_log": anchor_log, "grid_anchor_price": price})
            state.update({"grid_anchor_log": anchor_log, "grid_anchor_price": price})

        order_size_lit = state.get("order_size_lit")
        mode = sizing_mode(state)
        size_at = None
        if mode == "curve":
            size_at = await self._curve_sizer(state, price, anchor_log, step, holdings, resting)
            order_size = size_at(price)
        elif mode == "dynamic":
            order_size = await self._dynamic_order_size(state, price, spacing_pct, holdings, resting)
        else:
            if order_size_lit is None:
                effective_capital = (float(state["capital_usd"])
                                     + float(state.get("profit_bucket_compound_usd") or 0))
                order_size_lit = compute_order_size_lit(
                    effective_capital, price, spacing_pct,
                    levels_for_drawdown(spacing_pct, float(state.get("drawdown_pct") or 10.0)))
                await self.update_state({"order_size_lit": order_size_lit})
            order_size = clamp_order_size(float(order_size_lit or 0.0))
        entries = bool(entries_allowed and order_size is not None)
        if size_at is None:
            size_at = lambda _px: order_size

        def off_curve(row, want):
            """Curve mode: an unfilled resting buy far from its curve size gets replaced."""
            if mode != "curve" or want is None or float(row.get("filled_qty") or 0) > 0:
                return False
            return abs(float(row.get("size") or 0) - want) > CURVE_REPLACE_FRAC * want

        levels_up = max(1, int(state.get("levels_up") or 1))
        levels_down = max(1, int(state["levels_down"]))
        reserved = {lv for lv, rows in resting.items() if any(r["side"] == "buy" for r in rows)}
        plan = grid_engine.plan_orders(price, anchor_log, step, spacing_pct / 100.0, active,
                                       levels_up, levels_down, round_price, entries_allowed=entries,
                                       reserved=reserved)
        # Orders already resting may stay out to TWICE the window: new orders follow the window,
        # but shuffling the far edge (cancel one far order every time a near one appears) cost two
        # requests per line and ran the budget out in fast moves (simulator, 2026-10-23).
        keep_plan = grid_engine.plan_orders(price, anchor_log, step, spacing_pct / 100.0, active,
                                            2 * levels_up, 2 * levels_down, round_price,
                                            entries_allowed=entries, reserved=reserved)
        new_sell_lots = {w.closes_line for w in plan.sells}
        new_buy_lines = {ln for ln, _px in plan.buy_lines}
        actual = self._actual_from_snapshot()
        now = time.time()
        self._inflight = {k: t for k, t in self._inflight.items() if now - t < INFLIGHT_S}
        for o in actual:
            self._inflight.pop((o["side"], price_to_int(o["price"])), None)
        self._reject_until = {k: t for k, t in self._reject_until.items() if t > now}

        # Which lot each resting sell on the book belongs to, via the ledger.
        row_by_co = {int(r["client_order_index"]): r for rows in resting.values() for r in rows
                     if r.get("client_order_index") is not None}
        # Orders on the book with no open ledger row (a send reported failed that landed anyway,
        # leftovers): never count them as satisfying a wanted order -- cancel them (audit
        # 2026-10-22: one kept as "the sell" would fill unseen by the ledger).
        foreign = [o for o in actual if o["client_order_index"] not in row_by_co]
        actual = [dict(o, closes_line=row_by_co[o["client_order_index"]].get("closes_level"))
                  for o in actual if o["client_order_index"] in row_by_co]
        # A lot is BUSY while ANY open ledger sell row closes it -- resting, in flight, timed out,
        # or filled-but-not-yet-reconciled. A busy lot never gets a second sell (market or limit):
        # on spot that second sell would spend another lot's LIT (audit 2026-10-22, P0-1).
        on_book_cos = {o["client_order_index"] for o in actual}
        remaining_by_co = {o["client_order_index"]: o.get("remaining", 0.0) for o in actual}
        busy = {}
        for rows in resting.values():
            for r in rows:
                if r["side"] == "sell" and r.get("closes_level") is not None:
                    co = int(r["client_order_index"]) if r.get("client_order_index") is not None else None
                    busy.setdefault(r["closes_level"], []).append((co, round_price(float(r.get("limit_price") or 0))))

        # Passed-level market sells, one per cycle, only once no open row sells that lot (the diff
        # below cancels its resting sell first; reconcile then resolves the row).
        for ln, qty, cost in plan.market_sells:
            if ln in busy:
                continue
            size = clamp_order_size(qty)
            if size is not None:
                await self.log_run("sell_level_passed_market_sell", {"closes_level": ln, "price": price})
                await self.market_sell_level(ln, size, min_price=cost)
            break

        wants = []
        # A lot whose sell price has just been passed keeps its resting sell: it has almost surely
        # filled already and the fill is on its way -- cancelling it only spends a request.
        for ln, _qty, _cost in plan.market_sells:
            for co, px in busy.get(ln, []):
                if co in on_book_cos:
                    wants.append(grid_engine.Want("sell", px, 0.0, ln, closes_line=ln))
        # An order price has just gone through has filled (its fill is on the way): keep it,
        # cancelling it only spends a request.
        for o in actual:
            if (o["side"] == "buy" and o["price"] >= price) or (o["side"] == "sell" and o["price"] <= price):
                wants.append(grid_engine.Want(o["side"], o["price"], 0.0, 0, closes_line=o.get("closes_line")))
        for w in keep_plan.sells:
            if clamp_order_size(w.size) is None:
                continue
            if w.closes_line not in new_sell_lots and not any(
                    co in on_book_cos and price_to_int(px) == price_to_int(w.price)
                    for co, px in busy.get(w.closes_line, [])):
                continue   # beyond the window and not already resting: not placed
            if w.closes_line in busy:
                # Keep it only if its own sell is already resting at exactly this price AND for the
                # whole lot; anything else (wrong price, wrong size -- a merged v1 line had a sell
                # for half its LIT, audit 2026-10-23 -- not visible yet) waits until reconcile
                # resolves that row; an unwanted resting one is cancelled by the diff, never
                # replaced in the same pass.
                lot_qty = clamp_order_size(w.size) or 0.0
                if not any(co in on_book_cos and price_to_int(px) == price_to_int(w.price)
                           and abs(remaining_by_co.get(co, 0.0) - lot_qty) < 0.011
                           for co, px in busy[w.closes_line]):
                    continue
            wants.append(grid_engine.Want("sell", w.price, clamp_order_size(w.size), w.line,
                                          closes_line=w.closes_line))
        resting_keys = {(o["side"], price_to_int(o["price"])) for o in actual}
        funds_ok = True
        buys_need_release = False   # a new buy is funded only by cancelling a far buy in this batch
        if not entries:
            # Paused (OFF, balance check, stale order): no NEW buys, but the ones already resting
            # stay -- cancelling and re-placing them on every pause was churn, and v1 kept them too.
            for o in actual:
                if o["side"] == "buy" and o["client_order_index"] in row_by_co:
                    wants.append(grid_engine.Want("buy", o["price"], 0.0, 0))
        if entries:
            _, base_remaining, available = self._funding(state, holdings, resting)
            max_open = state.get("max_open_buys")
            allowance = (int(max_open) - int(state.get("lifetime_buy_count") or 0)
                         if max_open is not None else None)
            new_buys = 0
            kept_far = []    # (px, want) resting buys beyond the window, cancellable to fund near ones
            for ln, px in keep_plan.buy_lines:
                key = ("buy", price_to_int(px))
                if ln not in new_buy_lines and key in resting_keys:
                    sz = size_at(px)
                    rows_here = [r for r in resting.get(ln, []) if r["side"] == "buy"]
                    if any(off_curve(r, sz) for r in rows_here):
                        continue   # cancelled by the diff; placed again at its curve size once in range
                    held_qty = max((float(r.get("size") or 0) for r in rows_here), default=sz or 0.0)
                    w = grid_engine.Want("buy", px, sz, ln)
                    wants.append(w)
                    kept_far.append((px, w, held_qty))
            for ln, px in plan.buy_lines:
                key = ("buy", price_to_int(px))
                line_rows = [r for r in resting.get(ln, []) if r["side"] == "buy"]
                sz = size_at(px)
                if sz is None:
                    continue
                if line_rows:
                    # This line already has an open buy row. Keep it only if it is resting at this
                    # exact price; otherwise (filled but not yet recorded, in flight, old price)
                    # wait for reconcile -- a second buy here would stack two lots on one line.
                    # Curve mode: one far off its curve size is not kept (the diff cancels it, and
                    # the line is bought again at its curve size once reconcile clears the row).
                    if any(int(r["client_order_index"]) in on_book_cos
                           and price_to_int(float(r.get("limit_price") or 0)) == key[1]
                           and not off_curve(r, sz) for r in line_rows):
                        wants.append(grid_engine.Want("buy", px, sz, ln))
                    continue
                if key in resting_keys or key in self._inflight:
                    wants.append(grid_engine.Want("buy", px, sz, ln))
                    continue
                cost = px * sz
                # Short of money while far buys hold it: release the farthest (the diff cancels it,
                # and the cancel goes before this buy in the batch).
                while cost > available and kept_far:
                    far = min(kept_far, key=lambda x: x[0])
                    kept_far.remove(far)
                    wants.remove(far[1])
                    available += far[0] * far[2]
                    buys_need_release = True
                if cost > available or (allowance is not None and new_buys >= allowance):
                    funds_ok = False
                    break
                wants.append(grid_engine.Want("buy", px, sz, ln,
                                              funded=max(0.0, cost - max(base_remaining, 0.0))))
                available -= cost
                base_remaining -= cost
                new_buys += 1
        if not funds_ok and not getattr(self, "_no_funds_logged", False):
            self._no_funds_logged = True
            await self.log_run("no_funds_for_buy", {"price": price})
        elif funds_ok:
            self._no_funds_logged = False

        # In flight also from the ledger, so it survives a restart: a row sent moments ago that no
        # read shows yet (simulator: a restart one tick after a batch placed the same buy twice).
        inflight = set(self._inflight)
        cutoff = datetime.now(timezone.utc) - timedelta(seconds=INFLIGHT_S)
        for rows in resting.values():
            for r in rows:
                placed = _parse_iso(r.get("placed_at"))
                if (placed is not None and placed > cutoff and r.get("limit_price") is not None
                        and r.get("client_order_index") is not None
                        and int(r["client_order_index"]) not in on_book_cos
                        and r.get("order_kind") != "market"):
                    inflight.add((r["side"], price_to_int(float(r["limit_price"]))))
        to_cancel, to_place = grid_engine.diff_orders(wants, actual, inflight, price_to_int)
        if foreign:
            await self.log_run("engine_foreign_orders_cancelled", {"count": len(foreign)})
            to_cancel = foreign + to_cancel
        to_place = [w for w in grid_engine.priority_order(to_place, price)
                    if (w.side, price_to_int(w.price)) not in self._reject_until]
        # The reaction orders lead the batch (direct request): the missing sell nearest above price
        # and the missing buy nearest below go out before any cleanup. Only one that cannot cross
        # one of our own resting orders (a post-only order that would cross is refused by the
        # exchange) -- otherwise it waits for the cancel in this same batch and goes next cycle.
        # A lead order that needs funds a cancel in this batch frees (a new buy while old buys
        # still hold the USDC, a new sell while old sells hold the LIT -- every fast run) goes right
        # AFTER the cancels instead: sent first, the exchange refuses it for lack of funds, and it
        # was refused again every cycle (simulator, 2026-10-23).
        own_buys = [o["price"] for o in actual if o["side"] == "buy"]
        own_sells = [o["price"] for o in actual if o["side"] == "sell"]
        # Reaction orders = the missing ones within 2 lines of price (a far sell that only fills
        # out the window is not one). A buy waits behind the cancels only when its money comes
        # from one of them; sells never need a cancel first (a lot whose old sell is still
        # resting gets no new one until that row resolves).
        near = math.log(1 + spacing_pct / 100.0) * 2.05
        head = [w for w in to_place[:2] if abs(math.log(w.price / price)) <= near]
        cancel_sides = {"buy"} if buys_need_release else set()
        lead = [w for w in head if w.side not in cancel_sides and (
                (w.side == "sell" and all(w.price > b for b in own_buys)) or
                (w.side == "buy" and all(w.price < s for s in own_sells)))]
        rest = [w for w in head if w not in lead] + [w for w in to_place if w not in head]
        # Stale orders are cancelled farthest first, in batches, never the whole book at once (a
        # cancel-all emptied the book for a cycle -- a gap). When the batch is cut for budget it
        # is cut from the end: lead, cancels, then the reaction orders that waited on them.
        to_cancel = sorted(to_cancel, key=lambda o: -abs(float(o["price"]) - price))
        if self._limiter.room() < LOW_BUDGET_SLOTS:
            # Budget nearly spent: only the reaction orders (sell right above, buy right below),
            # plus a cancel only where one of them needs its funds. Cleanup waits.
            needed_sides = {w.side for w in head if w not in lead}
            funding = [o for o in to_cancel if o["side"] in needed_sides][:len(needed_sides)]
            await self._send_batch(funding, [w for w in head if w not in lead], anchor_log, step, lead=lead)
            return
        # Cancels never fill the whole batch: the reaction orders that waited on them always
        # keep their slots (audit 2026-10-23: a spacing change sent 20 cancels and 0 creates).
        deferred = [w for w in head if w not in lead]
        room = BATCH_MAX - len(lead)
        cancels = to_cancel[:max(0, room - len(deferred))]
        await self._send_batch(cancels, rest[:max(0, room - len(cancels))], anchor_log, step, lead=lead)
        await self._publish_near_book(plan, actual, entries and funds_ok)

    async def _publish_near_book(self, plan, actual, buys_expected):
        """Dashboard gap alarm (direct request, 2026-10-23): is the buy right below price and the
        nearest sell the rules allow actually on the book? Written when that changes (and every
        30s), with the time a gap started -- the panel alarms once one lasts NEAR_BOOK_GAP_ALERT_S
        (normal reactions take ~1s and never trigger it)."""
        now = time.time()
        want_buy = plan.buy_lines[0][1] if (plan.buy_lines and buys_expected) else None
        want_sell = min((w.price for w in plan.sells), default=None)
        have = {(o["side"], price_to_int(o["price"])) for o in actual}
        buy_ok = want_buy is None or ("buy", price_to_int(want_buy)) in have
        sell_ok = want_sell is None or ("sell", price_to_int(want_sell)) in have
        gap = not (buy_ok and sell_ok)
        if gap and self._gap_since is None:
            self._gap_since = now_iso()
        elif not gap:
            self._gap_since = None
        status = (buy_ok, sell_ok, want_buy, want_sell)
        if status == getattr(self, "_near_book_last", None) and now - getattr(self, "_near_book_at", 0.0) < 30:
            return
        self._near_book_last, self._near_book_at = status, now
        await self.update_state_optional({"near_book": {
            "buy_ok": buy_ok, "sell_ok": sell_ok, "want_buy": want_buy, "want_sell": want_sell,
            "gap_since": self._gap_since, "at": now_iso(), "alert_after_s": NEAR_BOOK_GAP_ALERT_S}})

    async def _apply_reanchor_journal(self, journal):
        self._rows_cache = None
        for rid, (col, line) in journal["moves"].items():
            await self.sb("PATCH", f"{self.TABLE_ORDERS}?id=eq.{int(rid)}", {col: int(line)})
        self._holdings_cache = None
        await self.update_state({
            "grid_anchor_log": journal["anchor_log"],
            "grid_anchor_price": math.exp(journal["anchor_log"]) if journal["anchor_log"] > -700 else None,
            "internal_spacing_pct": journal["spacing"], "order_size_lit": None,
            "reanchor_journal": None, **(journal.get("extra") or {})})
        self._inflight.clear()

    async def _tick_v2(self, state, profit_mode, route):
        """engine_v2_enabled path. Same safety gates as v1 (lock, flatten, reset, reconcile,
        real-balance check, stale-order pause), then a desired-state cycle."""
        now = time.time()
        has_stale = getattr(self, "_last_stale", False)
        pre_read = await self._read_balance_for_check()
        feed = self._orders_feed
        every = (ORDERS_WS_RECONCILE_EVERY if feed is not None and feed.trusted(now) else RECONCILE_EVERY)
        # A fill/cancel just arrived on the trusted feed: reconcile now, not at the next interval
        # -- this is what lets the reaction order go out within a second of the fill.
        feed_moved = feed is not None and feed.trusted(now) and feed.seq != self._reconciled_seq
        if pre_read is not None or feed_moved or now - self._last_reconcile_at >= every:
            if feed is not None:
                self._reconciled_seq = feed.seq
            self._last_reconcile_at = now
            reconciled_ok, usdc_delta, has_stale = await self.reconcile_pending_orders(
                profit_mode=profit_mode, route=route)
            self._last_stale = has_stale
            await self._apply_usdc_delta(usdc_delta)
            if not reconciled_ok:
                return
        balance_ok, _ = await self.check_balance_divergence(confirm=True, pre_read=pre_read)
        price = await self.fetch_current_price()
        if price is None:
            return
        state = await self.get_state()
        entries_allowed = bool(state.get("enabled")) and balance_ok and not has_stale
        # Bookkeeping that does not change which orders are next to price (profit buckets ~1.7s,
        # tier refresh) runs AFTER the reaction orders, every SLOW_EVERY -- it used to run before
        # them on every fill (measured live, 2026-10-23).
        slow_due = now - self._last_slow_at >= SLOW_EVERY
        if slow_due and not feed_moved:
            await self._v2_slow_refresh(state, price)
        spacing_pct = effective_spacing_pct(state)
        persisted = state.get("internal_spacing_pct")
        if persisted is None:
            await self.update_state({"internal_spacing_pct": spacing_pct})
        elif float(persisted) != spacing_pct and self._anchor_log(state) is not None:
            # A spacing change goes through the clean reset (2026-10-26): one cancel-all, wait for
            # an empty book, then re-anchor with lots merged next to their cost. Re-anchoring with
            # sells still resting kept every lot on its own line and pushed collided lots far
            # above cost.
            await self.update_state({"grid_reset_requested": True})
            await self.log_run("spacing_change_clean_reset", {"from": float(persisted), "to": spacing_pct, "price": price})
            return
        await self.engine_cycle(state, price, entries_allowed=entries_allowed)
        await self.update_state({"live_price": price, "updated_at": now_iso()})
        if slow_due and feed_moved:
            await self._v2_slow_refresh(state, price)

    async def _v2_slow_refresh(self, state, price):
        self._last_slow_at = time.time()
        buckets = await self._bucket_balances(rest_withdrawn=state.get("rest_withdrawn_usd"))
        compound_now = buckets.get("profit_bucket_compound_usd")
        # Curve mode sizes every buy from the budget, profit included -- no order-size resize.
        resize = sizing_mode(state) != "curve" and self._compound_resize_due(state, compound_now, price)
        step_usd = self._compound_step_usd(state, price)
        if resize:
            # Compounding only ever ADDS to the order size (2026-10-24, owner: "compounding should
            # increase size not decrease it"): the new compound dollars spread over the same lines,
            # on top of the current size. A full recompute from available cash re-counted the money
            # already sitting in open buys and shrank orders 44.3 -> 43.3 -> 40.1 LIT in one day.
            # A gate change still recomputes from available cash (_dynamic_order_size).
            cur = state.get("order_size_lit")
            if sizing_mode(state) == "dynamic" and cur is not None and step_usd > 0:
                rec0 = state.get("compound_resize")
                base = rec0.get("compound_usd") if isinstance(rec0, dict) else None
                base = float(base if base is not None else getattr(self, "_compound_base", 0.0) or 0.0)
                added = (float(compound_now or 0) - base) * COMPOUND_RESIZE_MIN_LIT / step_usd
                buckets["order_size_lit"] = float(cur) + max(0.0, added)
            else:
                buckets["order_size_lit"] = None
        await self.update_state(buckets)
        state.update(buckets)
        if resize:
            await self._note_compound_resize(state, compound_now, step_usd)
        elif getattr(self, "_compound_base_unsaved", False):
            self._compound_base_unsaved = False
            rec = {"at": None, "compound_usd": round(self._compound_base, 6),
                   "capital_usd": float(state.get("capital_usd") or 0), "step_usd": round(step_usd, 2)}
            await self.update_state_optional({"compound_resize": rec})
            state["compound_resize"] = rec
        else:
            # Panel's "next resize at $..." = baseline + step; the step moves with price/gate, so
            # refresh it when it has drifted by 50 cents or more (not every 15s).
            rec = state.get("compound_resize")
            if isinstance(rec, dict) and rec.get("compound_usd") is not None and (
                    rec.get("step_usd") is None or abs(float(rec["step_usd"]) - step_usd) >= 0.5):
                rec = dict(rec, step_usd=round(step_usd, 2))
                await self.update_state_optional({"compound_resize": rec})
                state["compound_resize"] = rec
        if sizing_mode(state) == "dynamic":
            holdings = await self.current_holdings()
            resting = await self.resting_orders_by_level()
            await self._dynamic_order_size(state, price, effective_spacing_pct(state), holdings, resting)
        elif sizing_mode(state) == "curve":
            await self._publish_curve_state(state, price)

    async def market_sell_level(self, level, qty, min_price=None):
        """min_price (2026-10-22): the worst execution price allowed, floored at the lot's own
        cost by the passed-level caller so a market sell can never fill below what the lot cost
        -- the plain 0.5% slippage band alone is wider than a 0.125% grid step. Flatten passes
        none on purpose: it is the explicit sell-everything-now control."""
        # Lock validated BEFORE anything else (external audit fix, fifth pass): this function
        # never touched the heartbeat at all before, so a dethroned worker could keep flattening
        # indefinitely on an all-sell-no-cancel pass.
        if not await self._touch_lock_heartbeat():
            return None
        sized = clamp_order_size(qty)
        if sized is None:
            return None
        price = self.live.best_mid()
        if price is None:
            return None
        if not self._take_request():
            return None
        band_price = round_price(price * 0.995)
        if min_price is not None:
            band_price = max(band_price, math.ceil(float(min_price) * 10 ** PRICE_DECIMALS) / 10 ** PRICE_DECIMALS)
        co_idx = self._next_co_idx()
        row = {"level": level, "side": "sell", "closes_level": level, "client_order_index": co_idx,
               "status": "pending", "limit_price": band_price, "size": sized, "placed_at": now_iso(),
               "order_kind": "market"}
        inserted = await self.sb("POST", self.TABLE_ORDERS, row)
        row_id = inserted[0]["id"]
        try:
            _o, _r, err = await asyncio.wait_for(
                self.client.create_market_order(
                    market_index=MARKET_ID, client_order_index=co_idx,
                    base_amount=size_to_int(sized), avg_execution_price=price_to_int(band_price),
                    is_ask=True, reduce_only=False,
                ),
                timeout=ORDER_TIMEOUT,
            )
            if err:
                await self.sb("PATCH", f"{self.TABLE_ORDERS}?id=eq.{row_id}",
                               {"status": "rejected", "error": str(err)[:200]})
                return None
        except Exception as e:
            if await self._on_send_exception(e):
                await self.sb("PATCH", f"{self.TABLE_ORDERS}?id=eq.{row_id}",
                               {"status": "rejected", "error": ("rate_limited: " + str(e))[:200]})
                return None
            await self.log_run("flatten_sell_unknown", {"row_id": row_id, "error": str(e)[:200]})
            return row_id
        await self.sb("PATCH", f"{self.TABLE_ORDERS}?id=eq.{row_id}", {"status": "open"})
        return row_id

    async def flatten_all(self, profit_mode=None, route=None):
        """Emergency path, retried every tick until VERIFIED complete. Cancels everything
        resting first, reconciles, then sells each held level that has no unresolved resting
        sell already working it (external audit fix P1-2) -- never a duplicate attempt against
        the same inventory. A terminal fill below the sellable minimum is logged distinctly
        (external audit fix P2-9) rather than looking like an ordinary retry.

        Both loops below bail the moment the lock is lost (external audit fix, fifth pass -- this
        function previously had NO lock checks at all, so a dethroned worker could keep
        flattening after a handover, racing the replacement worker over the same inventory). The
        new lock-holder picks the same flatten_requested flag up on its own very next tick, so
        stopping here never leaves the position unprotected. Every reconcile call's cash delta
        is applied via _apply_usdc_delta() (external audit fix, seventh pass) -- discarding it
        here is harmless to safety (entries are blocked throughout flatten regardless) but was
        still a real, permanent loss of display accuracy for exactly the reason fixed in tick()."""
        # One reconcile per tick (2026-10-22): each one is a book read against the shared request
        # budget, and four per tick starved the sells themselves during a crash. Whatever this
        # pass sends is picked up by the next tick's reconcile.
        _ok, delta, _stale = await self.reconcile_pending_orders(profit_mode=profit_mode, route=route)
        await self._apply_usdc_delta(delta)
        if not self._lock_held:
            await self.log_run("flatten_aborted_lock_lost", {})
            return
        resting = await self.resting_orders_by_level()
        resting_buys = [r for rows in resting.values() for r in rows if r["side"] == "buy"]
        resting_sells = [r for rows in resting.values() for r in rows
                         if r["side"] == "sell" and r.get("order_kind") != "market"]
        if resting_buys or resting_sells:
            ok = await self._cancel_all_on_exchange("flatten")
            if not self._lock_held:
                await self.log_run("flatten_aborted_lock_lost", {})
                return
            await self.log_run("flatten_incomplete", {"waiting_for": "cancel_all", "sent": bool(ok),
                                                      "resting": len(resting_buys) + len(resting_sells)})
            return

        unresolved_sell_closes = {
            r["closes_level"] for rows in resting.values() for r in rows
            if r["side"] == "sell" and r.get("closes_level") is not None
        }
        holdings = await self.current_holdings()
        sell_failed = False
        if holdings:
            # Never ask to sell more than the account really holds: a ledger lot a hair above the
            # real balance (rounding) is refused by the exchange on every retry, forever.
            if not self._take_request():
                return
            try:
                _usdc, real_lit = await self.real_balances()
            except Exception as e:
                await self.log_run("flatten_balance_check_failed", {"error": str(e)[:200]})
                return
            available = math.floor(real_lit * 10 ** SIZE_DECIMALS + 1e-6) / 10 ** SIZE_DECIMALS
        for lvl, h in holdings.items():
            if not self._lock_held:
                await self.log_run("flatten_aborted_lock_lost", {})
                return
            if lvl in unresolved_sell_closes:
                sell_failed = True
                continue
            qty = round_size(min(h["qty"], available))
            if clamp_order_size(qty) is None:
                # Under the exchange's 1 LIT minimum: no order can sell it. Logged, then left --
                # the final check below decides on the REAL balance (audit 2026-10-22: counting
                # it as a failure kept Flatten running, and the bot enabled, forever).
                await self.log_run("flatten_dust_stuck", {"level": lvl, "qty": h["qty"], "sellable": qty})
                continue
            if await self.market_sell_level(lvl, qty) is not None:
                available -= qty
            sell_failed = True   # sent or skipped -- the next tick's reconcile settles it
        if sell_failed or resting:
            await self.log_run("flatten_incomplete", {"waiting_for": "market_sells",
                                                      "levels": sorted(holdings)})
            return

        if not self._take_request():
            return
        try:
            _usdc, real_lit = await self.real_balances()
        except Exception as e:
            await self.log_run("flatten_balance_check_failed", {"error": str(e)[:200]})
            return
        if clamp_order_size(real_lit) is not None:
            # 1 LIT or more is still really held: sellable, so not done.
            await self.log_run("flatten_incomplete", {"real_lit_remaining": real_lit})
            return

        await self.update_state({"flatten_requested": False, "enabled": False})
        await self.log_run("flatten_completed", {"final_real_lit": real_lit,
                                                 "dust_left": real_lit > BALANCE_DIVERGENCE_TOLERANCE_LIT})

    async def _apply_usdc_delta(self, usdc_delta):
        """Persists a reconciliation pass's cash delta immediately, reading the current balance
        fresh rather than trusting a possibly-stale closure value (external audit fix, seventh
        pass: the spacing-change branch used to call reconcile_pending_orders() a second time and
        silently discard its returned delta entirely -- a fill confirmed during that cancel-
        triggered pass was durably marked 'filled' in the ledger, but its cash impact was never
        applied anywhere, permanently, for exactly the same reason the main-flow delta needed
        fixing last round. Every reconcile_pending_orders() call site now runs its delta through
        this same helper.) Fails CLOSED (pauses new entries, never exits) if the persist write
        itself fails, same philosophy as an unverifiable balance read."""
        if not usdc_delta:
            return
        try:
            fresh = await self.get_state()
            await self.update_state({"usdc_balance": float(fresh.get("usdc_balance") or 0) + usdc_delta})
        except Exception as e:
            self._balance_paused = True
            await self.log_run("cash_delta_persist_failed", {"error": str(e)[:200], "delta": usdc_delta})

    async def tick(self):
        self._holdings_cache = None
        self._holdings_cache_on = True
        try:
            await self._tick()
        finally:
            self._holdings_cache_on = False
            self._holdings_cache = None

    async def _tick(self):
        state = await self.get_state()
        profit_mode = state.get("profit_mode")
        route = {"cap": state.get("rest_cap_usd"), "overflow": state.get("rest_overflow_to"),
                 "withdrawn": state.get("rest_withdrawn_usd")}
        if state.get("reanchor_journal"):
            # A re-anchor interrupted by a crash finishes first, before Flatten, a reset or
            # either engine reads the ledger (audit 2026-10-22).
            await self._apply_reanchor_journal(state["reanchor_journal"])
            state = await self.get_state()
        if state.get("flatten_requested"):
            await self.flatten_all(profit_mode=profit_mode, route=route)
            return
        if state.get("grid_reset_requested"):
            await self.reset_grid(profit_mode=profit_mode, route=route)
            return
        # Engine v2 is the only engine (v1 removed 2026-10-23 after ~24h of clean v2 audits on
        # both bots; engine_v2_enabled in the state row is no longer read).
        self._v2_active = True
        await self._tick_v2(state, profit_mode, route)


async def _run_tick_loop(bot):
    backoff = RATE_LIMIT_BACKOFF_START
    try:
        while True:
            sleep_for = TICK_EVERY
            try:
                if await bot.acquire_lock():
                    await bot.tick()
                backoff = RATE_LIMIT_BACKOFF_START
            except Exception as e:
                msg = str(e)
                try:
                    await bot.log_run("tick_error", {"error": msg[:300]})
                except Exception:
                    print(f"[lit-grid-live{bot._tag}] tick_error (and log_run also failed): {e}", flush=True)
                if "429" in msg or "Too Many Requests" in msg:
                    sleep_for = backoff
                    backoff = min(backoff * 2, RATE_LIMIT_BACKOFF_MAX)
            feed = getattr(bot, "_orders_feed", None)
            if (getattr(bot, "_v2_active", False) and feed is not None and feed.changed is not None
                    and sleep_for == TICK_EVERY):
                # v2: wake the moment the websocket reports an order change (a fill), instead of
                # waiting out the 2s tick. At most one tick every REACT_MIN_INTERVAL, so a burst of
                # fills is answered in one pass; the request budget is untouched (same orders,
                # sent sooner; the shared limiter still caps every send).
                try:
                    await asyncio.wait_for(feed.changed.wait(), timeout=sleep_for)
                except asyncio.TimeoutError:
                    pass
                feed.changed.clear()
                await asyncio.sleep(REACT_MIN_INTERVAL)
            else:
                await asyncio.sleep(sleep_for)
    finally:
        await bot.release_lock()


async def run_lit_grid_live(table_state=TABLE_STATE, table_orders=TABLE_ORDERS,
                             table_runs=TABLE_RUNS, env_prefix="", tag=""):
    """Runs one LIT grid instance to completion (its own http session, its own tick loop).
    Zero args = Worker 4's exact original behavior (this service's own LIGHTER_* env vars,
    the original table names). A second instance on a different sub-account passes env_prefix
    (e.g. "WORKER3_" to read WORKER3_LIGHTER_ACCOUNT_INDEX etc, same convention
    lighter_hedge_dual_leg.py already uses) and its own table_state/table_orders/table_runs +
    tag so it never touches Worker 4's rows or Worker 4's heartbeat/log lines."""
    async with aiohttp.ClientSession() as http:
        bot = LitGridLive(http, table_state=table_state, table_orders=table_orders,
                           table_runs=table_runs, tag=tag)
        bot.account_index = int(os.environ[f"{env_prefix}LIGHTER_ACCOUNT_INDEX"])
        api_key_index = int(os.environ[f"{env_prefix}LIGHTER_API_KEY_INDEX"])
        api_private_key = os.environ[f"{env_prefix}LIGHTER_API_PRIVATE_KEY"]
        bot.client = lighter.SignerClient(
            url=LIGHTER_URL, account_index=bot.account_index,
            api_private_keys={api_key_index: api_private_key},
        )
        bot._order_api = lighter.OrderApi(bot.client.api_client)
        bot._account_api = lighter.AccountApi(bot.client.api_client)
        await bot.log_run("started", {})
        await asyncio.gather(_run_tick_loop(bot), bot.run_book_ws_forever(), bot.run_orders_ws_forever(),
                             return_exceptions=True)
