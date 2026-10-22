import { NextResponse } from "next/server";
import { getStandings } from "@/lib/nba/standings";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getStandings(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[api/standings] upstream failure", error);
    return NextResponse.json({ error: "Unable to load regular-season standings" }, { status: 502 });
  }
}
