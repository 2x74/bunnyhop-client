// Voice playout: when each received 20 ms frame plays. DOM-free (apps/web/test/voice.test.ts).
//
// The room socket is TCP, so frames arrive in order and never get lost on the way; what varies is when they arrive.
// Each talker's frames are queued on a playhead kept `target` ms ahead of the arrival of the spurt's first frame and
// advanced 20 ms per frame. `target` adapts between MIN and MAX from the measured arrival jitter (an EWMA of how far
// packets land from their 40 ms rhythm): a calm connection plays ~60 ms behind, a jumpy one up to ~120 ms. A frame
// that would be late (the playhead fell behind the clock: a stall) restarts the playhead `target` ahead and raises the
// target; a playhead that drifted far ahead (a burst after a stall) drops frames until it's back. A missing packet
// (the room dropped one: rate limit) keeps its time as silence, so the rest stays in rhythm.

import { VOICE_FRAME_MS } from "../net/voice-wire";

export const PLAYOUT = {
  minMs: 60,
  maxMs: 120,
  /** Starting target before any jitter is known. */
  startMs: 80,
  /** The playhead may run this far past target before frames are dropped. */
  slackMs: 80,
  /** Frames must be scheduled at least this far in the future (audio clock granularity, decode time). */
  leadMs: 8,
} as const;

export class Playout {
  /** Current target delay (ms). */
  target: number = PLAYOUT.startMs;
  /** Smoothed arrival jitter (ms). */
  jitter = 0;
  /** Audio-clock time (ms) the next frame starts at; null between spurts. */
  private head: number | null = null;
  private lastArrival: number | null = null;
  private lastFrames = 0;
  /** Counters (the proof's report, the dev overlay). */
  readonly stats = { frames: 0, late: 0, dropped: 0, lost: 0, spurts: 0 };

  /**
   * A packet of `frames` frames arrived at audio-clock `now` (ms). `start`: it opens a spurt. `lostBefore`: frames the
   * room dropped just before it (keep their time). Returns each frame's start time (ms), or null for a frame to drop.
   */
  arrive(now: number, frames: number, start = false, lostBefore = 0): (number | null)[] {
    if (start || this.head === null) {
      this.head = now + this.target;
      this.lastArrival = null;
      this.stats.spurts++;
    } else if (this.lastArrival !== null) {
      // How far this packet landed from the rhythm the previous one set.
      const expected = (this.lastFrames + lostBefore) * VOICE_FRAME_MS;
      const d = Math.abs(now - this.lastArrival - expected);
      this.jitter += (d - this.jitter) / 8;
      const want = Math.max(PLAYOUT.minMs, Math.min(PLAYOUT.maxMs, 40 + 2.5 * this.jitter));
      // Rise at once, settle slowly.
      this.target = want > this.target ? want : this.target + (want - this.target) / 32;
    }
    this.lastArrival = now;
    this.lastFrames = frames;
    if (lostBefore > 0) {
      this.head! += lostBefore * VOICE_FRAME_MS;
      this.stats.lost += lostBefore;
    }
    const out: (number | null)[] = [];
    for (let i = 0; i < frames; i++) {
      this.stats.frames++;
      if (this.head! < now + PLAYOUT.leadMs) {
        // Late: the clock passed the playhead (a stall). Start over `target` ahead, with more margin next time.
        this.stats.late++;
        this.target = Math.min(PLAYOUT.maxMs, this.target + VOICE_FRAME_MS);
        this.head = now + this.target;
      } else if (this.head! > now + this.target + PLAYOUT.slackMs) {
        // Far ahead (a burst after a stall): drop this frame to come back towards the target.
        this.stats.dropped++;
        out.push(null);
        continue;
      }
      out.push(this.head!);
      this.head! += VOICE_FRAME_MS;
    }
    return out;
  }

  /** The spurt ended (VF_END or a pause): the next packet starts fresh. */
  end(): void {
    this.head = null;
    this.lastArrival = null;
  }

  /** When the queued audio runs out (audio-clock ms), or null. */
  get until(): number | null {
    return this.head;
  }
}
