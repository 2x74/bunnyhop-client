// Procedural animation for the bunny on the CS:S rig, used while the CS:S animations load or when there is no hosted
// player content (so the bunny always animates). The same pose model as the runner (runner.ts): idle / run /
// crouch / air poses blended by smoothed state weights, body yaw following the view, strafe lean, landing dip; scaled
// to the CS:S skeleton's proportions and with a knife-style grip on the carrot.
//
// Output: skinning matrices S (bind model space -> posed model space, 3x4 per bone) for the rig's CS:S bones, built
// hierarchically as S_j = S_parent * Dm_j, where Dm_j is the bone's rotation about its bind-pose joint expressed in
// the bind frame. Rotations are authored in the runner's axes (Y up, Z forward, X left) and conjugated into the bind
// frame (Z up, -Y forward, X left); arm bones get a rest correction from the A-pose to hanging arms.

import * as THREE from "three";
import type { PlayerPose } from "../model";
import { rig, type Rig, type V3 } from "./rig";

const enum C {
  HIPS_Y, HIPS_PITCH, HIPS_YAW, HIPS_ROLL,
  SPINE_PITCH, SPINE_YAW, CHEST_PITCH, CHEST_YAW, CHEST_ROLL, NECK_PITCH, HEAD_PITCH, HEAD_ROLL,
  THIGH_X_L, THIGH_Z_L, KNEE_L, FOOT_L, THIGH_X_R, THIGH_Z_R, KNEE_R, FOOT_R,
  ARM_X_L, ARM_Z_L, ELBOW_L, ARM_X_R, ARM_Z_R, ELBOW_R,
  COUNT,
}
type Pose = Float32Array;
const newPose = () => new Float32Array(C.COUNT);

const D2R = Math.PI / 180;
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const damp = (cur: number, target: number, rate: number, dt: number) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
const wrap180 = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;
function mix(out: Pose, a: Pose, b: Pose, t: number): Pose {
  for (let i = 0; i < C.COUNT; i++) out[i] = a[i] + (b[i] - a[i]) * t;
  return out;
}

/** Runner axes -> bind axes: rotation of +90 degrees about X (Y up -> Z up, Z forward -> -Y forward). */
const M = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
const Mi = M.clone().invert();
/** Hip-height scale vs the runner (its leg is ~29 units, the CS:S rig's ~36). */
const K = 1.25;

interface Joint {
  bone: number;
  parent: number;
  pivot: V3;
  /** Rest correction (bind -> rest pose of the animation), and its parent's inverse. */
  c: THREE.Quaternion;
  cpInv: THREE.Quaternion;
}

export class BunnyProcedural {
  private r: Rig = rig();
  private joints: Joint[];
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private m = new THREE.Matrix4();
  private rot = new Float32Array(12);
  /** Rotation per CS bone (runner axes), identity unless set this frame. */
  private local: THREE.Quaternion[];
  private idx: Record<string, number> = {};
  private curl: { bone: number; axis: THREE.Vector3; amount: number }[] = [];

  // Smoothed state (see runner.ts)
  private bodyYaw = 0;
  private viewYaw = 0;
  private viewPitch = 0;
  private yawRate = 0;
  private lastYaw = NaN;
  private legYaw = 0;
  private ground = 1;
  private crouch = 0;
  private tuck = 0;
  private runAmp = 0;
  private phase = 0;
  private lean = 0;
  private airTime = 0;
  private wasGrounded = true;
  private dip = 0;
  private dipV = 0;
  private time = Math.random() * 10;
  private p = { idle: newPose(), run: newPose(), crouch: newPose(), air: newPose(), airCrouch: newPose(), g: newPose(), a: newPose(), out: newPose() };
  state = "idle";
  private thigh: number;
  private shin: number;
  private hipZ: number;

