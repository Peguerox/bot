import { NextRequest, NextResponse } from "next/server";

// Real-money controls (toggle/settings/flatten) got a release-blocking audit finding (2026-10-18):
// no application auth at all, same posture as every other bot's routes in this codebase but now
// carrying real-money risk (anyone who finds the URL could enable trading or trigger Flatten).
// A shared secret, never shipped in the client bundle -- the dashboard panel prompts the user for
// it once and stores it in localStorage, sending it as a header on every live-bot control call.
// Not a full auth system (no sessions, no per-user identity) -- a deliberately small fix scoped to
// this bot's specific risk, not a rewrite of every route's access model.
export function checkLitGridLiveAuth(req: NextRequest): NextResponse | null {
  const expected = process.env.LIT_GRID_LIVE_ADMIN_SECRET;
  if (!expected) {
    // Misconfiguration -- fail closed rather than silently allow unauthenticated control.
    return NextResponse.json({ error: "Server missing LIT_GRID_LIVE_ADMIN_SECRET." }, { status: 500 });
  }
  const provided = req.headers.get("x-admin-secret");
  if (provided !== expected) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  return null;
}
