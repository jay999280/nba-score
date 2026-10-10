import { NextResponse } from "next/server";

import { loadStore, storeBackend } from "@/lib/nba/reminder-store";
import { schedulerRunning } from "@/lib/nba/reminder-scheduler";

export const dynamic = "force-dynamic";

/**
 * GET /api/push/status — what the settings UI needs and nothing more.
 * The private key and the endpoint URL never leave the server.
 */
export async function GET() {
  const store = await loadStore();
  return NextResponse.json(
    {
      configured: Boolean(
        process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY,
      ),
      vapidPublicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? null,
      subscribed: store.subscription !== null,
      settings: store.subscription ? store.settings : null,
      scheduler: schedulerRunning(),
      store: storeBackend(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
