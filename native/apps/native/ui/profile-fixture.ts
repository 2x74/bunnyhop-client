import { DEFAULT_COSMETICS } from "../../web/src/progression";
import type { Profile, RunCard } from "../../web/src/api";
export const profileRunFixture: RunCard = {
  runId: "run-fixture",
  map: "bhop_fixture",
  tier: 3,
  style: "autohop",
  track: 0,
  ticks: 1234,
  time: 12.34,
  jumps: 18,
  strafes: 44,
  sync: 92,
  date: "2026-10-26T00:00:00Z",
  rank: 2,
  players: 30,
  points: 125,
  pb: true,
  views: 7,
};
export const fullProfileFixture: Profile = {
  mine: true,
  player: {
    id: "profile-fixture",
    name: "Profile Hopper",
    avatarUrl: null,
    provider: "discord",
    since: "2025-01-01T00:00:00Z",
    country: "US",
  },
  level: { level: 12, xp: 1800, into: 50, need: 100, fraction: 0.5 },
  rank: {
    scope: "all",
    points: 125,
    rank: 24,
    ranked: 300,
    records: 1,
    wrs: 0,
    top10s: 1,
    group: { id: "hopper", name: "Hopper", color: "#ff9900" },
  },
  styles: [],
  stats: {
    clearsByTier: [1, 2, 3, 0, 0, 0],
    rankedByTier: [10, 20, 30, 40, 50, 60],
    maps: 6,
    pbs: 6,
    wrs: 0,
    top10s: 1,
    bonuses: 2,
    runs: 11,
    jumps: 123,
    seconds: 1234,
    playtime: 3600,
    replayViews: 7,
    styleMaps: { autohop: 6 },
    clearedMaps: ["bhop_fixture"],
  },
  social: { followers: 4, following: 3, friends: 2 } as Profile["social"],
  cosmetics: { ...DEFAULT_COSMETICS },
  badges: [],
  achievements: [],
  progress: {},
  notices: [],
  featured: [profileRunFixture],
  featuredAuto: true,
  recentPBs: [profileRunFixture],
  suggestions: [],
};
export function nativeProfileFixture(id: string, name: string, mine: boolean): Profile {
  const p = structuredClone(fullProfileFixture);
  p.player.id = id;
  p.player.name = name;
  p.mine = mine;
  return p;
}
