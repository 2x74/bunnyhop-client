// The bunny holding a gun (third person): where the gun sits, how both arms reach it, and the gestures other players
// read from a distance (shot kick, reload, draw). Runs on the skinning matrices after the animation (CS:S or
// procedural), the acting layer and the inspect, so it works the same on both animation sources.
//
// The hold is built from the gun's own data (viewmodel/guns/types.ts GunDef), not from per-gun tuning:
//   - the right fist grips the gun where first person does (GunDef.right: fist centre, grip axis, knuckles), mapped
//     onto the bunny's fist (FIST below, in R_Hand's frame). The gun's geometry is baked into the hand's bind space
//     with that mapping (gunBake; guns/meshes.ts bunnyGunGeometry), so the gun sits through the curled fingers with
//     the bore along the knuckles, a straight wrist's line, instead of sticking out of the thumb side like the knife.
//   - the left (support) fist goes where first person's does (GunDef.left: under a pistol's grip, on a long gun's
//     fore-end; the shotgun's pump), the bunny's left fist being the mirror of its right.
//   - pistols are held out in both hands along the aim, as far as a straight right wrist takes them (solved per frame:
//     the elbow lands where the forearm continues the hand's line); long guns sit with the butt in the right
//     shoulder's pocket along the aim (the butt is the gun's rearmost point, from its geometry).
//   - both arms are two-bone IK from the shoulders the animation placed; the elbow is the point of its circle closest
//     to where a straight wrist puts it, pulled down and out (never up into the head or into the chest). The forearm
//     takes part of the hand's twist so the wrist doesn't wring. The hands keep the animation's finger curl (the left
//     hand takes the right's curl, mirrored: a fist round the fore-end).
//
// Gestures (offsets of the gun's pose; the arms follow through the IK, so the kick shows in the elbows):
//   shot    the muzzle flips up and the gun comes back on an underdamped spring sized by class, then settles
//   reload  magazine guns: the gun cants toward the support hand, the left hand takes the magazine (it rides in the
//           hand: the gun mesh has its own two bones, gun and magazine), lowers it to the hip, brings it back, seats
//           it with a shove; an empty pistol / SMG then racks. Tube guns: the gun cants, the left hand goes from the
//           hip to the loading port once per shell. Sized to the reload's length.
//   draw    the gun comes up from low ready (a switch or pickup; not on snaps, so models appearing don't draw)
// Potato (cosmeticsStill): the hold stays (it's what the gun looks like), the gestures simplify: no springs, the reload
// is a held cant, no draw.
//
// Cost: 2-4 two-bone solves + a few 3x4 products per armed bunny per frame (~0.02 ms; a few small temporary arrays).

import { concat, invert34, rig, xform, type Rig, type V3 } from "./rig";
import type { GunDef, HandPlace } from "../../viewmodel/guns/types";

const D2R = Math.PI / 180;
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
/** 0 -> 1 over [a, b] (smoothstep). */
const ramp = (t: number, a: number, b: number) => smooth((t - a) / (b - a));

/**
 * The bunny's fist in R_Hand's bind frame (rig.ts: x along the fingers, -z the thumb / index side, the palm toward -y;
 * the forearm runs along +x into the wrist): the middle of the curled fingers, the held axis out of the thumb side (the
 * carrot's handle axis, knives/ctx.ts TP_CARROT), the knuckles roughly along the hand. The left fist is its mirror.
 * Hand places on a gun (GunDef.left, places; HandPlace: o, up = the held axis, fwd = the knuckles) map onto it.
 */
export const FIST = { o: [3.25, -1.55, -0.35] as V3, up: [0.48, 0.08, -0.87] as V3, fwd: [1, 0, 0] as V3 };

/**
 * The right fist on a gun's grip: the grip's middle (GunDef.right.o) in the fist, the palm against the grip's left
 * flank, and the bore along the forearm's line cocked `COCK` degrees toward the thumb (a straight wrist: the hand
 * doesn't bend at the wrist to level the gun). Pistols ride high in line with the arm; long guns' grips sit lower in
 * the hand (the forearm comes up to them from below the stock).
 */
const COCK: Record<GunDef["cls"], number> = { pistol: 4, smg: 50, rifle: 50, shotgun: 50, sniper: 50 };
/** Third-person scale of the long guns (first-person sized models; GunDef.tp.s for pistols). */
const LONG_SCALE = 1.22;

type M34 = Float64Array;
const m34 = () => new Float64Array(12);
const v3 = () => new Float64Array(3);

function norm3(v: ArrayLike<number>, out: Float64Array = v3()): Float64Array {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  out[0] = v[0] / l, out[1] = v[1] / l, out[2] = v[2] / l;
  return out;
}
function cross3(a: ArrayLike<number>, b: ArrayLike<number>, out: Float64Array = v3()): Float64Array {
  const x = a[1] * b[2] - a[2] * b[1], y = a[2] * b[0] - a[0] * b[2], z = a[0] * b[1] - a[1] * b[0];
  out[0] = x, out[1] = y, out[2] = z;
  return out;
}
const dot3 = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** A frame (rotation columns a, b, c = a x b; origin o) as a 3x4: frame-local -> parent. */
function frameM(o: ArrayLike<number>, up: ArrayLike<number>, fwd: ArrayLike<number>, out: M34 = m34()): M34 {
  const a = norm3(up), f = norm3(fwd);
  const d = dot3(f, a);
  const b = norm3([f[0] - a[0] * d, f[1] - a[1] * d, f[2] - a[2] * d]);
  const c = cross3(a, b);
  for (let r = 0; r < 3; r++) (out[r * 4] = a[r]), (out[r * 4 + 1] = b[r]), (out[r * 4 + 2] = c[r]), (out[r * 4 + 3] = o[r]);
  return out;
}

/** Rigid inverse (3x4). */
function inv34(m: ArrayLike<number>, out: M34 = m34()): M34 {
  invert34(m as Float32Array, 0, out as unknown as Float32Array, 0);
  return out;
}

/** Rotation about a unit axis through a pivot, as a 3x4. */
function rotAbout(ax: ArrayLike<number>, ang: number, p: ArrayLike<number>, out: M34): M34 {
  const c = Math.cos(ang), s = Math.sin(ang), t = 1 - c;
  const x = ax[0], y = ax[1], z = ax[2];
  out[0] = t * x * x + c; out[1] = t * x * y - s * z; out[2] = t * x * z + s * y;
  out[4] = t * x * y + s * z; out[5] = t * y * y + c; out[6] = t * y * z - s * x;
  out[8] = t * x * z - s * y; out[9] = t * y * z + s * x; out[10] = t * z * z + c;
  for (let r = 0; r < 3; r++) out[r * 4 + 3] = p[r] - (out[r * 4] * p[0] + out[r * 4 + 1] * p[1] + out[r * 4 + 2] * p[2]);
  return out;
}

