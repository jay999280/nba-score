/**
 * The 30 NBA clubs, for the favorites picker.
 *
 * Teams are listed once, as flat data, because the app needs them before any
 * game has been loaded (PRD §16).
 */

import { teamLogo } from "./team-meta";

export interface TeamInfo {
  id: number;
  tricode: string;
  /** 中文城市名 */
  city: string;
  /** 中文队名 */
  name: string;
}

export const TEAM_CATALOG: TeamInfo[] = [
  { id: 1610612737, tricode: "ATL", city: "亚特兰大", name: "老鹰" },
  { id: 1610612738, tricode: "BOS", city: "波士顿", name: "凯尔特人" },
  { id: 1610612751, tricode: "BKN", city: "布鲁克林", name: "篮网" },
  { id: 1610612766, tricode: "CHA", city: "夏洛特", name: "黄蜂" },
  { id: 1610612741, tricode: "CHI", city: "芝加哥", name: "公牛" },
  { id: 1610612739, tricode: "CLE", city: "克利夫兰", name: "骑士" },
  { id: 1610612742, tricode: "DAL", city: "达拉斯", name: "独行侠" },
  { id: 1610612743, tricode: "DEN", city: "丹佛", name: "掘金" },
  { id: 1610612765, tricode: "DET", city: "底特律", name: "活塞" },
  { id: 1610612744, tricode: "GSW", city: "金州", name: "勇士" },
  { id: 1610612745, tricode: "HOU", city: "休斯顿", name: "火箭" },
  { id: 1610612754, tricode: "IND", city: "印第安纳", name: "步行者" },
  { id: 1610612746, tricode: "LAC", city: "洛杉矶", name: "快船" },
  { id: 1610612747, tricode: "LAL", city: "洛杉矶", name: "湖人" },
  { id: 1610612763, tricode: "MEM", city: "孟菲斯", name: "灰熊" },
  { id: 1610612748, tricode: "MIA", city: "迈阿密", name: "热火" },
  { id: 1610612749, tricode: "MIL", city: "密尔沃基", name: "雄鹿" },
  { id: 1610612750, tricode: "MIN", city: "明尼苏达", name: "森林狼" },
  { id: 1610612740, tricode: "NOP", city: "新奥尔良", name: "鹈鹕" },
  { id: 1610612752, tricode: "NYK", city: "纽约", name: "尼克斯" },
  { id: 1610612760, tricode: "OKC", city: "俄克拉荷马城", name: "雷霆" },
  { id: 1610612753, tricode: "ORL", city: "奥兰多", name: "魔术" },
  { id: 1610612755, tricode: "PHI", city: "费城", name: "76人" },
  { id: 1610612756, tricode: "PHX", city: "菲尼克斯", name: "太阳" },
  { id: 1610612757, tricode: "POR", city: "波特兰", name: "开拓者" },
  { id: 1610612758, tricode: "SAC", city: "萨克拉门托", name: "国王" },
  { id: 1610612759, tricode: "SAS", city: "圣安东尼奥", name: "马刺" },
  { id: 1610612761, tricode: "TOR", city: "多伦多", name: "猛龙" },
  { id: 1610612762, tricode: "UTA", city: "犹他", name: "爵士" },
  { id: 1610612764, tricode: "WAS", city: "华盛顿", name: "奇才" },
];

export function teamLogoUrl(teamId: number): string {
  return teamLogo(teamId);
}
