import { NextResponse } from "next/server";

import { sanitizeSettings } from "@/lib/nba/reminders";
import { loadStore, saveStore } from "@/lib/nba/reminder-store";

export const dynamic = "force-dynamic";

/** PATCH /api/push/subscription — update settings without re-subscribing. */
export async function PATCH(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const settings = sanitizeSettings((body as { settings?: unknown }).settings);
  if (!settings) {
    return NextResponse.json({ error: "Invalid settings" }, { status: 400 });
  }

  const store = await loadStore();
  if (!store.subscription) {
    return NextResponse.json({ error: "Not subscribed" }, { status: 404 });
  }

  store.settings = settings;
  await saveStore(store);
  return NextResponse.json({ ok: true });
}

/** DELETE /api/push/subscription — forget the browser entirely. */
export async function DELETE() {
  const store = await loadStore();
  store.subscription = null;
  await saveStore(store);
  return NextResponse.json({ ok: true });
}