/** Shortest rotation taking direction a to direction b, about pivot p. */
function swingM(a: ArrayLike<number>, b: ArrayLike<number>, p: ArrayLike<number>, out: M34, ax: Float64Array): boolean {
  const la = Math.hypot(a[0], a[1], a[2]), lb = Math.hypot(b[0], b[1], b[2]);
  if (la < 1e-9 || lb < 1e-9) return false;
  cross3(a, b, ax);
  const s = Math.hypot(ax[0], ax[1], ax[2]) / (la * lb), c = dot3(a, b) / (la * lb);
  if (s < 1e-9) return false;
  norm3(ax, ax);
  rotAbout(ax, Math.atan2(s, c), p, out);
  return true;
}

/** Per gun: the bake (gun-local -> R_Hand bind, scaled) and the grips / points the hold uses, cached. */
export interface GunHoldData {
  def: GunDef;
  s: number;
  long: boolean;
  /** gun-local -> bunny bind space (right fist on the gun's grip). */
  bake: M34;
  /** The right fist's frame on this gun's grip, bind space (fist-local -> bind), and its inverse. */
  grip: M34;
  gripInv: M34;
  /** Fist frames on the gun (fist-local -> gun-local, gun units): right grip, left support, left on the magazine / port / rack. */
  right: M34;
  left: M34;
  mag: M34 | null;
  port: M34 | null;
  rack: M34 | null;
  /** The right fist on a bolt action's knob (GunDef.places.bolt). */
  bolt: M34 | null;
  /** The butt (rearmost point of the stock, gun-local) and the muzzle. */
  butt: V3;
  muzzle: V3;
  eject: { p: V3; dir: V3 };
}

let fists: { R: M34; L: M34; Rinv: M34; Linv: M34 } | null = null;
/** The fists' frames in bind model space (fist-local -> bind), right and mirrored left. */
export function fistFrames(r: Rig = rig()): { R: M34; L: M34; Rinv: M34; Linv: M34 } {
  if (fists) return fists;
  const h = r.bone("R_Hand");
  const H = r.bind.subarray(h * 12, h * 12 + 12);
  const o = xform(H, 0, FIST.o);
  const dir = (v: V3) => [H[0] * v[0] + H[1] * v[1] + H[2] * v[2], H[4] * v[0] + H[5] * v[1] + H[6] * v[2], H[8] * v[0] + H[9] * v[1] + H[10] * v[2]];
  const up = dir(FIST.up), fwd = dir(FIST.fwd);
  const R = frameM(o, up, fwd);
  const L = frameM([-o[0], o[1], o[2]], [-up[0], up[1], up[2]], [-fwd[0], fwd[1], fwd[2]]);
  fists = { R, L, Rinv: inv34(R), Linv: inv34(L) };
  return fists;
}

const placeM = (p: HandPlace | undefined): M34 | null => (p ? frameM(p.o, p.up, p.fwd) : null);
const cache = new Map<GunDef, GunHoldData>();

/**
 * The hold data of a gun. `extent` gives the gun's bounding box in gun-local units (the world model's), for the butt;
 * guns/meshes.ts passes it (this module stays free of the builders).
 */
export function gunHoldData(def: GunDef, extent?: () => { min: V3; max: V3 }): GunHoldData {
  let d = cache.get(def);
  if (d) return d;
  const long = def.cls !== "pistol";
  const s = long ? LONG_SCALE : def.tp.s;
  // The right fist on the grip (gun side: the grip's middle, bore x, left y; bunny side: the fist, the bore cocked from
  // the forearm's line toward the thumb, the palm), both through frameM's (a, b) convention.
  const right = frameM(def.right.o, [1, 0, 0], [0, 1, 0]);
  const r = rig(), h = r.bone("R_Hand"), fo = r.bone("R_Forearm");
  const H = r.bind.subarray(h * 12, h * 12 + 12), Bd = r.bind;
  const fw = [Bd[h * 12 + 3] - Bd[fo * 12 + 3], Bd[h * 12 + 7] - Bd[fo * 12 + 7], Bd[h * 12 + 11] - Bd[fo * 12 + 11]];
  // Forearm line and thumb side in the hand's frame (H^T).
  const fh = norm3([H[0] * fw[0] + H[4] * fw[1] + H[8] * fw[2], H[1] * fw[0] + H[5] * fw[1] + H[9] * fw[2], H[2] * fw[0] + H[6] * fw[1] + H[10] * fw[2]]);
  const th = norm3([-fh[0] * -fh[2], -fh[1] * -fh[2], -1 - fh[2] * -fh[2]]);
  const c = COCK[def.cls] * D2R;
  const bore = [fh[0] * Math.cos(c) + th[0] * Math.sin(c), fh[1] * Math.cos(c) + th[1] * Math.sin(c), fh[2] * Math.cos(c) + th[2] * Math.sin(c)];
  const toBind = (v: ArrayLike<number>) => [H[0] * v[0] + H[1] * v[1] + H[2] * v[2], H[4] * v[0] + H[5] * v[1] + H[6] * v[2], H[8] * v[0] + H[9] * v[1] + H[10] * v[2]];
  const F = frameM(xform(H, 0, FIST.o), toBind(bore), toBind([0, -1, 0]));
  // bake = F * scale(s) * right^-1 : gun-local -> bind, the gun's grip in the bunny's right fist.
  const ri = inv34(right);
  const bake = m34();
  concat(F, 0, ri, 0, bake as unknown as Float32Array, 0);
  // Scale the gun about the fist: bake(p) = F( s * right^-1(p) ).
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) bake[r * 4 + c] *= s;
  for (let k = 0; k < 3; k++) bake[k * 4 + 3] = F[k * 4] * ri[3] * s + F[k * 4 + 1] * ri[7] * s + F[k * 4 + 2] * ri[11] * s + F[k * 4 + 3];
  let butt: V3 = [-6, 0, -1];
  if (extent) {
    const e = extent();
    butt = [e.min[0] + 0.25, 0, long ? -0.3 : e.min[2]];
  }
  d = {
    def,
    s,
    long,
    bake,
    grip: F,
    gripInv: inv34(F),
    right,
    left: frameM(def.left.o, def.left.up, def.left.fwd),
    mag: placeM(def.places.mag),
    port: placeM(def.places.port),
    rack: placeM(def.places.rack),
    bolt: placeM(def.places.bolt),
    butt,
    muzzle: [...def.muzzle] as V3,
    eject: def.eject,
  };
  cache.set(def, d);
  return d;
}

/** What the hold reads from the frame (model space: Source axes before the feet's yaw). */
export interface HoldInput {
  /** Aim yaw relative to the feet (degrees) and pitch (+ = down). */
  yaw: number;
  pitch: number;
  crouched: boolean;
  grounded: boolean;
  /** Horizontal speed (u/s). */
  speed: number;
  dt: number;
  snap: boolean;
  /** Potato: gestures simplified (cosmeticsStill). */
  still: boolean;
}

interface Arm {
  upper: number;
  fore: number;
  hand: number;
  upperSub: number[];
  foreSub: number[];
  handSub: number[];
  fingers: number[];
  L1: number;
  L2: number;
  /** Bind forearm direction (elbow -> wrist), unit. */
  fb: Float64Array;
  side: 1 | -1;
}