  constructor() {
    const r = this.r;
    const n = r.csBones;
    this.local = Array.from({ length: n }, () => new THREE.Quaternion());
    for (const nm of ["Pelvis", "Spine", "Spine1", "Spine2", "Spine4", "Neck1", "Head1", "L_Thigh", "L_Calf", "L_Foot", "R_Thigh", "R_Calf", "R_Foot", "L_UpperArm", "L_Forearm", "L_Hand", "R_UpperArm", "R_Forearm", "R_Hand"]) this.idx[nm] = r.bone(nm);
    const at = (i: number): V3 => [r.bind[i * 12 + 3], r.bind[i * 12 + 7], r.bind[i * 12 + 11]];
    // Arm rest correction: rotate the A-pose arm (shoulder -> elbow) to hang down, slightly out.
    const corr = new Map<number, THREE.Quaternion>();
    for (const s of ["L", "R"]) {
      const sh = at(r.bone(`${s}_UpperArm`)), el = at(r.bone(`${s}_Forearm`));
      const d = new THREE.Vector3(el[0] - sh[0], el[1] - sh[1], el[2] - sh[2]).normalize();
      const down = new THREE.Vector3(s === "L" ? 0.06 : -0.06, 0, -1).normalize();
      const c = new THREE.Quaternion().setFromUnitVectors(d, down);
      // Everything below the upper arm shares it.
      const stack = [r.bone(`${s}_UpperArm`)];
      while (stack.length) {
        const b = stack.pop()!;
        corr.set(b, c);
        for (let j = 0; j < n; j++) if (r.parent[j] === b) stack.push(j);
      }
    }
    const I = new THREE.Quaternion();
    this.joints = Array.from({ length: n }, (_, i) => ({
      bone: i,
      parent: r.parent[i],
      pivot: at(i),
      c: corr.get(i) ?? I,
      cpInv: (r.parent[i] >= 0 ? corr.get(r.parent[i]) : undefined)?.clone().invert() ?? I,
    }));
    // Finger curl axes (bind frame): rotate each finger segment toward the palm.
    for (const s of ["L", "R"]) {
      const hand = at(r.bone(`${s}_Hand`));
      const f1 = at(r.bone(`${s}_Finger1`)), f2 = at(r.bone(`${s}_Finger2`));
      const along = new THREE.Vector3((f1[0] + f2[0]) / 2 - hand[0], (f1[1] + f2[1]) / 2 - hand[1], (f1[2] + f2[2]) / 2 - hand[2]).normalize();
      const palm = new THREE.Vector3(s === "L" ? -1 : 1, 0, 0);
      palm.addScaledVector(along, -palm.dot(along)).normalize();
      const axis = new THREE.Vector3().crossVectors(along, palm).normalize();
      const grip = s === "R";
      for (const [f, a] of [["Finger1", 45], ["Finger11", 55], ["Finger12", 35], ["Finger2", 50], ["Finger21", 55], ["Finger22", 35], ["Finger0", 15], ["Finger01", 25], ["Finger02", 20]] as const) {
        const thumb = f.startsWith("Finger0");
        this.curl.push({ bone: r.bone(`${s}_${f}`), axis: thumb ? axis.clone().negate().applyAxisAngle(along, 0) : axis, amount: (grip ? a : a * 0.45) * D2R * (thumb ? 0.8 : 1) });
      }
    }
    const len = (a: string, b: string) => {
      const p = at(r.bone(a)), q = at(r.bone(b));
      return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    };
    this.thigh = len("L_Thigh", "L_Calf");
    this.shin = len("L_Calf", "L_Foot");
    this.hipZ = at(r.bone("L_Thigh"))[2];
  }

