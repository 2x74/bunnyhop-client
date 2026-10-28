// Run sessions: signed heartbeats while the timer runs (anticheat v2, research/ANTICHEAT.md; Momentum Mod style, and
// stateless on the server: apps/api/src/run-clock.ts).
//
// When the timer starts, and then every BEAT_MS of wall time while it runs, the game posts what it has recorded so far:
// ticks since the timer's start and the rolling hash of those commands (run-hash.ts), plus whether the game was paused
// since the last beat. The run's time is its tick count, and ticks only run while the frame loop runs with the pointer
// locked (main.ts frame), so "paused" is any of: the pointer unlocked, the tab hidden or the window blurred, the replay
// viewer open over the run (main.ts skips the live sim: hold), or no live frame at all since the last beat. A beat whose
// request fails passes its pause on to the next one. The server answers each with an HMAC-signed token of
// {session, player, tick, hash, server time, paused}; nothing is stored. The tokens go with the run's submission
// (api.submitRun: a multipart `beats` field next to the replay), in send order: a slow request can answer after the
// next one (0.0.10 kept arrival order, which the server read as tokens going back). Verification then checks that the
// replay contains exactly the hashed commands at every token (a savestate's abandoned branch doesn't) and that the
// ticks advanced at ~100 per second of real time while the game ran (a slowed-down game doesn't). A beat that fails
// (offline, blocked) is just missing: the server notes gaps, never rejects for them.
//
// Never touches the timer, the sim or the replay bytes. A restart or reset drops the session; the next start opens one.
// Each beat also carries the attempt counter for the board (attempts.ts: the n-th start, resets, practice exits, time on
// the board), so it is signed with the run: context for staff only.

import { api } from "./api";
import type { AttemptClaim } from "./attempts";
import { cursorFree } from "./free-cursor";
import { hashHex, RUN_HASH_SEED } from "./run-hash";

/**
 * Wall time between beats: 4 s since 0.0.21 (2 s before; half the Worker requests). The server scales its gap check to
 * the interval a run's beats actually show (apps/api/src/run-clock.ts analyzeClock), so both cadences are judged alike.
 */
export const BEAT_MS = 4000;
/**
 * Tokens kept per run: a beat every BEAT_MS through the longest run the server accepts (4 h; apps/api/src/run-clock.ts
 * MAX_BEATS). A longer run stops beating; the server notes the gap.
 */
const MAX_BEATS = 7500;

export interface RunClockSource {
  map: string;
  track: number;
  style: string;
  /** The timer's start tick (first timed command). */
  startTick: number;
  /** Commands recorded so far (the replay recorder's length). */
  length: () => number;
  /** Folds recorded commands [from, to) into a hash (ReplayRecorder.fold). */
  fold: (h: number, from: number, to: number) => number;
  /** This attempt on the board (attempts.ts), sent with every beat. */
  attempt?: AttemptClaim;
}

export class RunClock {
  private src: RunClockSource | null = null;
  private sid: string | null = null;
  /** Tokens by send order: one slot per beat sent (a failed or unanswered beat leaves a hole). */
  private tokens: (string | undefined)[] = [];
  private sent = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private h = RUN_HASH_SEED;
  private upto = 0;
  /** The game was paused since the last beat (see the header). */
  private paused = false;
  /** Live frames since the last beat (none: the frame loop didn't run the live game, so neither did the sim). */
  private frames = 0;
  private gen = 0;

  constructor() {
    if (typeof document === "undefined") return;
    // Pauses the frame loop can't see: it stops in a hidden tab, and these fire before the next frame does.
    const hold = () => this.hold();
    document.addEventListener("visibilitychange", hold);
    document.addEventListener("pointerlockchange", () => {
      // Not the chat's free cursor (free-cursor.ts): the game keeps playing under it.
      if (!document.pointerLockElement && !cursorFree()) this.hold();
    });
    addEventListener("blur", hold);
  }

  /** The timer started: a new session (any previous one is dropped). */
  start(src: RunClockSource): void {
    this.stop();
    if (!api.available()) return;
    this.src = src;
    this.h = RUN_HASH_SEED;
    this.upto = src.startTick;
    this.paused = false;
    this.frames = 1; // the frame that started the timer
    void this.beat(this.gen);
    this.timer = setInterval(() => void this.beat(this.gen), BEAT_MS);
  }

  /** Every rendered frame of the live game: notes an unlocked pointer (the sim is paused) for the next beat. */
  frame(locked: boolean): void {
    if (!this.src) return;
    this.frames++;
    if (!locked) this.paused = true;
  }

  /** The live sim isn't running (the replay viewer over the run, a hidden tab, a lost pointer lock): the next beat is paused. */
  hold(): void {
    if (this.src) this.paused = true;
  }

  /** Restart / reset: the session is dropped. */
  stop(): void {
    if (!this.src && !this.timer && !this.sent) return; // idle (called every tick of a practice attempt)
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.src = null;
    this.sid = null;
    this.tokens = [];
    this.sent = 0;
    this.gen++;
  }

  /** The run finished: the tokens collected so far, in send order (beats still in flight are left out); the session ends. */
  finish(): string[] {
    const t = this.tokens.filter((x): x is string => x !== undefined);
    this.stop();
    return t;
  }

  private async beat(gen: number): Promise<void> {
    const s = this.src;
    if (!s || this.sent >= MAX_BEATS) return;
    const len = s.length();
    this.h = s.fold(this.h, this.upto, len);
    this.upto = Math.max(this.upto, len);
    const paused = this.paused || this.frames === 0 || (typeof document !== "undefined" && document.hidden);
    const body = { sid: this.sid, map: s.map, track: s.track, style: s.style, tick: Math.max(0, len - s.startTick), hash: hashHex(this.h), paused, ...(s.attempt ? { att: s.attempt } : {}) };
    this.paused = false;
    this.frames = 0;
    const seq = this.sent++;
    try {
      const r = await api.runBeat(body);
      if (gen !== this.gen) return; // restarted meanwhile
      this.sid ??= r.sid;
      if (r.sid === this.sid) this.tokens[seq] = r.token;
    } catch {
      // Offline / refused: a gap the server notes. The server measures from the last token it has, so the pause carries
      // over to the next beat.
      if (gen === this.gen && paused) this.paused = true;
    }
  }
}
