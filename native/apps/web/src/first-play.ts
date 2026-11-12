// A new player's first map visits, summed up and sent once when the page is hidden or left (apps/api src/first-play.ts,
// Analytics Engine: no database writes). Only until this browser has finished a map, and only its first five visits:
// enough to see where players who never finish a run stop (load, first jump, falls, how far they got, how they left).
// Never the player's id. The tick hook only adds to a few counters; the progress check runs every 25 ticks.

import { API_URL } from "./api";
import { touchOnly } from "./platform/touch";
import type { Zone } from "./zones";

const VISITS_KEY = "bunnyhop:first-plays";
const REF_KEY = "bunnyhop:landing-ref";
const MAX_VISITS = 5;
const EVENT_TELEPORTED = 1 << 0;
const EVENT_JUMPED = 1 << 1;
/** Teleports from within this many units of each other count as the same spot. */
const SPOT = 256;

type Vec3 = ArrayLike<number>;

const read = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* storage blocked */
  }
};

/** The site the browser came from on its first visit ("" direct or unknown), kept from then on. */
export function landingRef(referrer = typeof document === "undefined" ? "" : document.referrer, here = typeof location === "undefined" ? "" : location.host): string {
  const kept = read(REF_KEY);
  if (kept !== null) return kept;
  let host = "";
  try {
    host = referrer ? new URL(referrer).host.replace(/^www\./, "") : "";
  } catch {
    /* not a URL */
  }
  if (host === here) host = "";
  write(REF_KEY, host);
  return host;
}

export interface FirstPlayInit {
  map: string;
  tutorial: boolean;
  room: boolean;
  /** Seconds per tick. */
  tick: number;
  /** The tutorial: lessons done in this browser (its progress lives only here). */
  lessons?: () => number;
}

/** One map visit's numbers (the API's doubles, by name). */
export class FirstPlay {
  readonly visit = crypto.randomUUID();
  outcome: "ok" | "missing" | "network" | "build" = "ok";
  loadMs = 0;
  playS = 0;
  starts = 0;
  restarts = 0;
  teleports = 0;
  jumps = 0;
  topSpeed = 0;
  progress = 0;
  finishS = 0;
  firstJumpS = -1;
  private seq = 0;
  private lockedS = 0;
  private lockedAt = -Infinity;
  private running = false;
  private finished = false;
  private spots = new Map<string, number>();
  private n = 0;
  private start: [number, number, number] | null = null;
  private end: [number, number, number] | null = null;
  private span = 0;

  constructor(
    readonly o: FirstPlayInit,
    readonly visitN: number,
  ) {}

  /** The main track's start and end zones, for the progress measure (straight-line, so only a rough one). */
  setZones(zones: readonly Zone[]): void {
    const centre = (z?: Zone) => (z ? ([0, 1, 2].map((i) => (z.mins[i] + z.maxs[i]) / 2) as [number, number, number]) : null);
    this.start = centre(zones.find((z) => z.kind === "start" && !z.track));
    this.end = centre(zones.find((z) => z.kind === "end" && !z.track));
    this.span = this.start && this.end ? Math.hypot(this.end[0] - this.start[0], this.end[1] - this.start[1], this.end[2] - this.start[2]) : 0;
  }

  /** Every simulated tick: the step's events, the player after it, and whether the run clock is going / done. */
  tick(events: number, origin: Vec3, velocity: Vec3, locked: boolean, status: "idle" | "running" | "finished", runTime: () => number, prevOrigin: Vec3): void {
    if (locked) {
      this.lockedAt = performance.now();
      this.playS += this.o.tick;
      this.lockedS += this.o.tick;
    }
    if (events & EVENT_JUMPED) {
      this.jumps++;
      if (this.firstJumpS < 0) this.firstJumpS = this.lockedS;
    }
    if (events & EVENT_TELEPORTED) {
      this.teleports++;
      const key = `${Math.round(prevOrigin[0] / SPOT)},${Math.round(prevOrigin[1] / SPOT)},${Math.round(prevOrigin[2] / SPOT)}`;
      this.spots.set(key, (this.spots.get(key) ?? 0) + 1);
    }
    const speed = Math.hypot(velocity[0], velocity[1]);
    if (speed > this.topSpeed) this.topSpeed = speed;
    if (status === "running" && !this.running) this.starts++;
    this.running = status === "running";
    if (status === "finished" && !this.finished) {
      this.finished = true;
      this.finishS = runTime();
      this.progress = 1;
    }
    if (++this.n % 25 === 0 && this.end && this.span > 0 && !this.finished) {
      const d = Math.hypot(origin[0] - this.end[0], origin[1] - this.end[1], origin[2] - this.end[2]);
      this.progress = Math.max(this.progress, Math.min(1, Math.max(0, 1 - d / this.span)));
    }
  }

  /** R and the like (not the map's own first reset while it loads: loadMs is set at Ready). */
  restarted(): void {
    if (this.loadMs) this.restarts++;
    this.running = false;
  }

  /** The summary as the API reads it. */
  body(leave: "game" | "menu" | "finished" | "error", gl: string): Record<string, unknown> {
    return {
      visit: this.visit, map: this.o.map, outcome: this.outcome, leave, gl, ref: landingRef(), touch: touchOnly(),
      visitN: this.visitN, loadMs: Math.round(this.loadMs), playS: Math.round(this.playS), starts: this.starts, restarts: this.restarts,
      teleports: this.teleports, jumps: this.jumps, topSpeed: Math.round(this.topSpeed), progress: Math.round(this.progress * 100) / 100,
      finished: this.finished ? 1 : 0, finishS: Math.round(this.finishS * 1000) / 1000, firstJumpS: Math.round(this.firstJumpS * 10) / 10,
      sameSpot: Math.max(0, ...this.spots.values()), seq: ++this.seq, tutorial: this.o.tutorial ? 1 : 0, room: this.o.room ? 1 : 0,
      lessons: this.o.lessons?.() ?? 0,
    };
  }

  /**
   * Sends the summary so far (sendBeacon: it survives the page closing). Left from the game if it was playing a moment
   * ago (hiding the tab releases the mouse before this runs), else from a menu.
   */
  send(): void {
    if (!API_URL) return;
    const leave = this.outcome !== "ok" ? "error" : this.finished ? "finished" : performance.now() - this.lockedAt < 1500 ? "game" : "menu";
    const gl = read("bunnyhop:gfx-detect") === "software" ? "software" : read("bunnyhop:gfx-detect") === "gpu" ? "gpu" : "";
    try {
      navigator.sendBeacon(`${API_URL}/first-play`, JSON.stringify(this.body(leave, gl)));
    } catch {
      /* best effort */
    }
  }
}

/**
 * A FirstPlay for this map visit if this browser is still new (`finishedAMap`: ui/stats.ts hasFinishedAMap) and has
 * made fewer than five; null otherwise. Sends itself when the page is hidden or left.
 */
export function startFirstPlay(o: FirstPlayInit, finishedAMap: boolean): FirstPlay | null {
  if (finishedAMap || !API_URL) return null;
  const done = Number(read(VISITS_KEY)) || 0;
  if (done >= MAX_VISITS) return null;
  write(VISITS_KEY, String(done + 1));
  landingRef();
  const fp = new FirstPlay(o, done + 1);
  let sentHidden = false;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && !sentHidden) {
      sentHidden = true;
      fp.send();
    } else if (document.visibilityState === "visible") sentHidden = false;
  });
  addEventListener("pagehide", () => !sentHidden && fp.send());
  return fp;
}
