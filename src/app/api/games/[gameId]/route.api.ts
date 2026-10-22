import { NextResponse } from "next/server";

import { getGameDetail, isValidGameId } from "@/lib/nba/games";
import type { GameDetailResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

/** GET /api/games/[gameId] */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ gameId: string }> },
) {
  const { gameId } = await params;

  if (!isValidGameId(gameId)) {
    return NextResponse.json({ error: "Invalid game id" }, { status: 400 });
  }

  try {
    const body: GameDetailResponse = await getGameDetail(gameId);
    return NextResponse.json(body, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("[api/games/[gameId]] upstream failure", error);
    return NextResponse.json({ error: "Unable to load game" }, { status: 502 });
  }
}
