-- Run this in Supabase SQL Editor to add chase exit support
ALTER TABLE positions ADD COLUMN IF NOT EXISTS chase_price DECIMAL(18,8);