  /** Two-bone leg IK in the sagittal plane: foot at (forward, down) from the hip -> [thigh swing, knee flex] (deg). */
  private legIK(fwd: number, down: number): [number, number] {
    const L1 = this.thigh, L2 = this.shin;
    const d = clamp(Math.hypot(fwd, down), Math.abs(L1 - L2) + 0.1, L1 + L2 - 0.01);
    const knee = Math.PI - Math.acos(clamp((L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2), -1, 1));
    const toFoot = Math.atan2(fwd, down);
    const inner = Math.acos(clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1));
    return [(toFoot + inner) / D2R, knee / D2R];
  }

  /** Advances and writes S for the CS:S bones. Returns the body yaw (degrees, Source) for the model's yaw group. */
  update(dt: number, s: PlayerPose, vel: number[], snap: boolean, _jumped: boolean, S: Float32Array): number {
    this.time = s.visualTime ?? (this.time + dt);
    const [vx, vy, vz] = vel;
    const speed = Math.hypot(vx, vy);
    let dYaw = Number.isNaN(this.lastYaw) || snap || dt <= 0 ? 0 : wrap180(s.yaw - this.lastYaw) / dt;
    this.lastYaw = s.yaw;
    if (Math.abs(dYaw) > 3000) dYaw = 0;
    this.yawRate = snap ? 0 : damp(this.yawRate, dYaw, 10, dt);
    this.viewYaw = s.yaw;
    this.viewPitch = clamp(s.pitch, -89, 89);
    if (snap) this.bodyYaw = s.yaw;
    else {
      this.bodyYaw += wrap180(s.yaw - this.bodyYaw) * (1 - Math.exp(-9 * dt));
      const lag = wrap180(s.yaw - this.bodyYaw);
      if (Math.abs(lag) > 50) this.bodyYaw = s.yaw - Math.sign(lag) * 50;
    }
    const by = this.bodyYaw * D2R;
    const fwdV = vx * Math.cos(by) + vy * Math.sin(by);
    const leftV = -vx * Math.sin(by) + vy * Math.cos(by);

    const grounded = s.grounded;
    if (grounded && !this.wasGrounded && this.airTime > 0.12) this.dipV += clamp(-vz / 900, 0.15, 0.7) * 2.2;
    this.airTime = grounded ? 0 : this.airTime + dt;
    this.wasGrounded = grounded;
    const gT = grounded ? 1 : 0;
    this.ground = snap ? gT : damp(this.ground, gT, gT > this.ground ? 9 : 22, dt);
    this.crouch = snap ? +s.crouched : damp(this.crouch, s.crouched ? 1 : 0, 14, dt);
    const tuckT = vz > 0 ? 1 : clamp(1 + vz / 520, 0.2, 1);
    this.tuck = snap ? tuckT : damp(this.tuck, tuckT, 7, dt);
    const ampT = Math.pow(clamp(speed / 250, 0, 1), 0.8);
    this.runAmp = snap ? ampT : damp(this.runAmp, ampT, 8, dt);
    let moveAng = Math.atan2(leftV, fwdV) / D2R;
    let back = false;
    if (Math.abs(moveAng) > 100) {
      back = true;
      moveAng = wrap180(moveAng + 180);
    }
    const stride = clamp(60 + speed * 0.22, 60, 140);
    if (snap && s.visualTime !== undefined) this.phase = (back ? -1 : 1) * (speed / stride) * Math.PI * 2 * s.visualTime;
    this.phase += (back ? -1 : 1) * ((speed / stride) * Math.PI * 2 * dt) * (0.35 + 0.65 * this.ground);
    const legYawT = speed > 30 ? clamp(moveAng, -65, 65) * this.ground : 0;
    this.legYaw = snap ? legYawT : damp(this.legYaw, legYawT, 8, dt);
    const side = s.sidemove ?? 0;
    const leanT = clamp(this.yawRate * 0.055 - (side / 450) * 7, -26, 26) * (0.35 + 0.65 * (1 - this.ground)) * clamp(speed / 200, 0.2, 1);
    this.lean = snap ? leanT : damp(this.lean, leanT, 6, dt);
    if (snap) this.dip = this.dipV = 0;
    this.dipV += (-240 * this.dip - 15 * this.dipV) * dt;
    this.dip = clamp(this.dip + this.dipV * dt, -0.08, 0.16);
    this.state = this.ground < 0.5 ? "air" : this.crouch > 0.5 ? "crouch" : speed > 30 ? "run" : "idle";

    const P = this.p;
    this.idlePose(P.idle);
    this.runPose(P.run);
    this.crouchPose(P.crouch);
    this.airPose(P.air, false);
    this.airPose(P.airCrouch, true);
    mix(P.g, P.idle, P.run, this.runAmp);
    mix(P.g, P.g, P.crouch, this.crouch);
    mix(P.a, P.air, P.airCrouch, this.crouch);
    this.apply(mix(P.out, P.a, P.g, this.ground), S);
    return this.bodyYaw;
  }

  private idlePose(o: Pose): void {
    o.fill(0);
    const t = this.time;
    const breath = Math.sin(t * 1.7);
    o[C.HIPS_ROLL] = Math.sin(t * 0.6) * 1.2;
    o[C.SPINE_PITCH] = 2 + breath * 0.7;
    o[C.CHEST_PITCH] = -1 - breath * 0.9;
    o[C.HEAD_PITCH] = breath * 0.4;
    for (const [tx, tz, kn, sd] of [[C.THIGH_X_L, C.THIGH_Z_L, C.KNEE_L, 1], [C.THIGH_X_R, C.THIGH_Z_R, C.KNEE_R, -1]] as const) {
      o[tx] = 3;
      o[kn] = 6;
      o[tz] = 3 - sd * Math.sin(t * 0.6) * 1.2;
    }
    o[C.ARM_X_L] = 4 + breath;
    o[C.ARM_Z_L] = 9 + breath * 0.8;
    o[C.ELBOW_L] = 16;
    o[C.ARM_X_R] = 24 + breath;
    o[C.ARM_Z_R] = 10;
    o[C.ELBOW_R] = 62;
  }

  private runPose(o: Pose): void {
    o.fill(0);
    const ph = this.phase;
    const s = Math.sin(ph);
    const c = Math.cos(ph);
    o[C.HIPS_Y] = -1.6 * (1 + Math.cos(2 * ph)) * 0.5 - 0.6;
    o[C.HIPS_YAW] = -8 * s;
    o[C.SPINE_PITCH] = 9;
    o[C.SPINE_YAW] = 4 * s;
    o[C.CHEST_PITCH] = 4;
    o[C.CHEST_YAW] = 8 * s;
    o[C.HEAD_PITCH] = -6;
    const leg = (sw: number, cs: number, tx: number, kn: number, ft: number) => {
      o[tx] = 38 * sw + 6;
      o[kn] = 14 + 22 * Math.max(0, -sw) + 62 * Math.pow(Math.max(0, cs), 1.4);
      o[ft] = 12 * sw - 6;
    };
    leg(s, c, C.THIGH_X_L, C.KNEE_L, C.FOOT_L);
    leg(-s, -c, C.THIGH_X_R, C.KNEE_R, C.FOOT_R);
    o[C.THIGH_Z_L] = o[C.THIGH_Z_R] = 2;
    o[C.ARM_X_L] = -40 * s + 6;
    o[C.ARM_X_R] = 26 * s + 22;
    o[C.ARM_Z_L] = o[C.ARM_Z_R] = 10;
    o[C.ELBOW_L] = 78 + 18 * s;
    o[C.ELBOW_R] = 80 - 12 * s;
  }

  private crouchPose(o: Pose): void {
    o.fill(0);
    const drop = 14.5 * K;
    const a = this.runAmp;
    const s = Math.sin(this.phase);
    o[C.HIPS_Y] = -14.5;
    o[C.SPINE_PITCH] = 20;
    o[C.CHEST_PITCH] = 10;
    o[C.NECK_PITCH] = -12;
    o[C.HEAD_PITCH] = -10;
    for (const [tx, tz, kn, ft, sg] of [[C.THIGH_X_L, C.THIGH_Z_L, C.KNEE_L, C.FOOT_L, 1], [C.THIGH_X_R, C.THIGH_Z_R, C.KNEE_R, C.FOOT_R, -1]] as const) {
      const step = sg * s * a * 11;
      const [th, kn2] = this.legIK(1 + step, this.hipZ - drop - 4.5 - Math.max(0, sg * Math.cos(this.phase)) * a * 3.5);
      o[tx] = th;
      o[kn] = kn2;
      o[ft] = 0;
      o[tz] = 7;
    }
    o[C.ARM_X_L] = 28 - 14 * s * a;
    o[C.ARM_X_R] = 34 + 10 * s * a;
    o[C.ARM_Z_L] = o[C.ARM_Z_R] = 12;
    o[C.ELBOW_L] = 62;
    o[C.ELBOW_R] = 70;
  }

  private airPose(o: Pose, crouched: boolean): void {
    o.fill(0);
    const T = this.tuck;
    if (crouched) {
      o[C.HIPS_Y] = -13;
      o[C.SPINE_PITCH] = 14;
      o[C.CHEST_PITCH] = 6;
      o[C.NECK_PITCH] = -8;
      o[C.HEAD_PITCH] = -6;
      o[C.THIGH_X_L] = 88;
      o[C.KNEE_L] = 128;
      o[C.THIGH_X_R] = 76;
      o[C.KNEE_R] = 120;
      o[C.FOOT_L] = o[C.FOOT_R] = -14;
      o[C.THIGH_Z_L] = o[C.THIGH_Z_R] = 10;
    } else {
      o[C.SPINE_PITCH] = 5 + 4 * T;
      o[C.CHEST_PITCH] = 2;
      o[C.HEAD_PITCH] = -4;
      o[C.THIGH_X_L] = 18 + 48 * T;
      o[C.KNEE_L] = 22 + 76 * T;
      o[C.THIGH_X_R] = 6 + 34 * T;
      o[C.KNEE_R] = 34 + 56 * T;
      o[C.FOOT_L] = -18 + 6 * T;
      o[C.FOOT_R] = -22 + 8 * T;
      o[C.THIGH_Z_L] = 5;
      o[C.THIGH_Z_R] = 4;
    }
    o[C.ARM_X_L] = 14;
    o[C.ARM_X_R] = 26;
    o[C.ARM_Z_L] = 26 + 12 * T;
    o[C.ARM_Z_R] = 18 + 10 * T;
    o[C.ELBOW_L] = 38;
    o[C.ELBOW_R] = 64;
  }

  /** Runner-axes Euler (degrees) -> local rotation of a bone. */
  private set(bone: number, x: number, y: number, z: number, order: THREE.EulerOrder = "YXZ"): void {
    this.e.set(x * D2R, y * D2R, z * D2R, order);
    this.local[bone].setFromEuler(this.e);
  }

  private apply(o: Pose, S: Float32Array): void {
    const I = this.idx;
    for (const q of this.local) q.identity();
    const aimYaw = wrap180(this.viewYaw - this.bodyYaw);
    const pitch = this.viewPitch;
    const lean = this.lean;
    const legYaw = this.legYaw;
    this.set(I.Pelvis, o[C.HIPS_PITCH], o[C.HIPS_YAW] + legYaw, o[C.HIPS_ROLL] - lean);
    this.set(I.Spine, (o[C.SPINE_PITCH] + pitch * 0.08) * 0.5, (o[C.SPINE_YAW] - legYaw * 0.5 + aimYaw * 0.2) * 0.5, lean * 0.08);
    this.set(I.Spine1, (o[C.SPINE_PITCH] + pitch * 0.08) * 0.5, (o[C.SPINE_YAW] - legYaw * 0.5 + aimYaw * 0.2) * 0.5, lean * 0.07);
    this.set(I.Spine2, (o[C.CHEST_PITCH] + pitch * 0.15) * 0.5, (o[C.CHEST_YAW] - legYaw * 0.5 + aimYaw * 0.3) * 0.5, (o[C.CHEST_ROLL] + lean * 0.1) * 0.5);
    this.set(I.Spine4, (o[C.CHEST_PITCH] + pitch * 0.15) * 0.5, (o[C.CHEST_YAW] - legYaw * 0.5 + aimYaw * 0.3) * 0.5, (o[C.CHEST_ROLL] + lean * 0.1) * 0.5);
    this.set(I.Neck1, o[C.NECK_PITCH] + pitch * 0.25, aimYaw * 0.2, 0);
    this.set(I.Head1, o[C.HEAD_PITCH] + clamp(pitch * 0.45, -38, 40), aimYaw * 0.3, o[C.HEAD_ROLL] + lean * 0.45);
    this.set(I.L_Thigh, -o[C.THIGH_X_L], 0, o[C.THIGH_Z_L] + Math.max(0, -lean) * 0.3, "XZY");
    this.set(I.L_Calf, o[C.KNEE_L], 0, 0, "XYZ");
    this.set(I.L_Foot, -(o[C.FOOT_L] + o[C.KNEE_L] - o[C.THIGH_X_L]) * 0.85, 0, 0, "XYZ");
    this.set(I.R_Thigh, -o[C.THIGH_X_R], 0, -o[C.THIGH_Z_R] - Math.max(0, lean) * 0.3, "XZY");
    this.set(I.R_Calf, o[C.KNEE_R], 0, 0, "XYZ");
    this.set(I.R_Foot, -(o[C.FOOT_R] + o[C.KNEE_R] - o[C.THIGH_X_R]) * 0.85, 0, 0, "XYZ");
    this.set(I.L_UpperArm, -o[C.ARM_X_L], 0, o[C.ARM_Z_L] - lean * 0.9, "XZY");
    this.set(I.L_Forearm, -o[C.ELBOW_L], 0, 0, "XYZ");
    this.set(I.R_UpperArm, -o[C.ARM_X_R], 0, -o[C.ARM_Z_R] - lean * 0.9, "XZY");
    this.set(I.R_Forearm, -o[C.ELBOW_R], 0, 0, "XYZ");
    // Carrot hand: wrist turned so the blade points forward.
    this.set(I.R_Hand, 20, -35, 0, "XYZ");

    // Compose S hierarchically. Root: bind faces -Y; turn to face +X (Source model forward) and drop the hips.
    const r = this.r;
    const n = r.csBones;
    const q = this.q;
    const m = this.m.elements;
    const rot = this.rot;
    const hipDrop = (o[C.HIPS_Y] - this.dip * 10) * K;
    for (let i = 0; i < n; i++) {
      const j = this.joints[i];
      // Dm = T(pivot) * (Cp^-1 * (M R Mi) * C) * T(-pivot)
      q.copy(j.cpInv).multiply(M).multiply(this.local[i]).multiply(Mi).multiply(j.c);
      for (const c of this.curl) if (c.bone === i) q.multiply(new THREE.Quaternion().setFromAxisAngle(c.axis, c.amount));
      this.m.makeRotationFromQuaternion(q);
      const [px, py, pz] = j.pivot;
      rot[0] = m[0], rot[1] = m[4], rot[2] = m[8];
      rot[4] = m[1], rot[5] = m[5], rot[6] = m[9];
      rot[8] = m[2], rot[9] = m[6], rot[10] = m[10];
      rot[3] = px - (rot[0] * px + rot[1] * py + rot[2] * pz);
      rot[7] = py - (rot[4] * px + rot[5] * py + rot[6] * pz);
      rot[11] = pz - (rot[8] * px + rot[9] * py + rot[10] * pz);
      if (j.parent < 0) {
        // Rz(+90) * T(0, 0, hipDrop) * Dm
        const o = i * 12;
        for (let c = 0; c < 4; c++) {
          const r0 = rot[c], r1 = rot[4 + c], r2 = rot[8 + c] + (c === 3 ? hipDrop : 0);
          S[o + c] = -r1;
          S[o + 4 + c] = r0;
          S[o + 8 + c] = r2;
        }
      } else {
        const a = j.parent * 12, o = i * 12;
        for (let rr = 0; rr < 3; rr++) {
          const a0 = S[a + rr * 4], a1 = S[a + rr * 4 + 1], a2 = S[a + rr * 4 + 2], a3 = S[a + rr * 4 + 3];
          S[o + rr * 4] = a0 * rot[0] + a1 * rot[4] + a2 * rot[8];
          S[o + rr * 4 + 1] = a0 * rot[1] + a1 * rot[5] + a2 * rot[9];
          S[o + rr * 4 + 2] = a0 * rot[2] + a1 * rot[6] + a2 * rot[10];
          S[o + rr * 4 + 3] = a0 * rot[3] + a1 * rot[7] + a2 * rot[11] + a3;
        }
      }
    }
  }
}