/** A spring (x, v) toward 0. */
interface Spring { x: number; v: number }
function stepSpring(sp: Spring, k: number, zeta: number, dt: number): void {
  const c = 2 * zeta * Math.sqrt(k);
  const n = Math.max(1, Math.ceil(dt / (1 / 240)));
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    sp.v += (-k * sp.x - c * sp.v) * h;
    sp.x += sp.v * h;
  }
}

/** Kick per class: muzzle flip (deg), push back (units), spring stiffness, damping. */
const KICK: Record<GunDef["cls"], { flip: number; back: number; k: number; z: number }> = {
  pistol: { flip: 9, back: 1.1, k: 330, z: 0.42 },
  smg: { flip: 3.2, back: 0.7, k: 520, z: 0.5 },
  rifle: { flip: 4.5, back: 1.1, k: 420, z: 0.45 },
  shotgun: { flip: 9, back: 2.0, k: 240, z: 0.4 },
  sniper: { flip: 10, back: 2.4, k: 200, z: 0.38 },
};

export interface HoldStats {
  /** Wrist bend (deg) after the forearm's share of the twist, right / left: the swing between forearm and hand. */
  bend: [number, number];
  /** The reload's cant applied this frame (deg). */
  cant: number;
  /** Twist left between forearm and hand (deg). */
  twist: [number, number];
  /** How far each hand is from its grip (units; 0 = on it). */
  gap: [number, number];
}

const TWIST_SHARE = 0.75;
/** Soft grip (deg): how far a fist may turn on its grip toward the forearm's line (the gun stays put). */
const SOFT_PISTOL = 8;
const SOFT_LONG = 20;
const SOFT_SUPPORT = 25;
/** Long guns: the grip at least this share of the arm's length from the shoulder. */
const MIN_GRIP = 0.5;
/** Stance (deg): how far the shoulders' line is turned from square to the aim, left shoulder forward. */
const BLADE_LONG = 32;
const BLADE_PISTOL = 10;
const MAX_BLADE = 40;
/** Draw (s). */
const DRAW = 0.42;

export class GunHold {
  private r: Rig;
  private arms: [Arm, Arm];
  private bind: Float32Array;
  data: GunHoldData | null = null;
  /** The gun mesh's two bones (bind -> posed, 3x4 each): the gun, the magazine. */
  readonly skin = new Float32Array(24);
  /** Posed model-space muzzle point and the barrel's direction, ejection port and its throw (after apply). */
  readonly muzzle = new Float64Array(3);
  readonly barrel = new Float64Array(3);
  readonly port = new Float64Array(3);
  readonly throwDir = new Float64Array(3);
  readonly stats: HoldStats = { bend: [0, 0], twist: [0, 0], gap: [0, 0], cant: 0 };
  /** The silencer is on (the flash comes from its tip). */
  silenced = false;
  // Gestures
  private flip: Spring = { x: 0, v: 0 };
  private back: Spring = { x: 0, v: 0 };
  private roll = 0;
  private rollSign = 1;
  private reloadT = -1;
  /** 0..1: how far the gun is canted into the reload pose (eased). */
  private cantK = 0;
  private reloadLen = 0;
  private reloadShell = false;
  private reloadEmpty = false;
  private drawT = -1;
  /** The shot counter (a pump / bolt gesture follows a shotgun / sniper shot). */
  private sinceShot = 9;
  private wantDraw = false;
  // Scratch
  private G = m34();
  private K0 = m34();
  private T = m34();
  private T2 = m34();
  private A = m34();
  private B = m34();
  private Rm = m34();
  private fistR = m34();
  private fistL = m34();
  private fistTmp = m34();
  private ax = v3();
  private p0 = v3();
  private p1 = v3();
  private p2 = v3();
  private e = v3();
  private w = v3();
  private d = v3(); private dp = v3();
  private rr = v3();
  private uu = v3();
  private q = v3();
  private tmp = new Float32Array(12);
  private tmp2 = new Float32Array(12);

  constructor(r: Rig = rig()) {
    this.r = r;
    this.bind = r.bind;
    const sub = (root: number) => {
      const out = [root];
      for (let i = root + 1; i < r.csBones; i++) if (out.includes(r.parent[i])) out.push(i);
      return out;
    };
    const arm = (side: "R" | "L"): Arm => {
      const upper = r.bone(`${side}_UpperArm`), fore = r.bone(`${side}_Forearm`), hand = r.bone(`${side}_Hand`);
      const at = (i: number) => [r.bind[i * 12 + 3], r.bind[i * 12 + 7], r.bind[i * 12 + 11]];
      const P0 = at(upper), P1 = at(fore), P2 = at(hand);
      const handSub = sub(hand);
      return {
        upper, fore, hand,
        upperSub: sub(upper), foreSub: sub(fore), handSub,
        fingers: handSub.slice(1),
        L1: Math.hypot(P1[0] - P0[0], P1[1] - P0[1], P1[2] - P0[2]),
        L2: Math.hypot(P2[0] - P1[0], P2[1] - P1[1], P2[2] - P1[2]),
        fb: norm3([P2[0] - P1[0], P2[1] - P1[1], P2[2] - P1[2]]),
        side: side === "R" ? 1 : -1,
      };
    };
    this.arms = [arm("R"), arm("L")];
    this.chest = r.bone("Spine2");
    this.chestSub = sub(this.chest);
    this.neck = r.bone("Neck1");
    this.neckSub = sub(this.neck);
  }
  private chest: number;
  private chestSub: number[];
  private pelvis = rig().bone("Pelvis");
  /** The magazine is out in the left hand this frame; the left fist's frame on the seated magazine, inverted. */
  private magHeld = false;
  private magInv = m34();
  private hip = v3();
  private neck: number;
  private neckSub: number[];

  /** The gun in hand (null: none); `draw` plays the draw (a switch / pickup, not a model appearing). */
  setGun(data: GunHoldData | null, draw: boolean): void {
    if (data === this.data) return;
    this.data = data;
    this.reloadT = -1;
    this.flip.x = this.flip.v = this.back.x = this.back.v = 0;
    this.sinceShot = 9;
    this.wantDraw = draw && !!data;
  }

  /** A shot from the gun in hand. */
  shot(): void {
    const d = this.data;
    if (!d) return;
    const k = KICK[d.def.cls];
    // Impulses sized so the first peak is about `flip` / `back` (an underdamped spring peaks near v / sqrt(k)).
    this.flip.v += k.flip * Math.sqrt(k.k) * (0.85 + Math.random() * 0.3);
    this.back.v += k.back * Math.sqrt(k.k);
    this.rollSign = -this.rollSign;
    this.roll = this.rollSign * (0.4 + Math.random() * 0.6);
    this.sinceShot = 0;
    // A shot cancels a tube gun's loading (the core stops it), not a magazine reload.
    if (this.reloadShell) this.reloadT = -1;
  }

  /** A reload started (`seconds` long), or (`shell`) one shell went in; `empty`: the gun was empty (rack at the end). */
  reload(seconds: number, shell = false, empty = false): void {
    if (!this.data) return;
    if (shell) {
      // Each shell restarts the loading cycle (the cant holds between them).
      this.reloadShell = true;
      this.reloadLen = clamp(seconds, 0.25, 1.2);
      this.reloadT = 0;
      return;
    }
    this.reloadShell = !!this.data.def.timing.shells;
    this.reloadLen = clamp(seconds, 0.3, 6);
    this.reloadEmpty = empty;
    this.reloadT = 0;
  }

