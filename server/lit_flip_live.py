"""Flip martingale on a Lighter perp -- REAL MONEY, built 2026-11-03. One coin per process (FLIP_COIN env var, see COINS):
  * LIT (market 120): Worker 2's service + account, Start Command `python server/lit_flip_live.py`.
  * NEAR (market 10): Worker 1's service + account, same Start Command with env FLIP_COIN=NEAR (own tables lighter_near_flip_*).
    (SOL, market 2, ran there 2026-11-03/04 -- kept in COINS.)
Each uses its own service's plain LIGHTER_* env vars.

Strategy and research: lit_flip_core.py (setting A). This file is the I/O:
  * Sequence start: range signal on the last 30 closed 1-min LIT perp candles -> market order, first trade 5% of equity.
  * While a position is open, two orders rest on the exchange at all times:
      TARGET  reduce-only limit at +2%
      FLIP    stop at -0.5% for (current qty + next qty) the other way, NOT reduce-only, so Lighter itself closes and
              re-opens in ONE fill (owner: "the flip has to be instant"). At the last ladder step it is a plain
              reduce-only stop (bust).
  * "watch" fallback (flip_mode): if Lighter refuses the non-reduce-only stop, the bot watches the live order book
    (websocket) every 0.25 s and fires the same single combined market order the moment the stop price is touched.
  * Order events come over the account_orders websocket and wake the bot at once (position re-read on the next tick,
    resting orders re-counted 3 s later); REST reads stay as a slow safety net (10 s / 60 s, or 3 s / 20 s if it's down).
  * Reconcile from the REAL position (REST is the truth): position gone -> target (or bust stop) filled -> sequence
    over; position on the other side -> flip filled -> place the next target + flip.
  * OFF (enabled=false) only stops NEW sequences; an open position keeps its target and flip. Flatten
    (close_requested) cancels everything and closes at market. Single-instance lock gates every exchange action.
Tables: lighter_lit_flip_state / _trades / _runs (supabase/migrations/lighter_lit_flip.sql).
"""
import asyncio, json, math, os, time
from datetime import datetime, timezone
import aiohttp

import lit_flip_core as F
from dataclasses import asdict, replace

# One file, one coin per process: FLIP_COIN env var (default LIT). Market details from orderBookDetails (2026-11-03).
COINS = {
    # Worker 2's service: setting A (stop 0.5 / target 2).
    "LIT": dict(market=120, price_dec=4, size_dec=2, min_base=1.00, tables="lighter_lit_flip", params=F.Params()),
    # Worker 1's service (owner, 2026-11-03): SOL 5y backtest picked stop 0.5 / target 1 -- the smoothest
    # (+6%/month, worst drop 23%, 210 busts in 25,630 sequences). research/martingale-dca-2026-11-03/target_sweep.py
    "SOL": dict(market=2, price_dec=3, size_dec=3, min_base=0.055, tables="lighter_sol_flip", params=F.Params(sl_pct=0.5, tp_pct=1.0)),
    # Worker 1 from 2026-11-04 (owner): NEAR, target 2% -- last 120 days on Lighter candles NEAR +14%/month (2nd after LIT
    # +26%) while SOL lost -3%/-1.6%. research/flip-coins-2026-11-04/test_coins.py
    "NEAR": dict(market=10, price_dec=5, size_dec=1, min_base=2.0, tables="lighter_near_flip", params=F.Params()),
}
COIN = os.environ.get("FLIP_COIN", "LIT").upper()
_C = COINS[COIN]
MARKET_ID = _C["market"]
PRICE_DEC, SIZE_DEC = _C["price_dec"], _C["size_dec"]
MIN_BASE = _C["min_base"]             # exchange minimum order size, in the coin
PARAMS = _C["params"]
LEVERAGE = 5                          # account setting for this market; the strategy itself caps at 3x
BASE_URL = "https://mainnet.zklighter.elliot.ai"
TABLE_STATE, TABLE_TRADES, TABLE_RUNS = (f"{_C['tables']}_state", f"{_C['tables']}_trades", f"{_C['tables']}_runs")
ACCOUNT_EVERY, CANDLES_EVERY, ORDERS_CHECK_EVERY = 3.0, 20.0, 20.0     # REST fallback while the orders websocket is down
ACCOUNT_EVERY_WS, ORDERS_CHECK_EVERY_WS = 10.0, 60.0  # REST safety net while it is live (any order event wakes the bot)
ORDERS_SETTLE_S = 3.0                 # after an order event, wait this long before counting orders (new ones show late)
ORDERS_WS_PING_EVERY, ORDERS_WS_RENEW_EVERY = 20.0, 8 * 60.0   # Lighter drops a silent socket; auth tokens live 10 min
ORDERS_WS_FRESH_S = 60.0              # no frame for this long -> websocket treated as down (REST cadence again)
TICK_NATIVE, TICK_WATCH = 1.0, 0.25
PUBLISH_EVERY = 3.0                   # panel readout write, seconds
MISMATCH_GRACE_S = 8.0                # a fill can take a few seconds to show; wait before "fixing" a mismatch
WATCH_REFIRE_S = 5.0                  # watch mode: never fire again within this long of the last shot
LOCK_STALE_AFTER, LOCK_REFRESH_EVERY = 30.0, 5.0
CANCEL_TRIES, CANCEL_SETTLE_S = 3, 0.5
# Panel-editable settings (owner 2026-11-04): override_params JSON on the state row. Each change applies from the NEXT
# sequence -- an open sequence keeps the params it started with (seq_params), so a running ladder never changes halfway.
EDITABLE = {"tp_pct": (0.2, 10.0), "sl_pct": (0.1, 5.0), "first_pct": (0.5, 50.0), "mult": (1.05, 3.0), "lev_cap": (0.2, 5.0)}    # verified cancel: retries, and wait before re-counting resting orders
ORDER_TIMEOUT, REST_TIMEOUT = 12.0, 8.0
MARKET_BAND = 0.005                   # market orders: worst average price 0.5% away
STOP_BAND = 0.005                     # stop orders: execution limit 0.5% beyond the trigger


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def qty_round(q):                     # sizes: SIZE_DEC decimals, never below the exchange minimum
    return max(MIN_BASE, math.floor(q * 10 ** SIZE_DEC + 1e-6) / 10 ** SIZE_DEC)   # +1e-6: 5.02 stored as 5.0199999


