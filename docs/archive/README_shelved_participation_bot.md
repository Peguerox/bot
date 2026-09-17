# Shelved: SOL/BTC Participation bot (2026-09-17)

Built, verified against the C++ reference engine (matched to float64 precision), deployed to
Worker 1, ran live in paper mode. Shelved to make room for the fast trade-tape strategy
(trade-pressure signal, verified against real Bitfinex trade data this same day) while that
strategy is still being refined with external research help.

Files archived here (were server/sol-dca-bitfinex.ts, lib/solbtc-participation-engine.ts,
lib/solbtc-participation-db.ts):
- sol-dca-bitfinex-participation-v1.ts.txt
- solbtc-participation-engine-v1.ts.txt
- solbtc-participation-db-v1.ts.txt

Supabase tables (solbtc_participation_state/trades/runs) are left in place, untouched -- the
bot's last real state is preserved there if this needs to be resumed later.

To resume: restore the three files above to their original paths, restore server/sol-dca-bitfinex.ts
to the participation-worker entrypoint pattern, redeploy.
