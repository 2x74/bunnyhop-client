// First-person viewmodel: the bunny's gloved hands holding the carrot blade, played like the CS:S knife.
//
// Rendering: its own scene + camera, drawn after the world with the depth buffer cleared (so it never clips into
// walls), with its own FOV (CS:S `viewmodel_fov`, Hor+ like fov_desired). The camera copies the world camera's
// position and orientation, so the player materials' world-space lighting stays consistent.
//
// Animation: with the hosted CS:S content, v_knife_t's own sequences (idle, draw, midslash1/2, stab_miss) run through
// the studio bone setup (player/studio/pose.ts) on our rig (rig.ts: v_knife_t's skeleton, mapped by name), with the
// client's sequence crossfades (fade-in 0.2 s; the attack sequences snap). Without content, procedural.ts stands in.
// Inspect is ours in both cases (CS:S has no inspect): per-knife trick chains on top of the base pose (inspects/: tap F
// for the base inspect, re-press during it for the next trick, hold F to keep a spin going; attacks cancel it).
//
// On top (all in view space, from the SDK 2013 viewmodel code): CS:S bob (CWeaponCSBase::CalcViewmodelBob / AddViewmodelBob:
// cl_bobcycle 0.8, cl_bobup 0.5, speed-limited, only while grounded here), viewmodel lag (CBaseViewModel::CalcViewModelLag:
// the last-facing vector catching up at 5/s, max lag 1.5, plus the pitch offset), a strafe tilt, a crouch offset, a
// landing dip and a little breathing. Bob amount and sway amount scale these (Settings -> Viewmodel), and the
// CS:GO-style viewmodel_offset_x / _y / _z (Settings -> Viewmodel -> Position) moves the whole pose in view space.
//
// Purely cosmetic: nothing here reaches the simulation. main.ts forwards mouse binds (attack / attack2 / inspect) only
// when they aren't movement binds (input.ts gives movement binds priority), and records attacks as replay cosmetics.
//
// Attacks: with a sim that swings the knife itself (physics v4 + a wasm build with `attack_report`), `followSim` is on
// and the swings play from the simulated attacks only (main.ts calls simAttack on EVENT_ATTACK), so holding a button
// repeats at the sim's rate and nothing plays when the sim didn't attack. Otherwise (older builds) the binds drive
// them with the CS:S timings below.

import * as THREE from "three";
import { playerUniforms, solidMaterial, type PlayerUniforms } from "../player/materials";
import { colourway, paletteOf } from "../player/bunny/palettes";
import { getLoadout, getOutfit, getPlayerGlow, onLoadout, onOutfit } from "../player/cosmetics";
import { PlayerGlowShell } from "../player/glow";
import { DEFAULT_LOADOUT, gloveStyle, type CosmeticLoadout } from "../loadout";
import { applyLoadoutUniforms, NO_LOOK, sameLook, type FinishSpec, type MaterialLook } from "./finishes/shader";
import { wantsReflection } from "./finishes/detail";
import { ensureViewmodelLayout } from "./finishes/layout";
import { followLoadout } from "./equip";
import { concat } from "../player/bunny/rig";
import { BoneSetup } from "../player/studio/pose";
import { STUDIO_SNAP, type StudioData } from "../player/studio/data";
import { hasViewmodelAnims, loadViewmodelAnims, readyViewmodelAnims } from "../player/studio/loader";
import { onPlayerContent } from "../content/player";
import { prefs, verticalFov } from "../ui/settings";
import { ATTACK_SLASH, ATTACK_STAB, emitWeaponEvent as emitEvent } from "./events";
import { angleMatrix } from "./math";
import { viewmodelGeometry } from "./mesh";
import { equippedKnife, onKnife } from "./knives/equipped";
import { KnifeHold, prewarmGrips } from "./knives/hold";
import { KNIVES } from "./knives/index";
import { carrot } from "./knives/carrot";
import type { KnifeDef } from "./knives/types";
import { PROC_DURATION, VmProcedural, type VmAction } from "./procedural";
import { vmRig } from "./rig";
import { VmInspect } from "./inspects/runtime";
import { clampFingers } from "./fingers";

