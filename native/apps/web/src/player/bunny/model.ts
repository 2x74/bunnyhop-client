import { PlayerGlowShell } from "../glow";
import type { PlayerGlow } from "../glow-config";
// BunnyModel: the bunnyhop.lol bunny (mesh.ts) on the CS:S player skeleton (rig.ts). Implements the PlayerModel
// contract (player/model.ts): setState(pose) / update(dt) per frame, Source-space poses in, three.js out.
//
// Animation:
//   - CS:S (when the hosted player content is available): the CS:S anim state (studio/animstate.ts, SDK 2013 port)
//     and bone setup (studio/pose.ts) run on the animation model models/player/cs_player_shared.mdl, exactly as for
//     the real CS:S player models, so proportions, timing, jump tuck, leg yaw, body twist and aim layers are
//     identical. The bunny's bones are mapped to the animation model's by name; skinning matrix = animated
//     bone-to-model * inverse bind.
//   - procedural (procedural.ts) on the same rig while the animations load, or when there is no hosted content.
// Ears are bunny-only bones with spring dynamics driven by the head's world-space motion (hops, landings, turns,
// speed), applied on top of either source.
//
// GPU skinning: bone matrices are written directly (DetachedBindMode, identity bind matrix). The mesh sits in Source
// model space under a yaw group (feet yaw) and a Z-up -> Y-up group, like the CS:S models.

import * as THREE from "three";
import { depthMaterial, ghostMaterial, playerUniforms, silhouetteMaterial, solidMaterial, type PlayerUniforms } from "../materials";
import type { PlayerModelImpl, PlayerModelOptions, PlayerPose, PlayerStyle } from "../model";
import { CsAnimState } from "../studio/animstate";
import type { StudioData } from "../studio/data";
import { BoneSetup } from "../studio/pose";
import { bunnyGeometry, type BunnyHood } from "./mesh";
import { hoodOf } from "./prebuild-parts";
import type { KnifeDef } from "../../viewmodel/knives/types";
import { colourway, paletteOf, type Colourway } from "./palettes";
import { BunnyProcedural } from "./procedural";
import { concat, EAR, EAR_DOWN, invert34, KNIFE_BONE, rig, type Rig } from "./rig";
import { TpInspect, type TpBones } from "../../viewmodel/inspects/third";
import { TP_CARROT } from "../../viewmodel/knives/ctx";
import { gloveStyle, HAIR_DEFAULT, HAIR_LENGTH, type CosmeticLoadout } from "../../loadout";
import { applyLoadoutUniforms, cosmeticsStill, NO_LOOK, sameLook, type MaterialLook } from "../../viewmodel/finishes/shader";
import { advanceCapybara, advancePonytail, capybaraMotion, advancePropeller, ponytailMotion } from "../hat-fx";
import { ensureBunnyLayout } from "../../viewmodel/finishes/layout";
import { headwear } from "./hats";
import { ensureHeadwear } from "../hat-detail";
import { hatFit } from "./hat-fit";
import { lookOf, type BunnyLook } from "./look";
import { gunById } from "../../viewmodel/guns/index";

/** The ponytail's length over the built one (loadout.hairLength, a percent; absent = 1). */
const ponyLength = (l: CosmeticLoadout | null | undefined): number => (l?.hairLength ?? HAIR_LENGTH.default) / 100;
import { bunnyGunGeometry, bunnyHold, bunnySilencerGeometry } from "../../viewmodel/guns/meshes";
import { GunHold } from "./gun-hold";
import { BunnyGunFx } from "./gun-fx";

const D2R = Math.PI / 180;
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
/** Third-person muzzle flash size per gun class (the first-person quads, scaled for distance). */
const FLASH_SIZE = { pistol: 1.7, smg: 1.5, rifle: 2.0, shotgun: 2.5, sniper: 2.3 } as const;
const _pt = new THREE.Vector3();

class DirectSkeleton extends THREE.Skeleton {
  constructor(n: number) {
    super(Array.from({ length: n }, () => new THREE.Bone()), Array.from({ length: n }, () => new THREE.Matrix4()));
  }
  override update(): void {
    if (this.boneTexture) this.boneTexture.needsUpdate = true;
  }
}

let invBind: Float32Array | null = null;
function inverseBind(r: Rig): Float32Array {
  if (invBind) return invBind;
  invBind = new Float32Array(r.bind.length);
  for (let i = 0; i < r.names.length; i++) invert34(r.bind, i * 12, invBind, i * 12);
  return invBind;
}

/** Rig bone -> animation-model bone (-1 = none), per animation model. */
const maps = new WeakMap<StudioData, Int16Array>();
function boneMap(r: Rig, d: StudioData): Int16Array {
  let m = maps.get(d);
  if (!m) {
    m = new Int16Array(r.names.length).fill(-1);
    for (let i = 0; i < r.csBones; i++) m[i] = d.bone(r.names[i]);
    maps.set(d, m);
  }
  return m;
}

/** 3x4 rotation about `pivot` taking unit vector a to unit vector b, scaled to `frac` of the angle (max maxAng). */
function swing(a: ArrayLike<number>, b: ArrayLike<number>, pivot: ArrayLike<number>, frac: number, maxAng: number, out: Float32Array): void {
  let ax = a[1] * b[2] - a[2] * b[1], ay = a[2] * b[0] - a[0] * b[2], az = a[0] * b[1] - a[1] * b[0];
  const s = Math.hypot(ax, ay, az);
  const c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  let ang = Math.atan2(s, c);
  if (s < 1e-6) (ax = 1), (ay = az = 0), (ang = 0);
  else (ax /= s), (ay /= s), (az /= s);
  ang = Math.min(ang, maxAng) * frac;
  const cs = Math.cos(ang), sn = Math.sin(ang), t = 1 - cs;
  const r00 = t * ax * ax + cs, r01 = t * ax * ay - sn * az, r02 = t * ax * az + sn * ay;
  const r10 = t * ax * ay + sn * az, r11 = t * ay * ay + cs, r12 = t * ay * az - sn * ax;
  const r20 = t * ax * az - sn * ay, r21 = t * ay * az + sn * ax, r22 = t * az * az + cs;
  const [px, py, pz] = [pivot[0], pivot[1], pivot[2]];
  out[0] = r00, out[1] = r01, out[2] = r02, out[3] = px - (r00 * px + r01 * py + r02 * pz);
  out[4] = r10, out[5] = r11, out[6] = r12, out[7] = py - (r10 * px + r11 * py + r12 * pz);
  out[8] = r20, out[9] = r21, out[10] = r22, out[11] = pz - (r20 * px + r21 * py + r22 * pz);
}

/** Bind-space directions an ear (left; mirror x) leans toward when acting: pricked straight up, laid flat back. */
const EAR_UP = [0.08, 0.06, 1].map((v, _, a) => v / Math.hypot(...a));
const EAR_BACK = [0.32, 0.95, -0.02].map((v, _, a) => v / Math.hypot(...a));
/** The rest direction `dir0` of the ear on side `sx`, leaned by `perk` (-1..1) toward EAR_BACK / EAR_UP, into out. */
function earWant(dir0: number[], sx: number, perk: number, out: number[]): number[] {
  const to = perk > 0 ? EAR_UP : EAR_BACK;
  const k = Math.min(1, Math.abs(perk));
  for (let i = 0; i < 3; i++) out[i] = dir0[i] + ((i === 0 ? to[0] * sx : to[i]) - dir0[i]) * k;
  const l = Math.hypot(out[0], out[1], out[2]) || 1;
  out[0] /= l, out[1] /= l, out[2] /= l;
  return out;
}

