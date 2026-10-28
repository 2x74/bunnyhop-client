// The avatar renderer: one WebGL canvas showing the bunny for an AvatarSpec (avatar/spec.ts), posed deterministically
// (the same spec always gives the same picture: the pose is simulated from rest at a fixed step), framed, and drawn
// over its backdrop. The editor (avatar/main.ts) shows it live; render() makes the square images that get saved,
// downloaded or copied, with a real alpha channel when the backdrop is "clear".
//
// Poses run the game's own animation (PlayerModel: the CS:S anim state on the bunny when the hosted player content is
// there, procedural otherwise) for a short scripted moment: standing, a hop, an air strafe, a knife swing, the knife's
// first inspect trick. `moment` picks where in it the picture is taken. Head tilt and ears are the bunny's acting
// layer (BunnyModel.setActing) on top.

import * as THREE from "three";
import { PlayerModel, type PlayerPose } from "../player/model";
import { loadoutFor } from "../loadout";
import { cosmetic } from "../progression";
import { inspectSetFor } from "../viewmodel/inspects/index";
import { knifeById } from "../viewmodel/knives/index";
import { BACKDROPS, type AvatarPose, type AvatarSpec } from "./spec";
import type { ArmReach, ArmTurn } from "../player/bunny/model";

const D2R = Math.PI / 180;
const DT = 1 / 120;
const JUMP = 301.993;
const GRAV = 800;
const HOP = (2 * JUMP) / GRAV;
/** Facing at turn = 0: three-quarters toward the camera (which looks along Source +y). */
const BASE_YAW = -62;
const SETTLE = 1.2;

/**
 * Gestures on the acting layer (BunnyActing), on top of the standing animation. Arms are placed by reach (two-bone IK:
 * where the wrist goes and which way the elbow points, in the bunny's bind space carried by the chest: x its left, -y
 * its front, z up; shoulders at (±8, 2, 61), the head bone at (0, 1, 67), the hood's front at y ≈ -7), so the hand
 * lands on the body from every angle. "Hold up" keeps its tuned turns (BunnyActing.arm). Hands open or point; the chest
 * and head lean [pitch, yaw, roll] degrees. Checked from several turns in the editor.
 */
export interface Gesture {
  arm?: ArmTurn;
  reachR?: ArmReach;
  reachL?: ArmReach;
  handR?: "open" | "point";
  handL?: "open" | "point";
  /** Square the upper body to the view (BunnyActing.square); the reach gestures all do. */
  square?: number;
  chest?: [number, number, number];
  head?: [number, number, number];
  /** View pitch (degrees, + = down) for the stance. */
  pitch?: number;
}
/** The free arm in one-arm gestures: hanging relaxed at the side, the elbow back. */
const REST_L: ArmReach = { hand: [11.5, 1.5, 39], pole: [0.4, 1, 0] };
export const GESTURES: Partial<Record<AvatarPose, Gesture>> = {
  holdup: { arm: { shoulder: [-32, 6, -22], elbow: [-104, 0, 0] }, pitch: 6 },
  wave: { reachR: { hand: [-18, -3, 76], pole: [-1, 0.3, -0.8] }, reachL: REST_L, handR: "open", head: [0, 0, -6], pitch: 4 },
  point: { reachR: { hand: [-6, -26, 62], pole: [-0.4, 0.2, -1] }, reachL: REST_L, handR: "point", pitch: 4 },
  cheer: { reachR: { hand: [-15, -3, 84], pole: [-1, 0, -0.2] }, reachL: { hand: [15, -3, 84], pole: [1, 0, -0.2] }, head: [-10, 0, 0], pitch: 2 },
  crossed: { reachR: { hand: [2, -10, 57], pole: [-1, -0.1, -0.7], wrist: [30, 0, 0] }, reachL: { hand: [-2, -12.5, 55.5], pole: [1, -0.1, -0.7], wrist: [30, 0, 0] }, head: [0, 0, 5], pitch: 6 },
  hips: { reachR: { hand: [-10, -1, 41], pole: [-1, 0.5, 0] }, reachL: { hand: [10, -1, 41], pole: [1, 0.5, 0] }, pitch: 6 },
  salute: { reachR: { hand: [-9.5, -8, 71], pole: [-1, -0.2, -0.5] }, reachL: REST_L, handR: "open", head: [-4, 0, 0], pitch: 4 },
  think: { reachR: { hand: [-1, -10, 61], pole: [-0.5, 0.1, -1] }, reachL: { hand: [-5, -9, 50], pole: [1, 0, -0.6] }, head: [7, 0, 6], pitch: 8 },
  shrug: { reachR: { hand: [-18, -9, 52], pole: [-0.4, 0.4, -1] }, reachL: { hand: [18, -9, 52], pole: [0.4, 0.4, -1] }, handR: "open", handL: "open", chest: [-5, 0, 0], head: [0, 0, 12], pitch: 4 },
};

