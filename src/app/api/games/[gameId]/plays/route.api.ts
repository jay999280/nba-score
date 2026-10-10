import { NextResponse } from "next/server";

import { getGamePlays, isValidGameId } from "@/lib/nba/games";
import type { PlaysResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

/** GET /api/games/[gameId]/plays — structured events + score flow, lazy-loaded by the Plays tab. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ gameId: string }> },
) {
  const { gameId } = await params;

  if (!isValidGameId(gameId)) {
    return NextResponse.json({ error: "Invalid game id" }, { status: 400 });
  }

  try {
    const plays = await getGamePlays(gameId);
    const body: PlaysResponse = { ...plays, updatedAt: new Date().toISOString() };
    return NextResponse.json(body, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("[api/games/[gameId]/plays] upstream failure", error);
    return NextResponse.json({ error: "Unable to load plays" }, { status: 502 });
  }
}
