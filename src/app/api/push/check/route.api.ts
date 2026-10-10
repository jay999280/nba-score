import { NextResponse } from "next/server";

import { checkRemindersOnce, ensureScheduler } from "@/lib/nba/reminder-scheduler";

export const dynamic = "force-dynamic";

/**
 * GET /api/push/check?secret= — external cron entrypoint for serverless
 * deployments, where no process lives long enough to run the in-process
 * timer. Point cron-job.org (or equivalent) at it once a minute.
 * Local dev keeps its own timer and never needs this.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "Cron not configured" }, { status: 404 });
  }
  const { searchParams } = new URL(request.url);
  const provided =
    searchParams.get("secret") ??
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (provided !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  ensureScheduler();
  try {
    const result = await checkRemindersOnce();
    return NextResponse.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[push/check] failed", error);
    return NextResponse.json({ error: "Check failed" }, { status: 500 });
  }
}