  /** Clears gestures (snaps). */
  reset(): void {
    this.reloadT = -1;
    this.drawT = -1;
    this.flip.x = this.flip.v = this.back.x = this.back.v = 0;
    this.sinceShot = 9;
  }

  /**
   * Poses both arms on the gun in S (skinning matrices) and writes the gun's two bone matrices (skin). `armsFree`:
   * leave the arms as they are and keep the gun in the right hand (the avatar editor's gestures).
   */
  apply(S: Float32Array, inp: HoldInput, armsFree = false): void {
    const d = this.data;
    if (!d) return;
    const [R, L] = this.arms;
    if (armsFree) {
      // The gun rides the right hand (its bake is the hand's bind): bone 0 = the hand's skinning matrix.
      this.skin.set(S.subarray(R.hand * 12, R.hand * 12 + 12), 0);
      this.skin.set(S.subarray(R.hand * 12, R.hand * 12 + 12), 12);
      this.points(d);
      return;
    }
    const dt = inp.snap ? 0 : inp.dt;
    if (inp.snap) this.reset();
    if (this.wantDraw) {
      this.wantDraw = false;
      if (!inp.snap && !inp.still) this.drawT = 0;
    }
    // Gesture clocks.
    if (inp.still) this.flip.x = this.flip.v = this.back.x = this.back.v = 0;
    else {
      const k = KICK[d.def.cls];
      stepSpring(this.flip, k.k, k.z, dt);
      stepSpring(this.back, k.k * 0.8, k.z + 0.1, dt);
    }
    this.sinceShot += dt;
    if (this.drawT >= 0 && (this.drawT += dt) > DRAW) this.drawT = -1;
    if (this.reloadT >= 0) {
      this.reloadT += dt;
      const len = this.reloadShell ? this.reloadLen + 0.35 : this.reloadLen;
      if (this.reloadT > len) this.reloadT = -1;
    }
    // The reload's cant eases in and out (and holds between a tube gun's shells); Potato holds it without easing.
    const want = this.reloadT >= 0 && this.reloadT < (this.reloadShell ? this.reloadLen + 0.35 : this.reloadLen) - 0.22 ? 1 : 0;
    this.cantK = inp.still || inp.snap ? want : this.cantK + (want - this.cantK) * (1 - Math.exp(-11 * dt));

    // --- The aim frame (model space): d forward along the aim, r right, u up (perpendicular to d).
    const yaw = inp.yaw * D2R, pitch = clamp(inp.pitch < 0 ? inp.pitch * 0.82 : inp.pitch, -60, 75) * D2R;
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const D = this.d, Rt = this.rr, U = this.uu;
    D[0] = cp * cy, D[1] = cp * sy, D[2] = -sp;
    Rt[0] = sy, Rt[1] = -cy, Rt[2] = 0;
    cross3(Rt, D, U);
    // Where the hands go follows the pitch only part way (aiming high doesn't lift the arms over the head; aiming low
    // doesn't drop them to the knees); the gun itself still points along the aim, the wrists take the rest.
    const pp = pitch * (pitch < 0 ? 0.6 : 0.9), Dp = this.dp;
    Dp[0] = Math.cos(pp) * cy, Dp[1] = Math.cos(pp) * sy, Dp[2] = -Math.sin(pp);
    /** 0..1 how high the aim is (long guns: the butt drops off the shoulder line so the barrel clears the hood). */
    const high = clamp(-inp.pitch / 55, 0, 1);
    // Stance: turn the chest so the shoulders' line is bladed to the aim (left shoulder forward: long guns well into
    // it, pistols a touch), whatever the animation's stance was; the head turns back so the face stays on the aim.
    this.blade(S, d.long ? BLADE_LONG : BLADE_PISTOL);
    // Shoulders where the animation (and the stance) put them.
    const sR = this.joint(S, R.upper, this.p0), sL = this.joint(S, L.upper, this.p1);
    const G = this.G;
    // Gun rotation: x along the aim, y left, z up.
    for (let r = 0; r < 3; r++) (G[r * 4] = D[r]), (G[r * 4 + 1] = -Rt[r]), (G[r * 4 + 2] = U[r]);
    const s = d.s;
    // Reload / draw / potato poses: the gun cants and lowers (angles in degrees, offsets in units).
    let cant = 0, dip = 0, inward = 0, lower = 0;
    const rl = this.reloadT >= 0 || this.cantK > 0.001 ? this.reloadPhase() : null;
    if (rl) {
      cant = rl.cant;
      dip = rl.dip;
      inward = rl.inward;
      lower = rl.lower;
    }
    if (this.drawT >= 0) {
      const k = 1 - smooth(this.drawT / DRAW);
      dip += 55 * k;
      lower += 4 * k;
      inward += 2 * k;
    }
    // Pivot: the fist (pistols) or the butt (long guns), placed in the body.
    const piv = this.q;
    if (d.long) {
      // The butt in the right shoulder's pocket: in from the joint toward the chest, a little forward and down.
      const hz = Math.hypot(D[0], D[1]) || 1;
      for (let r = 0; r < 3; r++) piv[r] = sR[r] - Rt[r] * (3.2 + inward - high * 6) + (r < 2 ? (D[r] / hz) * (1.6 + high * 5) : 0) - (r === 2 ? 1.2 + lower + high * 5 : 0);
      this.placeBy(d.butt, piv);
      // A short stock puts the grip almost on the shoulder (the arm folds flat and the elbow has no good place): the
      // gun slides forward along the aim until the grip is MIN_GRIP from the shoulder.
      const s3 = d.s, rg = d.right, Gm = this.G;
      const cx = Gm[3] + s3 * (Gm[0] * rg[3] + Gm[1] * rg[7] + Gm[2] * rg[11]) - sR[0];
      const cyy = Gm[7] + s3 * (Gm[4] * rg[3] + Gm[5] * rg[7] + Gm[6] * rg[11]) - sR[1];
      const cz = Gm[11] + s3 * (Gm[8] * rg[3] + Gm[9] * rg[7] + Gm[10] * rg[11]) - sR[2];
      const min = MIN_GRIP * (R.L1 + R.L2);
      if (cx * cx + cyy * cyy + cz * cz < min * min) {
        const cd = cx * D[0] + cyy * D[1] + cz * D[2], cc = cx * cx + cyy * cyy + cz * cz;
        const t = -cd + Math.sqrt(Math.max(0, cd * cd - cc + min * min));
        for (let r = 0; r < 3; r++) (Gm[r * 4 + 3] += D[r] * t), (piv[r] += D[r] * t);
      }
    } else {
      // Pistols: both hands out in front, a little right of the chest's middle, below the shoulders.
      for (let r = 0; r < 3; r++) piv[r] = (sR[r] + sL[r]) / 2 + Rt[r] * (1.2 - inward) - (r === 2 ? 4.5 + lower : 0);
      // The fist (gun-local right grip centre) at piv + Dp * t, t from the straight-wrist reach.
      const t = this.pistolReach(d, piv, sR, Dp);
      for (let r = 0; r < 3; r++) piv[r] += Dp[r] * t;
      this.placeBy([d.right[3], d.right[7], d.right[11]], piv);
    }
    // Gestures as rotations of the gun about the pivot: kick (muzzle up), cant (roll toward the support hand), dip.
    const flip = this.flip.x - dip;
    if (flip) this.turnGun(1, -flip * D2R, piv);
    this.stats.cant = cant;
    if (cant) this.turnGun(0, cant * D2R, piv);
    if (this.roll && !inp.still) this.turnGun(0, this.roll * this.flip.x * 0.08 * D2R, piv);
    if (this.back.x) for (let r = 0; r < 3; r++) G[r * 4 + 3] -= D[r] * this.back.x;

    // --- Bone 0: bind -> posed (gun-local -> posed composed with the bake's inverse).
    // = the right hand's skinning matrix while it grips: fist on the grip * the fist's bind frame^-1.
    const K0 = this.K0;
    this.fistOn(d.right, this.fistR);
    concat(this.fistR, 0, d.gripInv, 0, K0 as unknown as Float32Array, 0);
    for (let k = 0; k < 12; k++) this.skin[k] = K0[k];
    for (let k = 0; k < 12; k++) this.skin[12 + k] = K0[k];

    // --- Right hand on the grip (a bolt action's hand leaves it after a shot and throws the bolt).
    if (d.bolt && !inp.still) this.boltRight(d);
    this.reach(S, R, this.fistR, 0, U, (d.long ? SOFT_LONG : SOFT_PISTOL) * D2R);
    // --- Left hand: the support grip, or the reload's path (magazine / port / hip).
    this.fistOn(d.left, this.fistL);
    this.magHeld = false;
    if (rl && this.reloadT >= 0 && !inp.still) this.reloadLeft(d, rl.t, S);
    else if (this.sinceShot < 0.9 && (d.def.cls === "shotgun" && !!d.def.timing.pump)) this.pumpLeft(d);
    this.slideLeftIntoReach(S, L);
    this.reach(S, L, this.fistL, 1, U, SOFT_SUPPORT * D2R);
    // The magazine in the left fist where the hand actually got to (bone 1 = fist * fist_on_mag^-1 * K0).
    if (this.magHeld) {
      concat(S, L.hand * 12, fistFrames(this.r).L, 0, this.A as unknown as Float32Array, 0);
      concat(this.A, 0, this.magInv, 0, this.B as unknown as Float32Array, 0);
      concat(this.B, 0, this.K0, 0, this.T as unknown as Float32Array, 0);
      for (let k = 0; k < 12; k++) this.skin[12 + k] = this.T[k];
    }
    this.mirrorFingers(S);
    this.points(d);
  }

