import { NextResponse } from "next/server";

import { isValidGameId } from "@/lib/nba/games";
import { getLineups } from "@/lib/nba/lineups";
import type { LineupsResponse, LineupsSection } from "@/lib/types";

export const dynamic = "force-dynamic";

/** `?section=` narrows which half of the payload is computed; omitted means both. */
function sectionFrom(request: Request): LineupsSection | undefined | null {
  const value = new URL(request.url).searchParams.get("section");
  if (value === null || value === "") return undefined;
  if (value === "comparison" || value === "lineups") return value;
  return null;
}

/**
 * GET /api/games/[gameId]/lineups[?section=comparison|lineups]
 *
 * The pre-game season comparison (eager) and the probable lineups (lazy). The
 * two halves are separate computations because the lineups cost a box score, a
 * roster and up to ten player-statistics reads — the client asks for the
 * comparison alone on mount and for the lineups only when the block expands.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ gameId: string }> },
) {
  const { gameId } = await params;

  if (!isValidGameId(gameId)) {
    return NextResponse.json({ error: "Invalid game id" }, { status: 400 });
  }

  const section = sectionFrom(request);
  if (section === null) {
    return NextResponse.json({ error: "Invalid section" }, { status: 400 });
  }

  try {
    const body: LineupsResponse = await getLineups(gameId, section ? { section } : {});
    return NextResponse.json(body, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("[api/games/[gameId]/lineups] upstream failure", error);
    return NextResponse.json({ error: "Unable to load pregame data" }, { status: 502 });
  }
}