const dir = (yaw: number, s: number): [number, number] => [Math.cos(yaw * D2R) * s, Math.sin(yaw * D2R) * s];

function hopAt(t: number) {
  const ph = ((t % HOP) + HOP) % HOP;
  return { z: Math.max(0, JUMP * ph - 0.5 * GRAV * ph * ph), vz: JUMP - GRAV * ph, grounded: ph < 0.01 };
}

/** The scripted moment for a pose: the pose at time t, and how long to run before the picture. */
function script(spec: AvatarSpec): { at: (t: number, yaw: number) => PlayerPose; until: number; signal?: { at: number; inspect?: number; attack?: number } } {
  const stand = (yaw: number, pitch = 4): PlayerPose => ({ position: [0, 0, 0], velocity: [0, 0, 0], yaw, pitch, crouched: false, grounded: true });
  const m = spec.moment;
  switch (spec.pose) {
    case "idle":
      return { at: (_t, y) => stand(y), until: SETTLE + m * 3 };
    case "lookup":
      return { at: (_t, y) => stand(y + 28, -38), until: SETTLE + m * 3 };
    case "crouch":
      return { at: (_t, y) => ({ ...stand(y, 10), crouched: true }), until: SETTLE + m * 2 };
    case "run":
      return { at: (_t, y) => ({ ...stand(y), velocity: [...dir(y, 250), 0], forwardmove: 450 }), until: SETTLE + m * 0.9 };
    case "hop": {
      const t0 = SETTLE;
      return {
        at: (t, y) => {
          if (t < t0) return { ...stand(y), velocity: [...dir(y, 300), 0] };
          const h = hopAt(t - t0);
          return { position: [0, 0, h.z], velocity: [...dir(y, 400), h.vz], yaw: y, pitch: 6, crouched: false, grounded: h.grounded, forwardmove: 450 };
        },
        until: t0 + 0.04 + m * (HOP - 0.08),
      };
    }
    case "strafe": {
      const t0 = SETTLE;
      return {
        at: (t, y) => {
          if (t < t0) return { ...stand(y), velocity: [...dir(y, 300), 0] };
          const h = hopAt(t - t0);
          const w = (t - t0) * 5;
          const yy = y + 50 * Math.sin(w);
          return { position: [0, 0, h.z], velocity: [...dir(yy, 700), h.vz], yaw: yy, pitch: 4, crouched: false, grounded: h.grounded, sidemove: Math.cos(w) > 0 ? -450 : 450 };
        },
        until: t0 + 0.08 + m * (HOP - 0.14),
      };
    }
    case "swing":
      return { at: (_t, y) => stand(y, 8), until: SETTLE + 0.02 + m * 0.6, signal: { at: SETTLE, attack: m > 0.5 ? 2 : 1 } };
    case "holdup":
    case "wave":
    case "point":
    case "cheer":
    case "crossed":
    case "hips":
    case "salute":
    case "think":
    case "shrug": {
      // A gesture (GESTURES, on the acting layer) over the standing animation; moment = where in the idle sway.
      const pitch = GESTURES[spec.pose]?.pitch ?? 6;
      return { at: (_t, y) => stand(y, pitch), until: SETTLE + m * 3 };
    }
    case "showoff": {
      if (spec.hand !== "knife") return { at: (_t, y) => stand(y, 12), until: SETTLE + m * 3 };
      const clip = inspectSetFor(knifeById(spec.knife) ?? null).clips[0];
      const len = clip?.len ?? 2.4;
      return { at: (_t, y) => stand(y, 14), until: SETTLE + 0.1 + m * Math.max(0.2, len - 0.3), signal: { at: SETTLE, inspect: 1 } };
    }
  }
}

