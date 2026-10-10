import { NextResponse } from "next/server";

import { sanitizeSettings, sanitizeSubscription } from "@/lib/nba/reminders";
import { loadStore, saveStore } from "@/lib/nba/reminder-store";
import { ensureScheduler } from "@/lib/nba/reminder-scheduler";

export const dynamic = "force-dynamic";

/** POST /api/push/subscribe — store (or replace) the browser subscription. */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const payload = body as { subscription?: unknown; settings?: unknown };
  const subscription = sanitizeSubscription(payload.subscription);
  const settings = sanitizeSettings(payload.settings);

  if (!subscription || !settings) {
    return NextResponse.json({ error: "Invalid subscription or settings" }, { status: 400 });
  }

  const store = await loadStore();
  store.subscription = subscription;
  store.settings = settings;
  await saveStore(store);
  ensureScheduler();

  return NextResponse.json({ ok: true });
}
