"""NEAR flip bot (FLIP_COIN=NEAR: market 10, 1 size decimal, min 2 NEAR, 5 price decimals, stop 0.5 / target 2)
(plain script: python3 test_near_flip_live.py). Reuses the fake exchange from test_sol_flip_live.py."""
import asyncio, os
os.environ["FLIP_COIN"] = "NEAR"
os.environ.setdefault("NEXT_PUBLIC_SUPABASE_URL", "http://x"); os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "x")
import lit_flip_core as F
import lit_flip_live as L
L.ACCOUNT_EVERY = 0.0; L.CANDLES_EVERY = 0.0; L.ORDERS_CHECK_EVERY = 0.0; L.MISMATCH_GRACE_S = 0.0; L.WATCH_REFIRE_S = 0.0; L.PUBLISH_EVERY = 0.0
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "test_lit_flip_live.py")).read()
exec(src[src.index("class FakeEx"):src.index("async def _ticks")])
PASS, FAIL = [], []
def check(name, ok, detail=None):
    (PASS if ok else FAIL).append(name)
    print(("  PASS  " if ok else "  FAIL  ") + name + ("" if ok or detail is None else f"   -> {detail}"))

async def main():
    check("market 10, own tables, stop 0.5 / target 2, 1 size dec, 5 price dec, min 2 NEAR",
          L.MARKET_ID == 10 and L.TABLE_STATE == "lighter_near_flip_state" and L.PARAMS.tp_pct == 2.0 and L.SIZE_DEC == 1
          and L.PRICE_DEC == 5 and L.MIN_BASE == 2.0)
    check("price 3.73657 -> 373657, 3.3 NEAR -> 33", L.px_int(3.73657) == 373657 and L.qty_int(3.3) == 33)
    ex, db = FakeEx(price=3.75, equity=249.0), FakeDB(); bot = L.FlipBot(ex, db)
    await bot.tick()
    check("first trade 5% of $249 = $12.45 -> 3.3 NEAR (1 decimal), >= $10", bot.pos is not None and abs(ex.pos - 3.3) < 1e-9 and ex.pos * 3.75 >= 10, ex.pos)
    flip = [o for o in ex.orders if o["kind"] == "stop"][0]; tgt = [o for o in ex.orders if o["kind"] == "limit"][0]
    check("target +2%, flip -0.5% for 3.3 + next 5.0 = 8.3 (one decimal)", abs(tgt["price"] - 3.825) < 1e-9 and abs(flip["price"] - 3.73125) < 1e-9
          and abs(flip["qty"] - 8.3) < 1e-9, (tgt, flip))
    ex.move(3.73125); await bot.tick(); await bot.tick()
    check("flipped to SHORT 5.0 NEAR, level 1", bot.pos.side == F.SHORT and bot.pos.level == 1 and abs(ex.pos + 5.0) < 1e-9, (bot.pos, ex.pos))
    print(f"\n==== {len(PASS)} passed, {len(FAIL)} failed ====")

async def _nosleep(*a, **k): return None
L.asyncio.sleep = _nosleep
asyncio.run(main())
raise SystemExit(1 if FAIL else 0)
