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
// landing dip and a little breathing. Bob amount and sway amount scale these (Settings -> Viewmodel; Bob defaults to
// half of CS:S since v0.0.38), and the CS:GO-style viewmodel_offset_x / _y / _z (Settings -> Viewmodel -> Position)
// moves the whole pose in view space.
// Since v0.0.38 (feel.ts): the lag catches up exponentially (the same at any frame rate) and its offset levels off
// (LAG_LIMIT) so a fast strafe sweep no longer throws the hands across the screen while small aim moves stay CS:S; the
// landing dip is an exact spring kicked by landImpact (a flat bhop landing barely moves it, a real drop does); attacks
// blend in over ATTACK_BLEND instead of cutting.
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
import { getHeldLoadout, getOutfit, getPlayerGlow, onHeldLoadout, onOutfit } from "../player/cosmetics";
import { PlayerGlowShell } from "../player/glow";
import { DEFAULT_LOADOUT, gloveStyle, type CosmeticLoadout } from "../loadout";
import { applyLoadoutUniforms, lookDefines, NO_LOOK, sameLook, type FinishSpec, type MaterialLook } from "./finishes/shader";
import { compileModel, prebuildViewmodels } from "../player/bunny/prebuild";
import type { GloveStyleId } from "../loadout";
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
import { viewmodelGeometry } from "./mesh";
import { equippedKnife, onKnife } from "./knives/equipped";
import { KnifeHold, prewarmGrips } from "./knives/hold";
import { knifeById, KNIVES } from "./knives/index";
import { carrot } from "./knives/carrot";
import type { KnifeDef } from "./knives/types";
import { PROC_DURATION, VmProcedural, type VmAction } from "./procedural";
import { vmRig } from "./rig";
import { VmInspect } from "./inspects/runtime";
import { clampFingers } from "./fingers";
import { motionScale, ViewFeel } from "./feel";
import { angleMatrix } from "./math";
import { HandIdle } from "./idle";
import { poseLeftThumb } from "./leftthumb";
import { VIEWMODEL_BOB } from "./defaults";

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** CS:S knife timings (s): next primary / secondary after a missed slash, after a missed stab, after a draw. */
const SLASH_NEXT_PRIMARY = 0.4;
const SLASH_NEXT_SECONDARY = 0.5;
const STAB_NEXT = 1.0;
const DRAW_NEXT = 0.6;

/** Crossfade into the attack sequences (CS:S snaps them; a few frames keeps the swing crisp without the pop). */
export const ATTACK_BLEND = 0.05;

/**
 * Switching away from the knife (presentation only: the core has already switched): it lowers out of view over this
 * long while the gun comes up, instead of vanishing. The gun's draw starts below the screen, so the two overlap.
 */
