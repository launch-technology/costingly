/**
 * Vercel Cron target.  Drop this at `app/api/sync/route.ts` in a Next.js repo.
 *
 * It is deliberately thin: authenticate, call `syncAllItems()`, return the
 * summary. All the real logic stays in `src/` — the same code the local
 * `plaid-sync sync` CLI runs, with no serverless-specific branches in it.
 *
 * This file is NOT part of the local app and is excluded from its tsconfig
 * (it imports `next/server`, which is not a dependency here). It typechecks
 * once it is inside a real Next.js project.
 *
 * Adjust the import below to wherever you put `src/` — e.g. if you copy it to
 * `lib/plaid-sync/`, import from "@/lib/plaid-sync/sync".
 */

import { NextResponse } from "next/server";
import { syncAllItems } from "@/lib/plaid-sync/sync";
import { safeEqual } from "@/lib/plaid-sync/crypto";

/**
 * The sync makes live Plaid calls and must never be prerendered or cached —
 * a cached response would report a stale run.
 */
export const dynamic = "force-dynamic";

/**
 * A first-time backfill across several banks can take minutes. 300s is the
 * ceiling on Vercel's Pro plan; Hobby caps out lower (60s), which is fine for
 * incremental daily runs but may not be enough for the very first sync. If you
 * hit that, run the initial backfill locally and let cron handle the deltas.
 */
export const maxDuration = 300;

/**
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET` on every scheduled
 * invocation, so checking that header is all the auth this route needs — the
 * same env var works locally with `curl -H "Authorization: Bearer ..."`.
 */
function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // Fail closed. An unset secret must not mean "allow everyone".
    console.error("[sync] CRON_SECRET is not set; refusing to run.");
    return false;
  }

  const header = request.headers.get("authorization");
  if (!header) return false;

  // Constant-time compare so the secret cannot be recovered by timing.
  return safeEqual(header, `Bearer ${secret}`);
}

export async function GET(request: Request): Promise<NextResponse> {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const summary = await syncAllItems();

    // Note: do NOT close the pool here. The container is reused across
    // invocations and the warm connections are worth keeping.

    // 500 when any item failed, so a failed sync is visible in Vercel's cron
    // logs and any uptime monitor pointed at this route.
    return NextResponse.json(summary, { status: summary.ok ? 200 : 500 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[sync] run failed:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

/**
 * Vercel Cron issues GET requests. POST is exposed as well so you can trigger a
 * manual run (or point a Plaid `SYNC_UPDATES_AVAILABLE` webhook at it) with the
 * same authentication.
 */
export const POST = GET;
