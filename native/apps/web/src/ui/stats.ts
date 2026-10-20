// Local player stats for the home screen (localStorage; nothing here is uploaded).
// Maps played are recorded when a map loads; jumps are counted by main.ts from sim events
// (live play only, not replays). PBs come from pb.ts. The tutorial (bhop_lol_tutorial) isn't a map played and its
// final-course time isn't counted as a personal best here: it has its own line on the home menu.

import { TUTORIAL_MAP } from "../tutorial/data";

const KEY = "bunnyhop:stats";
const PB_PREFIX = "bunnyhop:pb:";

interface Stored {
  maps: string[];
  jumps: number;
}

function read(): Stored {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return seed();
    const v = JSON.parse(raw) as Partial<Stored> | null;
    return { maps: Array.isArray(v?.maps) ? v.maps.filter((x) => typeof x === "string") : [], jumps: Number(v?.jumps) || 0 };
  } catch {
    return { maps: [], jumps: 0 };
  }
}

/** First run with stats: start from what the stored PBs already prove (their maps and jumps). */
function seed(): Stored {
  const s: Stored = { maps: [], jumps: 0 };
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k?.startsWith(PB_PREFIX)) continue;
    try {
      const pb = JSON.parse(localStorage.getItem(k)!) as { map?: string; jumps?: number };
      if (pb.map && !s.maps.includes(pb.map)) s.maps.push(pb.map);
      s.jumps += Number(pb.jumps) || 0;
    } catch {
      /* ignore */
    }
  }
  return s;
}

function write(s: Stored): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* quota / private mode */
  }
}

export function recordMapPlayed(map: string): void {
  const s = read();
  if (!s.maps.includes(map)) {
    s.maps.push(map);
    write(s);
  }
}

let pendingJumps = 0;
let flushTimer = 0;
function flush(): void {
  if (!pendingJumps) return;
  const s = read();
  s.jumps += pendingJumps;
  pendingJumps = 0;
  write(s);
}
addEventListener("pagehide", flush);

/** Cheap to call every tick; batched into localStorage every few seconds. */
export function countJump(): void {
  pendingJumps++;
  if (!flushTimer) flushTimer = window.setTimeout(() => ((flushTimer = 0), flush()), 4000);
}

export interface PlayerStats {
  mapsPlayed: number;
  pbs: number;
  jumps: number;
}

/** Maps played in this browser (loaded, or with a saved PB in any style or track); not the tutorial. */
export function playedMaps(): Set<string> {
  const maps = new Set(read().maps);
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith(PB_PREFIX)) maps.add(k.slice(PB_PREFIX.length).split(":")[0]);
  }
  maps.delete(TUTORIAL_MAP);
  return maps;
}

/** A finish on a real map in this browser (a saved PB on any map but the tutorial, in any style or track). */
export function hasFinishedAMap(): boolean {
  return playerStats().pbs > 0;
}

export function playerStats(): PlayerStats {
  const s = read();
  const maps = new Set(s.maps);
  let pbs = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k?.startsWith(PB_PREFIX)) continue;
    const map = k.slice(PB_PREFIX.length).split(":")[0];
    if (map === TUTORIAL_MAP) continue;
    pbs++;
    maps.add(map);
  }
  maps.delete(TUTORIAL_MAP);
  return { mapsPlayed: maps.size, pbs, jumps: s.jumps + pendingJumps };
}
