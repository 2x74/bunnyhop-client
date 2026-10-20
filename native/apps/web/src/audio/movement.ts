// Movement sounds from player state: jump, landing (scaled by fall speed), footsteps (surface-aware), boosters,
// teleports, water enter / exit / swimming, ladders. One tracker per mover: the local player (per sim tick, exact
// core events), replays (per cached tick, live in the viewer and offline for MP4 export), other players and ghosts
// (per rendered frame, events derived from grounded transitions). Numbers in, sink calls out, no allocation.

import { EVENT_JUMPED, EVENT_LANDED, EVENT_TELEPORTED } from "../core";
import { STEP_SFX, SURFACES, type SfxId } from "./catalog";
import { surfaces } from "./surfaces";

export interface SoundSink {
  /** A sound at Source position (x, y, z); non-positional sinks ignore the position. */
  play(id: SfxId, gain: number, rate: number, x: number, y: number, z: number): void;
}

export { EVENT_JUMPED, EVENT_LANDED, EVENT_TELEPORTED };

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** Fall speeds (u/s): a flat bhop lands at ~300; above HARD_FALL is a real drop. */
const HARD_FALL = 560;

export class MoveSounds {
  /** CS:S behaviour (Classic CS:S sounds): jumps and landings play the surface's footstep, like the engine does. */
  classic = false;
  footsteps = true;
  /** Overall level (ghosts are quieter). */
  gain = 1;
  private first = true;
  private pvx = 0;
  private pvy = 0;
  private pvz = 0;
  private wasGrounded = true;
  private stepTimer = 0;
  private swimTimer = 0;
  private boostCool = 0;
  private inWater = false;

  constructor(private sink: SoundSink) {}

  /** Forget history (seeks, restarts): the next update only primes state. */
  reset(): void {
    this.first = true;
    this.stepTimer = 0.15;
    this.swimTimer = 0;
    this.boostCool = 0;
  }

  private surfaceAt(x: number, y: number, z: number): number {
    const m = surfaces();
    const s = m ? m.at(x, y, z) : -1;
    return s < 0 ? 0 : s;
  }

  private step(surface: number, gain: number, x: number, y: number, z: number): void {
    this.sink.play(STEP_SFX[SURFACES[surface]], gain * this.gain, 1, x, y, z);
  }