interface Ear {
  /** First ear bone; the second follows it. */
  bone: number;
  /** The bone that carries the ear: the head (hood up) or the upper spine (hood down, rig.ts EAR_DOWN). */
  carrier: number;
  /** Bind-pose base / mid joint and rest direction. */
  base: number[];
  mid: number[];
  dir0: number[];
  /** Tip proxy (Source world space) and its velocity. */
  p: Float64Array;
  v: Float64Array;
  wb: Float64Array;
  hasBase: boolean;
  side: number;
}

/**
 * Acting on top of the animation (setActing; ui/onboarding-preview.ts, the first-visit bunny): extra turns of the
 * upper body and the head about their own joints, in their own frames, and where the ears want to point. The game,
 * replays and the Loadout never set it, so they're untouched. Degrees.
 */
export interface BunnyActing {
  /** Upper body from the chest: lean forward +, twist to its left +, lean to its right +. */
  chestPitch: number;
  chestYaw: number;
  chestRoll: number;
  /** Head from the neck: nod down +, turn to its left +, tilt (right ear down) +. */
  headPitch: number;
  headYaw: number;
  headRoll: number;
  /** Ears (its left, its right): 1 = pricked straight up, 0 = rest, -1 = laid flat back. The springs still swing them. */
  earL: number;
  earR: number;
  /**
   * The arms (optional; right `arm`, left `armL`): the upper arm turned about the shoulder, then the forearm about the
   * elbow, then the hand about the wrist, each [pitch, yaw, roll] in degrees like the chest and head (turnAbout). The
   * knife follows the hand. The avatar editor's poses (avatar/stage.ts).
   */
  arm?: ArmTurn;
  armL?: ArmTurn;
  /**
   * Arms placed by reach (two-bone IK; wins over `arm` / `armL` for that side): the wrist goes to a point and the elbow
   * bends toward a direction, both in the bunny's bind space (Source units: x its left, -y its front, z up; the
   * shoulders at (±8, 2, 61), the head bone at (0, 1, 67)), placed from where the shoulders are now, facing where the
   * bunny looks (its eye yaw), so the hand lands in the same place on the body whatever the stance does.
   */
  reachR?: ArmReach;
  reachL?: ArmReach;
  /**
   * 0..1: undo the stance's twist and lean of the upper body (the CS:S knife idle stands side-on, chest forward), so it
   * squarely faces where the bunny looks. For gestures.
   */
  square?: number;
  /** Hands: "open" = fingers straight (their bind shape, rigid with the hand) instead of the animation's grip; "point" = the index finger only. */
  handR?: "open" | "point";
  handL?: "open" | "point";
}

export interface ArmReach {
  hand: readonly [number, number, number];
  pole: readonly [number, number, number];
  /** Then the hand about the wrist, [pitch, yaw, roll] degrees (turnAbout). */
  wrist?: readonly [number, number, number];
}

export interface ArmTurn {
  shoulder: readonly [number, number, number];
  elbow: readonly [number, number, number];
  wrist?: readonly [number, number, number];
}

export interface BunnyStats {
  source: "cs" | "procedural";
  activity: string;
  feetYaw: number;
  ms: number;
}

export class BunnyModel implements PlayerModelImpl {
  readonly root = new THREE.Group();
  readonly uniforms: PlayerUniforms;
  readonly kind = "bunny";
  private src = new THREE.Group();
  private yawG = new THREE.Group();
  private mesh: THREE.SkinnedMesh;
  private glow: PlayerGlowShell;
  private depthMesh: THREE.SkinnedMesh;
  private skeleton: DirectSkeleton;
  private r = rig();
  private inv = inverseBind(this.r);
  /** Skinning matrices (bind model space -> posed model space), 3x4 per rig bone. */
  private S: Float32Array;
  private style: PlayerStyle = "solid";
  private dither = false;
  /** Drawn as a "???" silhouette (setSilhouette): no colours at all. */
  private silhouette = false;
  private baseRenderOrder = 20;
  private colours: Colourway;
  /** The bunny's head and hoodie, or Tek's (tek.ts; from the outfit). */
  private bodyLook: BunnyLook;
  private knife: KnifeDef | null = null;
  private accentOverride: THREE.ColorRepresentation | undefined;
  /** Cosmetic loadout look (blade finish, glove style) compiled into the solid material (viewmodel/finishes/shader.ts). */
  private loadout: CosmeticLoadout | null = null;
  private capyMotion = capybaraMotion();
  private ponyMotion = ponytailMotion();
  /**
   * Headwear (hats.ts headwear): the owner's hat (loadout.hat) or else the rank crown (loadout.crown: overall #1 / #2 /
   * #3), sharing the skeleton and the body's material.
   */
  private crown: THREE.SkinnedMesh | null = null;
  /**
   * A map-given gun in both hands (guns/meshes.ts bunnyGunGeometry, the body's material) on its own two-bone skeleton
   * (gun, magazine) that the hold writes (gun-hold.ts: the gun on the aim, both arms on it, kick / reload / draw); the
   * knife hides (its bone collapses) while one is out. null = the knife.
   */
  private gun: THREE.SkinnedMesh | null = null;
  private gunId: string | null = null;
  private gunSkel: DirectSkeleton | null = null;
  private hold: GunHold | null = null;
  private gunFx: BunnyGunFx | null = null;
  /** The gun's silencer (the USP's), shown while setGunSilencer(true). */
  private silencer: THREE.SkinnedMesh | null = null;
  private silencerOn = false;
  /** An empty hand (setKnifeHidden): the knife collapses like it does for a gun. */
  private knifeHidden = false;
  private look: MaterialLook = NO_LOOK;

  private cs: { d: StudioData; bs: BoneSetup; anim: CsAnimState; map: Int16Array } | null = null;
  private proc = new BunnyProcedural();

  // Input / derived state
  private pose: PlayerPose | null = null;
  private lastPos = new THREE.Vector3();
  private hasLast = false;
  private vel = [0, 0, 0];
  private snapNext = true;
  private time = Math.random() * 10;
  private vzHist: { t: number; vz: number }[] = [];
  private lastJump = -1;
  private wasGrounded = true;
  private yaw = 0;
  private head = this.r.bone("Head1");
  private hood: BunnyHood = "up";
  private ears: Ear[] = this.makeEars("up");
  /** The ears' pivots for the hood: on the head (rig bind) or hanging from the lowered hood (rig.ts EAR_DOWN). */
  private makeEars(hood: BunnyHood): Ear[] {
    return [1, -1].map((side) => {
      const bone = this.r.index(side > 0 ? "bunny.EarL" : "bunny.EarR");
      const b = this.r.bind;
      const down = hood === "down";
      const base = down ? [EAR_DOWN.base[0] * side, EAR_DOWN.base[1], EAR_DOWN.base[2]] : [b[bone * 12 + 3], b[bone * 12 + 7], b[bone * 12 + 11]];
      const dir0 = down ? [EAR_DOWN.dir[0] * side, EAR_DOWN.dir[1], EAR_DOWN.dir[2]] : [EAR.dir[0] * side, EAR.dir[1], EAR.dir[2]];
      const mid = base.map((x, k) => x + dir0[k] * EAR.seg);
      const carrier = down ? this.r.bone(EAR_DOWN.carrier) : this.r.bone("Head1");
      return { bone, carrier, base, mid, dir0, p: new Float64Array(3), v: new Float64Array(3), wb: new Float64Array(3), hasBase: false, side };
    });
  }
  private earTwitch = 3;
  private tmp = new Float32Array(12);
  private tmp2 = new Float32Array(12);
  /** Inspect gesture layer (created on the first inspect signal). */
  private tp: TpInspect | null = null;
  private tpBones: TpBones | null = null;
  private knifeBone = this.r.index(KNIFE_BONE);
  private handBone = this.r.bone("R_Hand");
  /** Acting layer (setActing), null = none. */
  private acting: BunnyActing | null = null;
  private actingRig: { chest: number; upperChest: number; chestSub: number[]; headSub: number[]; arms: { upper: number; upperSub: number[]; fore: number; foreSub: number[]; hand: number; handSub: number[]; fingers: number[]; index: number[] }[] } | null = null;
  private act3 = new Float32Array(12);
  private actM = new Float32Array(12);
  private actT = new Float32Array(12);
  private actE = new THREE.Euler();
  private actX = new THREE.Matrix4();
  private earWant = [0, 0, 1];
  /** Perf: ms spent in the last update. */
  lastUpdateMs = 0;