export const KNIFE_HOLSTER = 0.15;

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

  /** The hand's own idle and settle (idle.ts): wrist and grip, not the screen. */
  private handIdle = new HandIdle();
  // Movement feel (bob, lag, tilt, crouch, landing dip, breathing; feel.ts)
  private feelState = new ViewFeel();
  private V = this.feelState.V;
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
  /** First-person weapons may be drawn at all (setVisible's `inEye`): the lowering knife is drawn only then. */
  private inEye = true;
  /** Seconds into the lower out of view after a switch away (Infinity: not lowering). */
  private holsterT = Infinity;
  private L = new Float32Array(12);
  private LV = new Float32Array(12);
  /** Cosmetic loadout on the hands + knife (finish, gloves; the knife itself comes through setKnife) and its program variant. */
  private loadout: CosmeticLoadout = getHeldLoadout();
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
    this.setLoadout(follow ? getHeldLoadout() : { ...DEFAULT_LOADOUT });
    if (follow) {
      this.unsub.push(onHeldLoadout((l) => this.setLoadout(l)));
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
    const old = this.mesh.material as THREE.ShaderMaterial;
    this.mesh.material = this.materialFor(look);
    if (![...this.kept.values()].includes(old)) old.dispose();
  }

  /**
   * Program variants kept compiled (looks a knife pool swaps between, warmLoadouts): their materials stay alive so
   * three keeps the programs, and a swap on restart picks one up without compiling. Anything else is made per change.
   */
  private kept = new Map<string, THREE.ShaderMaterial>();
  private materialFor(look: MaterialLook): THREE.ShaderMaterial {
    return this.kept.get(JSON.stringify(lookDefines(look))) ?? solidMaterial(this.uniforms, look);
  }

  /**
   * Builds and compiles what holding each of `ls` needs (a knife pool's picks, player/cosmetics.ts): the hands + knife
   * geometry in the prebuild worker, then one program variant each, compiled off the frame (compileModel). Variants
   * from an earlier call that aren't in `ls` are let go.
   */
  async warmLoadouts(ls: readonly CosmeticLoadout[], renderer: THREE.WebGLRenderer, camera: THREE.Camera, scene: THREE.Scene): Promise<void> {
    const glove = gloveStyle(this.loadout.glove).style;
    const knives = ls.map((l) => knifeById(l.knife) ?? carrot);
    await prebuildViewmodels(knives.map((k) => [k, glove] as [KnifeDef, GloveStyleId]), !!getPlayerGlow()?.enabled && prefs.get().firstPersonGlow);
    const want = new Map<string, MaterialLook>();
    for (const l of ls) {
      const look = applyLoadoutUniforms(this.uniforms, { ...l, glove: this.loadout.glove }, undefined, true);
      want.set(JSON.stringify(lookDefines(look)), look);
    }
    // Back to the held loadout's uniforms (the glove is the same, so this only restates them).
    applyLoadoutUniforms(this.uniforms, this.loadout, this.finishOverride, true);
    for (const [key, m] of this.kept) if (!want.has(key)) (this.kept.delete(key), m !== this.mesh.material && m.dispose());
    const root = new THREE.Group();
    for (const [key, look] of want) {
      let m = this.kept.get(key);
      if (!m) this.kept.set(key, (m = sameLook(look, this.look) ? (this.mesh.material as THREE.ShaderMaterial) : solidMaterial(this.uniforms, look)));
      const mesh = new THREE.SkinnedMesh(this.mesh.geometry, m);
      mesh.bindMode = THREE.DetachedBindMode;
      mesh.bind(this.skeleton, new THREE.Matrix4());
      mesh.frustumCulled = false;
      root.add(mesh);
    }
    for (const k of knives) viewmodelGeometry(k === carrot ? undefined : k, glove);
    await compileModel(renderer, root, camera, scene);
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

  /** The viewmodel's clock (s): what its idle life and breathing run on. An export steps it by exactly 1 / fps a frame. */
  get clock(): number {
    return this.now;
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
    this.holsterT = Infinity;
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

  /**
   * The weapon in hand switched away from the knife (the core's switch; presentation only): if it's on screen, it
   * lowers out of view over KNIFE_HOLSTER while the gun comes up (drawn after setVisible(false) while `inEye`).
   */
  holster(): void {
    if (!this.visible || this.holsterT < KNIFE_HOLSTER) return;
    this.holsterT = 0;
    this.inspects.cancel("switch");
  }

  /**
   * Straight to idle, no deploy, and no history (the replay viewer after a seek, an export's start): the viewmodel
   * clock (breathing, hand idle phases), the sequence (no crossfade from what was showing), the inspect, the movement
   * feel, the attack timers. The same replay from the same tick then poses the same every time.
   */
  idle(): void {
    this.holsterT = Infinity;
    this.handIdle.reset();
    this.feelState.reset();
    this.inspects.reset();
    this.now = 0;
    this.nextPrimary = this.nextSecondary = 0;
    this.slashSide = 0;
    this.pressedPrimary = this.pressedSecondary = false;
    this.play = { seq: -1, cycle: 0, prevSeq: -1, prevCycle: 0, fade: 0, fadeT: 0 };
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
    if (this.cs) this.play.cycle = clamp(t * this.rate(this.play.seq), 0, 1);
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
    // An attack from a pose on screen blends in over ATTACK_BLEND (the draw still cuts: it comes up from off screen).
    const attack = a === "slash1" || a === "slash2" || a === "stab";
    if (snap && attack && p.seq >= 0) {
      p.prevSeq = p.seq;
      p.prevCycle = p.cycle;
      p.fade = ATTACK_BLEND;
      p.fadeT = 0;
    } else if (snap) {
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
    p.cycle = clamp(t * this.rate(seq), 0, 1);
  }

  /**
   * How fast a sequence plays (cycles per second). The idle is held at its start: v_knife_t's 12.5 s idle rests for
   * 3 s, then from 5.5 s to 11 s lays the knife flat against the left palm, a move for the CS knife and a CS hand. On
   * these knives it read as the knife drifting sideways for five seconds in every twelve (most of a run, where nobody
   * swings; first seen in exported videos). The idle's life is the hands' own (idle.ts).
   */
  private rate(seq: number): number {
    const cs = this.cs!;
    return seq === cs.seqs.idle ? 0 : cs.bs.cycleRate(seq);
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
    if (this.holsterT < KNIFE_HOLSTER) this.holsterT += dt;
    this.actionT += dt;
    this.attack(held);
    if (this.action !== "idle" && this.actionT >= this.duration(this.action)) this.setAction("idle");
    else if (this.action === "idle" && this.actionT >= this.duration("idle")) this.setAction("idle");
    this.inspects.update(dt, held.inspect ?? false);
    this.handIdle.update(dt, this.action === "idle" && !this.inspects.active);
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
      p.cycle = Math.min(1, p.cycle + dt * this.rate(p.seq));
      bs.initPose();
      let w = 1;
      if (p.prevSeq >= 0 && p.fade > 0) {
        p.fadeT += dt;
        p.prevCycle = Math.min(1, p.prevCycle + dt * this.rate(p.prevSeq));
        const f = clamp(p.fadeT / p.fade, 0, 1);
        if (f >= 1) p.prevSeq = -1;
        else {
          bs.accumulate(p.prevSeq, p.prevCycle, 1);
          w = f * f * (3 - 2 * f);
        }
      }
      bs.accumulate(p.seq, p.cycle, w);
      const A = bs.buildMatrices();
      // (Copied by hand: a subarray per bone per frame was garbage.)
      const bind = r.bind;
      for (let i = 0; i < map.length; i++) {
        const a = map[i];
        const src = a >= 0 ? A : bind, so = a >= 0 ? a * 12 : i * 12, o = i * 12;
        for (let k = 0; k < 12; k++) W[o + k] = src[so + k];
      }
      void d;
      // The left thumb's last joint back on its hinge (leftthumb.ts); the rest of the left arm is the sequence's.
      poseLeftThumb(W, r);
    } else {
      this.proc.pose(this.action, this.actionT, W);
    }
    // Knife hold (non-carrot knives): fingers + knife follow the hand, per-action tweaks; extra bones after the inspect.
    if (this.knifeHold) this.knifeHold.state.time = this.now;
    this.knifeHold?.apply(W, this.action, this.actionT, cs ? "cs" : "procedural");
    this.inspects.apply(W);
    this.knifeHold?.solve(W);
    // The hand's idle and settle (idle.ts), scaled like the bob (0 = still) and by reduced motion.
    this.handIdle.apply(W, this.inspects.arm, this.now, Math.min(1.5, prefs.get().viewmodel.bob / VIEWMODEL_BOB) * motionScale());
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

  /** Bob, lag/sway, strafe tilt, crouch offset, landing dip, breathing -> this.V (view space; feel.ts ViewFeel). */
  private feel(dt: number, s: ViewmodelInput): void {
    const vp = prefs.get().viewmodel;
    // prefers-reduced-motion scales the feel like the guns' (feel.ts motionScale).
    const m = motionScale();
    this.feelState.update(dt, s, vp.bob * m, vp.sway * m, this.now);
  }

  // -------------------------------------------------------------------------------------------
  // Rendering

  /**
   * Shown / hidden; shown again it deploys (draw) unless `deploy` is false (a replay export's camera cut). `inEye`:
   * first-person weapons can be drawn at all (in eye, viewmodel on, not spectating): a knife lowering after a switch
   * (holster) is drawn only then.
   */
  setVisible(v: boolean, deploy = true, inEye = v): void {
    if (v && !this.visible && deploy) this.draw();
    this.visible = v;
    this.inEye = inEye;
    if (!inEye) this.holsterT = Infinity;
  }

  /** Lowering out of view after a switch away (holster), drawn though hidden. */
  get lowering(): boolean {
    return !this.visible && this.inEye && this.holsterT < KNIFE_HOLSTER;
  }

  get shown(): boolean {
    return this.visible;
  }

  /** Draws the viewmodel over the frame just rendered with `world` (depth cleared first). */
  render(renderer: THREE.WebGLRenderer, world: THREE.PerspectiveCamera): void {
    const lowering = this.lowering;
    if (!this.visible && !lowering) return;
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
    const V: Float32Array = lowering ? this.lowered(this.holsterT / KNIFE_HOLSTER) : this.V;
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

  /**
   * The feel with the switch-away lower on top (u 0..1 of KNIFE_HOLSTER): down and out of view, accelerating, the
   * wrist turning the blade down a little about the hand (view space; the gun's holster clip moves the same way).
   */
  private lowered(u: number): Float32Array {
    const k = u <= 0 ? 0 : u >= 1 ? 1 : u * u;
    const m = motionScale();
    // About the hand (~16 forward, 6 right, 7 down of the eye in view space).
    const px = 16, py = -6, pz = -7;
    angleMatrix(24 * k * m, 0, 12 * k * m, 0, 0, 0, this.L);
    const L = this.L;
    L[3] = px - (L[0] * px + L[1] * py + L[2] * pz) - 1.5 * k;
    // (Out to the right as well as down: the incoming gun's draw comes up the middle.)
    L[7] = py - (L[4] * px + L[5] * py + L[6] * pz) - 3.5 * k;
    L[11] = pz - (L[8] * px + L[9] * py + L[10] * pz) - 9 * k;
    concat(L, 0, this.V, 0, this.LV, 0);
    return this.LV;
  }

  dispose(): void {
    for (const u of this.unsub) u();
    this.glow.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.skeleton.dispose();
  }
}
