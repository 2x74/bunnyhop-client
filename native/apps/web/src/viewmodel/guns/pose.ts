// The gun viewmodel's pose (no DOM, no rendering: the viewmodel draws it, the audits check it headless). Source
// viewmodel space, 3x4 bone-to-model per bone of guns/rig.ts (hands + gun):
//   gun        framing (GunDef.frame) * animation (guns/anim.ts: clips + recoil spring) about the right grip
//   parts      slide / pump / magazine / shell bones from the pose
//   right hand rides the gun (the solved hold, guns/hold.ts), fingers from the solved curls + the trigger squeeze
//   left hand  its support grip (on the gun or the pump), or a target on the gun (reloads, racks, inspects) plus a
//              view-space trip (off screen for a new magazine), blended; fingers blend from the solved grip to a preset
//   silencer   the can on the bore (turned / wound out along the thread) or carried; the left hand's "sil" target is
//              its solved grip on the can (guns/hold.ts solveSilencerHand), riding the can
//   forearms   re-aimed from each wrist toward an elbow anchor (the sleeves follow the hands without twisting)
//   safety     fingers.ts clampFingers on both hands (nothing bends backwards, whatever a blend did)
// No allocation per frame.

import { concat, invert34, type V3 } from "../../player/bunny/rig";
import type { GloveStyleId } from "../../loadout";
import { angleMatrix, rotAbout } from "../math";
import { clampFingers } from "../fingers";
import { GunAnimator, type CurlPreset, type GunPose } from "./anim";
import { FingerPoser, flatCurls, handAt, solveHand, solveSilencerHand, type SolvedHand } from "./hold";
import { gunRig } from "./rig";
import type { GunDef, GunPart } from "./types";

/** Left-hand finger presets (deg per joint + spread; index, middle, ring, pinky, thumb). */
const PRESET_CURLS: Record<Exclude<CurlPreset, "support" | "sil">, [number, number, number, number][]> = {
  open: [[8, 14, 10, 4], [10, 16, 10, 0], [12, 16, 10, -2], [14, 16, 10, -4], [4, 10, 8, 4]],
  mag: [[48, 52, 36, 0], [56, 60, 42, 0], [62, 64, 46, 0], [66, 66, 48, 0], [8, 22, 18, 10]],
  pinch: [[46, 56, 40, 0], [72, 84, 60, 0], [80, 88, 64, 0], [84, 88, 64, 0], [14, 30, 28, 12]],
  shell: [[30, 40, 30, 0], [48, 58, 44, 0], [76, 84, 64, 0], [82, 84, 64, 0], [8, 16, 12, 10]],
  flat: [[4, 6, 4, 2], [4, 6, 4, 0], [4, 6, 4, -2], [6, 6, 4, -4], [2, 6, 4, 6]],
};
const PRESETS = Object.fromEntries(Object.entries(PRESET_CURLS).map(([k, v]) => [k, Float32Array.from(v.flat())])) as Record<Exclude<CurlPreset, "support" | "sil">, Float32Array>;
/** The right index off the trigger, along the frame (reloads, inspects). */
const INDEX_OFF: [number, number, number] = [6, 8, 4];

/** Largest bob / sway / lag offset (forward, left, up / down; units) a gun takes from the knife viewmodel's feel. */
export const FEEL_MAX = { fwd: 2, left: 2.5, up: 2.5, down: 4 } as const;

/**
 * The knife viewmodel's feel matrix (3x4: bob, sway, lag, crouch, landing dip) for a gun: its offset stays a nudge.
 * The knife's lag can stick at its extreme (a view snapped exactly 180 degrees by a teleport / restart, no mouse motion
 * since: a 10-unit pull back), which would push a gun's slide into the camera.
 */
export function clampFeel(feel: ArrayLike<number>, out: Float32Array): Float32Array {
  for (let i = 0; i < 12; i++) out[i] = feel[i];
  out[3] = Math.max(-FEEL_MAX.fwd, Math.min(FEEL_MAX.fwd, out[3]));
  out[7] = Math.max(-FEEL_MAX.left, Math.min(FEEL_MAX.left, out[7]));
  out[11] = Math.max(-FEEL_MAX.down, Math.min(FEEL_MAX.up, out[11]));
  return out;
}