const D2R = Math.PI / 180;
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** CS:S knife timings (s): next primary / secondary after a missed slash, after a missed stab, after a draw. */
const SLASH_NEXT_PRIMARY = 0.4;
const SLASH_NEXT_SECONDARY = 0.5;
const STAB_NEXT = 1.0;
const DRAW_NEXT = 0.6;

/** Sequence names per action (v_knife_t). */
const SEQ: Record<VmAction, string> = { idle: "idle", draw: "draw", slash1: "midslash1", slash2: "midslash2", stab: "stab_miss" };

class DirectSkeleton extends THREE.Skeleton {
  constructor(n: number) {
    super(Array.from({ length: n }, () => new THREE.Bone()), Array.from({ length: n }, () => new THREE.Matrix4()));
  }
  override update(): void {
    if (this.boneTexture) this.boneTexture.needsUpdate = true;
  }
}

export interface ViewmodelInput {
  /** Interpolated velocity, Source units/s. */
  velocity: ArrayLike<number>;
  grounded: boolean;
  /** Eye height above the feet (64 standing, 46 ducked in CS:S); drives the crouch offset. */
  viewOffsetZ: number;
  /** Commanded side move (±450), for the strafe tilt. */
  sidemove: number;
  /** View angles, degrees (Source). */
  yaw: number;
  pitch: number;
  /** Vertical speed of a landing since the last frame (negative, units/s), or 0. */
  landed: number;
}

interface Playing {
  seq: number;
  cycle: number;
  /** Previous sequence fading out (crossfade), weight of the new one rising over `fade` s. */
  prevSeq: number;
  prevCycle: number;
  fade: number;
  fadeT: number;
}

export class Viewmodel {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(41, 1, 0.75, 400);
  readonly uniforms: PlayerUniforms = playerUniforms();
  /** Called when an attack starts (cosmetic: replays, multiplayer, third person). */
  onAttack: ((kind: number) => void) | null = null;
  /** Swings follow the simulation (simAttack) instead of the attack binds. */
  followSim = false;
  /** Perf: ms spent in the last update. */
  lastUpdateMs = 0;
  /** Animation time scale (dev / screenshots: 0 freezes the pose; see seek()). */
  timeScale = 1;
  /**
   * Inspect combo runtime (inspects/runtime.ts): set `inspects.onSignal` to forward trick starts to rooms / replays;
   * `inspects.holding` is the held level. Dev: inspects.setOverride(set) (?vminspect=).
   */
  readonly inspects = new VmInspect(vmRig());

  private root = new THREE.Group();
  readonly mesh: THREE.SkinnedMesh;
  private glow: PlayerGlowShell;
  /** The Loadout's stage: the glow being edited (a preview, a supporter's or not); undefined = your own. */
  glowOverride: import("../player/glow-config").PlayerGlow | null | undefined = undefined;
  private skeleton: DirectSkeleton;
  private r = vmRig();
  private W: Float32Array;
  private S: Float32Array;
  private proc: VmProcedural;
  private cs: { d: StudioData; bs: BoneSetup; map: Int16Array; seqs: Record<VmAction, number> } | null = null;
  private play: Playing = { seq: -1, cycle: 0, prevSeq: -1, prevCycle: 0, fade: 0, fadeT: 0 };

  // Action state (vm clock, seconds)
  private now = 0;
  private action: VmAction = "idle";
  private actionT = 0;
  private nextPrimary = 0;
  private nextSecondary = 0;
  private slashSide = 0;
  private pressedPrimary = false;
  private pressedSecondary = false;

  // Movement feel
  private bobTime = 0;
  private bobSpeed = 0;
  private vBob = 0;
  private lBob = 0;
  private lastFacing: [number, number, number] | null = null;
  private lag = [0, 0, 0];
  private tilt = 0;
  private shift = 0;
  private duck = 0;
  private dip = 0;
  private dipV = 0;
  private V = new Float32Array(12);
  private T = new Float32Array(12);
  private T2 = new Float32Array(12);
  private tmp = new Float32Array(12);
  private conv = new THREE.Matrix4();
  private m4 = new THREE.Matrix4();
  private unsub: (() => void)[] = [];
  /** The knife in hand (null = the carrot) and its hold layer (knives/hold.ts; the carrot has none). */
  private knifeDef: KnifeDef | null = null;
  /** Hold layer of the knife: its `state` (wrist / offset / extra-bone angles) is what inspects may adjust. */
  knifeHold: KnifeHold | null = null;
  private visible = true;
  /** Cosmetic loadout on the hands + knife (finish, gloves; the knife itself comes through setKnife) and its program variant. */
  private loadout: CosmeticLoadout = getLoadout();
  private look: MaterialLook = NO_LOOK;
  /** Dev lab / previews: a finish shown instead of the loadout's (undefined = the loadout's). */
  private finishOverride: FinishSpec | null | undefined = undefined;

