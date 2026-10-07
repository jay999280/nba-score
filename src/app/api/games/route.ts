import { NextResponse } from "next/server";

import { listGames } from "@/lib/nba/games";
import type { GamesResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/games?date=YYYY-MM-DD&from=<iso>&to=<iso>
 *
 * `date` is the browser's own calendar day; `from`/`to` are the UTC bounds of
 * that day. The window is what actually selects games, so a device in any zone
 * sees a game on the day it starts locally (PRD §6, §28).
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get("date");
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  if (!date || !from || !to) {
    return NextResponse.json(
      { error: "Missing required parameters: date, from, to" },
      { status: 400 },
    );
  }

  try {
    const games = await listGames(from, to);
    const body: GamesResponse = {
      date,
      games,
      updatedAt: new Date().toISOString(),
    };
    return NextResponse.json(body, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("[api/games] upstream failure", error);
    return NextResponse.json({ error: "Unable to load games" }, { status: 502 });
  }
}