/**
 * How much the forearms aim at the elbow anchors (1) vs continue the hand (0), and the most a wrist may bend (deg)
 * between the line the hand continues and its forearm: the firing hand nearly straight, the support hand a little
 * more (the forearm still heads toward its anchor, only as far as that allows).
 */
export const ARM = { anchor: 0.9, bendR: 14, bendL: 24 };
/** The firing wrist's limit while the hand is on a bolt (GunPose.rightW). */
const BOLT_WRIST = 55;
/**
 * Elbow anchors (view space): forearms aim from the wrists back toward these. The pistols' (and the default): out to
 * each side and down, so the two forearms open into a V below the gun and leave the screen at its bottom edge instead
 * of standing up as two sleeves. Long guns set their own (GunDef.elbows): the support elbow tucks in under the gun,
 * so that sleeve drops out of view behind it right below the hand rather than crossing the screen.
 */
export const ELBOW: Record<"R" | "L", V3> = { R: [10, -20, -24], L: [10, 10, -24] };

export class GunPoser {
  readonly anim = new GunAnimator(null as unknown as GunDef);
  def: GunDef | null = null;
  /** The finger safety clamp (fingers.ts); off only in audits (to see the raw pose). */
  clamp = true;
  private rig = gunRig();
  private W: Float32Array;
  private right: SolvedHand | null = null;
  private left: SolvedHand | null = null;
  /** The left hand solved onto the silencer (null: no silencer). */
  private onSil: SolvedHand | null = null;
  private curlsSil = new Float32Array(20);
  private targets = new Map<string, Float32Array>();
  /** The right hand on a bolt action's knob (GunDef.places.bolt; relative to the bolt), or null. */
  private rightBolt: Float32Array | null = null;
  private poserR = new FingerPoser("R");
  private poserL = new FingerPoser("L");
  private curlsR = new Float32Array(20);
  private curlsL = new Float32Array(20);
  private cR = new Float32Array(20);
  private cL = new Float32Array(20);
  // Scratch.
  private G = new Float32Array(12);
  private T = new Float32Array(12);
  private T2 = new Float32Array(12);
  private T3 = new Float32Array(12);
  private C = new Float32Array(12);
  private C2 = new Float32Array(12);
  private C3 = new Float32Array(12);
  private C4 = new Float32Array(12);
  private pivot = new Float32Array(3);
  private H = new Float32Array(12);
  private prevLeft = new Float32Array(12);
  private hadLeft = false;
  private bones: { R: ArmBones; L: ArmBones };

