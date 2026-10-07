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
    const game = await getGameDetail(gameId);
    const body: GameDetailResponse = {
      game,
      updatedAt: new Date().toISOString(),
    };
    return NextResponse.json(body, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("[api/games/[gameId]] upstream failure", error);
    return NextResponse.json({ error: "Unable to load game" }, { status: 502 });
  }
}
