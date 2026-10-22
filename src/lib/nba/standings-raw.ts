/** Raw ESPN standings response; keep this inside the NBA data layer. */
export interface RawEspnStandingStat {
  name: string;
  value?: number;
  displayValue?: string;
}

export interface RawEspnStandingEntry {
  team: { abbreviation: string; displayName?: string };
  stats: RawEspnStandingStat[];
}

export interface RawEspnConferenceStandings {
  abbreviation: "East" | "West";
  standings: {
    season: number;
    seasonType: number;
    entries: RawEspnStandingEntry[];
  };
}

export interface RawEspnStandings {
  season: { year: number; displayName?: string };
  children: RawEspnConferenceStandings[];
}
