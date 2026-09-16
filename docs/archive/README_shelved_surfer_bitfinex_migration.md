# Shelved: Surfer-on-Bitfinex migration (2026-09-16)

Built and verified this session (typecheck clean, real WS connection tested against the real
Bitfinex account), but never deployed or enabled. Shelved in favor of building the
"participation" hybrid CUSUM paper bot on Worker 1 instead -- the Surfer bots stay on
Binance.US/Trigger.dev, real money, unchanged, for now.

Files (still live, not archived, since they're harmless reusable infra):
- lib/bitfinex-multi-book-ws.ts -- multi-symbol Bitfinex book WS tracker
- lib/surfer-bfx-solbtc-db.ts, lib/surfer-bfx-solusd-db.ts -- DB layer
- supabase/migrations/surfer_bitfinex_tables.sql -- schema (never applied)

Archived here (were server/surfer-bfx-solbtc.ts and server/surfer-bfx-solusd.ts, Worker-1-specific
engine implementations -- superseded in server/sol-dca-bitfinex.ts by the participation strategy):
- surfer-bfx-solbtc-shelved-migration.ts.txt
- surfer-bfx-solusd-shelved-migration.ts.txt

To resume: restore these two files to server/, and rewrite server/sol-dca-bitfinex.ts back to the
combined-worker entrypoint pattern they expect (see git history around 2026-09-16 for the exact
prior version).