  constructor() {
    const r = this.rig;
    this.W = new Float32Array(r.count * 12);
    for (let i = 0; i < r.count; i++) this.W.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], i * 12);
    this.W.set(r.hands.bind);
    this.bones = { R: armBones("R"), L: armBones("L") };
  }

  /** The gun (solves its holds in this glove style on first use, cached). `keepAnim`: same gun, new gloves. */
  setGun(def: GunDef | null, glove: GloveStyleId, keepAnim = false): void {
    this.def = def;
    this.hadLeft = false;
    if (!def) return;
    this.right = solveHand(def, "R", glove);
    this.left = solveHand(def, "L", glove);
    flatCurls(this.right.curls, this.curlsR);
    flatCurls(this.left.curls, this.curlsL);
    this.onSil = solveSilencerHand(def, glove);
    if (this.onSil) flatCurls(this.onSil.curls, this.curlsSil);
    this.targets.clear();
    for (const [k, pl] of Object.entries(def.places)) if (pl && k !== "bolt") this.targets.set(k, handAt("L", pl));
    this.rightBolt = def.places.bolt ? handAt("R", def.places.bolt) : null;
    if (!keepAnim || this.anim.def !== def) this.anim.setGun(def);
  }

  draw(): void {
    this.anim.draw();
    this.hadLeft = false;
  }

  /** Advances the animation by dt and poses every bone. */
  update(dt: number): void {
    if (!this.def) return;
    this.anim.update(dt);
    this.pose(this.def, this.anim.pose);
  }

  private partMatrix(part: GunPart): number {
    return this.rig.part(part) * 12;
  }

  /** Bone index of a gun part (bonesW offsets are index * 12). */
  partIndex(part: GunPart): number {
    return this.rig.part(part);
  }

  private pose(def: GunDef, p: GunPose): void {
    const W = this.W, r = this.rig, R = this.right!, L = this.left!;
    const G = this.G, T = this.T, T2 = this.T2;
    // --- Gun: framing * (offset, rotation about the right grip).
    const fr = def.frame;
    const piv = def.right.o;
    angleMatrix(fr.a[0], fr.a[1], fr.a[2], fr.o[0], fr.o[1], fr.o[2], T);
    angleMatrix(p.a[0], p.a[1], p.a[2], 0, 0, 0, T2);
    // T2 about the pivot: p + R (x - p)
    T2[3] = piv[0] - (T2[0] * piv[0] + T2[1] * piv[1] + T2[2] * piv[2]);
    T2[7] = piv[1] - (T2[4] * piv[0] + T2[5] * piv[1] + T2[6] * piv[2]);
    T2[11] = piv[2] - (T2[8] * piv[0] + T2[9] * piv[1] + T2[10] * piv[2]);
    concat(T, 0, T2, 0, G, 0);
    // View-space offset (forward, left, up) on top.
    G[3] += p.o[0];
    G[7] += p.o[1];
    G[11] += p.o[2];
    const gi = this.partMatrix("Gun");
    W.set(G, gi);
    // --- Parts.
    translateLocal(G, -p.slide, 0, 0, W, this.partMatrix("Slide"));
    translateLocal(G, -p.pump, 0, 0, W, this.partMatrix("Pump"));
    if (def.bolt && p.bolt) {
      // A bolt action: turned up about its own axis (nose of the handle rising), then drawn back.
      const pi = this.partMatrix("Pump");
      rotX(def.bolt.side * p.bolt * D2R, def.bolt.axis[0], def.bolt.axis[1], this.C);
      concat(W, pi, this.C, 0, this.C2, 0);
      W.set(this.C2, pi);
    }
    // The trigger swings back about its pivot with the squeeze.
    const ti = this.partMatrix("Trig");
    if (def.trigger && p.trigger > 0) {
      rotY(TRIGGER_DEG * D2R * Math.min(1, p.trigger), def.trigger[0], def.trigger[2], this.C);
      concat(G, 0, this.C, 0, W, ti);
    } else W.set(G, ti);
    // --- Right hand on the grip (rides the gun), fingers from the solved curls.
    const hR = this.bones.R.hand * 12;
    concat(G, 0, R.handInGun, 0, W, hR);
    if (p.rightW > 0 && this.rightBolt) {
      // Off the grip onto the bolt knob, riding the bolt (turned and drawn back with it).
      concat(W, this.partMatrix("Pump"), this.rightBolt, 0, T, 0);
      for (let i = 0; i < 12; i++) this.C[i] = W[hR + i];
      lerpRigid(this.C, T, p.rightW, this.C2);
      W.set(this.C2, hR);
    }
    const cR = this.cR;
    cR.set(this.curlsR);
    // Trigger squeeze (index MCP / PIP), index off the trigger along the frame, the thumb flick.
    const sq = p.trigger;
    cR[0] += 10 * sq;
    cR[1] += 14 * sq;
    cR[2] += 6 * sq;
    if (p.indexOff > 0) for (let k = 0; k < 3; k++) cR[k] += (INDEX_OFF[k] - cR[k]) * p.indexOff;
    if (p.thumb > 0) {
      cR[17] += 18 * p.thumb;
      cR[18] += 10 * p.thumb;
    }
    if (p.rightW > 0) for (let i = 0; i < 20; i++) cR[i] += (PRESETS.pinch[i] - cR[i]) * p.rightW;
    this.poserR.pose(W, (i, k) => cR[i * 4 + k], (i) => cR[i * 4 + 3]);
    // --- Left hand: support (on the gun / the pump), or a target, plus a view-space trip.
    const hL = this.bones.L.hand * 12;
    const support = def.left.part === "Pump" ? this.partMatrix("Pump") : gi;
    concat(W, support, L.handInGun, 0, this.H, 0);
    const tgt = p.leftT ? this.targets.get(p.leftT) : undefined;
    if (p.leftT === "sil" && this.onSil && p.leftW > 0) {
      // Around the can: the can's frame with the hand's own roll (it rolls back between twists while the can stays),
      // lifted off radially in a re-grip; the hand rides it.
      this.canFrame(def, p, p.handRoll, p.handLift, this.C);
      concat(G, 0, this.C, 0, this.C2, 0);
      concat(this.C2, 0, this.onSil.handInGun, 0, T, 0);
      lerpRigid(this.H, T, p.leftW, this.H);
    } else if (tgt && p.leftW > 0) {
      // On a target; the magazine target rides with the magazine's travel.
      if (p.leftT === "mag" && p.magHand && def.mag) {
        translateLocal(G, def.mag.out[0] * p.mag, def.mag.out[1] * p.mag, def.mag.out[2] * p.mag, this.T3, 0);
        concat(this.T3, 0, tgt, 0, T, 0);
      } else if (p.leftT === "rack" && def.bolt) concat(W, this.partMatrix("Pump"), tgt, 0, T, 0);
      else concat(G, 0, tgt, 0, T, 0);
      lerpRigid(this.H, T, p.leftW, this.H);
    }
    this.H[3] += p.leftOff[0];
    this.H[7] += p.leftOff[1];
    this.H[11] += p.leftOff[2];
    // Crossfade from the previous clip's final left hand (a target can't be blended by name).
    if (this.anim.leftFade > 0 && this.hadLeft) lerpRigid(this.H, this.prevLeft, this.anim.leftFade * this.anim.leftFade * (3 - 2 * this.anim.leftFade), this.H);
    else this.prevLeft.set(this.H);
    if (this.anim.leftFade <= 0) this.prevLeft.set(this.H);
    this.hadLeft = true;
    W.set(this.H, hL);
    const cL = this.cL;
    cL.set(this.curlsL);
    if (p.leftCurl !== "support" && p.leftCurlW > 0) {
      // The silencer grip only means something on the can: elsewhere (blending in / out) it follows the target weight.
      const pre = p.leftCurl === "sil" ? (this.onSil ? this.curlsSil : PRESETS.mag) : PRESETS[p.leftCurl];
      const w = Math.min(1, p.leftCurl === "sil" ? p.leftCurlW * p.leftW : p.leftCurlW);
      for (let i = 0; i < 20; i++) cL[i] += (pre[i] - cL[i]) * w;
    }
    if (p.leftOpen > 0) {
      const pre = PRESETS.open;
      const w = Math.min(1, p.leftOpen);
      for (let i = 0; i < 20; i++) cL[i] += (pre[i] - cL[i]) * w;
    }
    this.poserL.pose(W, (i, k) => cL[i * 4 + k], (i) => cL[i * 4 + 3]);
    // --- Magazine: seated / sliding out along its axis / falling, or in the left hand.
    const mi = this.partMatrix("Mag");
    if (p.magHide) W.fill(0, mi, mi + 12);
    else if (def.mag) {
      const out = def.mag.out;
      if (p.magHand) {
        const mt = this.targets.get("mag");
        if (mt) {
          // W[mag] = W[left hand] * inverse(hand at "mag") * T(out * mag)
          invert34(mt, 0, T, 0);
          concat(W, hL, T, 0, T2, 0);
          translateLocal(T2, out[0] * p.mag, out[1] * p.mag, out[2] * p.mag, W, mi);
        } else W.set(G, mi);
      } else {
        translateLocal(G, out[0] * p.mag, out[1] * p.mag, out[2] * p.mag, W, mi);
        if (p.magSpin) {
          // Tumbling as it falls: about gun-local y through its pivot.
          const mp = def.mag.p;
          rotY(p.magSpin * D2R, mp[0], mp[2], this.C);
          concat(W, mi, this.C, 0, this.C2, 0);
          W.set(this.C2, mi);
        }
        W[mi + 3] += p.magDrop[0];
        W[mi + 7] += p.magDrop[1];
        W[mi + 11] += p.magDrop[2];
      }
    } else W.set(G, mi);
    // --- The left hand's shell (Aux): built seated in the port; rides in the fingers, then slides in.
    const ai = this.partMatrix("Aux");
    const port = this.targets.get("port");
    if (p.aux > 0 && port) {
      invert34(port, 0, T, 0);
      concat(W, hL, T, 0, T2, 0);
      // Before it's in: back out of the port toward the hand (gun-local -x, down).
      const k = 1 - p.auxIn;
      translateLocal(T2, -1.3 * k, 0, -0.6 * k, W, ai);
    } else if (def.id === "fiveseven") {
      // The Jackrabbit's ears ride the slide and flop back / forward about their base (p.tail: shots, the inspect).
      const si = this.partMatrix("Slide");
      if (p.tail) {
        rotY(-p.tail * 0.38, EAR_C[0], EAR_C[2], this.C);
        concat(W, si, this.C, 0, this.C2, 0);
        W.set(this.C2, ai);
      } else W.copyWithin(ai, si, si + 12);
    } else if (def.id === "usp" || def.id === "p90") {
      // The Cottontail's tail / the Seed Drill's pod lid ride the slide / the magazine with a wobble (scale).
      const base = def.id === "usp" ? this.partMatrix("Slide") : mi;
      W.copyWithin(ai, base, base + 12);
      if (p.tail) scaleAbout(W, ai, def.id === "usp" ? TAIL_C : POD_C, 1 + 0.18 * p.tail, 1 - 0.12 * p.tail);
    } else W.fill(0, ai, ai + 12);
    // --- The silencer: on the bore (turned, wound out along the thread) or carried; collapsed while it's off.
    const si = this.partMatrix("Sil");
    if (def.silencer && p.sil > 0) {
      this.canFrame(def, p, p.silSpin, 0, this.C);
      concat(G, 0, this.C, 0, W, si);
    } else W.fill(0, si, si + 12);
    // --- Forearms toward the elbows; wrist helpers with the hands.
    this.arm("R");
    this.arm("L");
    // Safety net: no finger joint past its range on either hand (audits turn it off to check the raw pose).
    if (this.clamp) clampFingers(W, r.hands, "both");
  }

  /**
   * The can's frame (gun-local; the can is built seated, so this is its bone's matrix relative to the gun): turned by
   * `spin` about the bore, `lift` units off it radially (the hand's re-grip), wound out silX along the bore, tilted
   * about its seat (silPitch / silYaw) and offset (silOff) while it's carried.
   */
  private canFrame(def: GunDef, p: GunPose, spin: number, lift: number, out: Float32Array): void {
    const sil = def.silencer!;
    const ay = sil.axis[0], az = sil.axis[1];
    const S = this.C3, R = this.C4, pv = this.pivot;
    // Spin about the bore (x through (ay, az)); a lift moves it out along the turned "up" (the side the knuckles are).
    pv[0] = 0, pv[1] = ay, pv[2] = az;
    rotAbout(X_AXIS, spin * D2R, pv, S);
    if (lift) {
      const r = spin * D2R;
      S[7] += -Math.sin(r) * lift;
      S[11] += Math.cos(r) * lift;
    }
    S[3] += p.silX;
    // Tilt about the seat: pitch (nose up) about -y, yaw (nose left) about z.
    pv[0] = sil.seat;
    if (p.silPitch || p.silYaw) {
      rotAbout(Y_NEG, p.silPitch * D2R, pv, R);
      concat(R, 0, S, 0, out, 0);
      rotAbout(Z_AXIS, p.silYaw * D2R, pv, R);
      concat(R, 0, out, 0, S, 0);
    }
    out.set(S);
    out[3] += p.silOff[0];
    out[7] += p.silOff[1];
    out[11] += p.silOff[2];
  }

  /** Re-aims a forearm from its posed wrist back toward the elbow anchor (minimal swing of the hand's rigid move). */
  private arm(side: "R" | "L"): void {
    const W = this.W, b = this.bones[side], r = this.rig.hands;
    const h = b.hand * 12;
    // Rigid move of the hand from bind: Gh = W[hand] * inverse(bind[hand]).
    concat(W, h, b.invHand, 0, this.T, 0);
    const wrist: V3 = [W[h + 3], W[h + 7], W[h + 11]];
    const T = this.T;
    // Bind forearm direction (elbow -> wrist), carried by the hand's move.
    const d = b.dir;
    const cur: V3 = [T[0] * d[0] + T[1] * d[1] + T[2] * d[2], T[4] * d[0] + T[5] * d[1] + T[6] * d[2], T[8] * d[0] + T[9] * d[1] + T[10] * d[2]];
    const e = this.def?.elbows?.[side] ?? ELBOW[side];
    let want: V3 = [wrist[0] - e[0], wrist[1] - e[1], wrist[2] - e[2]];
    const wl = Math.hypot(want[0], want[1], want[2]) || 1;
    // Halfway between a straight wrist (the forearm continuing the hand) and the elbow anchor.
    const cl = Math.hypot(cur[0], cur[1], cur[2]) || 1;
    const k = ARM.anchor;
    want = [(want[0] / wl) * k + (cur[0] / cl) * (1 - k), (want[1] / wl) * k + (cur[1] / cl) * (1 - k), (want[2] / wl) * k + (cur[2] / cl) * (1 - k)];
    const hl = Math.hypot(want[0], want[1], want[2]) || 1;
    want = [want[0] / hl, want[1] / hl, want[2] / hl];
    // Keep the wrist nearly straight: no more than ARM.bendR / bendL from the hand's own line (a slerp from it).
    const cn: V3 = [cur[0] / cl, cur[1] / cl, cur[2] / cl];
    const th = Math.acos(Math.max(-1, Math.min(1, cn[0] * want[0] + cn[1] * want[1] + cn[2] * want[2])));
    let limDeg = this.def?.wrist?.[side] ?? (side === "R" ? ARM.bendR : ARM.bendL);
    // Working a bolt, the firing wrist turns (its forearm drops toward the elbow below the screen, not across it).
    if (side === "R") limDeg += (BOLT_WRIST - limDeg) * Math.max(0, Math.min(1, this.anim.pose.rightW));
    const lim = (limDeg * Math.PI) / 180;
    if (th > lim && th > 1e-4) {
      const sn = Math.sin(th), a = Math.sin(th - lim) / sn, b = Math.sin(lim) / sn;
      want = [cn[0] * a + want[0] * b, cn[1] * a + want[1] * b, cn[2] * a + want[2] * b];
    }
    const ax: V3 = [cur[1] * want[2] - cur[2] * want[1], cur[2] * want[0] - cur[0] * want[2], cur[0] * want[1] - cur[1] * want[0]];
    const s = Math.hypot(ax[0], ax[1], ax[2]);
    const c = cur[0] * want[0] + cur[1] * want[1] + cur[2] * want[2];
    if (s > 1e-6) rotAbout([ax[0] / s, ax[1] / s, ax[2] / s], Math.atan2(s, c), wrist, this.T2);
    else this.T2.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
    concat(this.T2, 0, T, 0, this.T3, 0);
    for (const i of b.forearm) concat(this.T3, 0, r.bind, i * 12, W, i * 12);
    // Wrist twist helper halfway (the cuff follows the hand's roll half way).
    for (const i of b.helper) concat(T, 0, r.bind, i * 12, W, i * 12);
  }


  /** Posed bone matrices (Source viewmodel space, 3x4 per bone; audits / fx). */
  get bonesW(): Float32Array {
    return this.W;
  }

  /** A gun-local point on a part, posed (viewmodel space). */
  pointOn(part: GunPart, p: ArrayLike<number>): V3 {
    const o = this.partMatrix(part), W = this.W;
    return [W[o] * p[0] + W[o + 1] * p[1] + W[o + 2] * p[2] + W[o + 3], W[o + 4] * p[0] + W[o + 5] * p[1] + W[o + 6] * p[2] + W[o + 7], W[o + 8] * p[0] + W[o + 9] * p[1] + W[o + 10] * p[2] + W[o + 11]];
  }

  /** A gun-local direction on a part, posed (viewmodel space). */
  dirOn(part: GunPart, d: ArrayLike<number>): V3 {
    const o = this.partMatrix(part), W = this.W;
    return [W[o] * d[0] + W[o + 1] * d[1] + W[o + 2] * d[2], W[o + 4] * d[0] + W[o + 5] * d[1] + W[o + 6] * d[2], W[o + 8] * d[0] + W[o + 9] * d[1] + W[o + 10] * d[2]];
  }
}

