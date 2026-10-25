// Back up whole Supabase tables to local gzip JSONL before they are cleared (2026-10-25,
// free-plan storage over 500 MB). Read-only. Keyset pagination on id (stable, no OFFSET slowdown).
// Usage: node scripts/archive_tables.cjs <outdir> table1 table2 ...
require("dotenv").config({ path: ".env.local" });
const fs = require("fs"), zlib = require("zlib"), path = require("path");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: key, Authorization: `Bearer ${key}` };
const [outdir, ...tables] = process.argv.slice(2);
(async () => {
  for (const t of tables) {
    const gz = zlib.createGzip(); const file = path.join(outdir, `${t}.jsonl.gz`);
    const ws = fs.createWriteStream(file); gz.pipe(ws);
    let last = null, n = 0;
    for (;;) {
      const filt = last == null ? "" : `&id=gt.${encodeURIComponent(last)}`;
      let j;
      for (let a = 0; a < 6; a++) {
        try { const r = await fetch(`${url}/rest/v1/${t}?select=*&order=id.asc&limit=1000${filt}`, { headers: H }); j = await r.json(); if (Array.isArray(j)) break; } catch (e) {}
        await new Promise(r => setTimeout(r, 2000 * (a + 1)));
      }
      if (!Array.isArray(j)) throw new Error(`${t}: ${JSON.stringify(j).slice(0, 200)}`);
      for (const row of j) gz.write(JSON.stringify(row) + "\n");
      n += j.length; if (j.length < 1000) break; last = j[j.length - 1].id;
    }
    gz.end(); await new Promise(r => ws.on("finish", r));
    const c = await fetch(`${url}/rest/v1/${t}?select=id&limit=1`, { headers: { ...H, Prefer: "count=exact" } });
    const total = Number((c.headers.get("content-range") || "/0").split("/")[1]);
    console.log(`${t}: saved ${n} rows (table has ${total}) -> ${(fs.statSync(file).size / 1e6).toFixed(1)} MB${n >= total ? "" : "  <-- MISMATCH"}`);
  }
})().catch(e => { console.error("FAILED", e.message); process.exit(1); });
