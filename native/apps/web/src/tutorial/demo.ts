// "Show me": a lesson's demo replay (recorded by tools/tutorial/demos.ts) played as a ghost from the lesson start, in
// real time: once when you first enter a lesson, or looping when you ask for it (X). Re-simulated once on a separate
// physics-only core (like race ghosts), so it never touches the live run.

import type * as THREE from "three";
import { Core } from "../core";
import { Ghost } from "../ghost";
import { decodeReplay } from "../replay";
import { FRAME_STRIDE, simulate } from "../sim";
import { base64Bytes } from "./data";

const PAUSE_TICKS = 120;

export class DemoGhost {
  private t = 0;
  private constructor(
    readonly ghost: Ghost,
    private frames: number,
    private scene: THREE.Scene,
    readonly loop: boolean,
  ) {
    scene.add(ghost.root);
  }

  static async create(o: { wasmBytes: Uint8Array; bsp: Uint8Array; scene: THREE.Scene; demo: string; aux?: Core; loop?: boolean }): Promise<DemoGhost> {
    const replay = await decodeReplay(base64Bytes(o.demo));
    const core = o.aux ?? (await Core.create(o.wasmBytes as Uint8Array<ArrayBuffer>));
    if (!o.aux) core.loadMapPhysics(o.bsp);
    // A demo is shown even if a newer build simulates it slightly differently (checkpoints aren't required to match).
    const sim = simulate(core, replay, replay.header.zones, { frames: true });
    const frames = sim.frames!;
    const n = frames.length / FRAME_STRIDE;
    const ghost = new Ghost({
      kind: "custom",
      track: 0,
      style: "*",
      name: "Demo",
      frames,
      startTick: 0,
      endTick: n - 1,
      tickInterval: Math.fround(replay.header.settings.tickInterval),
      side: replay.side,
      forward: replay.forward,
    });
    return new DemoGhost(ghost, n, o.scene, o.loop ?? true);
  }

  get tick(): number {
    return Math.min(Math.floor(this.t), this.frames - 1);
  }

  restart(): void {
    this.t = 0;
  }

  /** A one-shot demo has played to the end. */
  get ended(): boolean {
    return !this.loop && this.t > this.frames - 1 + PAUSE_TICKS / 2;
  }

  frame(dt: number, camera: THREE.Vector3): void {
    this.t += dt * 100;
    if (this.loop && this.t > this.frames - 1 + PAUSE_TICKS) this.t = 0;
    const t = Math.min(this.t, this.frames - 1);
    this.ghost.showAt(t, t < this.frames - 1, dt, camera, { opacity: 0.7, trail: true, nearFade: true, tag: true });
  }

  dispose(): void {
    this.scene.remove(this.ghost.root);
    this.ghost.dispose();
  }
}