const D2R = Math.PI / 180;
/** How far the trigger swings back at a full squeeze (deg). */
const TRIGGER_DEG = 16;

/** out = rotation about gun-local y through (x, *, z) by `a` (rad; + swings a point below the pivot back, toward -x). */
function rotY(a: number, x: number, z: number, out: Float32Array): void {
  const c = Math.cos(a), s = Math.sin(a);
  out[0] = c, out[1] = 0, out[2] = s, out[3] = x - (c * x + s * z);
  out[4] = 0, out[5] = 1, out[6] = 0, out[7] = 0;
  out[8] = -s, out[9] = 0, out[10] = c, out[11] = z - (-s * x + c * z);
}

/** out = rotation about gun-local x through (*, y, z) by `a` (rad). */
function rotX(a: number, y: number, z: number, out: Float32Array): void {
  const c = Math.cos(a), s = Math.sin(a);
  out[0] = 1, out[1] = 0, out[2] = 0, out[3] = 0;
  out[4] = 0, out[5] = c, out[6] = -s, out[7] = y - (c * y - s * z);
  out[8] = 0, out[9] = s, out[10] = c, out[11] = z - (s * y + c * z);
}
const X_AXIS: V3 = [1, 0, 0], Y_NEG: V3 = [0, -1, 0], Z_AXIS: V3 = [0, 0, 1];