/** Backdrop paint for a 2D canvas (null = transparent). Map shots load asynchronously (cached). */
const images = new Map<string, Promise<HTMLImageElement | null>>();
function loadImage(src: string): Promise<HTMLImageElement | null> {
  let p = images.get(src);
  if (!p) {
    p = new Promise((res) => {
      const img = new Image();
      img.decoding = "async";
      img.onload = () => res(img);
      img.onerror = () => res(null);
      img.src = src;
    });
    images.set(src, p);
  }
  return p;
}

export interface MapShots {
  /** Map name -> hero shot URL (maps/index.json). */
  hero(name: string): string | null;
}

export async function paintBackdrop(ctx: CanvasRenderingContext2D, bg: string, size: number, maps: MapShots | null): Promise<void> {
  ctx.clearRect(0, 0, size, size);
  if (bg === "clear") return;
  if (bg.startsWith("#")) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, size, size);
    return;
  }
  if (bg.startsWith("map:")) {
    const src = maps?.hero(bg.slice(4));
    const img = src ? await loadImage(src) : null;
    if (img) {
      // Cover, slightly blurred and dimmed so the bunny stands out.
      const s = Math.max(size / img.width, size / img.height) * 1.08;
      const w = img.width * s, h = img.height * s;
      ctx.save();
      ctx.filter = `blur(${Math.round(size / 160)}px) brightness(0.82) saturate(1.1)`;
      ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
      ctx.restore();
      const v = ctx.createRadialGradient(size / 2, size * 0.45, size * 0.2, size / 2, size / 2, size * 0.75);
      v.addColorStop(0, "rgba(0,0,0,0)");
      v.addColorStop(1, "rgba(0,0,0,0.35)");
      ctx.fillStyle = v;
      ctx.fillRect(0, 0, size, size);
      return;
    }
    ctx.fillStyle = "#1c1c22";
    ctx.fillRect(0, 0, size, size);
    return;
  }
  let top = "#26262d", bottom = "#0c0c0f", glow: string | null = null;
  if (bg.startsWith("outfit:")) {
    // The colourway's own studio: dark, lit from above in its swatch colour.
    glow = cosmetic(bg.slice(7))?.color ?? "#ffb43c";
    top = "#22222a";
    bottom = "#0e0e12";
  } else {
    const b = BACKDROPS.find((x) => x.id === bg);
    if (b) (top = b.top), (bottom = b.bottom);
  }
  const g = ctx.createLinearGradient(0, 0, 0, size);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const r = ctx.createRadialGradient(size * 0.5, size * 0.28, 0, size * 0.5, size * 0.28, size * 0.7);
  r.addColorStop(0, glow ? hexA(glow, 0.42) : "rgba(255,255,255,0.16)");
  r.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = r;
  ctx.fillRect(0, 0, size, size);
}

function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

const _box = new THREE.Box3();
const _v = new THREE.Vector3();
const _head = new THREE.Vector3();

/** Thumbnail close-ups (the editor's picker): a knife in the raised hand, or a glove. */
export type Focus = "hand" | "glove";

export class AvatarStage {
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(24, 1, 1, 4000);
  private model: PlayerModel;
  private spec: AvatarSpec | null = null;
  private posed = "";

