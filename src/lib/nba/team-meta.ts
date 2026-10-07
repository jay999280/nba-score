/**
 * Presentation metadata for the 30 NBA teams.
 *
 * The CDN exposes no usable team palette or translation, so the accent colors
 * and the Chinese names live here as flat data. Accents are tuned to stay
 * legible on both the white and the dark surface and are only ever used as
 * accents (PRD §19).
 */

interface TeamMeta {
  accent: string;
  /** "洛杉矶" */
  cityZh: string;
  /** "湖人" */
  nameZh: string;
}

const TEAMS: Record<string, TeamMeta> = {
  ATL: { accent: "#E03A3E", cityZh: "亚特兰大", nameZh: "老鹰" },
  BOS: { accent: "#00954C", cityZh: "波士顿", nameZh: "凯尔特人" },
  BKN: { accent: "#8A8F98", cityZh: "布鲁克林", nameZh: "篮网" },
  CHA: { accent: "#6B5BD2", cityZh: "夏洛特", nameZh: "黄蜂" },
  CHI: { accent: "#CE1141", cityZh: "芝加哥", nameZh: "公牛" },
  CLE: { accent: "#B02A4E", cityZh: "克利夫兰", nameZh: "骑士" },
  DAL: { accent: "#1B76C4", cityZh: "达拉斯", nameZh: "独行侠" },
  DEN: { accent: "#C99A1E", cityZh: "丹佛", nameZh: "掘金" },
  DET: { accent: "#D62839", cityZh: "底特律", nameZh: "活塞" },
  GSW: { accent: "#2E63C8", cityZh: "金州", nameZh: "勇士" },
  HOU: { accent: "#CE1141", cityZh: "休斯顿", nameZh: "火箭" },
  IND: { accent: "#D9A21B", cityZh: "印第安纳", nameZh: "步行者" },
  LAC: { accent: "#D8232A", cityZh: "洛杉矶", nameZh: "快船" },
  LAL: { accent: "#7C4DDB", cityZh: "洛杉矶", nameZh: "湖人" },
  MEM: { accent: "#6C86BF", cityZh: "孟菲斯", nameZh: "灰熊" },
  MIA: { accent: "#C41E4B", cityZh: "迈阿密", nameZh: "热火" },
  MIL: { accent: "#0F8A46", cityZh: "密尔沃基", nameZh: "雄鹿" },
  MIN: { accent: "#5FA22F", cityZh: "明尼苏达", nameZh: "森林狼" },
  NOP: { accent: "#B08A42", cityZh: "新奥尔良", nameZh: "鹈鹕" },
  NYK: { accent: "#1A7FD4", cityZh: "纽约", nameZh: "尼克斯" },
  OKC: { accent: "#0091DB", cityZh: "俄克拉荷马城", nameZh: "雷霆" },
  ORL: { accent: "#0A87D4", cityZh: "奥兰多", nameZh: "魔术" },
  PHI: { accent: "#1273CE", cityZh: "费城", nameZh: "76人" },
  PHX: { accent: "#E56020", cityZh: "菲尼克斯", nameZh: "太阳" },
  POR: { accent: "#E03A3E", cityZh: "波特兰", nameZh: "开拓者" },
  SAC: { accent: "#8250C8", cityZh: "萨克拉门托", nameZh: "国王" },
  SAS: { accent: "#9AA0A6", cityZh: "圣安东尼奥", nameZh: "马刺" },
  TOR: { accent: "#CE1141", cityZh: "多伦多", nameZh: "猛龙" },
  UTA: { accent: "#D98F12", cityZh: "犹他", nameZh: "爵士" },
  WAS: { accent: "#E31837", cityZh: "华盛顿", nameZh: "奇才" },
};

const NEUTRAL = "#8A8A8E";

export function teamAccent(tricode: string): string {
  return TEAMS[tricode]?.accent ?? NEUTRAL;
}

/** Chinese nickname, falling back to whatever the feed called the team. */
export function teamNameZh(tricode: string, fallback: string): string {
  return TEAMS[tricode]?.nameZh ?? fallback;
}

/** Chinese city, falling back to whatever the feed called the team. */
export function teamCityZh(tricode: string, fallback: string): string {
  return TEAMS[tricode]?.cityZh ?? fallback;
}

export function teamLogo(teamId: number): string {
  // Served from our own origin, never straight from the NBA CDN (PRD §25).
  return `/api/logo/${teamId}`;
}