/** Cottontail's tail ball centre / the Seed Drill's pod centre (gun-local), for their wobble. */
const TAIL_C: V3 = [-1.0, 0, 1.0];
const POD_C: V3 = [-5.9, 0, 1.75];
/** The Jackrabbit's ears' base (gun-local), their flop pivot. */
const EAR_C: V3 = [-0.25, 0, 1.5];

interface ArmBones {
  hand: number;
  forearm: number[];
  helper: number[];
  invHand: Float32Array;
  /** Bind forearm direction (elbow -> wrist). */
  dir: V3;
}

function armBones(side: "R" | "L"): ArmBones {
  const r = gunRig().hands;
  const B = (n: string) => r.bone(n);
  const hand = B(side === "R" ? "Right_Hand" : "Left_Hand");
  const forearm = (side === "R" ? ["Root36", "Right_Arm", "eff18", "Root23"] : ["Root34", "Left_Arm", "eff16", "Root16"]).map(B);
  const helper = (side === "R" ? ["Root98", "R_wrist_helper"] : ["Root99", "L_wrist_helper"]).map(B);
  const invHand = new Float32Array(12);
  invert34(r.bind, hand * 12, invHand, 0);
  const w = r.at(side === "R" ? "Right_Hand" : "Left_Hand"), a = r.at(side === "R" ? "Right_Arm" : "Left_Arm");
  const d: V3 = [w[0] - a[0], w[1] - a[1], w[2] - a[2]];
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  return { hand, forearm, helper, invHand, dir: [d[0] / l, d[1] / l, d[2] / l] };
}

