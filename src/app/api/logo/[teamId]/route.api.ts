import { getTeamLogo, isValidTeamId } from "@/lib/nba/logos";

/**
 * GET /api/logo/[teamId]
 *
 * Serves a team crest from our own origin so the browser never talks to the
 * NBA CDN, and so the asset arrives with a long-lived cache header (PRD §25, §34).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ teamId: string }> },
) {
  const { teamId } = await params;

  if (!isValidTeamId(teamId)) {
    return new Response("Invalid team id", { status: 400 });
  }

  const svg = await getTeamLogo(Number(teamId));

  if (!svg) {
    return new Response("Logo unavailable", { status: 404 });
  }

  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=604800, immutable",
    },
  });
}