  constructor(canvas?: HTMLCanvasElement) {
    this.canvas = canvas ?? document.createElement("canvas");
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setClearColor(0x000000, 0);
    this.model = new PlayerModel({ model: "bunny", style: "solid", playerGlow: null, outfit: "outfit-cream", loadout: loadoutFor({}) });
    this.model.setNearFade(0, 0);
    this.model.setOpacity(1);
    this.scene.add(this.model.root);
  }

  get animSource(): string {
    return this.model.bunnyModel?.animSource ?? "none";
  }

  /** Dresses and poses the bunny for `spec` (cheap when only the camera-side fields changed). */
  set(spec: AvatarSpec): void {
    const prev = this.spec;
    this.spec = spec;
    const bm = this.model.bunnyModel;
    if (!prev || prev.outfit !== spec.outfit) bm?.setOutfit(spec.outfit);
    const look = [spec.knife, spec.finish, spec.glove, spec.hat, spec.body, spec.hand, spec.gun].join("|");
    const prevLook = prev ? [prev.knife, prev.finish, prev.glove, prev.hat, prev.body, prev.hand, prev.gun].join("|") : "";
    if (look !== prevLook) {
      this.model.setLoadout(loadoutFor({ knife: spec.knife, finish: spec.finish, glove: spec.glove, hat: spec.hat, body: spec.body }));
      this.model.setGun(spec.hand === "gun" ? spec.gun : null);
      bm?.setKnifeHidden(spec.hand === "none");
    }
    // The pose depends only on what's in hand (the knife's inspect, a gun) and the pose fields: colourway, hat, finish,
    // gloves and build are restyles of the same pose (cheap: the picker's thumbnails swap them without re-posing).
    const key = [spec.knife, spec.hand, spec.gun, spec.pose, spec.moment.toFixed(3), spec.tilt.toFixed(3), spec.ears.toFixed(3), spec.turn.toFixed(1), this.animSource, JSON.stringify(GESTURES[spec.pose] ?? null)].join("|");
    if (key !== this.posed) {
      this.posed = key;
      this.pose(spec);
    }
  }

  /** Re-poses from rest (the CS:S animations arrived, say). */
  repose(): void {
    this.posed = "";
    if (this.spec) this.set(this.spec);
  }

  private pose(spec: AvatarSpec): void {
    const bm = this.model.bunnyModel;
    const g = GESTURES[spec.pose];
    const c = g?.chest ?? [0, 0, 0], h = g?.head ?? [0, 0, 0];
    bm?.setActing({
      chestPitch: c[0], chestYaw: c[1], chestRoll: c[2],
      headPitch: h[0], headYaw: h[1], headRoll: h[2] + spec.tilt * 18,
      earL: spec.ears, earR: spec.ears,
      ...(g ? { arm: g.arm, reachR: g.reachR, reachL: g.reachL, handR: g.handR, handL: g.handL, square: g.square ?? (g.reachR || g.reachL ? 1 : 0) } : {}),
    });
    const s = script(spec);
    const yaw = BASE_YAW + spec.turn;
    let t = 0;
    const first = s.at(0, yaw);
    this.model.setState({ ...first, visualTime: 0 });
    this.model.snap();
    this.model.update(1e-4);
    let fired = false;
    while (t < s.until) {
      t += DT;
      const p = { ...s.at(t, yaw), visualTime: t };
      if (s.signal && !fired && t >= s.signal.at) {
        fired = true;
        if (s.signal.inspect) p.inspect = s.signal.inspect;
        if (s.signal.attack) p.attack = s.signal.attack;
      }
      this.model.setState(p);
      this.model.update(DT);
    }
  }

  /** Debug: the framing inputs (head point, body box) as of the last pose. */
  debugFrame(): unknown {
    const bm = this.model.bunnyModel;
    if (!bm) return null;
    this.scene.updateMatrixWorld(true);
    const box = bm.bodyBox(new THREE.Box3());
    return { head: bm.headPoint(new THREE.Vector3()).toArray(), box: [box.min.toArray(), box.max.toArray()], feetYaw: bm.feetYaw, root: this.model.root.position.toArray(), cam: this.camera.position.toArray() };
  }