  /** No sounds or weapon events from this viewmodel or its inspects (the replay viewer's arms; exports mix their own sound). */
  readonly silent: boolean;

  /**
   * `follow: false` (the replay viewer): not your equipped loadout / knife / colourway; the owner sets them
   * (setLoadout, setKnife, setOutfit). Default: follows yours. `silent`: see `silent`.
   */
  constructor(o: { follow?: boolean; silent?: boolean } = {}) {
    this.silent = this.inspects.silent = !!o.silent;
    const n = this.r.names.length;
    this.W = new Float32Array(n * 12);
    this.S = new Float32Array(n * 12);
    this.skeleton = new DirectSkeleton(n);
    this.mesh = new THREE.SkinnedMesh(viewmodelGeometry(), solidMaterial(this.uniforms));
    this.mesh.bindMode = THREE.DetachedBindMode;
    this.mesh.bind(this.skeleton, new THREE.Matrix4());
    this.mesh.frustumCulled = false;
    // Bounds only sort it (it's the scene's one opaque mesh): a fixed sphere around the hands, so three doesn't skin
    // every vertex on the CPU to find one in the first frame.
    this.mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 64);
    this.mesh.name = "viewmodel";
    this.root.add(this.mesh);
    // A supporter's own glow on the hands and knife (the third-person shell, player/glow.ts, on the same rig).
    // Its own near-fade (off: the hands are at the camera, which the third-person fade hides) and full opacity.
    this.glow = new PlayerGlowShell(this.root, { ...this.uniforms, uNearFade: { value: new THREE.Vector2(0, 0) }, uOpacity: { value: 1 } }, { width: 0.16, strength: 0.6 });
    this.root.matrixAutoUpdate = false;
    this.scene.add(this.root);
    this.proc = new VmProcedural(this.r);
    // Source viewmodel space (x forward, y left, z up) -> three camera space (-z forward, x right, y up).
    this.conv.set(0, -1, 0, 0, 0, 0, 1, 0, -1, 0, 0, 0, 0, 0, 0, 1);
    const follow = o.follow !== false;
    this.applyColours(follow ? getOutfit() : undefined);
    if (follow) followLoadout();
    this.setKnife(follow ? equippedKnife() : null);
    this.setLoadout(follow ? getLoadout() : { ...DEFAULT_LOADOUT });
    if (follow) {
      this.unsub.push(onLoadout((l) => this.setLoadout(l)));
      this.unsub.push(onKnife((k) => this.setKnife(k)));
      this.unsub.push(onOutfit((id) => this.applyColours(id)));
    }
    this.unsub.push(onPlayerContent(() => this.tryLoad()));
    this.tryLoad();
    this.draw();
    // Dev-only cosmetics prototype (research/COSMETICS-PLAN.md): ?vmfinish=nebula, ?vminspect=flip.
    // import.meta.env.DEV is false in builds, so this branch and the chunk are dropped from production.
    if (import.meta.env.DEV && /[?&]vm(finish|inspect)=/.test(location.search)) void import("./finishes/dev").then((m) => m.installDevCosmetics(this));
    // Dev-only knife selector (?vmknife=karrotbit; knives/dev.ts), dropped from builds the same way.
    if (import.meta.env.DEV && /[?&]vmknife=/.test(location.search)) void import("./knives/dev").then((m) => m.installDevKnife());
  }

  /** The knife in hand (registry entry, null = the carrot): swaps the hands + knife geometry (cached per knife). */
  setKnife(k: KnifeDef | null): void {
    if (k?.id === "carrot") k = null;
    if (k === this.knifeDef && this.knifeHold && this.mesh.geometry === this.geometryFor(k)) return;
    this.knifeDef = k;
    this.knifeHold = null;
    this.refreshLook();
  }

  /**
   * The hold layer for the knife in hand and the glove style on the hand (the grip solver closes the fingers on the
   * glove's skin, knives/hold.ts GRIP_SKIN): rebuilt when either changes (~2 ms).
   */
  private refreshHold(): void {
    const k = this.knifeDef, glove = gloveStyle(this.loadout.glove).style;
    if (this.knifeHold && this.knifeHold.def === (k ?? carrot) && this.knifeHold.glove === glove) return;
    // Every knife has a hold, the carrot included (its CARROT_HOLD fist is procedural.ts's rest pose; with v_knife_t it
    // replaces the CS:S knife's grip with ours).
    this.knifeHold = new KnifeHold(k ?? carrot, this.r, glove);
    this.inspects.setKnife(k, k ? this.knifeHold.state : null);
    // The other knives' grips in these gloves, solved when the browser is idle (cached in knives/hold.ts), so switching
    // knives (the Loadout's hover previews) never solves on the spot.
    if (glove !== this.prewarmed) prewarmGrips(KNIVES, (this.prewarmed = glove), this.r);
  }
  private prewarmed: string | null = null;

  /** Finish + gloves of a loadout (your equipped one by default; the knife follows knives/equipped.ts). */
  setLoadout(l: CosmeticLoadout): void {
    this.loadout = l;
    this.refreshLook();
  }

  /** Shows a finish spec instead of the loadout's (dev lab, previews); undefined goes back to the loadout. */
  setFinishOverride(spec: FinishSpec | null | undefined): void {
    this.finishOverride = spec;
    this.refreshLook();
  }

  /** Uniforms for the current loadout; a new program variant only when the finish kind / glove style changes. */
  /** Hands + knife geometry for a knife in the loadout's glove style (cached per pair, mesh.ts). */
  private geometryFor(k: KnifeDef | null): THREE.BufferGeometry {
    return viewmodelGeometry(k ?? undefined, gloveStyle(this.loadout.glove).style);
  }

  private refreshLook(): void {
    this.refreshHold();
    const g = this.geometryFor(this.knifeDef);
    if (this.mesh.geometry !== g) this.mesh.geometry = g;
    ensureViewmodelLayout(this.mesh.geometry);
    // The first-person detail shading (finishes/detail.ts); the scene reflection only runs for reflective hardware or a
    // painted finish (its metallic / glossy parts; the metal finishes, 22+, keep their own capture alive).
    const look = applyLoadoutUniforms(this.uniforms, this.loadout, this.finishOverride, true);
    this.uniforms.uCosEnv.want = wantsReflection(g) || (look.finish > 0 && look.finish < 22);
    if (sameLook(look, this.look)) return;
    this.look = look;
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.material = solidMaterial(this.uniforms, look);
  }

  get knife(): KnifeDef | null {
    return this.knifeDef;
  }

  /** The colourway on the hands (yours unless constructed with `follow: false`). */
  setOutfit(id: string | null | undefined): void {
    this.applyColours(id);
  }

  private applyColours(id: string | null | undefined): void {
    const c = colourway(id);
    const pal = paletteOf(c);
    this.uniforms.uPalette.value.forEach((col, i) => col.set(pal[i]));
    this.uniforms.uAccent.value.set(c.accent);
  }

  /** Loads v_knife_t's animations when the hosted content is known (procedural until then). */
  private tryLoad(): void {
    if (this.cs || !hasViewmodelAnims() || new URLSearchParams(location.search).has("vmproc")) return;
    const ready = readyViewmodelAnims();
    if (ready) return this.setAnimations(ready);
    loadViewmodelAnims().then(
      (d) => this.setAnimations(d),
      (e) => console.warn("viewmodel: CS:S knife animations unavailable, procedural fallback", e),
    );
  }

  private setAnimations(d: StudioData): void {
    if (this.cs?.d === d) return;
    const map = new Int16Array(this.r.names.length).fill(-1);
    for (let i = 0; i < map.length; i++) map[i] = d.bone(this.r.names[i]);
    const seqs = {} as Record<VmAction, number>;
    for (const a of Object.keys(SEQ) as VmAction[]) seqs[a] = d.seq(SEQ[a]);
    if (seqs.idle < 0) return;
    d.warm(Object.values(seqs).filter((s) => s >= 0));
    this.cs = { d, bs: new BoneSetup(d), map, seqs };
    this.play = { seq: -1, cycle: 0, prevSeq: -1, prevCycle: 0, fade: 0, fadeT: 0 };
    this.startSeq(this.action, this.actionT);
  }

  get animSource(): "cs" | "procedural" {
    return this.cs ? "cs" : "procedural";
  }

  /** The bob / sway / crouch / landing feel (3x4, view space) of the last update: the gun viewmodel rides it too. */
  get feelMatrix(): Float32Array {
    return this.V;
  }

  // -------------------------------------------------------------------------------------------
  // Actions

  private emit(e: Parameters<typeof emitEvent>[0]): void {
    if (!this.silent) emitEvent(e);
  }

  /** Deploy (spawn, restart, viewmodel shown again). */
  draw(): void {
    this.setAction("draw");
    this.nextPrimary = this.nextSecondary = this.now + DRAW_NEXT;
    this.inspects.cancel("draw");
    this.emit({ type: "draw", source: "local" });
  }

  /** A replay's / another player's inspect signal (combo.ts SIG_START / SIG_NEXT): the trick starts or chains now. */
  inspectSignal(sig: number): void {
    if (this.action !== "idle" && this.action !== "draw") return;
    this.inspects.remote(sig);
  }

  /** Straight to idle, no deploy (the replay viewer after a seek). */
  idle(): void {
    this.setAction("idle");
    this.inspects.cancel("draw");
  }

  /** Attack buttons pressed this frame (taps shorter than a frame still count). */
  press(secondary: boolean): void {
    if (secondary) this.pressedSecondary = true;
    else this.pressedPrimary = true;
  }

  /** Inspect key pressed: starts the knife's inspect, or chains the next trick during one (inspects/combo.ts). */
  inspect(): void {
    if (this.action !== "idle" && this.action !== "draw") return;
    this.inspects.press();
  }

  /**
   * Dev / screenshots: shows `a` at t seconds (inspect: t into trick `trick` of the knife's chain) and freezes there
   * (timeScale 0).
   */
  seek(a: VmAction | "inspect", t: number, trick = 0): void {
    this.timeScale = 0;
    if (a === "inspect") {
      this.setAction("idle");
      this.play.prevSeq = -1;
      this.inspects.seek(trick, t);
      return;
    }
    this.inspects.seek(-1, 0);
    this.setAction(a);
    this.actionT = t;
    this.play.prevSeq = -1;
    if (this.cs) this.play.cycle = clamp(t * this.cs.bs.cycleRate(this.play.seq), 0, 1);
  }

  private setAction(a: VmAction): void {
    this.action = a;
    this.actionT = 0;
    this.startSeq(a, 0);
  }

  private startSeq(a: VmAction, t: number): void {
    const cs = this.cs;
    if (!cs) return;
    const seq = cs.seqs[a] >= 0 ? cs.seqs[a] : cs.seqs.idle;
    const p = this.play;
    const next = cs.d.seqs[seq];
    const snap = (next.flags & STUDIO_SNAP) !== 0 || p.seq < 0;
    if (snap) {
      p.prevSeq = -1;
      p.fade = 0;
    } else {
      const prev = cs.d.seqs[p.seq];
      p.prevSeq = p.seq;
      p.prevCycle = p.cycle;
      p.fade = Math.min(prev?.fadeOut ?? 0.2, next.fadeIn || 0.2);
      p.fadeT = 0;
    }
    p.seq = seq;
    p.cycle = clamp(t * cs.bs.cycleRate(seq), 0, 1);
  }

  private duration(a: VmAction): number {
    const cs = this.cs;
    if (cs) {
      const s = cs.seqs[a] >= 0 ? cs.seqs[a] : cs.seqs.idle;
      const rate = cs.bs.cycleRate(s);
      return rate > 0 ? 1 / rate : 1;
    }
    return PROC_DURATION[a];
  }

  private attack(held: { primary: boolean; secondary: boolean }): void {
    const wantP = this.pressedPrimary || held.primary;
    const wantS = this.pressedSecondary || held.secondary;
    this.pressedPrimary = this.pressedSecondary = false;
    if (this.followSim) return;
    if (wantP && this.now >= this.nextPrimary) {
      this.slash();
      this.nextPrimary = this.now + SLASH_NEXT_PRIMARY;
      this.nextSecondary = this.now + SLASH_NEXT_SECONDARY;
    } else if (wantS && !wantP && this.now >= this.nextSecondary) {
      this.stab();
      this.nextPrimary = this.nextSecondary = this.now + STAB_NEXT;
    }
  }

  private slash(): void {
    this.slashSide ^= 1;
    const variant = this.slashSide ? 1 : 2;
    this.setAction(variant === 1 ? "slash1" : "slash2");
    this.inspects.cancel("attack");
    this.emit({ type: "slash", variant, source: "local" });
    this.onAttack?.(ATTACK_SLASH);
  }

  private stab(): void {
    this.setAction("stab");
    this.inspects.cancel("attack");
    this.emit({ type: "stab", source: "local" });
    this.onAttack?.(ATTACK_STAB);
  }

  /** The simulation swung the knife this tick (EVENT_ATTACK; `mode` 1 = slash, 2 = stab): plays it, whatever the binds. */
  simAttack(mode: 1 | 2): void {
    if (mode === 2) this.stab();
    else this.slash();
  }

  // -------------------------------------------------------------------------------------------
  // Per frame

  /**
   * Advances animation and movement feel by dt. `held`: attack binds currently held (auto-repeat like the CS:S knife).
   * Runs even while hidden (cheap), so swings stay in step for replays and other players.
   */
  update(dt: number, s: ViewmodelInput, held: { primary: boolean; secondary: boolean; inspect?: boolean }): void {
    const t0 = performance.now();
    dt = clamp(dt, 0, 0.1) * this.timeScale;
    this.now += dt;
    this.actionT += dt;
    this.attack(held);
    if (this.action !== "idle" && this.actionT >= this.duration(this.action)) this.setAction("idle");
    else if (this.action === "idle" && this.actionT >= this.duration("idle")) this.setAction("idle");
    this.inspects.update(dt, held.inspect ?? false);
    this.pose(dt);
    this.feel(dt, s);
    this.lastUpdateMs = performance.now() - t0;
  }

  private pose(dt: number): void {
    const W = this.W;
    const cs = this.cs;
    const r = this.r;
    if (cs) {
      const { bs, d, map } = cs;
      const p = this.play;
      p.cycle = Math.min(1, p.cycle + dt * bs.cycleRate(p.seq));
      bs.initPose();
      let w = 1;
      if (p.prevSeq >= 0 && p.fade > 0) {
        p.fadeT += dt;
        p.prevCycle = Math.min(1, p.prevCycle + dt * bs.cycleRate(p.prevSeq));
        const f = clamp(p.fadeT / p.fade, 0, 1);
        if (f >= 1) p.prevSeq = -1;
        else {
          bs.accumulate(p.prevSeq, p.prevCycle, 1);
          w = f * f * (3 - 2 * f);
        }
      }
      bs.accumulate(p.seq, p.cycle, w);
      const A = bs.buildMatrices();
      for (let i = 0; i < map.length; i++) {
        const a = map[i];
        if (a >= 0) W.set(A.subarray(a * 12, a * 12 + 12), i * 12);
        else W.set(r.bind.subarray(i * 12, i * 12 + 12), i * 12);
      }
      void d;
    } else {
      this.proc.pose(this.action, this.actionT, W);
    }
    // Knife hold (non-carrot knives): fingers + knife follow the hand, per-action tweaks; extra bones after the inspect.
    this.knifeHold?.apply(W, this.action, this.actionT, cs ? "cs" : "procedural");
    this.inspects.apply(W);
    this.knifeHold?.solve(W);
    // Safety net: no finger joint past its anatomical range, whatever the layers above did (fingers.ts).
    clampFingers(W, this.r);
    // Skinning matrices: animated bone-to-model * inverse bind, written column-major for three.js.
    const S = this.S;
    const inv = r.inv;
    const bm = this.skeleton.boneMatrices!;
    for (let i = 0; i < r.names.length; i++) {
      concat(W, i * 12, inv, i * 12, S, i * 12);
      const o = i * 12, q = i * 16;
      bm[q] = S[o], bm[q + 1] = S[o + 4], bm[q + 2] = S[o + 8], bm[q + 3] = 0;
      bm[q + 4] = S[o + 1], bm[q + 5] = S[o + 5], bm[q + 6] = S[o + 9], bm[q + 7] = 0;
      bm[q + 8] = S[o + 2], bm[q + 9] = S[o + 6], bm[q + 10] = S[o + 10], bm[q + 11] = 0;
      bm[q + 12] = S[o + 3], bm[q + 13] = S[o + 7], bm[q + 14] = S[o + 11], bm[q + 15] = 1;
    }
    this.skeleton.update();
  }

  /** Bob, lag/sway, strafe tilt, crouch offset, landing dip, breathing -> this.V (view space). */
  private feel(dt: number, s: ViewmodelInput): void {
    const vp = prefs.get().viewmodel;
    const bobK = vp.bob;
    const swayK = vp.sway;
    // --- CS:S bob (CalcViewmodelBob), only while grounded.
    const hs = s.grounded ? Math.hypot(s.velocity[0], s.velocity[1]) : 0;
    const maxDelta = dt * 320;
    let speed = clamp(hs, this.bobSpeed - maxDelta, this.bobSpeed + maxDelta);
    speed = clamp(speed, -320, 320);
    this.bobSpeed = speed;
    this.bobTime += dt * (speed / 320);
    const CYCLE = 0.8, UP = 0.5;
    const phase = (len: number) => {
      let c = (this.bobTime % len) / len;
      c = c < UP ? (Math.PI * c) / UP : Math.PI + (Math.PI * (c - UP)) / (1 - UP);
      return c;
    };
    let v = speed * 0.005;
    this.vBob = clamp(v * 0.3 + v * 0.7 * Math.sin(phase(CYCLE)), -7, 4) * bobK;
    v = speed * 0.005;
    this.lBob = clamp(v * 0.3 + v * 0.7 * Math.sin(phase(CYCLE * 2)), -7, 4) * bobK;

    // --- Lag (CalcViewModelLag), world space -> view space.
    const cy = Math.cos(s.yaw * D2R), sy = Math.sin(s.yaw * D2R), cp = Math.cos(s.pitch * D2R), sp = Math.sin(s.pitch * D2R);
    const fwd: [number, number, number] = [cp * cy, cp * sy, -sp];
    const left = [-sy, cy, 0];
    const up = [sp * cy, sp * sy, cp];
    if (!this.lastFacing) this.lastFacing = [...fwd];
    const lf = this.lastFacing;
    // A view snapped (nearly) straight around (a teleport or restart turning 180°) would leave the lag direction
    // antiparallel and stuck at full strength, pulling the viewmodel into the camera: start the lag over instead.
    if (Math.hypot(fwd[0] - lf[0], fwd[1] - lf[1], fwd[2] - lf[2]) > 1.9) (lf[0] = fwd[0]), (lf[1] = fwd[1]), (lf[2] = fwd[2]);
    const dx = fwd[0] - lf[0], dy = fwd[1] - lf[1], dz = fwd[2] - lf[2];
    if (dt > 0) {
      let k = 5;
      const diff = Math.hypot(dx, dy, dz);
      if (diff > 1.5) k *= diff / 1.5;
      lf[0] += dx * k * dt;
      lf[1] += dy * k * dt;
      lf[2] += dz * k * dt;
      const ll = Math.hypot(lf[0], lf[1], lf[2]) || 1;
      lf[0] /= ll, lf[1] /= ll, lf[2] /= ll;
    }
    const ox = -5 * dx * swayK, oy = -5 * dy * swayK, oz = -5 * dz * swayK;
    this.lag[0] = ox * fwd[0] + oy * fwd[1] + oz * fwd[2];
    this.lag[1] = ox * left[0] + oy * left[1] + oz * left[2];
    this.lag[2] = ox * up[0] + oy * up[1] + oz * up[2];

    // --- Strafe tilt + slight counter-shift, crouch, landing dip, breathing.
    const side = clamp(s.sidemove / 450, -1, 1);
    const kT = 1 - Math.exp(-dt * 7);
    this.tilt += (side * 3.2 * swayK - this.tilt) * kT;
    this.shift += (side * 0.35 * swayK - this.shift) * kT;
    const duckTarget = clamp((64 - s.viewOffsetZ) / 18, 0, 1);
    this.duck += (duckTarget - this.duck) * (1 - Math.exp(-dt * 10));
    if (s.landed < -50) this.dipV -= clamp(-s.landed / 300, 0, 2.2) * 9 * bobK;
    // Slightly underdamped spring back to 0 (semi-implicit Euler in small steps: stable at any frame rate).
    const K = 170, C = 20;
    const steps = Math.ceil(dt / (1 / 240));
    const h = steps ? dt / steps : 0;
    for (let i = 0; i < steps; i++) {
      this.dipV += (-K * this.dip - C * this.dipV) * h;
      this.dip += this.dipV * h;
    }
    this.dip = clamp(this.dip, -4, 2);
    const breathe = Math.sin(this.now * ((2 * Math.PI) / 3.8)) * bobK;

    const pitch = s.pitch > 180 ? s.pitch - 360 : s.pitch;
    // AddViewmodelBob (scaled down to 40%) + the lag pitch offset (forward, right, up = -pitch * 0.035 / 0.03 / 0.02).
    const fx = this.vBob * 0.4 + this.lag[0] - pitch * 0.035 - this.duck * 0.4;
    const fy = -this.lBob * 0.2 + this.lag[1] + pitch * 0.03 + this.shift + this.duck * 0.25;
    const fz = this.vBob * 0.1 + this.lag[2] - pitch * 0.02 - this.duck * 0.55 + this.dip * 0.6 + breathe * 0.07;
    const aP = -this.vBob * 0.4 + breathe * 0.12 + this.dip * -1.2;
    const aY = -this.lBob * 0.3;
    const aR = this.vBob * 0.5 + this.tilt - this.duck * 1.5;
    angleMatrix(aP, aY, aR, fx, fy, fz, this.V);
  }

  // -------------------------------------------------------------------------------------------
  // Rendering

  /** Shown / hidden; shown again it deploys (draw) unless `deploy` is false (a replay export's camera cut). */
  setVisible(v: boolean, deploy = true): void {
    if (v && !this.visible && deploy) this.draw();
    this.visible = v;
  }

  get shown(): boolean {
    return this.visible;
  }

  /** Draws the viewmodel over the frame just rendered with `world` (depth cleared first). */
  render(renderer: THREE.WebGLRenderer, world: THREE.PerspectiveCamera): void {
    if (!this.visible) return;
    const vp = prefs.get().viewmodel;
    const cam = this.camera;
    world.updateMatrixWorld();
    cam.position.copy(world.position);
    cam.quaternion.copy(world.quaternion);
    cam.aspect = world.aspect;
    const fov = verticalFov(vp.fov);
    if (cam.fov !== fov || cam.aspect !== world.aspect) cam.updateProjectionMatrix();
    cam.fov = fov;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    // root = camera * conv * (offset + V) (* mirror for the left hand). The offset (CS:GO viewmodel_offset_x/y/z, view
    // space: x right, y forward, z up) adds to V's origin (columns forward, left, up); x points outward for either hand.
    const V = this.V;
    const left = vp.hand === "left";
    this.m4.set(V[0], V[1], V[2], V[3] + vp.y, V[4], V[5], V[6], V[7] + (left ? vp.x : -vp.x), V[8], V[9], V[10], V[11] + vp.z, 0, 0, 0, 1);
    const m = this.root.matrix;
    m.multiplyMatrices(cam.matrixWorld, this.conv).multiply(this.m4);
    if (left) m.multiply(this.m4.makeScale(1, -1, 1));
    this.root.matrixWorldNeedsUpdate = true;
    // Own glow (null unless a supporter turned it on), unless "In first person" is off. The contour only: aura flames
    // around the hands would sit in the middle of the view.
    const p = prefs.get();
    this.glow.set(this.glowOverride === undefined ? getPlayerGlow() : this.glowOverride, p.firstPersonGlow, false);
    this.glow.sync([this.mesh], true, this.mesh.renderOrder);
    const auto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.scene, cam);
    renderer.autoClear = auto;
  }

  dispose(): void {
    for (const u of this.unsub) u();
    this.glow.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.skeleton.dispose();
  }
}
