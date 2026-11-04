// Freecam (!freecam, !fc, !freelook; an unbound Settings → Keys bind): the camera leaves your body and flies through
// walls, while the body keeps simulating with neutral input and the timer keeps running. Turning it off snaps the camera
// back into your eyes. Design: research notes in /tmp/bh-0036/design-freecam.md (v0.0.36).
//
// Why a run stays ranked: every command fed to the sim while it's on is what a player who lets go of everything
// produces. No keys or buttons, and the view where the sim last left it (only the sim itself sets it: a teleport or a
// rotating platform, exactly as for a hands-off player). The mouse goes to the camera and never into the counted view,
// and held keys are released when it turns on and off. So the replay format, the verifier and the core never change:
//
//   R1 neutral body       freecamSample(): forward 0, side 0, buttons 0, the counted view unchanged
//   R2 no view change     Input.lookSink / wheelSink take the mouse before it reaches the counted yaw or the stats
//   R3 no carried input   Input.releaseAll() on entry and exit
//   R4 nothing set        the freecam never moves, teleports or sets anything in the core
//   R5 not where R1-R3 can't hold: freecamUnavailable()
//
// DOM-free apart from the Input it's handed (tests drive the real Input through tools/input/timeline.ts).

import * as THREE from "three";
import type { Input, UserCmd } from "./input";
import { FreeCam, FREE_SPEED, freeSpeedStep, type FreeIntent } from "./viewer/cameras";

/** Why freecam can't turn on here (one line for the HUD), or null. */
export function freecamUnavailable(o: { tutorial?: boolean; editor?: boolean; viewer?: boolean; experiment?: boolean }): string | null {
  if (o.tutorial) return "Freecam isn't available in the tutorial.";
  if (o.editor) return "Close the zone editor to use freecam.";
  if (o.experiment) return "Freecam is off while the input experiment runs.";
  if (o.viewer) return "The replay viewer has its own free camera.";
  return null;
}

/**
 * R1: the command a player who lets go of everything produces. No movement and no buttons at all (jump, duck, use,
 * attack, turn binds, weapon slot / drop / reload / give bits), the view as sampled. The header flags of the sample
 * (timed, null binds) stay: they describe how input was read, and nothing is read here.
 */
export function neutralCommand(sample: UserCmd): UserCmd {
  const { wRelease: _w, ...rest } = sample;
  return { ...rest, forwardmove: 0, sidemove: 0, buttons: 0 };
}

/**
 * The next tick's command while freecam is on: the real Input's sample with turn binds, null binds and Release W off
 * (nothing may turn or resolve keys), neutralised. Its view is the counted view, which the mouse can't reach while the
 * look sink is set, so it only moves when the sim sets it (teleport, pusher), as for a still mouse.
 */
export function freecamSample(input: Input, o: { tickInterval?: number; at?: number } = {}): UserCmd {
  return neutralCommand(input.sample({ tickInterval: o.tickInterval, at: o.at }));
}

/** The live freecam: owns the flying camera and hooks the Input's mouse while active. */
export class Freecam {
  active = false;
  /** Base speed (u/s): FREE_SPEED, stepped by the wheel. Kept between uses on this page. */
  speed = FREE_SPEED;
  readonly cam = new FreeCam();
  private input: Input | null = null;

  /** Turns on at the current view (camera = what's on screen now). R3: releases every held key first. */
  begin(input: Input, camera: THREE.PerspectiveCamera): void {
    if (this.active) return;
    input.releaseAllUntilKeyup();
    // Source angles of what's on screen (first person or the chase cam: three.js YXZ, yaw - 90° and -pitch).
    const e = new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ");
    this.cam.set([camera.position.x, -camera.position.z, camera.position.y], (e.y * 180) / Math.PI + 90, (-e.x * 180) / Math.PI);
    this.input = input;
    input.lookSink = (dYaw, dPitch) => this.cam.lookDeg(dYaw, dPitch);
    input.wheelSink = (steps) => (this.speed = freeSpeedStep(this.speed, steps));
    this.active = true;
  }

  /** Turns off: the mouse goes back to the view, and every key held while flying is released (R3). */
  end(): void {
    if (!this.active) return;
    this.active = false;
    const input = this.input;
    this.input = null;
    if (!input) return;
    input.lookSink = null;
    input.wheelSink = null;
    input.releaseAllUntilKeyup();
  }

  /** Flies for this frame (the player's movement binds, Shift / Alt) and places the camera. */
  place(camera: THREE.PerspectiveCamera, dt: number, intent: FreeIntent): void {
    this.cam.move(intent, dt, this.speed);
    this.cam.place(camera);
  }
}

/**
 * The free camera's intent from held key codes and the player's binds (forward / back / left / right fly along the
 * view, jump rises, duck sinks; Shift faster and Alt slower unless they're bound to one of those). The replay viewer
 * reads its own held keys with this; the live game and rooms use Input.freeIntent().
 */
export function freeIntentFromCodes(held: ReadonlySet<string>, binds: Partial<Record<string, readonly string[]>>): FreeIntent {
  const on = (a: string) => (binds[a] ?? []).some((c) => held.has(c));
  const movement = new Set<string>();
  for (const a of ["forward", "back", "left", "right", "jump", "duck"]) for (const c of binds[a] ?? []) movement.add(c);
  const mod = (...codes: string[]) => codes.some((c) => held.has(c) && !movement.has(c));
  return {
    f: (on("forward") ? 1 : 0) - (on("back") ? 1 : 0),
    r: (on("right") ? 1 : 0) - (on("left") ? 1 : 0),
    u: (on("jump") ? 1 : 0) - (on("duck") ? 1 : 0),
    fast: mod("ShiftLeft", "ShiftRight"),
    slow: mod("AltLeft", "AltRight"),
  };
}