  /** Points the camera for the spec's framing at the given aspect (w/h), or on the right hand for a thumbnail `focus`. */
  private frame(spec: AvatarSpec, focus?: Focus): void {
    const bm = this.model.bunnyModel;
    this.scene.updateMatrixWorld(true);
    // The posed body's box (model space, before the feet's yaw) -> world: its middle and its top.
    let cx = 0, cy = 34, cz = 0, top = 78, feet = 0;
    if (bm) {
      const box = bm.bodyBox(_box);
      if (!box.isEmpty()) {
        const c = box.getCenter(_v);
        const a = bm.feetYaw * D2R;
        const x = c.x * Math.cos(a) - c.y * Math.sin(a), y = c.x * Math.sin(a) + c.y * Math.cos(a);
        const root = this.model.root.position;
        cx = root.x + x;
        cz = root.z - y;
        cy = root.y + c.z;
        top = root.y + box.max.z;
        feet = root.y + box.min.z;
      }
      bm.headPoint(_head);
    } else _head.set(0, 60, 0);
    let target: THREE.Vector3, height: number;
    if (focus && bm) {
      // "hand": the wrist and the blade above it (a raised knife: "Hold up"); "glove": the raised open hand (a wave).
      bm.handPoint(_v);
      target = new THREE.Vector3(_v.x, _v.y + (focus === "hand" ? 8 : 3), _v.z);
      height = focus === "hand" ? 34 : 17;
    } else if (spec.frame !== "full") {
      // Around the head bone (high in the hood, ~62 of the bunny's 78 units; the ear tips ~18 above it). A hat raises
      // the top a little; folded ears (mid-hop) never shrink the frame. How far down each frame reaches:
      const down = spec.frame === "face" ? 12 : spec.frame === "close" ? 21 : 32;
      const lo = _head.y - down, hi = Math.max(_head.y + 18, Math.min(top + 2, _head.y + 36));
      target = new THREE.Vector3(spec.frame === "bust" ? (_head.x + cx) / 2 : _head.x, (lo + hi) / 2, spec.frame === "bust" ? (_head.z + cz) / 2 : _head.z);
      height = (hi - lo) * (spec.frame === "face" ? 1.14 : 1.1);
    } else {
      target = new THREE.Vector3(cx, (feet + top) / 2, cz);
      height = (top - feet) * 1.14;
    }
    height *= spec.zoom;
    const fov = this.camera.fov * D2R;
    const dist = height / 2 / Math.tan(fov / 2);
    // Slightly above, looking a touch down.
    const elev = spec.frame === "full" ? 8 : 5;
    this.camera.position.set(target.x, target.y + Math.sin(elev * D2R) * dist, target.z + Math.cos(elev * D2R) * dist);
    this.camera.lookAt(target);
  }

  /** Draws the bunny (no backdrop: transparent) into the stage canvas at w×h device pixels. */
  draw(w: number, h: number, focus?: Focus): void {
    if (!this.spec) return;
    if (this.canvas.width !== w || this.canvas.height !== h) this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.frame(this.spec, focus);
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * A finished square picture of `spec` (backdrop + bunny), size px. Rendered at 2× and scaled down for clean edges.
   */
  async render(spec: AvatarSpec, size: number, maps: MapShots | null, focus?: Focus): Promise<HTMLCanvasElement> {
    this.set(spec);
    const ss = Math.min(2, Math.max(1, Math.floor(4096 / size)));
    const big = size * ss;
    const prevW = this.canvas.width, prevH = this.canvas.height;
    this.draw(big, big, focus);
    const out = document.createElement("canvas");
    out.width = out.height = size;
    const ctx = out.getContext("2d")!;
    await paintBackdrop(ctx, spec.bg, size, maps);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(this.canvas, 0, 0, big, big, 0, 0, size, size);
    if (prevW && prevH) this.draw(prevW, prevH);
    return out;
  }

  dispose(): void {
    this.model.dispose();
    this.renderer.dispose();
  }
}