def px_int(p):
    return int(round(p * 10 ** PRICE_DEC))


def qty_int(q):
    return int(round(q * 10 ** SIZE_DEC))


# ── Exchange adapter (real) ─────────────────────────────────────────────────────────────────────
class LighterExchange:
    def __init__(self, client, account_index):
        import lighter
        self.lighter, self.client, self.account_index = lighter, client, account_index
        self._token, self._token_exp = None, 0.0
        self._co = 0
        self.book = {"bids": [], "asks": []}
        self.book_at = 0.0
        self.on_orders_event = None           # set by main(): called on every account_orders update (fill, cancel, trigger)
        self.orders_ws_at = 0.0               # last frame from the orders websocket

    def orders_ws_live(self):
        return time.time() - self.orders_ws_at < ORDERS_WS_FRESH_S

    async def _orders_ws_session(self):
        """One account_orders connection for market 120: every order update (our target/flip filled, cancelled, a stop
        triggered or rejected) wakes the bot at once instead of waiting for the next REST read."""
        token = self._auth()
        if not token:
            raise RuntimeError("no auth token for the orders websocket")
        channel = f"account_orders/{MARKET_ID}/{self.account_index}"
        url = BASE_URL.replace("https://", "wss://") + "/stream"
        opened = last_ping = time.time()
        async with aiohttp.ClientSession() as s:
            async with s.ws_connect(url, heartbeat=None, max_msg_size=0) as ws:
                await ws.send_json({"type": "subscribe", "channel": channel, "auth": token})
                while time.time() - opened < ORDERS_WS_RENEW_EVERY:
                    if time.time() - last_ping >= ORDERS_WS_PING_EVERY:
                        await ws.send_json({"type": "ping"}); last_ping = time.time()
                    try:
                        msg = await ws.receive(timeout=5.0)
                    except asyncio.TimeoutError:
                        continue
                    if msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.CLOSING, aiohttp.WSMsgType.ERROR):
                        raise RuntimeError(f"orders websocket closed ({msg.type})")
                    if msg.type != aiohttp.WSMsgType.TEXT:
                        continue
                    data = json.loads(msg.data)
                    kind = str(data.get("type") or "")
                    if kind == "ping":
                        await ws.send_json({"type": "pong"})
                    if "error" in data or kind == "error":
                        raise RuntimeError(f"orders websocket error: {str(data)[:200]}")
                    self.orders_ws_at = time.time()
                    if kind.startswith("update") and "account_orders" in (kind + str(data.get("channel") or "")):
                        if self.on_orders_event:
                            self.on_orders_event()

    async def run_orders_ws_forever(self, log):
        failures = 0
        while True:
            try:
                await self._orders_ws_session(); failures = 0
            except Exception as e:
                failures += 1
                if failures in (1, 5) or failures % 50 == 0:
                    await log("orders_ws_reconnect", {"error": str(e)[:200], "failures": failures})
            self.orders_ws_at = 0.0
            await asyncio.sleep(min(30.0, 1.0 * failures))

    def _co_idx(self):
        self._co = max(int(time.time() * 1000) % 500_000_000, self._co + 1)
        return self._co

    def _auth(self):
        if self._token is None or time.time() > self._token_exp - 60:
            tok, err = self.client.create_auth_token_with_expiry()
            if err:
                return None
            self._token, self._token_exp = tok, time.time() + 600
        return self._token

    async def account(self):
        """{"pos": signed LIT, "entry": avg entry or None, "equity": total asset value} or None on failure."""
        api = self.lighter.AccountApi(self.client.api_client)
        acct = await asyncio.wait_for(api.account(by="index", value=str(self.account_index),
                                                  _headers={"authorization": self._auth() or ""}), REST_TIMEOUT)
        a = acct.accounts[0]
        pos, entry, upnl, funding = 0.0, None, 0.0, None
        for p in (a.positions or []):
            if int(p.market_id) == MARKET_ID:
                sign = 1 if str(p.sign) in ("1", "True", "true") else -1
                pos = sign * float(p.position or 0)
                entry = float(p.avg_entry_price) if p.avg_entry_price not in (None, "") and pos else None
                upnl = float(p.unrealized_pnl) if p.unrealized_pnl not in (None, "") and pos else 0.0
                tf = getattr(p, "total_funding_paid_out", None)
                funding = float(tf) if tf not in (None, "") else None     # Lighter's running funding total on this market
        equity = float(a.total_asset_value) if a.total_asset_value not in (None, "") else float(a.collateral)
        return {"pos": pos, "entry": entry, "equity": equity, "upnl": upnl, "funding": funding}

    async def candles(self, n=40):
        end = int(time.time() * 1000)
        url = f"{BASE_URL}/api/v1/candles?market_id={MARKET_ID}&resolution=1m&start_timestamp=0&end_timestamp={end}&count_back={n}"
        async with aiohttp.ClientSession() as s:
            async with s.get(url, timeout=aiohttp.ClientTimeout(total=REST_TIMEOUT)) as r:
                c = (await r.json()).get("c") or []
        return [{"t": x["t"], "h": float(x["h"]), "l": float(x["l"]), "c": float(x["c"])} for x in c]

    async def market(self, is_ask, qty, ref_price, reduce_only=False):
        worst = ref_price * (1 - MARKET_BAND if is_ask else 1 + MARKET_BAND)
        _o, _r, err = await asyncio.wait_for(self.client.create_market_order(
            market_index=MARKET_ID, client_order_index=self._co_idx(), base_amount=qty_int(qty),
            avg_execution_price=px_int(worst), is_ask=is_ask, reduce_only=reduce_only), ORDER_TIMEOUT)
        return err

    async def limit(self, is_ask, qty, price, reduce_only=True):
        c = self.client
        _o, _r, err = await asyncio.wait_for(c.create_order(
            MARKET_ID, self._co_idx(), qty_int(qty), px_int(price), is_ask, c.ORDER_TYPE_LIMIT,
            c.ORDER_TIME_IN_FORCE_GOOD_TILL_TIME, reduce_only=reduce_only, order_expiry=c.DEFAULT_28_DAY_ORDER_EXPIRY), ORDER_TIMEOUT)
        return err

    async def stop(self, is_ask, qty, trigger, reduce_only):
        worst = trigger * (1 - STOP_BAND if is_ask else 1 + STOP_BAND)
        _o, _r, err = await asyncio.wait_for(self.client.create_sl_order(
            market_index=MARKET_ID, client_order_index=self._co_idx(), base_amount=qty_int(qty),
            trigger_price=px_int(trigger), price=px_int(worst), is_ask=is_ask, reduce_only=reduce_only), ORDER_TIMEOUT)
        return err

    async def cancel_all(self):
        c = self.client
        _o, _r, err = await asyncio.wait_for(c.cancel_all_orders(
            time_in_force=c.CANCEL_ALL_TIF_IMMEDIATE, timestamp_ms=0, cancel_all_market_index=MARKET_ID), ORDER_TIMEOUT)
        return err

    async def open_order_count(self):
        api = self.lighter.OrderApi(self.client.api_client)
        r = await asyncio.wait_for(api.account_active_orders(authorization=self._auth() or "", account_index=self.account_index,
                                                             market_id=MARKET_ID), REST_TIMEOUT)
        return len(r.orders or [])

    async def set_leverage(self):
        c = self.client
        try:
            _o, _r, err = await asyncio.wait_for(c.update_leverage(MARKET_ID, c.CROSS_MARGIN_MODE, LEVERAGE), ORDER_TIMEOUT)
            return err
        except Exception as e:
            return str(e)

    def on_order_book(self, market_id, state):
        if str(market_id) == str(MARKET_ID):
            self.book, self.book_at = state, time.time()

    def best_bid_ask(self, max_age=5.0):
        if time.time() - self.book_at > max_age:
            return None, None
        b, a = self.book.get("bids") or [], self.book.get("asks") or []
        if not b or not a:
            return None, None
        return max(float(x["price"]) for x in b), min(float(x["price"]) for x in a)


