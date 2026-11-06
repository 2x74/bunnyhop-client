// Landing spot: while you're in the air, where you'd land if you made no further input (Settings → HUD → Advanced →
// Landing spot, !landing). Off by default. A routing aid like StrafesNET's: the ballistic path from where you are, swept
// with your hull through the map by the core (crates/core/src/game/landing.rs Game::predict_landing), a read-only
// query that never steps or changes the simulation. Like the trigger overlays it is drawn for you only and never part
// of a run: input, replays and what the verifier sees are the same with it on.
//
//   main.ts     initLanding(world.root); landingFrame(...) every frame with the interpolated state of your player
//   viewer      the same frame call with the replay's core and its interpolated sample (viewer.ts onPlayerFrame)
//   prefs       Prefs.landing (landing/prefs.ts): Off / Practice / Always, the arc, the colour
//
// The look is marker.ts.

import type * as THREE from "three";
import { registerChatCommand } from "../chat-commands";
import { LANDING_GROUND, LANDING_TELEPORT, predictLanding, type Core, type LandingPrediction } from "../core";
import { palette } from "../palette";
import { prefs } from "../ui/settings";
import { ARC_DOTS, ARC_SKIP, ARC_SPACING, arcPoints, LandingMarker, minSizeScale } from "./marker";
import { landingEnabled } from "./prefs";

/** How far ahead the path is searched, seconds (a long drop; past it nothing shows). */
export const LANDING_HORIZON_S = 4;
/** A landing tick between hops doesn't blink the spot out: it holds this long on the ground first, ms. */
const GROUND_HOLD_MS = 80;

export interface LandingInput {
  /** The simulation on screen (the live run's, or the replay viewer's). */
  core: Core;
  /** Interpolated feet origin and velocity (Source units), and the hull. */
  position: ArrayLike<number>;
  velocity: ArrayLike<number>;
  crouched: boolean;
  grounded: boolean;
  /** Nothing to predict or show: Hide UI, noclip / flight, a ladder, spectating someone. */
  suppressed: boolean;
  /** This attempt is practice (the Practice mode shows it then). */
  practicing: boolean;
  /** The replay viewer. */
  replay?: boolean;
  camera: THREE.PerspectiveCamera;
  /** CSS px tall of the view the camera draws. */
  viewHeight: number;
  now: number;
}

let parent: THREE.Object3D | null = null;
let marker: LandingMarker | null = null;
let airAt = -Infinity;
const arc = new Float32Array(ARC_DOTS * 3);
let result: LandingPrediction | undefined;

/** Per-frame cost (the query and the drawing update), for the dev hook and the perf check. */
export const landingStats = { frames: 0, totalMs: 0, maxMs: 0, lastMs: 0, lastTraces: 0, lastPieces: 0, lastKind: 0 };

/** main.ts, once the world is built: the world's container. The marker is built the first time it shows. */
export function initLanding(root: THREE.Object3D): void {
  parent = root;
  if (import.meta.env?.DEV) Object.assign(window, { __landing: { stats: landingStats, marker: () => marker } });
}

function built(): LandingMarker | null {
  if (!marker && parent) {
    marker = new LandingMarker();
    parent.add(marker.root);
  }
  return marker;
}

/** Every rendered frame. Returns whether the spot shows. */
export function landingFrame(f: LandingInput): boolean {
  const p = prefs.get().landing;
  if (!landingEnabled(p.mode, f.practicing, f.replay) || f.suppressed) {
    marker?.hide();
    return false;
  }
  if (f.grounded) {
    // Between hops: keep what was there for a moment, then hide.
    if (f.now - airAt > GROUND_HOLD_MS) marker?.hide();
    return !!marker?.root.visible;
  }
  airAt = f.now;
  const t0 = performance.now();
  const r = (result = predictLanding(f.core, f.position, f.velocity, f.crouched, LANDING_HORIZON_S, result) ?? undefined);
  const m = built();
  let shown = false;
  if (r && m && (r.kind === LANDING_GROUND || r.kind === LANDING_TELEPORT)) {
    const fail = r.kind === LANDING_TELEPORT;
    const dots = p.arc ? arcPoints(r.pieces, r.pieceCount, ARC_SPACING, ARC_SKIP, arc) : 0;
    // Source (x, y, z) -> three (x, z, -y).
    const c = f.camera.position;
    const distance = Math.hypot(r.position[0] - c.x, r.position[2] - c.y, -r.position[1] - c.z);
    const pxPerUnit = f.viewHeight / (2 * Math.tan(((f.camera.fov * Math.PI) / 180) / 2));
    m.setColors(p.color, palette().loss);
    m.show(r.position, r.normal, fail, minSizeScale(distance, pxPerUnit), p.arc ? arc : null, dots);
    shown = true;
    landingStats.lastTraces = r.traces;
    landingStats.lastPieces = r.pieceCount;
  } else m?.hide();
  const ms = performance.now() - t0;
  landingStats.frames++;
  landingStats.totalMs += ms;
  landingStats.lastMs = ms;
  landingStats.maxMs = Math.max(landingStats.maxMs, ms);
  landingStats.lastKind = r?.kind ?? -1;
  return shown;
}

/** Hides the spot (the viewer closing, a map change). */
export function hideLanding(): void {
  marker?.hide();
}

registerChatCommand({
  name: "landing",
  aliases: ["landingspot", "showlanding"],
  help: "show where you'll land",
  about: "marks where you'd land with no more input while you're in the air (again to hide it). Settings → HUD → Advanced has Practice only and the arc.",
  group: "more",
  where: "both",
  run: (ctx) => {
    let on = false;
    prefs.update((p) => {
      on = p.landing.mode === "off";
      p.landing.mode = on ? "always" : "off";
    });
    ctx.reply(on ? "Showing your landing spot while you're in the air." : "Landing spot hidden.");
  },
});