  /**
   * Turns the chest (Spine2 and everything above it) about the vertical through its joint so the shoulders' line makes
   * `want` degrees with the aim's right axis (+: the left shoulder forward), at most MAX_BLADE either way; the neck
   * turns back by as much so the head keeps facing where it did.
   */
  private blade(S: Float32Array, want: number): void {
    const [R, L] = this.arms;
    const sR = this.joint(S, R.upper, this.p0), sL = this.joint(S, L.upper, this.p1);
    const lx = sL[0] - sR[0], ly = sL[1] - sR[1];
    const D = this.d, Rt = this.rr;
    const hz = Math.hypot(D[0], D[1]) || 1;
    // Angle of the shoulder line (right -> left) from the aim's left axis, toward forward.
    const cur = Math.atan2((lx * D[0] + ly * D[1]) / hz, -(lx * Rt[0] + ly * Rt[1])) / D2R;
    const delta = clamp(want - cur, -MAX_BLADE, MAX_BLADE) * D2R;
    if (Math.abs(delta) < 1e-4) return;
    const ax = this.ax;
    ax[0] = 0, ax[1] = 0, ax[2] = 1;
    // Left shoulder forward = the chest turns right (clockwise from above): -delta about +z.
    this.joint(S, this.chest, this.p2);
    rotAbout(ax, -delta, this.p2, this.A);
    this.pre(S, this.chestSub, this.A, this.tmp);
    this.joint(S, this.neck, this.p2);
    rotAbout(ax, delta, this.p2, this.A);
    this.pre(S, this.neckSub, this.A, this.tmp);
  }

  /** The joint of bone i, posed (model space). */
  private joint(S: Float32Array, i: number, out: Float64Array): Float64Array {
    const B = this.bind, o = i * 12;
    const x = B[o + 3], y = B[o + 7], z = B[o + 11];
    for (let r = 0; r < 3; r++) out[r] = S[o + r * 4] * x + S[o + r * 4 + 1] * y + S[o + r * 4 + 2] * z + S[o + r * 4 + 3];
    return out;
  }

  /** Sets G's translation so gun-local point p (gun units) lands on posed point at. */
  private placeBy(p: ArrayLike<number>, at: ArrayLike<number>): void {
    const G = this.G, s = this.data!.s;
    for (let r = 0; r < 3; r++) G[r * 4 + 3] = at[r] - s * (G[r * 4] * p[0] + G[r * 4 + 1] * p[1] + G[r * 4 + 2] * p[2]);
  }

  /** Turns the gun about its own axis k (0 x, 1 y, 2 z) by ang (rad) about posed point piv. */
  private turnGun(k: number, ang: number, piv: ArrayLike<number>): void {
    const G = this.G, ax = this.ax;
    ax[0] = G[k], ax[1] = G[4 + k], ax[2] = G[8 + k];
    rotAbout(ax, ang, piv, this.A);
    // G is gun-local -> posed with the rotation part unscaled (s applied in placeBy / bake): rotate rows.
    concat(this.A, 0, G, 0, this.B as unknown as Float32Array, 0);
    G.set(this.B);
  }

  /**
   * Pistols: how far along the aim the fist goes so the right forearm continues the hand's line (a straight wrist) with
   * the elbow just short of locked: |E*(t) - shoulder| = 0.97 L1, E*(t) = wrist(t) - L2 * forearm direction.
   */
  private pistolReach(d: GunHoldData, base: ArrayLike<number>, shoulder: ArrayLike<number>, D: ArrayLike<number>): number {
    const R = this.arms[0];
    // The hand's skinning matrix at t = 0 (G placed with the fist at base).
    this.placeBy([d.right[3], d.right[7], d.right[11]], base);
    this.fistOn(d.right, this.fistR);
    concat(this.fistR, 0, d.gripInv, 0, this.T2 as unknown as Float32Array, 0);
    const H = this.T2, B = this.bind, o = R.hand * 12;
    const x = B[o + 3], y = B[o + 7], z = B[o + 11];
    const A = this.e;
    for (let r = 0; r < 3; r++) {
      const wrist = H[r * 4] * x + H[r * 4 + 1] * y + H[r * 4 + 2] * z + H[r * 4 + 3];
      const f = H[r * 4] * R.fb[0] + H[r * 4 + 1] * R.fb[1] + H[r * 4 + 2] * R.fb[2];
      A[r] = wrist - R.L2 * f - shoulder[r];
    }
    const ad = dot3(A, D), aa = dot3(A, A), L = 0.97 * R.L1;
    const disc = ad * ad - aa + L * L;
    const t = disc > 0 ? -ad + Math.sqrt(disc) : -ad;
    return clamp(t, 4, 26);
  }