# ── Database adapter (Supabase REST) ────────────────────────────────────────────────────────────
class SupabaseDB:
    def __init__(self):
        self.url, self.key = os.environ["NEXT_PUBLIC_SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"]

    async def _req(self, method, path, body=None, headers=None):
        h = {"apikey": self.key, "Authorization": f"Bearer {self.key}", "Content-Type": "application/json"}
        if method in ("POST", "PATCH"):
            h["Prefer"] = "return=representation"
        h.update(headers or {})
        async with aiohttp.ClientSession() as s:
            async with s.request(method, f"{self.url}/rest/v1/{path}", json=body, headers=h,
                                 timeout=aiohttp.ClientTimeout(total=REST_TIMEOUT)) as r:
                if r.status >= 400:
                    raise RuntimeError(f"supabase {method} {path} {r.status}: {(await r.text())[:200]}")
                t = await r.text()
                return json.loads(t) if t else None

    async def get_state(self):
        return (await self._req("GET", f"{TABLE_STATE}?id=eq.1&select=*"))[0]

    async def update_state(self, patch):
        patch = dict(patch, updated_at=now_iso())
        await self._req("PATCH", f"{TABLE_STATE}?id=eq.1", patch)

    async def log(self, action, detail):
        print(f"[{action}] {detail}", flush=True)
        try:
            await self._req("POST", TABLE_RUNS, {"action": action, "detail": detail})
        except Exception as e:
            print(f"  (log failed: {e})", flush=True)

    async def trade(self, row):
        await self._req("POST", TABLE_TRADES, row)

    async def try_lock(self, owner):
        stale = datetime.fromtimestamp(time.time() - LOCK_STALE_AFTER, timezone.utc).isoformat().replace("+00:00", "Z")
        q = (f"{TABLE_STATE}?id=eq.1&or=(lock_owner.is.null,lock_heartbeat.is.null,lock_owner.eq.{owner},"
             f"lock_heartbeat.lt.{stale})")
        rows = await self._req("PATCH", q, {"lock_owner": owner, "lock_heartbeat": now_iso()})
        return bool(rows)


