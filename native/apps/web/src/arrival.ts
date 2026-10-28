// Arriving in a map (main.ts): as the loading screen lifts off (menu.ts liftLoading), the camera starts a little
// behind and above the spawn view and swoops down into first person, the lens settling from a touch wider.
//
// Camera only, before the run: it runs in frames main.ts renders anyway, after main.ts has placed the first-person
// camera, and only moves the camera. The simulation, input, timers and replays never see it; it ends at once when the
// mouse is taken (play starts), in third person, and it isn't started for replays, rooms (spectating, races), reduced
// motion or potato mode (main.ts decides).

import type * as THREE from "three";
import { traceRay, type Core } from "./core";
import { uiSound } from "./audio";

const MS = 900;
/** Start offset, Source units: behind along the view's heading, up, and turned a little off-axis. */
const BACK = 150;
const UP = 60;
const SWING = 0.3;
/** Extra lens at the start, degrees (vertical). */
const FOV = 9;
/** The point the camera keeps looking at, ahead along the first-person view. */
const AHEAD = 260;

export class Arrival {
  /** Clock start (go()); until then the camera holds the start of the swoop. */
  private t0 = -1;
  private back = 0;
  private up = 0;
  private landed = false;
  active = false;

  /**
   * Arms the swoop from the eye at `eye` (Source units) looking along `yaw` (degrees). Traces keep the start inside
   * the map (a spawn room's ceiling or back wall shortens it). It holds its start until go().
   */
  start(core: Core, eye: [number, number, number], yaw: number): void {
    const r = 10;
    const fu = traceRay(core, eye, [eye[0], eye[1], eye[2] + UP], r);
    const up = Math.max(0, UP * fu - r * 1.5);
    const y = (yaw * Math.PI) / 180 + SWING;
    const top: [number, number, number] = [eye[0], eye[1], eye[2] + up];
    const fb = traceRay(core, top, [top[0] - Math.cos(y) * BACK, top[1] - Math.sin(y) * BACK, top[2]], r);
    const back = Math.max(0, BACK * fb - r * 2);
    // Boxed in (a tiny spawn room): no swoop worth the name.
    if (back < 40 && up < 24) return;
    this.back = back;
    this.up = up;
    this.t0 = -1;
    this.landed = false;
    this.active = true;
  }

  /** Starts the clock (main.ts, as the loading screen lifts off). */
  go(now: number): void {
    if (this.active && this.t0 < 0) this.t0 = now;
  }

  /** Ends it now (the camera is wherever main.ts put it this frame). */
  stop(): void {
    this.active = false;
  }

  /**
   * After main.ts has placed the first-person camera for this frame (Source eye position = camera position in three).
   * `yaw` / `pitch` are the view's degrees (input.yaw / input.pitch).
   */
  apply(camera: THREE.PerspectiveCamera, now: number, yaw: number, pitch: number): void {
    if (!this.active) return;
    const u = this.t0 < 0 ? 0 : Math.min(1, Math.max(0, now - this.t0) / MS);
    // Eased in and out: it gets going under the lifting plate and settles softly into first person.
    const k = 1 - (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);
    if (!this.landed && u > 0.8) {
      this.landed = true;
      uiSound("ui_land", 0.5, 0.9);
    }
    if (u >= 1) {
      this.active = false;
      return;
    }
    const y = (yaw * Math.PI) / 180;
    const p = (pitch * Math.PI) / 180;
    const ys = y + SWING;
    const eye = camera.position;
    // The look-at point first (from the real eye), so the view at k = 0 is exactly first person.
    const lx = eye.x + Math.cos(y) * Math.cos(p) * AHEAD;
    const ly = eye.y - Math.sin(p) * AHEAD;
    const lz = eye.z - Math.sin(y) * Math.cos(p) * AHEAD;
    // Source (x, y, z) -> three (x, z, -y): behind = -(cos ys, sin ys) in Source.
    eye.x -= Math.cos(ys) * this.back * k;
    eye.y += this.up * k;
    eye.z += Math.sin(ys) * this.back * k;
    camera.lookAt(lx, ly, lz);
    camera.fov += FOV * k;
    camera.updateProjectionMatrix();
  }
}