  constructor(o: PlayerModelOptions & { outfit?: string } = {}, uniforms: PlayerUniforms = playerUniforms(), anims: StudioData | null = null) {
    this.uniforms = uniforms;
    this.knife = o.knife ?? null;
    this.bodyLook = lookOf(o.outfit);

    this.hood = hoodOf(this.bodyLook, o.loadout?.hat);
    this.ears = this.makeEars(this.hood);
    this.uniforms.uHairColor.value.setHex(o.loadout?.hairColor ?? HAIR_DEFAULT);
    this.uniforms.uPonytail.value.z = ponyLength(o.loadout);
    const geo = bunnyGeometry(this.knife, gloveStyle(o.loadout?.glove).style, this.bodyLook, o.loadout?.body === "body-b" ? "feminine" : "classic", this.hood);
    const n = this.r.names.length;
    this.S = new Float32Array(n * 12);
    for (let i = 0; i < n; i++) this.S.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], i * 12);
    this.skeleton = new DirectSkeleton(n);
    this.mesh = new THREE.SkinnedMesh(geo, solidMaterial(this.uniforms));
    this.depthMesh = new THREE.SkinnedMesh(geo, depthMaterial(this.uniforms));
    const identity = new THREE.Matrix4();
    for (const m of [this.mesh, this.depthMesh]) {
      m.bindMode = THREE.DetachedBindMode;
      m.bind(this.skeleton, identity);
      m.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 38), 58);
      this.yawG.add(m);
    }
    (this.depthMesh.material as THREE.Material).forceSinglePass = true;
    this.src.rotation.x = -Math.PI / 2;
    this.src.add(this.yawG);
    this.root.add(this.src);
    this.root.name = "player-model:bunny";
    this.glow = new PlayerGlowShell(this.yawG, this.uniforms);
    this.glow.set(o.playerGlow ?? null, true);
    this.colours = colourway(o.outfit);
    this.accentOverride = o.color;
    this.applyColours();
    this.setStyle(o.style ?? "solid", o.color, o.dither);
    this.setLoadout(o.loadout ?? null);
    if (anims) this.setAnimations(anims);
  }

  /** Switches to the CS:S animations (or back to procedural with null). */
  setAnimations(d: StudioData | null): void {
    if (!d) {
      this.cs = null;
      return;
    }
    if (this.cs?.d === d) return;
    const bs = new BoneSetup(d);
    const anim = new CsAnimState(d, bs);
    d.warm(anim.sequences());
    this.cs = { d, bs, anim, map: boneMap(this.r, d) };
    this.snapNext = true;
  }

  get animSource(): "cs" | "procedural" {
    return this.cs ? "cs" : "procedural";
  }

  /**
   * The posed body's box, the hat included, in model space: Source axes, feet on z = 0, before the feet's yaw
   * (feetYaw) turns it. A sample of the vertices, each carried by its first bone. For framing (ui/bunny-preview.ts,
   * notify/item3d-scenes.ts): the CS:S stances don't stand the body over the origin (the knife idle's feet are spread
   * to one side, the head leans over the front foot).
   */
  bodyBox(out: THREE.Box3): THREE.Box3 {
    out.makeEmpty();
    this.bodyPoints((p) => out.expandByPoint(p));
    return out;
  }

  /**
   * How deep the knife reaches into the head and hood as posed now (units; <= 0: clear): for each sampled knife vertex,
   * the head's radius toward it (its farthest vertex within 10 degrees of the ray from the head's middle) minus its
   * distance. The ears don't count. For the avatar's stills (avatar/stage.ts), where an inspect caught mid-trick can
   * pass the blade through the face; research/avatar-refresh/clearance.cjs measures the same.
   */
  knifeHeadDepth(): number {
    if (this.gun || this.knifeHidden || this.knifeBone < 0) return -Infinity;
    const r = this.r, S = this.S;
    if (!this.headBones) {
      const set = new Set<number>();
      for (let i = 0; i < r.names.length; i++) {
        if (/Ear/.test(r.names[i])) continue;
        for (let k = i; k >= 0; k = r.parent[k]) {
          if (/Ear/.test(r.names[k])) break;
          if (k === this.head) {
            set.add(i);
            break;
          }
        }
      }
      this.headBones = set;
    }
    const P = this.mesh.geometry.getAttribute("position"), SI = this.mesh.geometry.getAttribute("skinIndex");
    const head: number[] = [], knife: number[] = [];
    const at = (i: number, b: number, out: number[]) => {
      const o = b * 12, x = P.getX(i), y = P.getY(i), z = P.getZ(i);
      out.push(S[o] * x + S[o + 1] * y + S[o + 2] * z + S[o + 3], S[o + 4] * x + S[o + 5] * y + S[o + 6] * z + S[o + 7], S[o + 8] * x + S[o + 9] * y + S[o + 10] * z + S[o + 11]);
    };
    for (let i = 0; i < P.count; i += 3) {
      const b = SI.getX(i);
      if (b === this.knifeBone) at(i, b, knife);
      else if (this.headBones.has(b)) at(i, b, head);
    }
    const n = head.length / 3;
    if (!n || !knife.length) return -Infinity;
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < head.length; i += 3) (cx += head[i]), (cy += head[i + 1]), (cz += head[i + 2]);
    (cx /= n), (cy /= n), (cz /= n);
    const cos = Math.cos((10 * Math.PI) / 180);
    let worst = -Infinity;
    for (let k = 0; k < knife.length; k += 3) {
      const dx = knife[k] - cx, dy = knife[k + 1] - cy, dz = knife[k + 2] - cz, l = Math.hypot(dx, dy, dz);
      if (l > 20 || l < 1e-6) continue;
      let rad = 0;
      for (let i = 0; i < head.length; i += 3) {
        const hx = head[i] - cx, hy = head[i + 1] - cy, hz = head[i + 2] - cz, hl = Math.hypot(hx, hy, hz);
        if (hx * dx + hy * dy + hz * dz > cos * l * hl) rad = Math.max(rad, hl);
      }
      if (rad) worst = Math.max(worst, rad - l);
    }
    return worst;
  }
  private headBones: Set<number> | null = null;

  /** The sample of posed vertices bodyBox is made of (same space), one at a time: the avatar's framing fits them. */
  bodyPoints(fn: (p: THREE.Vector3) => void): void {
    const S = this.S;
    for (const m of [this.mesh, this.crown]) {
      if (!m) continue;
      const P = m.geometry.getAttribute("position"), SI = m.geometry.getAttribute("skinIndex"), HW = m.geometry.getAttribute("headwear");
      for (let i = 0; i < P.count; i += 5) {
        const b = SI.getX(i);
        if ((this.gun || this.knifeHidden) && b === this.knifeBone) continue;
        const o = b * 12;
        let x = P.getX(i), y = P.getY(i), z = P.getZ(i);
        if (m === this.crown) {
          const face = (HW?.getX(i) ?? 1) > 1.5;
          const s = face ? this.uniforms.uHeadwearFaceScale.value : this.uniforms.uHeadwearScale.value;
          const t = face ? this.uniforms.uHeadwearFaceOffset.value : this.uniforms.uHeadwearOffset.value;
          x = x * s.x + t.x; y = y * s.y + t.y; z = z * s.z + t.z;
        }
        fn(_pt.set(S[o] * x + S[o + 1] * y + S[o + 2] * z + S[o + 3], S[o + 4] * x + S[o + 5] * y + S[o + 6] * z + S[o + 7], S[o + 8] * x + S[o + 9] * y + S[o + 10] * z + S[o + 11]));
      }
    }
  }

  /** The head bone's origin in three.js world space, as of the last update. For framing. */
  headPoint(out: THREE.Vector3): THREE.Vector3 {
    return this.bonePoint(this.head, out);
  }

  /** The right hand's origin (the wrist) in three.js world space, as of the last update. For framing. */
  handPoint(out: THREE.Vector3): THREE.Vector3 {
    return this.bonePoint(this.handBone, out);
  }

  private bonePoint(bone: number, out: THREE.Vector3): THREE.Vector3 {
    // S is the skinning matrix (posed * inverse bind): it carries the bind pose's joint to where it is now.
    const o = bone * 12, S = this.S, b = this.r.bind;
    const x = b[o + 3], y = b[o + 7], z = b[o + 11];
    this.yawG.updateWorldMatrix(true, false);
    return out
      .set(S[o] * x + S[o + 1] * y + S[o + 2] * z + S[o + 3], S[o + 4] * x + S[o + 5] * y + S[o + 6] * z + S[o + 7], S[o + 8] * x + S[o + 9] * y + S[o + 10] * z + S[o + 11])
      .applyMatrix4(this.yawG.matrixWorld);
  }

  /** The gun's muzzle (or the silencer's tip) in three.js world space as of the last update; false without a gun. */
  gunMuzzle(out: THREE.Vector3): boolean {
    const m = this.hold?.data && this.gun ? this.hold.muzzle : null;
    if (!m) return false;
    this.yawG.updateWorldMatrix(true, false);
    out.set(m[0], m[1], m[2]).applyMatrix4(this.yawG.matrixWorld);
    return true;
  }

  /** Hides the knife (an empty hand: the avatar editor). A gun hides it anyway. */
  setKnifeHidden(on: boolean): void {
    this.knifeHidden = on;
  }

  /** The feet's yaw, degrees (Source: CCW from +X): what turns bodyBox's space into the model's. */
  get feetYaw(): number {
    return this.yaw;
  }

  get stats(): BunnyStats {
    return { source: this.animSource, activity: this.cs ? this.cs.anim.activity : this.proc.state, feetYaw: this.yaw, ms: this.lastUpdateMs };
  }

  /** The blade in hand (knife registry entry, null = the carrot): swaps to that knife's bunny geometry (cached). */
  setKnife(k: KnifeDef | null): void {
    if (k?.id === "carrot") k = null;
    if (k === this.knife) return;
    this.knife = k;
    this.applyLook(); // the knife's geometry (in the glove style), finish / glove layout on it
  }

  /** Colourway (progression "outfit-*" id). */
  setOutfit(id: string | null | undefined): void {
    this.colours = colourway(id);
    this.applyColours();
    const look = lookOf(id);
    if (look === this.bodyLook) return;
    this.bodyLook = look;
    this.uniforms.uFabric.value = look === "plush" ? 1 : 0;

    this.applyLook(); // Tek's mesh (tek.ts) or the bunny's
    this.setCrown(this.headwear());
  }

  /** Headwear for the loadout (hats.ts headwear): none on Tek, whose temple wings are its helmet. */
  private headwear(): THREE.BufferGeometry | null {
    return this.bodyLook === "tek" ? null : headwear(this.loadout, this.bodyLook);
  }

  private applyColours(): void {
    this.uniforms.uFabric.value = this.bodyLook === "plush" ? 1 : 0;
    const pal = paletteOf(this.colours);
    this.uniforms.uPalette.value.forEach((c, i) => c.set(pal[i]));
    if (this.style === "solid") this.uniforms.uAccent.value.set(this.accentOverride ?? this.colours.accent);
  }

  setStyle(style: PlayerStyle, color?: THREE.ColorRepresentation, dither = this.dither): void {
    const changed = style !== this.style || dither !== this.dither;
    this.style = style;
    this.dither = dither;
    if (style === "solid") {
      if (color !== undefined) this.accentOverride = color;
      this.uniforms.uAccent.value.set(this.accentOverride ?? this.colours.accent);
    } else if (color !== undefined) this.uniforms.uGhost.value.set(color);
    if (changed) this.rebuildMaterial();
    this.depthMesh.visible = style === "ghost" && !dither && !this.silhouette;
    this.setRenderOrder(this.baseRenderOrder);
  }

  /** Blade finish + glove style of a loadout (null = plain). The knife model itself is the geometry's (bunnyGeometry). */
  setLoadout(l: CosmeticLoadout | null): void {
    if (this.loadout?.hat !== l?.hat) {
      this.capyMotion = capybaraMotion();
      this.uniforms.uCapybara.value.set(0, 0, 0, 0);
      this.ponyMotion = ponytailMotion();
      this.uniforms.uPonytail.value.set(0, 0, 1, 0);
      this.uniforms.uPropellerAngle.value = 0;
    }
    this.loadout = l;
    this.uniforms.uHairColor.value.setHex(l?.hairColor ?? HAIR_DEFAULT);
    this.uniforms.uPonytail.value.z = ponyLength(l);
    this.applyLook();
    this.setCrown(this.headwear());
  }

  /** The gun in the right hand (a core weapon id, "glock"; viewmodel/guns), or null for the knife. */
  setGun(id: string | null): void {
    if (id === this.gunId) return;
    this.gunId = id;
    this.gun?.removeFromParent();
    this.gun = null;
    this.silencer?.removeFromParent();
    this.silencer = null;
    const def = id ? gunById(id) : undefined;
    this.gunFx?.clear();
    // A switch or pickup draws (not a model appearing with a gun, or a snap).
    (this.hold ??= new GunHold(this.r)).setGun(def ? bunnyHold(def) : null, this.hasLast && !this.snapNext);
    if (!def) return;
    this.gunSkel ??= new DirectSkeleton(2);
    this.gun = this.handMesh(bunnyGunGeometry(def), this.gunSkel);
    this.yawG.add(this.gun);
    const sil = bunnySilencerGeometry(def);
    if (sil) {
      this.silencer = this.handMesh(sil, this.gunSkel);
      this.silencer.visible = this.silencerOn;
      this.yawG.add(this.silencer);
    }
  }

  /**
   * The gun's silencer on (the USP; a small mesh at its muzzle, guns/meshes.ts bunnySilencerGeometry) or off. Kept
   * across gun changes (a gun without one shows nothing); the caller sets it from the weapon state.
   */
  setGunSilencer(on: boolean): void {
    this.silencerOn = on;
    if (this.silencer) this.silencer.visible = on;
  }

  private handMesh(geo: THREE.BufferGeometry, skeleton: THREE.Skeleton = this.skeleton): THREE.SkinnedMesh {
    const m = new THREE.SkinnedMesh(geo, this.mesh.material);
    m.bindMode = THREE.DetachedBindMode;
    m.bind(skeleton, new THREE.Matrix4());
    m.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 38), 58);
    m.renderOrder = this.mesh.renderOrder;
    return m;
  }

  private setCrown(geo: THREE.BufferGeometry | null): void {
    const fit = hatFit(this.bodyLook, this.loadout?.hat);
    this.uniforms.uHeadwearScale.value.fromArray(fit.scale);
    this.uniforms.uHeadwearOffset.value.fromArray(fit.offset);
    this.uniforms.uHeadwearFaceScale.value.fromArray(fit.face?.scale ?? fit.scale);
    this.uniforms.uHeadwearFaceOffset.value.fromArray(fit.face?.offset ?? fit.offset);
    if (this.crown?.geometry === geo) return;
    this.crown?.removeFromParent();
    this.crown = null;
    if (!geo) return;
    // The head-fit flag, carrying each face's hat material (player/hat-detail.ts).
    ensureHeadwear(geo);
    const m = new THREE.SkinnedMesh(geo, this.mesh.material);
    m.bindMode = THREE.DetachedBindMode;
    m.bind(this.skeleton, new THREE.Matrix4());
    m.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 38), 58);
    m.renderOrder = this.mesh.renderOrder;
    this.crown = m;
    this.yawG.add(m);
  }

  private applyLook(): void {
    // Geometry per knife + glove style + look + build + hood (mesh.ts bunnyGeometry, cached). A wig lowers the hood,
    // and the ears move with it (their springs restart from rest).
    const hood = hoodOf(this.bodyLook, this.loadout?.hat);
    if (hood !== this.hood) (this.hood = hood), (this.ears = this.makeEars(hood));
    const g = bunnyGeometry(this.knife, gloveStyle(this.loadout?.glove).style, this.bodyLook, this.loadout?.body === "body-b" ? "feminine" : "classic", hood);
    if (this.mesh.geometry !== g) {
      this.mesh.geometry = g;
      this.depthMesh.geometry = g;
    }
    ensureBunnyLayout(this.mesh.geometry);
    const look = applyLoadoutUniforms(this.uniforms, this.loadout);
    if (sameLook(look, this.look)) return;
    this.look = look;
    if (this.style !== "solid" || this.silhouette) return;
    this.rebuildMaterial();
  }

  /**
   * A secret item not earned yet (the Loadout's "???" card): the whole model (knife, gun and headwear too) as an opaque
   * near-black silhouette with a faint rim (player/materials.ts silhouetteMaterial). The shader never reads colours.
   */
  setSilhouette(on: boolean): void {
    if (on === this.silhouette) return;
    this.silhouette = on;
    this.rebuildMaterial();
    this.depthMesh.visible = this.style === "ghost" && !this.dither && !on;
  }

  private rebuildMaterial(): void {
    (this.mesh.material as THREE.Material).dispose();
    const m = this.silhouette ? silhouetteMaterial(this.uniforms) : this.style === "solid" ? solidMaterial(this.uniforms, this.look) : ghostMaterial(this.uniforms, this.dither);
    m.forceSinglePass = true;
    this.mesh.material = m;
    for (const extra of [this.gun, this.silencer, this.crown]) if (extra) extra.material = m;
  }

  get currentStyle(): PlayerStyle {
    return this.style;
  }

  setOpacity(a: number): void {
    this.uniforms.uOpacity.value = a;
  }

  setNearFade(near: number, far: number): void {
    this.uniforms.uNearFade.value.set(near, far);
  }

  setRenderOrder(order: number): void {
    this.baseRenderOrder = order;
    this.depthMesh.renderOrder = order;
    this.mesh.renderOrder = order + 1;
  }

  setState(pose: PlayerPose): void {
    this.pose = pose;
  }

  snap(): void {
    this.snapNext = true;
  }

  /** Acting on top of the animation (BunnyActing; null = none). Kept (by reference) until changed. */
  setActing(a: BunnyActing | null): void {
    this.acting = a;
  }

  private applyActing(a: BunnyActing): void {
    let ar = this.actingRig;
    if (!ar) {
      const r = this.r;
      // A bone and everything under it (CS bones: parents come before their children; the ears follow the head later).
      const sub = (root: number) => {
        const out = [root];
        for (let i = root + 1; i < r.csBones; i++) if (out.includes(r.parent[i])) out.push(i);
        return out;
      };
      const chest = r.bone("Spine2");
      const arm = (side: "R" | "L") => {
        const upper = r.bone(`${side}_UpperArm`), fore = r.bone(`${side}_Forearm`), hand = r.bone(`${side}_Hand`);
        const finger = (n: string) => [0, 1, 2].map((k) => r.bone(`${side}_Finger${n}${k ? k : ""}`)).filter((i) => i >= 0);
        return { upper, upperSub: sub(upper), fore, foreSub: sub(fore), hand, handSub: sub(hand), fingers: [...finger("0"), ...finger("1"), ...finger("2")], index: finger("1") };
      };
      ar = this.actingRig = { chest, chestSub: sub(chest), headSub: sub(this.head), arms: [arm("R"), arm("L")], upperChest: r.bone("Spine4") };
    }
    if (a.square) {
      // The chest's forward (bind -y) now, against the eye direction in model space (the feet face +x there).
      const S = this.S, o = ar.chest * 12;
      const fx = -S[o + 1], fy = -S[o + 5], fz = -S[o + 9];
      const want = ((this.pose?.yaw ?? this.yaw) - this.yaw) * D2R;
      let dYaw = (want - Math.atan2(fy, fx)) / D2R;
      dYaw = ((((dYaw + 180) % 360) + 360) % 360) - 180;
      const lean = Math.asin(clamp(fz / (Math.hypot(fx, fy, fz) || 1), -1, 1)) / D2R; // < 0: leaning forward
      this.turnAbout(ar.chest, lean * a.square, dYaw * a.square, 0, ar.chestSub);
    }
    this.turnAbout(ar.chest, a.chestPitch, a.chestYaw, a.chestRoll, ar.chestSub);
    this.turnAbout(this.head, a.headPitch, a.headYaw, a.headRoll, ar.headSub);
    ([[a.arm, a.handR, a.reachR], [a.armL, a.handL, a.reachL]] as const).forEach(([t, hand, reach], k) => {
      const b = ar.arms[k];
      if (reach) {
        this.reachArm(b, ar.arms, reach);
        if (reach.wrist) this.turnAbout(b.hand, ...reach.wrist, b.handSub);
      } else if (t) {
        this.turnAbout(b.upper, ...t.shoulder, b.upperSub);
        this.turnAbout(b.fore, ...t.elbow, b.foreSub);
        if (t.wrist) this.turnAbout(b.hand, ...t.wrist, b.handSub);
      }
      // Straight fingers: a finger rigid with the hand in its bind shape has the hand's skinning matrix.
      if (hand) for (const f of hand === "open" ? b.fingers : b.index) this.S.copyWithin(f * 12, b.hand * 12, b.hand * 12 + 12);
    });
  }

  /** Where bone i's joint is now (model space): its skinning matrix applied to its bind origin. */
  private jointAt(i: number, out: Float64Array): Float64Array {
    const S = this.S, B = this.r.bind, o = i * 12;
    const x = B[o + 3], y = B[o + 7], z = B[o + 11];
    for (let r = 0; r < 3; r++) out[r] = S[o + r * 4] * x + S[o + r * 4 + 1] * y + S[o + r * 4 + 2] * z + S[o + r * 4 + 3];
    return out;
  }

  /** Rotates the bones `sub` about `pivot` by the shortest rotation taking direction a to direction b (model space). */
  private swingSub(sub: number[], a: ArrayLike<number>, b: ArrayLike<number>, pivot: ArrayLike<number>): void {
    const la = Math.hypot(a[0], a[1], a[2]), lb = Math.hypot(b[0], b[1], b[2]);
    if (la < 1e-6 || lb < 1e-6) return;
    let ax = (a[1] * b[2] - a[2] * b[1]) / (la * lb), ay = (a[2] * b[0] - a[0] * b[2]) / (la * lb), az = (a[0] * b[1] - a[1] * b[0]) / (la * lb);
    const sn = Math.hypot(ax, ay, az), cs = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb);
    if (sn < 1e-6) return;
    (ax /= sn), (ay /= sn), (az /= sn);
    const t = 1 - cs, M = this.actM;
    M[0] = cs + ax * ax * t; M[1] = ax * ay * t - az * sn; M[2] = ax * az * t + ay * sn;
    M[4] = ay * ax * t + az * sn; M[5] = cs + ay * ay * t; M[6] = ay * az * t - ax * sn;
    M[8] = az * ax * t - ay * sn; M[9] = az * ay * t + ax * sn; M[10] = cs + az * az * t;
    for (let r = 0; r < 3; r++) M[r * 4 + 3] = pivot[r] - (M[r * 4] * pivot[0] + M[r * 4 + 1] * pivot[1] + M[r * 4 + 2] * pivot[2]);
    const tmp = this.actT;
    for (const i of sub) {
      concat(M, 0, this.S, i * 12, tmp, 0);
      this.S.set(tmp, i * 12);
    }
  }

  /** Two-bone IK (BunnyActing.reachR / reachL): the upper arm swings so the elbow lands in the pole's plane, then the forearm so the wrist reaches. */
  private reachArm(b: { upper: number; upperSub: number[]; fore: number; foreSub: number[]; hand: number }, arms: { upper: number }[], reach: ArmReach): void {
    // The body's frame: origin between the shoulders as they are now, facing the eye direction (model space: the feet
    // face +x), z up. Bind space has the bunny facing -y with its left at +x and the shoulders' middle at MID.
    const r0 = this.jointAt(arms[0].upper, new Float64Array(3)), r1 = this.jointAt(arms[1].upper, new Float64Array(3));
    const mid = this.r.at("R_UpperArm"), mz = mid[2], my = mid[1];
    const yaw = ((this.pose?.yaw ?? this.yaw) - this.yaw) * D2R;
    const fx = Math.cos(yaw), fy = Math.sin(yaw); // forward; left = (-fy, fx)
    const toModel = (v: readonly number[], point: boolean, out: Float64Array) => {
      const x = v[0], y = point ? v[1] - my : v[1], z = point ? v[2] - mz : v[2];
      out[0] = fx * -y + -fy * x + (point ? (r0[0] + r1[0]) / 2 : 0);
      out[1] = fy * -y + fx * x + (point ? (r0[1] + r1[1]) / 2 : 0);
      out[2] = z + (point ? (r0[2] + r1[2]) / 2 : 0);
      return out;
    };
    const T = toModel(reach.hand, true, new Float64Array(3)), pole = toModel(reach.pole, false, new Float64Array(3));
    const P0 = this.jointAt(b.upper, new Float64Array(3)), P1 = this.jointAt(b.fore, new Float64Array(3)), P2 = this.jointAt(b.hand, new Float64Array(3));
    const L1 = Math.hypot(P1[0] - P0[0], P1[1] - P0[1], P1[2] - P0[2]), L2 = Math.hypot(P2[0] - P1[0], P2[1] - P1[1], P2[2] - P1[2]);
    const D = [T[0] - P0[0], T[1] - P0[1], T[2] - P0[2]];
    const dl = Math.hypot(D[0], D[1], D[2]) || 1;
    const d = clamp(dl, Math.abs(L1 - L2) + 0.05, L1 + L2 - 0.05);
    const dir = [D[0] / dl, D[1] / dl, D[2] / dl];
    // The elbow: on the circle around the shoulder-wrist line, toward the pole.
    const pd = pole[0] * dir[0] + pole[1] * dir[1] + pole[2] * dir[2];
    let px = pole[0] - dir[0] * pd, py = pole[1] - dir[1] * pd, pz = pole[2] - dir[2] * pd;
    const pl = Math.hypot(px, py, pz) || 1;
    (px /= pl), (py /= pl), (pz /= pl);
    const along = (L1 * L1 - L2 * L2 + d * d) / (2 * d), h = Math.sqrt(Math.max(0, L1 * L1 - along * along));
    const E = [P0[0] + dir[0] * along + px * h, P0[1] + dir[1] * along + py * h, P0[2] + dir[2] * along + pz * h];
    this.swingSub(b.upperSub, [P1[0] - P0[0], P1[1] - P0[1], P1[2] - P0[2]], [E[0] - P0[0], E[1] - P0[1], E[2] - P0[2]], P0);
    const W = this.jointAt(b.hand, new Float64Array(3));
    const T2 = [P0[0] + dir[0] * d, P0[1] + dir[1] * d, P0[2] + dir[2] * d];
    this.swingSub(b.foreSub, [W[0] - E[0], W[1] - E[1], W[2] - E[2]], [T2[0] - E[0], T2[1] - E[1], T2[2] - E[2]], E);
  }

  /**
   * Turns `bone` and the bones under it about the bone's posed joint, in the bone's own posed frame (bind frame: faces
   * -Y, left +X, up +Z): nod down `pitch` (about +X), turn left `yaw` (about +Z), tilt `roll` (about -Y), degrees.
   */
  private turnAbout(bone: number, pitch: number, yaw: number, roll: number, sub: number[]): void {
    if (!pitch && !yaw && !roll) return;
    const S = this.S, B = this.r.bind, o = bone * 12;
    this.actE.set(pitch * D2R, -roll * D2R, yaw * D2R, "ZXY");
    const e = this.actX.makeRotationFromEuler(this.actE).elements; // column-major
    // T = R_bone * L, then M = T * R_bone^T (the turn expressed in model space).
    const T = this.act3, M = this.actM;
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++) T[r * 4 + c] = S[o + r * 4] * e[c * 4] + S[o + r * 4 + 1] * e[c * 4 + 1] + S[o + r * 4 + 2] * e[c * 4 + 2];
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++) M[r * 4 + c] = T[r * 4] * S[o + c * 4] + T[r * 4 + 1] * S[o + c * 4 + 1] + T[r * 4 + 2] * S[o + c * 4 + 2];
    // About the joint where it is now.
    const bx = B[o + 3], by = B[o + 7], bz = B[o + 11];
    for (let r = 0; r < 3; r++) {
      const p = S[o + r * 4] * bx + S[o + r * 4 + 1] * by + S[o + r * 4 + 2] * bz + S[o + r * 4 + 3];
      this.actT[r] = p;
    }
    const px = this.actT[0], py = this.actT[1], pz = this.actT[2];
    for (let r = 0; r < 3; r++) M[r * 4 + 3] = this.actT[r] - (M[r * 4] * px + M[r * 4 + 1] * py + M[r * 4 + 2] * pz);
    const tmp = this.actT;
    for (const i of sub) {
      concat(M, 0, S, i * 12, tmp, 0);
      S.set(tmp, i * 12);
    }
  }

  setPlayerGlow(config: PlayerGlow | null, shown: boolean, auraEnabled = true): void { this.glow.set(config, shown, auraEnabled); }

  update(dt: number): void {
    this.glow.sync([this.mesh, ...(this.crown ? [this.crown] : [])], this.style === "solid" && !this.silhouette, this.mesh.renderOrder);
    const s = this.pose;
    if (!s) return;
    const t0 = performance.now();
    dt = clamp(dt, 0, 0.1);
    this.time = s.visualTime ?? (this.time + dt);
    const pos = s.position;
    const px = pos[0], py = pos[2], pz = -pos[1];
    const lp = this.lastPos;
    if (this.hasLast && (lp.x - px) ** 2 + (lp.y - py) ** 2 + (lp.z - pz) ** 2 > 160 * 160) this.snapNext = true;
    const snap = this.snapNext;
    this.snapNext = false;
    if (s.velocity) {
      this.vel[0] = s.velocity[0];
      this.vel[1] = s.velocity[1];
      this.vel[2] = s.velocity[2];
    } else if (this.hasLast && dt > 0 && !snap) {
      const k = 1 - Math.exp(-20 * dt);
      this.vel[0] += ((px - lp.x) / dt - this.vel[0]) * k;
      this.vel[1] += (-(pz - lp.z) / dt - this.vel[1]) * k;
      this.vel[2] += ((py - lp.y) / dt - this.vel[2]) * k;
    } else this.vel[0] = this.vel[1] = this.vel[2] = 0;
    if ((this.loadout?.hat === "hat-propeller" || this.loadout?.hat === "hat-maxwell") && !cosmeticsStill()) {
      // Raw horizontal velocity, the same u/s shown by the HUD. Read before animation processing;
      // airborne movement is included, with no dependence on gait, grounded state or leg playback.
      this.uniforms.uPropellerAngle.value = advancePropeller(this.uniforms.uPropellerAngle.value, Math.hypot(this.vel[0], this.vel[1]), dt);
    }
    if (this.loadout?.hat === "hat-ponytail") {
      // The tail's pendulum: the body's acceleration (hops, landings, strafes), wind from its speed, the head's turn.
      const p = this.ponyMotion;
      const len = ponyLength(this.loadout);
      advancePonytail(p, this.vel, s.yaw, dt, snap, cosmeticsStill(), len);
      this.uniforms.uPonytail.value.set(p.pitch, p.side, len, 0);
    }
    if (this.loadout?.hat === "hat-capybara" || this.loadout?.hat === "hat-maxwell") {
      const c = this.capyMotion;
      advanceCapybara(c, Math.hypot(this.vel[0], this.vel[1]), s.grounded, dt, snap, cosmeticsStill());
      this.uniforms.uCapybara.value.set(c.alert, c.squash, c.lean, c.time);
    }
    lp.set(px, py, pz);
    this.hasLast = true;
    this.root.position.set(px, py, pz);

    const jumped = s.jumped ?? this.detectJump(s, snap);
    const S = this.S;
    const inv = this.inv;
    const r = this.r;
    if (this.cs) {
      const { anim, bs, map } = this.cs;
      if (snap) {
        anim.reset(s.visualTime);
        if (!s.grounded) {
          const elapsed = (301.993 - this.vel[2]) / 800;
          if (elapsed >= 0 && elapsed < 2) anim.startAirborne(elapsed);
        }
      }
      if (s.attack) anim.fire();
      anim.update(snap ? 0 : dt, { vel: this.vel, eyeYaw: s.yaw, eyePitch: s.pitch, ducking: s.crouched, onGround: s.grounded, jumped }, snap ? s.visualTime : undefined);
      anim.apply();
      const W = bs.buildMatrices();
      for (let i = 0; i < r.csBones; i++) {
        const a = map[i];
        if (a >= 0) concat(W, a * 12, inv, i * 12, S, i * 12);
        else if (r.parent[i] >= 0) S.copyWithin(i * 12, r.parent[i] * 12, r.parent[i] * 12 + 12);
      }
      this.yaw = anim.feetYaw;
    } else {
      this.yaw = this.proc.update(snap ? 0 : dt, s, this.vel, snap, jumped, S);
    }
    if (this.acting) this.applyActing(this.acting);
    // The gun in both hands (before the ears: its stance turns the chest and the head).
    if (this.gun) this.gunLayer(s, snap, dt);
    this.updateEars(dt, snap, s);
    // The knife bone follows the hand (same bind), then the inspect gesture may move the arm and the knife.
    if (this.knifeBone >= 0) S.copyWithin(this.knifeBone * 12, this.handBone * 12, this.handBone * 12 + 12);
    if (!this.gun) this.inspectLayer(s, snap, dt);
    // A gun out (or an empty hand): the knife collapses to nothing (its geometry stays in the body's mesh; no swap).
    if ((this.gun || this.knifeHidden) && this.knifeBone >= 0) S.fill(0, this.knifeBone * 12, this.knifeBone * 12 + 12);

    const bm = this.skeleton.boneMatrices!;
    const n = r.names.length;
    for (let i = 0; i < n; i++) {
      const o = i * 12, q = i * 16;
      bm[q] = S[o], bm[q + 1] = S[o + 4], bm[q + 2] = S[o + 8], bm[q + 3] = 0;
      bm[q + 4] = S[o + 1], bm[q + 5] = S[o + 5], bm[q + 6] = S[o + 9], bm[q + 7] = 0;
      bm[q + 8] = S[o + 2], bm[q + 9] = S[o + 6], bm[q + 10] = S[o + 10], bm[q + 11] = 0;
      bm[q + 12] = S[o + 3], bm[q + 13] = S[o + 7], bm[q + 14] = S[o + 11], bm[q + 15] = 1;
    }
    this.yawG.rotation.z = this.yaw * D2R;
    this.uniforms.uAxisA.value.copy(this.root.position).y += 8;
    this.uniforms.uAxisB.value.copy(this.root.position).y += 60;
    if (this.gun) {
      this.gun.material = this.mesh.material;
      this.gun.renderOrder = this.mesh.renderOrder;
    }
    if (this.silencer) {
      this.silencer.material = this.mesh.material;
      this.silencer.renderOrder = this.mesh.renderOrder;
    }
    if (this.crown) {
      // Follows the body's material (style / finish changes) and draw order.
      this.crown.material = this.mesh.material;
      this.crown.renderOrder = this.mesh.renderOrder;
    }
    this.lastUpdateMs = performance.now() - t0;
  }

  /**
   * Ear secondary motion: each ear is a damped spring pendulum in world space hanging off the head (off the upper spine
   * with the hood down: rig.ts EAR_DOWN). The tip proxy follows the ear's rest direction (carried by that bone) with lag: hops flick the ears down then up, landings
   * flop them forward, speed streams them back, turns swing them sideways. The result is applied as a swing about
   * the ear base (first bone) and a softer extra bend at the mid joint (second bone).
   */
  private updateEars(dt: number, snap: boolean, s: PlayerPose): void {
    const S = this.S;
    const cy = Math.cos(this.yaw * D2R), sy = Math.sin(this.yaw * D2R);
    const P = s.position;
    const Lp = 6.5; // pendulum length
    this.earTwitch -= dt;
    let twitch = 0;
    if (this.earTwitch < 0) {
      this.earTwitch = 2.5 + Math.random() * 4.5;
      if (Math.hypot(this.vel[0], this.vel[1]) < 40) twitch = Math.random() < 0.5 ? 1 : -1;
    }
    for (const e of this.ears) {
      const sx = e.side;
      const { bone: bIdx, base } = e;
      const H = e.carrier * 12;
      // Acting: the ear's wanted direction leans toward pricked-up or laid-back (the swing below is still from rest;
      // hanging ears from a lowered hood don't act).
      const perk = this.acting && this.hood === "up" ? (sx > 0 ? this.acting.earL : this.acting.earR) : 0;
      const want = perk ? earWant(e.dir0, sx, perk, this.earWant) : e.dir0;
      // Carried base and rest direction, model space then world (Source).
      const mb = [0, 0, 0], md = [0, 0, 0];
      for (let k = 0; k < 3; k++) {
        mb[k] = S[H + k * 4] * base[0] + S[H + k * 4 + 1] * base[1] + S[H + k * 4 + 2] * base[2] + S[H + k * 4 + 3];
        md[k] = S[H + k * 4] * want[0] + S[H + k * 4 + 1] * want[1] + S[H + k * 4 + 2] * want[2];
      }
      const wb = [P[0] + cy * mb[0] - sy * mb[1], P[1] + sy * mb[0] + cy * mb[1], P[2] + mb[2]];
      const wd = [cy * md[0] - sy * md[1], sy * md[0] + cy * md[1], md[2]];
      const target = [wb[0] + wd[0] * Lp, wb[1] + wd[1] * Lp, wb[2] + wd[2] * Lp];
      const bv = [0, 0, 0];
      if (e.hasBase && dt > 0 && !snap) for (let k = 0; k < 3; k++) bv[k] = (wb[k] - e.wb[k]) / dt;
      if (snap || !e.hasBase) {
        for (let k = 0; k < 3; k++) (e.p[k] = target[k]), (e.v[k] = bv[k]);
      } else {
        const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
        const h = dt / steps;
        // Hanging from the lowered hood the ears are stiffer (they lie against the back rather than stand on the head).
        const hang = this.hood === "down";
        const K = hang ? 640 : 320, Crel = hang ? 34 : 21, Cabs = 1.0, G = 30;
        // Idle twitch: a little sideways flick (perpendicular to the ear, in the horizontal plane).
        if (twitch) (e.v[0] += -wd[1] * 70 * twitch * sx), (e.v[1] += wd[0] * 70 * twitch * sx);
        for (let it = 0; it < steps; it++) {
          for (let k = 0; k < 3; k++) {
            const a = K * (target[k] - e.p[k]) - Crel * (e.v[k] - bv[k]) - Cabs * e.v[k] - (k === 2 ? G : 0);
            e.v[k] += a * h;
            e.p[k] += e.v[k] * h;
          }
        }
      }
      // Keep the proxy at pendulum length from the base.
      let dx = e.p[0] - wb[0], dy = e.p[1] - wb[1], dz = e.p[2] - wb[2];
      const l = Math.hypot(dx, dy, dz) || 1;
      dx /= l, dy /= l, dz /= l;
      for (let k = 0; k < 3; k++) e.p[k] = wb[k] + [dx, dy, dz][k] * Lp;
      for (let k = 0; k < 3; k++) e.wb[k] = wb[k];
      e.hasBase = true;
      // World direction -> bind space (undo yaw, then the carrier's rotation: transpose of its 3x3).
      const mx = cy * dx + sy * dy, my = -sy * dx + cy * dy, mz = dz;
      const bd = [
        S[H] * mx + S[H + 4] * my + S[H + 8] * mz,
        S[H + 1] * mx + S[H + 5] * my + S[H + 9] * mz,
        S[H + 2] * mx + S[H + 6] * my + S[H + 10] * mz,
      ];
      const m1 = this.tmp, m2 = this.tmp2;
      // Hanging ears swing less far and bend less at the mid joint, so hops don't flare them out from the back.
      const hangs = this.hood === "down";
      swing(e.dir0, bd, base, hangs ? 0.55 : 1, hangs ? 0.5 : 1.1, m1);
      concat(S, H, m1, 0, S, bIdx * 12);
      swing(e.dir0, bd, e.mid, hangs ? 0.3 : 0.5, hangs ? 0.5 : 1.1, m2);
      concat(S, bIdx * 12, m2, 0, S, (bIdx + 1) * 12);
    }
  }

  /** Inspect gesture (viewmodel/inspects/third.ts) on the skinning matrices: signals in, arm + knife bone out. */
  private inspectLayer(s: PlayerPose, snap: boolean, dt: number): void {
    if (!this.tp) {
      if (!s.inspect) return;
      this.tp = new TpInspect(this.knife);
      const S = this.S, B = this.r.bind, tmp = this.tmp;
      this.tpBones = {
        index: (n) => this.r.index(n),
        parent: this.r.parent,
        count: this.r.names.length,
        posed: (i, out) => concat(S, i * 12, B, i * 12, out, 0),
        pre: (i, M) => {
          concat(M, 0, S, i * 12, tmp, 0);
          S.set(tmp, i * 12);
        },
      };
    }
    const tp = this.tp;
    tp.setKnife(this.knife);
    if (snap) tp.reset();
    if (s.attack) tp.cancel("attack");
    if (s.inspect) tp.signal(s.inspect);
    tp.setHeld(!!s.inspectHeld);
    tp.update(snap ? 0 : dt);
    tp.apply(this.tpBones!, this.r, KNIFE_BONE, this.knife?.tp ?? TP_CARROT);
  }

  /**
   * The gun in both hands (gun-hold.ts): the shot / reload events in, the arms posed on the gun, its two bones written,
   * the flash and the cases. The avatar editor's arm gestures (acting arms) keep the arms; the gun rides the right hand.
   */
  private gunLayer(s: PlayerPose, snap: boolean, dt: number): void {
    const hold = this.hold!, d = hold.data;
    if (!d) return;
    const still = cosmeticsStill();
    if (s.gunShot) hold.shot();
    if (s.gunReload) hold.reload(s.gunReload.seconds, !!s.gunReload.shell, !!s.gunReload.empty);
    const a = this.acting;
    hold.silenced = this.silencerOn && !!d.def.silencer;
    hold.apply(this.S, { yaw: s.yaw - this.yaw, pitch: s.pitch, crouched: s.crouched, grounded: s.grounded, speed: Math.hypot(this.vel[0], this.vel[1]), dt, snap, still }, !!a && !!(a.arm || a.armL || a.reachR || a.reachL));
    const bm = this.gunSkel!.boneMatrices!, K = hold.skin;
    for (let i = 0; i < 2; i++) {
      const o = i * 12, q = i * 16;
      bm[q] = K[o], bm[q + 1] = K[o + 4], bm[q + 2] = K[o + 8], bm[q + 3] = 0;
      bm[q + 4] = K[o + 1], bm[q + 5] = K[o + 5], bm[q + 6] = K[o + 9], bm[q + 7] = 0;
      bm[q + 8] = K[o + 2], bm[q + 9] = K[o + 6], bm[q + 10] = K[o + 10], bm[q + 11] = 0;
      bm[q + 12] = K[o + 3], bm[q + 13] = K[o + 7], bm[q + 14] = K[o + 11], bm[q + 15] = 1;
    }
    // Flash and cases (solid bunnies only: ghosts and silhouettes don't fire).
    const fx = (this.gunFx ??= new BunnyGunFx(this.yawG));
    if (snap) fx.clear();
    if (s.gunShot && this.style === "solid" && !this.silhouette)
      fx.shot(hold.muzzle, hold.barrel, FLASH_SIZE[d.def.cls] * (hold.silenced ? 0.4 : 1), hold.port, hold.throwDir, d.def.shell === "shotgun", still);
    fx.update(snap ? 0 : dt, hold.muzzle, hold.barrel);
  }

  /** PLAYERANIMEVENT_JUMP from state alone (see studio/csmodel.ts). */
  private detectJump(s: PlayerPose, snap: boolean): boolean {
    const vz = this.vel[2];
    const now = this.time;
    const h = this.vzHist;
    // A seek discards future velocity samples and the previous jump cooldown.
    // Otherwise replaying a jump shortly after a reverse seek suppresses its
    // event and changes the actual pose (and first-person body shadow).
    if (snap) { h.length = 0; this.lastJump = -1; this.wasGrounded = s.grounded; }
    h.push({ t: now, vz });
    while (h.length > 2 && now - h[0].t > 0.08) h.shift();
    const wasGrounded = this.wasGrounded;
    this.wasGrounded = s.grounded;
    if (snap || vz < 120 || (this.lastJump >= 0 && now - this.lastJump < 0.2)) return false;
    let min = vz;
    for (const e of h) if (e.vz < min) min = e.vz;
    if (vz - min > 220 || (wasGrounded && !s.grounded && vz > 150)) {
      this.lastJump = now;
      return true;
    }
    return false;
  }

  dispose(): void {
    this.gunFx?.dispose();
    this.glow.dispose();
    this.root.removeFromParent();
    (this.mesh.material as THREE.Material).dispose();
    (this.depthMesh.material as THREE.Material).dispose();
    this.skeleton.dispose();
  }
}