/** out[oo..] = M * T(x, y, z) (a translation in M's local frame). */
function translateLocal(M: ArrayLike<number>, x: number, y: number, z: number, out: Float32Array, oo: number): void {
  for (let r = 0; r < 3; r++) {
    const a0 = M[r * 4], a1 = M[r * 4 + 1], a2 = M[r * 4 + 2];
    out[oo + r * 4] = a0;
    out[oo + r * 4 + 1] = a1;
    out[oo + r * 4 + 2] = a2;
    out[oo + r * 4 + 3] = M[r * 4 + 3] + a0 * x + a1 * y + a2 * z;
  }
}

/** W[o] = W[o] * S where S scales about local point c (sx along x, s across). */
function scaleAbout(W: Float32Array, o: number, c: V3, sx: number, s: number): void {
  const k = [sx, s, s];
  // W * T(c) * S * T(-c): columns scaled, translation adjusted.
  const t = [0, 0, 0];
  for (let r = 0; r < 3; r++) {
    let off = 0;
    for (let j = 0; j < 3; j++) off += W[o + r * 4 + j] * c[j] * (1 - k[j]);
    t[r] = off;
  }
  for (let r = 0; r < 3; r++) {
    for (let j = 0; j < 3; j++) W[o + r * 4 + j] *= k[j];
    W[o + r * 4 + 3] += t[r];
  }
}