# ── The bot ─────────────────────────────────────────────────────────────────────────────────────
class FlipBot:
    def __init__(self, ex, db, params=PARAMS, owner="local"):
        self.ex, self.db, self.p, self.owner = ex, db, params, owner
        self.base = params                  # the coin's default settings (COINS)
        self.p_next = params                # what the NEXT sequence will use (base + panel overrides)
        self.pos = None                 # F.Position we expect on the exchange
        self.seq = None                 # {"id", "start_equity"}
        self.acct = None; self.acct_at = 0.0
        self.candles = []; self.candles_at = 0.0
        self.orders_checked_at = 0.0
        self.mismatch_since = None
        self.locked = False; self.lock_at = 0.0
        self.flip_mode = "native"
        self.loaded = False
        self.fired_at = 0.0
        self.published_at = 0.0
        self.cancel_pending = False       # a sequence ended but Lighter still showed resting orders -> no new sequence yet
        self.woken = asyncio.Event()

    def wake(self):
        """An order event from the websocket: re-read the position on the very next tick and count the resting orders
        ORDERS_SETTLE_S later (a triggered-but-rejected flip leaves one order missing -> re-placed within seconds)."""
        self.acct_at = 0.0
        self.orders_checked_at = min(self.orders_checked_at, time.time() - self._orders_every() + ORDERS_SETTLE_S)
        self.woken.set()

    def _ws_live(self):
        f = getattr(self.ex, "orders_ws_live", None)
        return bool(f and f())

    def _account_every(self):
        return ACCOUNT_EVERY_WS if self._ws_live() else ACCOUNT_EVERY

    def _orders_every(self):
        return ORDERS_CHECK_EVERY_WS if self._ws_live() else ORDERS_CHECK_EVERY

    # ---- persistence of the sequence (survives restarts) ----
    def _pos_to_state(self):
        if self.pos is None:
            return {"seq_side": None, "seq_qty": None, "seq_entry": None, "seq_level": None, "seq_ladder": None}
        return {"seq_side": self.pos.side, "seq_qty": self.pos.qty, "seq_entry": self.pos.entry,
                "seq_level": self.pos.level, "seq_ladder": self.pos.ladder_usd}

    async def _save(self, extra=None):
        patch = self._pos_to_state()
        patch.update({"seq_id": (self.seq or {}).get("id"), "seq_start_equity": (self.seq or {}).get("start_equity"),
                      "flip_mode": self.flip_mode,
                      "seq_params": ({k: getattr(self.p, k) for k in EDITABLE} if self.pos is not None else None)})
        patch.update(extra or {})
        await self.db.update_state(patch)

    def _params_from_state(self, st):
        """base settings + the panel's override_params; anything missing or out of range keeps the base value."""
        ov = st.get("override_params") or {}
        if isinstance(ov, str):
            try: ov = json.loads(ov)
            except Exception: ov = {}
        ch = {}
        for k, (lo, hi) in EDITABLE.items():
            try:
                v = float(ov[k])
            except (KeyError, TypeError, ValueError):
                continue
            if lo <= v <= hi:
                ch[k] = v
        p = replace(self.base, **ch)
        return p if p.tp_pct > p.sl_pct else self.base

    def _load(self, st):
        self.flip_mode = st.get("flip_mode") or "native"
        sp = st.get("seq_params")
        if sp and st.get("seq_side") is not None:
            try:
                self.p = replace(self.base, **{k: float(v) for k, v in (sp if isinstance(sp, dict) else json.loads(sp)).items() if k in EDITABLE})
            except Exception:
                pass
        if st.get("seq_side") is not None:
            self.pos = F.Position(side=int(st["seq_side"]), qty=float(st["seq_qty"]), entry=float(st["seq_entry"]),
                                  level=int(st["seq_level"]), ladder_usd=list(st.get("seq_ladder") or []))
            self.seq = {"id": st.get("seq_id"), "start_equity": st.get("seq_start_equity")}
        self.loaded = True

    # ---- exchange helpers ----
    async def _cancel_verified(self, why):
        """cancel_all, then confirm Lighter shows no resting order on this market (Astra review 2026-11-04: a stale
        non-reduce-only flip left on the book after a sequence ends could open an unwanted position). Up to 3 tries."""
        n = None
        for _ in range(CANCEL_TRIES):
            err = await self.ex.cancel_all()
            if err:
                await self.db.log("cancel_failed", {"why": why, "error": str(err)[:200]})
            await asyncio.sleep(CANCEL_SETTLE_S)
            try:
                n = await self.ex.open_order_count()
            except Exception as e:
                n = None; await self.db.log("orders_read_failed", {"why": why, "error": str(e)[:200]})
            if n == 0:
                self.cancel_pending = False
                return True
        self.cancel_pending = True
        await self.db.log("cancel_unverified", {"why": why, "open": n})
        return False

    async def _place_orders(self, pos):
        """Cancel everything on the market, then put the target and the flip (or bust stop) on the book at once (a position
        must never wait unprotected for a verification; a leftover order is caught by _check_orders' n > want)."""
        err = await self.ex.cancel_all()
        if err:
            await self.db.log("cancel_failed", {"why": "replace", "error": str(err)[:200]})
        out = {}
        for o in F.resting_orders(pos, self.p):
            if o.kind == "target":
                out["target"] = await self.ex.limit(o.is_ask, qty_round(o.qty), o.price, reduce_only=True)
            elif o.kind == "flip" and self.flip_mode == "native":
                e = await self.ex.stop(o.is_ask, qty_round(o.qty), o.price, reduce_only=False)
                if e:
                    # Lighter refused the non-reduce-only stop -> from now on the bot fires the flip itself.
                    self.flip_mode = "watch"
                    await self.db.log("flip_mode_watch", {"reason": str(e)[:200]})
                out["flip"] = e
            elif o.kind == "stop":
                out["stop"] = await self.ex.stop(o.is_ask, qty_round(o.qty), o.price, reduce_only=True)
        self.orders_checked_at = time.time()
        await self.db.log("orders_placed", {"side": pos.side, "qty": round(pos.qty, 2), "entry": pos.entry, "level": pos.level,
                                            "target": round(F.target_price(pos, self.p), 4), "stop": round(F.stop_price(pos, self.p), 4),
                                            "mode": self.flip_mode, "errors": {k: str(v)[:120] for k, v in out.items() if v}})
        return out

    async def _read_account(self, force=False):
        if force or time.time() - self.acct_at >= self._account_every():
            try:
                self.acct = await self.ex.account(); self.acct_at = time.time()
            except Exception as e:
                await self.db.log("account_read_failed", {"error": str(e)[:200]})
        return self.acct

    async def _lock(self):
        if time.time() - self.lock_at >= LOCK_REFRESH_EVERY:
            try:
                self.locked = await self.db.try_lock(self.owner)
            except Exception:
                self.locked = False
            self.lock_at = time.time()
        return self.locked

    async def _refresh_market(self):
        """LIT candles every CANDLES_EVERY (public data, also while OFF) so the panel always shows the live signal."""
        if time.time() - self.candles_at >= CANDLES_EVERY:
            try:
                self.candles = await self.ex.candles(self.p.window + 5); self.candles_at = time.time()
            except Exception as e:
                await self.db.log("candles_failed", {"error": str(e)[:200]})

    async def _publish(self, acct, force=False):
        """Panel readout (throttled): price, range, signal, position, open P&L, equity, heartbeat."""
        if not force and time.time() - self.published_at < PUBLISH_EVERY:
            return
        bid, ask = self.ex.best_bid_ask()
        price = ((bid + ask) / 2) if bid and ask else (self.candles[-1]["c"] if self.candles else None)
        pos_r, hi, lo = F.range_info(self.candles, self.p.window) if self.candles else (None, None, None)
        await self.db.update_state({"live_price": price, "live_range_pos": pos_r, "live_range_hi": hi, "live_range_lo": lo,
                                    "live_signal": F.range_signal(self.candles, self.p.window, self.p.band) if self.candles else None,
                                    "live_pos": acct["pos"], "live_upnl": self._live_upnl(acct, price), "equity": acct["equity"],
                                    "live_params": {k: getattr(self.p_next, k) for k in EDITABLE},
                                    "lock_heartbeat": now_iso()})
        self.published_at = time.time()

    def _live_upnl(self, acct, price):
        """Open P&L from the live websocket price (account reads are only every few seconds)."""
        if acct.get("pos") and acct.get("entry") and price:
            return acct["pos"] * (price - acct["entry"])
        return acct.get("upnl")

    # ---- one tick ----
    async def tick(self):
        st = await self.db.get_state()
        if not self.loaded:
            self._load(st)
        self.p_next = self._params_from_state(st)
        if self.pos is None:
            self.p = self.p_next                # flat: the next sequence uses the current panel settings
        if not await self._lock():
            return
        acct = await self._read_account()
        if acct is None:
            return
        live = acct["pos"]
        await self._refresh_market()
        await self._publish(acct)

        if st.get("close_requested"):
            await self._flatten(acct); return

        if self.pos is None:
            if abs(live) >= MIN_BASE / 2:
                await self._adopt(acct); return
            if self.cancel_pending and not await self._cancel_verified("retry_before_start"):
                return                          # never start a new sequence on top of a stale flip order
            await self._maybe_start(st, acct); return

        exp_side, exp_qty = self.pos.side, self.pos.qty
        if abs(live) < MIN_BASE / 2:
            await self._sequence_over(acct); return
        if (live > 0) != (exp_side == F.LONG):
            await self._flipped(acct); return
        if abs(abs(live) - exp_qty) > max(2 * 10 ** -SIZE_DEC, exp_qty * 0.01):
            # Same side, different size: a fill in progress (or a partial). Give it a few seconds, then adopt.
            self.mismatch_since = self.mismatch_since or time.time()
            if time.time() - self.mismatch_since >= MISMATCH_GRACE_S:
                await self.db.log("size_mismatch_adopted", {"expected": exp_qty, "live": live})
                self.pos = F.Position(self.pos.side, abs(live), acct["entry"] or self.pos.entry, self.pos.level, self.pos.ladder_usd)
                self.mismatch_since = None
                await self._place_orders(self.pos); await self._save()
            return
        self.mismatch_since = None
        # Watch mode: only once the real position matches what we expect (never on a stale view -- that would
        # fire a second flip right after the first), fire the flip/stop ourselves when the stop price is touched.
        if self.flip_mode == "watch" and time.time() - self.fired_at >= WATCH_REFIRE_S:
            if await self._watch_trigger():
                return
        if time.time() - self.orders_checked_at >= self._orders_every():
            await self._check_orders()

    async def _maybe_start(self, st, acct):
        if not st.get("enabled"):
            return
        sig = F.range_signal(self.candles, self.p.window, self.p.band) if self.candles else 0
        if sig == 0 or not self.candles:
            return
        bid, ask = self.ex.best_bid_ask()
        ref = (ask if sig == F.LONG else bid) or self.candles[-1]["c"]
        first = F.start(sig, ref, acct["equity"], self.p)
        if first is None:
            await self.db.log("too_small_to_start", {"equity": acct["equity"]}); return
        qty = qty_round(first.qty)
        if qty * ref < self.p.min_order_usd:    # rounding down can dip under Lighter's $10 minimum -> one size step up
            qty = round(qty + 10 ** -SIZE_DEC, SIZE_DEC)
        err = await self.ex.market(sig == F.SHORT, qty, ref)
        await self.db.log("sequence_start", {"side": sig, "qty": qty, "ref": ref, "error": str(err)[:200] if err else None})
        for _ in range(6):                      # the fill can take a few seconds to show
            await asyncio.sleep(0.5)
            a = await self._read_account(force=True)
            if a and abs(a["pos"]) >= MIN_BASE / 2:
                self.seq = {"id": int(time.time() * 1000), "start_equity": acct["equity"]}
                self.pos = F.Position(F.LONG if a["pos"] > 0 else F.SHORT, abs(a["pos"]), a["entry"] or ref, 0, first.ladder_usd)
                await self._place_orders(self.pos); await self._save()
                return
        await self.db.log("start_no_fill_seen", {"side": sig, "qty": qty})

    async def _flipped(self, acct):
        old = self.pos
        nq = F.next_qty(old, self.p)
        fill = acct["entry"] or F.stop_price(old, self.p)
        await self.db.trade({"seq_id": self.seq["id"] if self.seq else None, "level": old.level, "side": old.side, "qty": old.qty,
                             "entry": old.entry, "exit_price": F.stop_price(old, self.p), "result": "flip",
                             "pnl_usd": -old.qty * old.entry * self.p.sl_pct / 100})
        if nq is None:                          # should not happen (last step has a reduce-only stop); stay safe
            await self.db.log("flip_past_cap", {"live": acct["pos"]})
        self.pos = F.Position(side=F.LONG if acct["pos"] > 0 else F.SHORT, qty=abs(acct["pos"]), entry=fill,
                              level=old.level + 1, ladder_usd=old.ladder_usd)
        await self.db.log("flipped", {"to": self.pos.side, "qty": round(self.pos.qty, 2), "entry": fill, "level": self.pos.level,
                                      "trigger": round(F.stop_price(old, self.p), PRICE_DEC), "funding_total": acct.get("funding")})
        await self._place_orders(self.pos); await self._save()

    async def _sequence_over(self, acct):
        old = self.pos
        tgt, stp = F.target_price(old, self.p), F.stop_price(old, self.p)
        bid, ask = self.ex.best_bid_ask()
        px = ((bid if old.side == F.LONG else ask) or (self.candles[-1]["c"] if self.candles else old.entry))
        won = abs(px - tgt) < abs(px - stp)
        await self._cancel_verified("sequence_over")
        pnl_seq = acct["equity"] - float((self.seq or {}).get("start_equity") or acct["equity"])
        await self.db.trade({"seq_id": (self.seq or {}).get("id"), "level": old.level, "side": old.side, "qty": old.qty,
                             "entry": old.entry, "exit_price": tgt if won else stp, "result": "target" if won else "bust",
                             "pnl_usd": (old.qty * old.entry * (self.p.tp_pct if won else -self.p.sl_pct) / 100)})
        st = await self.db.get_state()
        await self.db.log("sequence_over", {"result": "target" if won else "bust", "level": old.level, "sequence_pnl_usd": round(pnl_seq, 4),
                                            "funding_total": acct.get("funding")})
        self.pos, self.seq = None, None
        await self._save({"sequences": int(st.get("sequences") or 0) + 1,
                          "wins": int(st.get("wins") or 0) + (1 if won else 0),
                          "busts": int(st.get("busts") or 0) + (0 if won else 1),
                          "realized_usd": float(st.get("realized_usd") or 0) + pnl_seq})

    async def _adopt(self, acct):
        """A position we don't know about (first start, or the state row was lost): treat it as level 0 of a new
        sequence sized from today's equity and protect it at once."""
        side = F.LONG if acct["pos"] > 0 else F.SHORT
        lad = F.ladder(acct["equity"], self.p) or [abs(acct["pos"]) * (acct["entry"] or 1)]
        self.pos = F.Position(side, abs(acct["pos"]), acct["entry"] or 0.0, 0, lad)
        self.seq = {"id": int(time.time() * 1000), "start_equity": acct["equity"]}
        await self.db.log("position_adopted", {"pos": acct["pos"], "entry": acct["entry"]})
        await self._place_orders(self.pos); await self._save()

    async def _check_orders(self):
        try:
            n = await self.ex.open_order_count()
        except Exception as e:
            await self.db.log("orders_read_failed", {"error": str(e)[:200]}); return
        want = 2 if self.flip_mode == "native" else 1
        self.orders_checked_at = time.time()
        if n < want:
            await self.db.log("orders_missing_replaced", {"open": n, "want": want})
            await self._place_orders(self.pos)
        elif n > want:                          # a stale order survived a cancel -> clear the book and re-place ours
            await self.db.log("orders_extra_replaced", {"open": n, "want": want})
            await self._place_orders(self.pos)

    async def _watch_trigger(self):
        bid, ask = self.ex.best_bid_ask()
        if bid is None:
            return False
        stp = F.stop_price(self.pos, self.p)
        touched = (bid <= stp) if self.pos.side == F.LONG else (ask >= stp)
        if not touched:
            return False
        nq = F.next_qty(self.pos, self.p)
        is_ask = self.pos.side == F.LONG
        if nq is None:
            err = await self.ex.market(is_ask, qty_round(self.pos.qty), bid if is_ask else ask, reduce_only=True)
        else:
            err = await self.ex.market(is_ask, qty_round(self.pos.qty + nq), bid if is_ask else ask)
        await self.db.log("watch_fired", {"bid": bid, "ask": ask, "stop": stp, "flip": nq is not None, "error": str(err)[:200] if err else None})
        self.acct_at = 0.0                      # re-read the position on the next tick
        self.fired_at = time.time()
        return True

    async def _flatten(self, acct):
        await self._cancel_verified("flatten")
        if abs(acct["pos"]) >= 0.005:
            bid, ask = self.ex.best_bid_ask()
            is_ask = acct["pos"] > 0
            ref = (bid if is_ask else ask) or (self.candles[-1]["c"] if self.candles else acct["entry"] or 0)
            err = await self.ex.market(is_ask, abs(acct["pos"]), ref, reduce_only=True)
            self.flatten_ref = ref
            await self.db.log("flatten_sent", {"pos": acct["pos"], "error": str(err)[:200] if err else None})
            self.acct_at = 0.0
            return
        if self.cancel_pending:                 # flat, but an order still rests -> keep trying before calling it done
            return
        if self.pos is not None and self.seq:
            # Owner 2026-11-04: a flattened sequence must show in the trades + counters (it vanished before). P&L from the
            # real account; exit price = the reference we sent the close at.
            old, pnl_seq = self.pos, acct["equity"] - float(self.seq.get("start_equity") or acct["equity"])
            ex_px = getattr(self, "flatten_ref", None) or old.entry
            await self.db.trade({"seq_id": self.seq.get("id"), "level": old.level, "side": old.side, "qty": old.qty, "entry": old.entry,
                                 "exit_price": ex_px, "result": "flatten", "pnl_usd": old.qty * (ex_px - old.entry) * old.side})
            st = await self.db.get_state()
            await self._save({"sequences": int(st.get("sequences") or 0) + 1, "wins": int(st.get("wins") or 0) + (1 if pnl_seq > 0 else 0),
                              "realized_usd": float(st.get("realized_usd") or 0) + pnl_seq})
            await self.db.log("sequence_over", {"result": "flatten", "level": old.level, "sequence_pnl_usd": round(pnl_seq, 4)})
        self.pos, self.seq = None, None
        await self._save({"close_requested": False, "enabled": False})
        await self.db.log("flattened", {})