  /** The posed fist frame (fist-local -> posed, rigid) of a grip (fist-local -> gun-local) on the posed gun G. */
  private fistOn(grip: M34, out: M34): M34 {
    const G = this.G, s = this.data!.s;
    // Rotation G.R * grip.R; origin G(grip.o) with the scale.
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) out[r * 4 + c] = G[r * 4] * grip[c] + G[r * 4 + 1] * grip[4 + c] + G[r * 4 + 2] * grip[8 + c];
      out[r * 4 + 3] = G[r * 4 + 3] + s * (G[r * 4] * grip[3] + G[r * 4 + 1] * grip[7] + G[r * 4 + 2] * grip[11]);
    }
    return out;
  }

  /**
   * Two-bone IK: the hand's skinning matrix becomes fist * F^-1 (F: the fist's bind frame), the wrist reached from the
   * shoulder; the elbow on its circle nearest a straight wrist, pulled down / out; the forearm takes TWIST_SHARE of
   * the hand's twist. Fingers follow the hand.
   */
  private reach(S: Float32Array, a: Arm, fist: M34, k: 0 | 1, up: ArrayLike<number>, soft = 0): void {
    const F = fistFrames(this.r);
    const Ht = this.T2;
    concat(fist, 0, a.side > 0 ? this.data!.gripInv : F.Linv, 0, Ht as unknown as Float32Array, 0);
    this.solveArm(S, a, Ht, k, up);
    if (soft > 0) {
      // A soft grip: the fist turns on the grip (about its centre) by up to `soft` toward the forearm's line, then the
      // arm reaches again. Where the forearm points vs where a straight wrist would have it: Rfore fb vs Rhand fb.
      const fo = a.fore * 12, ho = a.hand * 12, fb = a.fb, f = this.p1, h = this.p2;
      for (let r = 0; r < 3; r++) {
        f[r] = S[fo + r * 4] * fb[0] + S[fo + r * 4 + 1] * fb[1] + S[fo + r * 4 + 2] * fb[2];
        h[r] = S[ho + r * 4] * fb[0] + S[ho + r * 4 + 1] * fb[1] + S[ho + r * 4 + 2] * fb[2];
      }
      const ang = Math.acos(clamp(dot3(f, h) / (Math.hypot(f[0], f[1], f[2]) * Math.hypot(h[0], h[1], h[2]) || 1), -1, 1));
      if (ang > 0.01) {
        cross3(h, f, this.ax);
        norm3(this.ax, this.ax);
        rotAbout(this.ax, Math.min(ang, soft), [fist[3], fist[7], fist[11]], this.A);
        concat(this.A, 0, Ht, 0, this.B as unknown as Float32Array, 0);
        Ht.set(this.B);
        this.solveArm(S, a, Ht, k, up);
      }
    }
    this.twistForearm(S, a, k);
  }

  /** The two-bone solve for a hand target Ht (the hand's skinning matrix): upper arm, forearm, then the hand. */
  private solveArm(S: Float32Array, a: Arm, Ht: M34, k: 0 | 1, up: ArrayLike<number>): void {
    const B = this.bind, ho = a.hand * 12;
    const P0 = this.joint(S, a.upper, this.p0), P1 = this.joint(S, a.fore, this.p1);
    const W = this.w;
    for (let r = 0; r < 3; r++) W[r] = Ht[r * 4] * B[ho + 3] + Ht[r * 4 + 1] * B[ho + 7] + Ht[r * 4 + 2] * B[ho + 11] + Ht[r * 4 + 3];
    // Straight-wrist elbow: the wrist minus the forearm along the hand's line.
    const E = this.e;
    for (let r = 0; r < 3; r++) E[r] = W[r] - a.L2 * (Ht[r * 4] * a.fb[0] + Ht[r * 4 + 1] * a.fb[1] + Ht[r * 4 + 2] * a.fb[2]);
    // Down and out of the body: the elbow is pulled toward a point below and outside the shoulder.
    const out = this.ax;
    out[0] = E[0] - P0[0], out[1] = E[1] - P0[1], out[2] = E[2] - P0[2];
    const D0 = W[0] - P0[0], D1 = W[1] - P0[1], D2 = W[2] - P0[2];
    const dl = Math.hypot(D0, D1, D2) || 1;
    const L1 = a.L1, L2 = a.L2;
    const dd = clamp(dl, Math.abs(L1 - L2) + 0.05, L1 + L2 - 0.02);
    const dx = D0 / dl, dy = D1 / dl, dz = D2 / dl;
    this.stats.gap[k] = Math.max(0, dl - dd);
    // Pole: the straight-wrist elbow's direction, plus down and out (the shoulder's side, in the aim's right axis).
    const side = this.rr; // right
    const sideK = a.side * (k === 0 ? 0.22 : 0.25);
    let px = out[0] / L1 + side[0] * sideK - up[0] * 0.2;
    let py = out[1] / L1 + side[1] * sideK - up[1] * 0.2;
    let pz = out[2] / L1 + side[2] * sideK - up[2] * 0.2 - 0.2;
    const pd = px * dx + py * dy + pz * dz;
    px -= dx * pd, py -= dy * pd, pz -= dz * pd;
    const pl = Math.hypot(px, py, pz) || 1;
    px /= pl, py /= pl, pz /= pl;
    const along = (L1 * L1 - L2 * L2 + dd * dd) / (2 * dd), h = Math.sqrt(Math.max(0, L1 * L1 - along * along));
    const Ex = P0[0] + dx * along + px * h, Ey = P0[1] + dy * along + py * h, Ez = P0[2] + dz * along + pz * h;
    // Upper arm: elbow P1 -> E about the shoulder.
    const M = this.A, tmp = this.tmp;
    if (swingM([P1[0] - P0[0], P1[1] - P0[1], P1[2] - P0[2]], [Ex - P0[0], Ey - P0[1], Ez - P0[2]], P0, M, this.q)) this.pre(S, a.upperSub, M, tmp);
    // Forearm: wrist -> the reach point about the elbow.
    const P2 = this.joint(S, a.hand, this.p2);
    const Tx = P0[0] + dx * dd, Ty = P0[1] + dy * dd, Tz = P0[2] + dz * dd;
    if (swingM([P2[0] - Ex, P2[1] - Ey, P2[2] - Ez], [Tx - Ex, Ty - Ey, Tz - Ez], [Ex, Ey, Ez], M, this.q)) this.pre(S, a.foreSub, M, tmp);
    // Hand: to its target rotation, at the reached wrist (fingers carried along): delta = target * current^-1.
    if (this.stats.gap[k] > 0) (Ht[3] += Tx - W[0]), (Ht[7] += Ty - W[1]), (Ht[11] += Tz - W[2]);
    invert34(S, ho, tmp, 0);
    concat(Ht, 0, tmp, 0, this.B as unknown as Float32Array, 0);
    this.pre(S, a.handSub, this.B, this.tmp2);
  }

  /** Forearm twist: the forearm turns about its own axis by a share of the hand's twist against it; stats. */
  private twistForearm(S: Float32Array, a: Arm, k: 0 | 1): void {
    const fo = a.fore * 12, ho = a.hand * 12, M = this.A, tmp = this.tmp;
    const E = this.joint(S, a.fore, this.e);
    const Ex = E[0], Ey = E[1], Ez = E[2];
    // Q = Rfore^T Rhand (bind space); twist about fb.
    const Q = this.Rm;
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++) Q[r * 4 + c] = S[fo + r] * S[ho + c] + S[fo + 4 + r] * S[ho + 4 + c] + S[fo + 8 + r] * S[ho + 8 + c];
    // Quaternion of Q (w, v).
    const tr = Q[0] + Q[5] + Q[10];
    let qw: number, qx: number, qy: number, qz: number;
    if (tr > 0) {
      const s4 = Math.sqrt(tr + 1) * 2;
      qw = 0.25 * s4, qx = (Q[9] - Q[6]) / s4, qy = (Q[2] - Q[8]) / s4, qz = (Q[4] - Q[1]) / s4;
    } else if (Q[0] > Q[5] && Q[0] > Q[10]) {
      const s4 = Math.sqrt(1 + Q[0] - Q[5] - Q[10]) * 2;
      qw = (Q[9] - Q[6]) / s4, qx = 0.25 * s4, qy = (Q[1] + Q[4]) / s4, qz = (Q[2] + Q[8]) / s4;
    } else if (Q[5] > Q[10]) {
      const s4 = Math.sqrt(1 + Q[5] - Q[0] - Q[10]) * 2;
      qw = (Q[2] - Q[8]) / s4, qx = (Q[1] + Q[4]) / s4, qy = 0.25 * s4, qz = (Q[6] + Q[9]) / s4;
    } else {
      const s4 = Math.sqrt(1 + Q[10] - Q[0] - Q[5]) * 2;
      qw = (Q[4] - Q[1]) / s4, qx = (Q[2] + Q[8]) / s4, qy = (Q[6] + Q[9]) / s4, qz = 0.25 * s4;
    }
    const fb = a.fb;
    const proj = qx * fb[0] + qy * fb[1] + qz * fb[2];
    let twist = 2 * Math.atan2(proj, qw);
    twist = Math.atan2(Math.sin(twist), Math.cos(twist));
    // Swing (bend) = the rotation left after removing the twist: angle = 2 acos(|w| / |twist part|).
    const tl = Math.hypot(qw, proj) || 1;
    const bend = 2 * Math.acos(clamp(tl, 0, 1));
    const share = TWIST_SHARE;
    const fdir = this.q;
    for (let r = 0; r < 3; r++) fdir[r] = S[fo + r * 4] * fb[0] + S[fo + r * 4 + 1] * fb[1] + S[fo + r * 4 + 2] * fb[2];
    rotAbout(norm3(fdir, fdir), twist * share, [Ex, Ey, Ez], M);
    concat(M, 0, S, fo, tmp, 0);
    S.set(tmp, fo);
    this.stats.bend[k] = bend / D2R;
    this.stats.twist[k] = (twist * (1 - share)) / D2R;
  }

  /** Premultiplies M onto the bones in sub. */
  private pre(S: Float32Array, sub: number[], M: ArrayLike<number>, tmp: Float32Array): void {
    for (const i of sub) {
      concat(M, 0, S, i * 12, tmp, 0);
      S.set(tmp, i * 12);
    }
  }

  /** The left hand's fingers curl like the right's (mirrored): a fist round the fore-end / the right hand. */
  private mirrorFingers(S: Float32Array): void {
    const [R, L] = this.arms;
    const n = Math.min(R.fingers.length, L.fingers.length);
    const inv = this.tmp, rel = this.tmp2, Ro = R.hand * 12, Lo = L.hand * 12;
    invert34(S, Ro, inv, 0);
    for (let i = 0; i < n; i++) {
      // rel = S_Rhand^-1 S_Rfinger (bind space), mirrored across x = 0: M rel M with M = diag(-1, 1, 1).
      concat(inv, 0, S, R.fingers[i] * 12, rel, 0);
      rel[1] = -rel[1], rel[2] = -rel[2], rel[3] = -rel[3], rel[4] = -rel[4], rel[8] = -rel[8];
      concat(S, Lo, rel, 0, this.T as unknown as Float32Array, 0);
      for (let k = 0; k < 12; k++) S[L.fingers[i] * 12 + k] = this.T[k];
    }
  }

  /** If the support grip is out of the left arm's reach, slide it back along the gun until it isn't. */
  private slideLeftIntoReach(S: Float32Array, L: Arm): void {
    const d = this.data!;
    if (!d.long) return;
    const P0 = this.joint(S, L.upper, this.p0), f = this.fistL, G = this.G;
    const max = L.L1 + L.L2 - 1.0;
    // Fist centre -> wrist is ~3 units; measure from the fist's centre with that margin.
    const dist = Math.hypot(f[3] - P0[0], f[7] - P0[1], f[11] - P0[2]) + 2.5;
    if (dist <= max) return;
    // Along the barrel (G's x), back toward the shoulder: solve |f - t x - P0| = max - 2.5 for t.
    const ox = f[3] - P0[0], oy = f[7] - P0[1], oz = f[11] - P0[2];
    const bx = G[0], by = G[4], bz = G[8];
    const ob = ox * bx + oy * by + oz * bz, oo = ox * ox + oy * oy + oz * oz, m = max - 2.5;
    const disc = ob * ob - oo + m * m;
    const t = clamp(disc > 0 ? ob - Math.sqrt(disc) : ob, 0, 9 * d.s);
    f[3] -= bx * t, f[7] -= by * t, f[11] -= bz * t;
  }

  /**
   * A bolt action after a shot (GunTiming.pump: when and how long): the right fist goes from the grip to the knob,
   * lifts it, throws it back and home, and returns to the grip. The gun has its own bone, so it stays on the shoulder.
   */
  private boltRight(d: GunHoldData): void {
    const p = d.def.timing.pump;
    if (!p) return;
    const t = this.sinceShot;
    if (t > p.at + p.dur + 0.05) return;
    const k = ramp(t, p.at - 0.05, p.at + p.dur * 0.18) * (1 - ramp(t, p.at + p.dur * 0.8, p.at + p.dur + 0.05));
    if (k <= 0) return;
    // The knob's fist frame (tube convention, the bunny's right fist) as a grip-convention target for this hand.
    const F = fistFrames(this.r), tmp = this.fistTmp;
    this.fistOn(d.bolt!, tmp);
    concat(tmp, 0, F.Rinv, 0, this.A as unknown as Float32Array, 0);
    concat(this.A, 0, d.grip, 0, this.B as unknown as Float32Array, 0);
    this.blendFist(this.fistR, this.B, k);
    // Lift (up) then back and home along the bore.
    const G = this.G, s = d.s;
    const lift = ramp(t, p.at + p.dur * 0.15, p.at + p.dur * 0.3) * (1 - ramp(t, p.at + p.dur * 0.6, p.at + p.dur * 0.75));
    const back = ramp(t, p.at + p.dur * 0.3, p.at + p.dur * 0.42) * (1 - ramp(t, p.at + p.dur * 0.48, p.at + p.dur * 0.6));
    for (let r = 0; r < 3; r++) this.fistR[r * 4 + 3] += G[r * 4 + 2] * lift * 0.5 * s - G[r * 4] * back * 2.3 * s;
  }

  /** Shotgun pump after a shot: the left hand runs back and home along the fore-end. */
  private pumpLeft(d: GunHoldData): void {
    const p = d.def.timing.pump!;
    const t = this.sinceShot;
    const k = ramp(t, p.at, p.at + p.dur * 0.45) - ramp(t, p.at + p.dur * 0.5, p.at + p.dur);
    const G = this.G, f = this.fistL;
    for (let r = 0; r < 3; r++) f[r * 4 + 3] -= G[r * 4] * k * 2.4 * d.s;
  }

  /** Where the reload is: the phase clock (0..1) and the gun's cant / dip (muzzle down +) / offsets. */
  private reloadPhase(): { t: number; cant: number; dip: number; inward: number; lower: number } {
    const len = this.reloadShell ? this.reloadLen + 0.35 : this.reloadLen;
    const t = clamp(this.reloadT / len, 0, 1);
    const k = this.cantK;
    const long = this.data!.long;
    return { t, cant: (long ? 32 : 28) * k, dip: (long ? 7 : -10) * k, inward: (long ? 1.5 : 2.5) * k, lower: (long ? 2.0 : 2.5) * k };
  }

  /** The left hand's reload path (overrides fistL). Magazine guns: grip -> magazine -> hip -> magazine -> grip (-> rack). */
  private reloadLeft(d: GunHoldData, t: number, S: Float32Array): void {
    const f = this.fistL, tmp = this.fistTmp;
    // The pouch: low in front of the belly, a little to the left (seen from either side), below the gun.
    const P = this.joint(S, this.pelvis, this.p2);
    const Rt = this.rr, G = this.G;
    const hz = Math.hypot(G[0], G[4]) || 1;
    const hip = this.hip;
    for (let r = 0; r < 3; r++) hip[r] = P[r] - Rt[r] * 3 + (r < 2 ? (G[r * 4] / hz) * 8 : 8);
    if (this.reloadShell || !d.mag) {
      // Tube gun: hip -> port, once per shell (the clock restarts per shell).
      const port = d.port ?? d.left;
      this.fistOn(port, tmp);
      // Each shell: from the port down to the hip for a shell and back up, pressing it in at the end.
      const len = this.reloadLen + 0.35;
      const tt = clamp(this.reloadT / len, 0, 1);
      this.blendFist(f, tmp, this.cantK);
      const k = ramp(tt, 0.05, 0.4) * (1 - ramp(tt, 0.45, 0.85));
      for (let r = 0; r < 3; r++) f[r * 4 + 3] += (hip[r] - f[r * 4 + 3]) * k * 0.8;
      const press = Math.sin(clamp((tt - 0.85) / 0.12, 0, 1) * Math.PI);
      for (let r = 0; r < 3; r++) f[r * 4 + 3] += G[r * 4 + 2] * press * 0.7;
      return;
    }
    // Magazine: the old one comes out and goes well down (a long pull you read from either side), the new one up.
    this.fistOn(d.mag, tmp);
    for (let r = 0; r < 3; r++) hip[r] = tmp[r * 4 + 3] - Rt[r] * 2 + (r < 2 ? (G[r * 4] / hz) * 2 : -9);
    const toMag = ramp(t, 0.08, 0.22) * (1 - ramp(t, 0.66, 0.78));
    this.blendFist(f, tmp, toMag);
    // Down to the hip with the old one and back up with the new (0.24 .. 0.56), the shove home at 0.58.
    const out = ramp(t, 0.24, 0.36) * (1 - ramp(t, 0.42, 0.56));
    for (let r = 0; r < 3; r++) f[r * 4 + 3] += (hip[r] - f[r * 4 + 3]) * out;
    const shove = Math.sin(clamp((t - 0.56) / 0.06, 0, 1) * Math.PI);
    for (let r = 0; r < 3; r++) f[r * 4 + 3] += G[r * 4 + 2] * shove * 0.8;
    // The magazine rides in the hand while it's out (placed after the arm reaches: magInHand).
    this.magHeld = out > 0.02;
    if (this.magHeld) inv34(tmp, this.magInv);
    // Empty: rack (the slide / handle) after the magazine.
    if (this.reloadEmpty && d.rack) {
      this.fistOn(d.rack, tmp);
      const rk = ramp(t, 0.64, 0.72) * (1 - ramp(t, 0.82, 0.9));
      this.blendFist(f, tmp, rk);
      const pull = ramp(t, 0.72, 0.77) * (1 - ramp(t, 0.77, 0.8));
      for (let r = 0; r < 3; r++) f[r * 4 + 3] -= G[r * 4] * pull * 1.6 * d.s;
    }
  }

  /** f = f blended toward g by k (positions linearly, rotations by a normalised lerp of the axes). */
  private blendFist(f: M34, g: M34, k: number): void {
    if (k <= 0) return;
    if (k >= 1) {
      f.set(g);
      return;
    }
    for (let i = 0; i < 12; i++) f[i] += (g[i] - f[i]) * k;
    // Re-orthonormalise the rotation (columns a, b; c = a x b).
    const a = norm3([f[0], f[4], f[8]]);
    const b0 = [f[1], f[5], f[9]];
    const dd = dot3(a, b0);
    const b = norm3([b0[0] - a[0] * dd, b0[1] - a[1] * dd, b0[2] - a[2] * dd]);
    const c = cross3(a, b);
    for (let r = 0; r < 3; r++) (f[r * 4] = a[r]), (f[r * 4 + 1] = b[r]), (f[r * 4 + 2] = c[r]);
  }

  /** Muzzle / barrel / port / throw in posed model space from bone 0. */
  private points(d: GunHoldData): void {
    const K = this.skin, b = d.bake;
    const at = (p: ArrayLike<number>, out: Float64Array) => {
      const q = xform(b, 0, p);
      for (let r = 0; r < 3; r++) out[r] = K[r * 4] * q[0] + K[r * 4 + 1] * q[1] + K[r * 4 + 2] * q[2] + K[r * 4 + 3];
    };
    const dir = (v: ArrayLike<number>, out: Float64Array) => {
      const q = [b[0] * v[0] + b[1] * v[1] + b[2] * v[2], b[4] * v[0] + b[5] * v[1] + b[6] * v[2], b[8] * v[0] + b[9] * v[1] + b[10] * v[2]];
      for (let r = 0; r < 3; r++) out[r] = K[r * 4] * q[0] + K[r * 4 + 1] * q[1] + K[r * 4 + 2] * q[2];
      norm3(out, out);
    };
    at(this.silenced && d.def.silencer ? d.def.silencer.tip : d.muzzle, this.muzzle);
    dir([1, 0, 0], this.barrel);
    at(d.eject.p, this.port);
    dir(d.eject.dir, this.throwDir);
  }
}