const qa = new Float64Array(4), qb = new Float64Array(4);

function quatOf(m: ArrayLike<number>, q: Float64Array): void {
  const m00 = m[0], m01 = m[1], m02 = m[2], m10 = m[4], m11 = m[5], m12 = m[6], m20 = m[8], m21 = m[9], m22 = m[10];
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    (q[3] = 0.25 * s), (q[0] = (m21 - m12) / s), (q[1] = (m02 - m20) / s), (q[2] = (m10 - m01) / s);
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    (q[3] = (m21 - m12) / s), (q[0] = 0.25 * s), (q[1] = (m01 + m10) / s), (q[2] = (m02 + m20) / s);
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    (q[3] = (m02 - m20) / s), (q[0] = (m01 + m10) / s), (q[1] = 0.25 * s), (q[2] = (m12 + m21) / s);
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    (q[3] = (m10 - m01) / s), (q[0] = (m02 + m20) / s), (q[1] = (m12 + m21) / s), (q[2] = 0.25 * s);
  }
}

/** out = blend of rigid transforms a -> b by w (quaternion nlerp, linear translation); out may alias a. */
export function lerpRigid(a: ArrayLike<number>, b: ArrayLike<number>, w: number, out: Float32Array): void {
  if (w <= 0) {
    if (out !== a) for (let i = 0; i < 12; i++) out[i] = a[i];
    return;
  }
  if (w >= 1) {
    for (let i = 0; i < 12; i++) out[i] = b[i];
    return;
  }
  quatOf(a, qa);
  quatOf(b, qb);
  const s = qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3] < 0 ? -1 : 1;
  let x = qa[0] + (qb[0] * s - qa[0]) * w, y = qa[1] + (qb[1] * s - qa[1]) * w, z = qa[2] + (qb[2] * s - qa[2]) * w, q = qa[3] + (qb[3] * s - qa[3]) * w;
  const l = Math.hypot(x, y, z, q) || 1;
  (x /= l), (y /= l), (z /= l), (q /= l);
  const tx = a[3] + (b[3] - a[3]) * w, ty = a[7] + (b[7] - a[7]) * w, tz = a[11] + (b[11] - a[11]) * w;
  out[0] = 1 - 2 * (y * y + z * z), out[1] = 2 * (x * y - z * q), out[2] = 2 * (x * z + y * q), out[3] = tx;
  out[4] = 2 * (x * y + z * q), out[5] = 1 - 2 * (x * x + z * z), out[6] = 2 * (y * z - x * q), out[7] = ty;
  out[8] = 2 * (x * z - y * q), out[9] = 2 * (y * z + x * q), out[10] = 1 - 2 * (x * x + y * y), out[11] = tz;
}