async def main():
    import lighter
    account_index = int(os.environ["LIGHTER_ACCOUNT_INDEX"]); key_index = int(os.environ["LIGHTER_API_KEY_INDEX"])
    client = lighter.SignerClient(url=BASE_URL, account_index=account_index,
                                  api_private_keys={key_index: os.environ["LIGHTER_API_PRIVATE_KEY"]})
    ex = LighterExchange(client, account_index)
    db = SupabaseDB()
    owner = f"{os.environ.get('RENDER_INSTANCE_ID', 'local')}:{COIN.lower()}-flip"
    bot = FlipBot(ex, db, owner=owner)
    await db.log("started", {"coin": COIN, "market": MARKET_ID, "params": PARAMS.__dict__})
    err = await ex.set_leverage()
    await db.log("leverage_set", {"leverage": LEVERAGE, "error": str(err)[:200] if err else None})
    ws = lighter.WsClient(order_book_ids=[MARKET_ID], account_ids=[], on_order_book_update=ex.on_order_book,
                          on_account_update=lambda *a: None)
    asyncio.create_task(ws.run_async())
    ex.on_orders_event = bot.wake
    asyncio.create_task(ex.run_orders_ws_forever(db.log))
    errors = 0
    while True:
        try:
            await bot.tick(); errors = 0
        except Exception as e:
            errors += 1
            await db.log("tick_error", {"error": str(e)[:300], "n": errors})
            await asyncio.sleep(min(2 ** min(errors, 6), 60))
        try:                                # sleep until the next tick -- or less, if an order event arrives
            await asyncio.wait_for(bot.woken.wait(), TICK_WATCH if bot.flip_mode == "watch" and bot.pos is not None else TICK_NATIVE)
        except asyncio.TimeoutError:
            pass
        bot.woken.clear()


if __name__ == "__main__":
    asyncio.run(main())