  /**
   * One update. `dt` seconds since the last one; `events` = core EVENT_* bits since the last one (frame callers
   * pass 0 and set `derive` so landings come from grounded transitions).
   */
  update(dt: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, grounded: boolean, crouched: boolean, ladder: boolean, events: number, derive = false): void {
    const snd = this.sink;
    const g0 = this.gain;
    const hs = Math.sqrt(vx * vx + vy * vy);
    const m = surfaces();
    let depth = NaN;
    if (m?.hasWater) depth = m.waterAbove(x, y, z) - z;
    const inWater = depth > 6;
    if (this.first) {
      this.first = false;
      this.pvx = vx;
      this.pvy = vy;
      this.pvz = vz;
      this.wasGrounded = grounded;
      this.inWater = inWater;
      return;
    }
    let landed = (events & EVENT_LANDED) !== 0;
    let jumped = (events & EVENT_JUMPED) !== 0;
    if (derive) {
      // Frame-rate state: landings are grounded transitions, jumps leaving the ground upwards.
      if (grounded && !this.wasGrounded) landed = true;
      if (!grounded && this.wasGrounded && vz > 120) jumped = true;
    }
    if (events & EVENT_TELEPORTED) {
      snd.play("teleport", 0.8 * g0, 1, x, y, z);
      this.pvx = vx;
      this.pvy = vy;
      this.pvz = vz;
      this.wasGrounded = grounded;
      this.inWater = inWater;
      this.stepTimer = 0.2;
      return;
    }
    this.boostCool -= dt;
    // Water.
    if (inWater && !this.inWater) snd.play("water_enter", clamp(0.35 + Math.max(0, -this.pvz) / 800, 0.35, 1) * g0, 1, x, y, z);
    else if (!inWater && this.inWater && !(depth > 0)) snd.play("water_exit", 0.7 * g0, 1, x, y, z);
    this.inWater = inWater;
    const swimming = inWater && depth > 34;
    // Landing: soft for bhop landings, heavier for real drops. The fall speed is the previous update's (landing
    // zeroes vertical speed).
    if (landed && !swimming) {
      const fall = Math.max(0, -this.pvz);
      const surf = inWater ? 5 : this.surfaceAt(x, y, z);
      if (this.classic) this.step(surf, fall > HARD_FALL ? 1 : clamp(0.35 + fall / 900, 0.35, 0.8), x, y, z);
      else if (fall > HARD_FALL) {
        snd.play("land_hard", clamp(0.55 + (fall - HARD_FALL) / 900, 0.55, 1) * g0, 1, x, y, z);
        this.step(surf, 0.5, x, y, z);
      } else {
        // Chained bhop (land + jump on the same tick) stays light.
        snd.play("land_soft", clamp(0.22 + fall / 700, 0.2, 0.75) * (jumped ? 0.7 : 1) * g0, 1, x, y, z);
        if (!jumped) this.step(surf, 0.25, x, y, z);
      }
      this.stepTimer = 0.28;
    }
    if (jumped && !swimming) {
      if (this.classic) { if (!landed) this.step(this.surfaceAt(x, y, z), 0.3, x, y, z); }
      else snd.play("jump", (landed ? 0.55 : 0.8) * g0, 1, x, y, z);
    }
    // Boosters / push triggers: a velocity change in one update that movement can't produce (air acceleration adds
    // at most ~30 u/s per tick; jumps are excluded).
    const dvz = vz - this.pvz;
    const dh = hs - Math.sqrt(this.pvx * this.pvx + this.pvy * this.pvy);
    if (!jumped && !landed && this.boostCool <= 0 && (dvz > 160 || dh > 180) && !swimming) {
      snd.play("boost", clamp(Math.max(dvz, dh) / 700, 0.45, 1) * g0, 1, x, y, z);
      this.boostCool = 0.4;
    }
    // Footsteps (CS:S: every 0.3 s running, 0.4 s walking / crouched, silent below walking speed).
    if (this.footsteps && grounded && !jumped && !swimming && hs > 80) {
      this.stepTimer -= dt;
      if (this.stepTimer <= 0) {
        const surf = inWater ? 5 : this.surfaceAt(x, y, z);
        const loud = hs >= 150 ? 0.55 : 0.22;
        this.step(surf, loud * (crouched ? 0.55 : 1), x, y, z);
        this.stepTimer = hs >= 200 && !crouched ? 0.3 : 0.4;
      }
    } else if (this.footsteps && ladder && Math.abs(vz) > 40) {
      this.stepTimer -= dt;
      if (this.stepTimer <= 0) {
        snd.play("step_metal", 0.4 * g0, 0.92, x, y, z);
        this.stepTimer = 0.4;
      }
    } else if (grounded && hs <= 80) this.stepTimer = Math.min(this.stepTimer, 0.12);
    // Swimming strokes.
    if (swimming && Math.sqrt(hs * hs + vz * vz) > 60) {
      this.swimTimer -= dt;
      if (this.swimTimer <= 0) {
        snd.play("swim", 0.6 * g0, 1, x, y, z);
        this.swimTimer = 0.85;
      }
    } else this.swimTimer = Math.min(this.swimTimer, 0.2);
    this.pvx = vx;
    this.pvy = vy;
    this.pvz = vz;
    this.wasGrounded = grounded;
  }
}

/** Wind parameters for a speed (u/s). One shared object (no allocation); read it before the next call. */
export const wind = { gain: 0, rate: 1, cutoff: 500, high: 0 };

export function windFor(speed: number, grounded: boolean): typeof wind {
  // Silent at walking / prestrafe speed, rising through typical bhop speeds (300-1200), full by ~1300.
  const b = clamp((speed - 270) / 1000, 0, 1);
  wind.gain = Math.pow(b, 1.25) * (grounded ? 0.55 : 1);
  wind.rate = 0.85 + 0.4 * b;
  wind.cutoff = 450 + 7500 * Math.pow(b, 1.4);
  wind.high = Math.pow(clamp((speed - 750) / 1300, 0, 1), 1.5) * (grounded ? 0.5 : 1);
  return wind;
}
