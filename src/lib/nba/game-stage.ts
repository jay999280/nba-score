import type { GameStage } from "@/lib/types";

/**
 * NBA game ids carry a stable competition prefix. Labels are still useful for
 * special events and older cached games whose ids may be incomplete.
 */
export function gameStageFor(
  gameId: string,
  label?: string | null,
  subLabel?: string | null,
): GameStage {
  const id = (gameId ?? "").trim();
  const text = `${label ?? ""} ${subLabel ?? ""}`.trim().toLowerCase();

  if (/summer\s*league|夏季联赛/.test(text) || /^15\d/.test(id)) return "summer-league";
  if (/all[ -]?star|全明星/.test(text) || /^003/.test(id)) return "all-star";
  if (/play[ -]?in|附加赛/.test(text) || /^005/.test(id)) return "play-in";
  if (
    (/nba\s*cup|emirates nba cup|nba杯/.test(text) && /\b(?:final|championship)\b|(?<!半)决赛/.test(text)) ||
    (/^006/.test(id) && /cup|杯/.test(text))
  ) return "nba-cup-final";
  if (/pre[ -]?season|季前赛/.test(text) || /^001/.test(id)) return "preseason";
  if (/playoffs?|post[ -]?season|nba finals|总决赛|季后赛/.test(text) || /^004/.test(id)) {
    return "playoffs";
  }
  // NBA Cup group and knockout games are part of the regular-season schedule.
  if (/regular\s*season|常规赛/.test(text) || /^002/.test(id)) return "regular-season";
  return "unknown";
}

/** Every game receives a Chinese competition label, including old cache rows. */
export function gameStageLabel(stage: GameStage, rawLabel?: string | null): string {
  const label = (rawLabel ?? "").trim().toLowerCase();
  switch (stage) {
    case "preseason": return "季前赛";
    case "regular-season": return /nba\s*cup|emirates nba cup|nba杯/.test(label) ? "常规赛 · NBA杯" : "常规赛";
    case "playoffs": return /finals|总决赛/.test(label) ? "季后赛 · 总决赛" : "季后赛";
    case "play-in": return "附加赛";
    case "nba-cup-final": return "NBA杯决赛";
    case "all-star": return "全明星赛";
    case "summer-league": return "夏季联赛";
    default: return "比赛类型待确认";
  }
}
