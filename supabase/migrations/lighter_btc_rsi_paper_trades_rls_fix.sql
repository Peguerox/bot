-- Same bug the _TEMPLATE_new_bot_tables.sql checklist warns about: lighter_btc_rsi_paper_trades
-- was created without realtime publication or an anon-read RLS policy, so the dashboard's anon
-- client got zero rows back silently even though the backend was writing fine.

alter publication supabase_realtime add table public.lighter_btc_rsi_paper_trades;

alter table public.lighter_btc_rsi_paper_trades enable row level security;

create policy "anon_read" on public.lighter_btc_rsi_paper_trades for select to anon using (true);
