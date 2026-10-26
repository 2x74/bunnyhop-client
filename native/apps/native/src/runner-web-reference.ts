// Build/test only: original web runner, imports adapted to this native source tree. Never bundled in the menu.
// RunnerModel: the original bunnyhop.lol runner (player/rig.ts) with procedural animation driven by sim state.
// Used through the PlayerModel facade (player/model.ts), which picks it or the CS:S model per Settings.
//
// Poses are in Source conventions (Z-up position in units, yaw/pitch in degrees, pitch + = looking down); the model
// converts to three.js space itself, so it drops into the scene next to the world (which is rotated Z-up -> Y-up).
//
// Animation: idle / run (speed-scaled stride, legs follow the movement direction) / crouch / air (legs tucked,
// legs reach down while falling) poses are blended with smoothed weights, then layered with: body yaw following the
// view (head + torso aim at the view yaw/pitch), strafe lean into the turn (yaw rate + side input), landing squash
// and floppy ears (springs). Everything is O(bones) scalar maths: ~20 bones, one draw call (two for ghosts).

import * as THREE from "three";
import { createBones, LEG, PALETTE, playerGeometry } from "../../web/src/player/rig";
import { depthMaterial, ghostMaterial, playerUniforms, solidMaterial, type PlayerUniforms } from "../../web/src/player/materials";
import type { PlayerPose } from "../../web/src/player/model";
type PlayerStyle="ghost"|"solid";
interface PlayerModelOptions {style?:PlayerStyle;color?:THREE.ColorRepresentation;dither?:boolean}

// ---------------------------------------------------------------------------------------------
// Pose channels (degrees, except HIPS_Y in units). Blended linearly between states.

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
const smooth = (x: number, a: number, b: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Frame-rate independent exponential approach. */
const damp = (cur: number, target: number, rate: number, dt: number) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
const wrap180 = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

function mix(out: Pose, a: Pose, b: Pose, t: number): Pose {
  for (let i = 0; i < C.COUNT; i++) out[i] = a[i] + (b[i] - a[i]) * t;
  return out;
}

/** Two-bone leg IK in the sagittal plane: foot at (forward, down) from the hip -> [thigh swing fwd, knee flex]. */
function legIK(fwd: number, down: number): [number, number] {
  const L1 = LEG.thigh;
  const L2 = LEG.shin;
  const d = clamp(Math.hypot(fwd, down), Math.abs(L1 - L2) + 0.1, L1 + L2 - 0.01);
  const knee = Math.PI - Math.acos(clamp((L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2), -1, 1));
  const toFoot = Math.atan2(fwd, down);
  const inner = Math.acos(clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1));
  return [(toFoot + inner) / D2R, knee / D2R];
}

const BONE_INDEX = {
  root: 0, hips: 1, spine: 2, chest: 3, neck: 4, head: 5, earL: 6, earR: 7,
  upperArmL: 8, foreArmL: 9, handL: 10, upperArmR: 11, foreArmR: 12, handR: 13,
  thighL: 14, shinL: 15, footL: 16, thighR: 17, shinR: 18, footR: 19,
};

let sharedInverses: THREE.Matrix4[] | null = null;

export class RunnerModel {
  /** Add to the scene. Positioned/rotated by update(). */
  readonly root = new THREE.Group();
  readonly uniforms: PlayerUniforms;
  private body = new THREE.Group();
  private bones: THREE.Bone[];
  private skeleton: THREE.Skeleton;
  private mesh: THREE.SkinnedMesh;
  private depthMesh: THREE.SkinnedMesh;
  private style: PlayerStyle = "solid";
  private dither = false;
  private baseRenderOrder = 20;

  // Input state
  private pose: PlayerPose | null = null;
  private lastPos = new THREE.Vector3();
  private hasLast = false;
  // Smoothed animation state
  private vel = [0, 0, 0];
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
  private squash = 0;
  private squashV = 0;
  private ears = [0, 0, 0, 0]; // pitch, pitchVel, roll, rollVel
  private earTwitch = 2;
  private time = Math.random() * 10;
  private snapNext = true;
  private p = { idle: newPose(), run: newPose(), crouch: newPose(), air: newPose(), airCrouch: newPose(), g: newPose(), a: newPose(), out: newPose() };

  constructor(o: PlayerModelOptions = {}, uniforms: PlayerUniforms = playerUniforms()) {
    this.uniforms = uniforms;
    const geo = playerGeometry();
    this.bones = createBones();
    const rootBone = this.bones[0];
    this.body.add(rootBone);
    this.root.add(this.body);
    if (!sharedInverses) {
      rootBone.updateMatrixWorld(true);
      sharedInverses = this.bones.map((b) => b.matrixWorld.clone().invert());
    }
    this.skeleton = new THREE.Skeleton(this.bones, sharedInverses);
    const identity = new THREE.Matrix4();
    this.mesh = new THREE.SkinnedMesh(geo, solidMaterial(this.uniforms));
    this.depthMesh = new THREE.SkinnedMesh(geo, depthMaterial(this.uniforms));
    for (const m of [this.mesh, this.depthMesh]) {
      m.bind(this.skeleton, identity);
      m.boundingSphere = geo.boundingSphere!.clone();
      this.body.add(m);
    }
    (this.depthMesh.material as THREE.Material).forceSinglePass = true;
    this.root.name = "player-model";
    this.setStyle(o.style ?? "solid", o.color, o.dither);
  }

  /** Visual style. color = accent for solid (default brand amber), tint for ghosts. */
  setStyle(style: PlayerStyle, color?: THREE.ColorRepresentation, dither = this.dither): void {
    const changed = style !== this.style || dither !== this.dither || !this.mesh.material;
    this.style = style;
    this.dither = dither;
    if (style === "solid") this.uniforms.uAccent.value.set(color ?? PALETTE.accent);
    else if (color !== undefined) this.uniforms.uGhost.value.set(color);
    if (changed) {
      (this.mesh.material as THREE.Material).dispose();
      const m = style === "solid" ? solidMaterial(this.uniforms) : ghostMaterial(this.uniforms, dither);
      m.forceSinglePass = true;
      this.mesh.material = m;
    }
    this.depthMesh.visible = style === "ghost" && !dither;
    this.setRenderOrder(this.baseRenderOrder);
  }

  get currentStyle(): PlayerStyle {
    return this.style;
  }

  /** Ghost opacity (0..1). */
  setOpacity(a: number): void {
    this.uniforms.uOpacity.value = a;
  }

  /** Fade out when the camera is within `near`..`far` units of the body (0 disables). */
  setNearFade(near: number, far: number): void {
    this.uniforms.uNearFade.value.set(near, far);
  }

  /** Translucent ghosts draw a depth prepass at `order` and their colour at `order + 1`. */
  setRenderOrder(order: number): void {
    this.baseRenderOrder = order;
    this.depthMesh.renderOrder = order;
    this.mesh.renderOrder = order + 1;
  }

  /** Feeds the latest sim state. Call before update(). */
  setState(pose: PlayerPose): void {
    this.pose = pose;
  }

  /** Forget smoothing (after teleports, seeks, respawns): the next update snaps to the pose. */
  snap(): void {
    this.snapNext = true;
  }

  /** Advances the animation by dt seconds and poses the skeleton. */
  update(dt: number): void {
    const s = this.pose;
    if (!s) return;
    dt = clamp(dt, 0, 0.1);
    this.time = s.visualTime ?? (this.time + dt);
    const pos = s.position;
    // Source (x, y, z) -> three (x, z, -y)
    const px = pos[0], py = pos[2], pz = -pos[1];
    const lp = this.lastPos;
    if (this.hasLast && (lp.x - px) ** 2 + (lp.y - py) ** 2 + (lp.z - pz) ** 2 > 160 * 160) this.snapNext = true;
    const snap = this.snapNext;
    this.snapNext = false;

    // --- Velocity (Source axes) ---
    if (s.velocity) {
      this.vel[0] = s.velocity[0];
      this.vel[1] = s.velocity[1];
      this.vel[2] = s.velocity[2];
    } else if (this.hasLast && dt > 0 && !snap) {
      const k = 1 - Math.exp(-20 * dt);
      this.vel[0] += ((px - this.lastPos.x) / dt - this.vel[0]) * k;
      this.vel[1] += ((-(pz - this.lastPos.z)) / dt - this.vel[1]) * k;
      this.vel[2] += ((py - this.lastPos.y) / dt - this.vel[2]) * k;
    } else this.vel[0] = this.vel[1] = this.vel[2] = 0;
    this.lastPos.set(px, py, pz);
    this.hasLast = true;
    this.root.position.set(px, py, pz);

    const [vx, vy, vz] = this.vel;
    const speed = Math.hypot(vx, vy);

    // --- View / body yaw ---
    let dYaw = Number.isNaN(this.lastYaw) || snap || dt <= 0 ? 0 : wrap180(s.yaw - this.lastYaw) / dt;
    this.lastYaw = s.yaw;
    if (Math.abs(dYaw) > 3000) dYaw = 0; // teleport / respawn
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

    // --- State weights ---
    const grounded = s.grounded;
    if (grounded && !this.wasGrounded && this.airTime > 0.12) {
      // Landing squash, scaled by impact speed (vz just before landing is ~ the smoothed value).
      this.squashV += clamp(-this.vel[2] / 900, 0.15, 0.7) * 2.2;
    }
    this.airTime = grounded ? 0 : this.airTime + dt;
    this.wasGrounded = grounded;
    // Grounded weight rises slowly (bhop touches the ground for a single tick) and drops fast.
    const gTarget = grounded ? 1 : 0;
    this.ground = snap ? gTarget : damp(this.ground, gTarget, gTarget > this.ground ? 9 : 22, dt);
    this.crouch = snap ? +s.crouched : damp(this.crouch, s.crouched ? 1 : 0, 14, dt);
    const tuckT = vz > 0 ? 1 : clamp(1 + vz / 520, 0.2, 1);
    this.tuck = snap ? tuckT : damp(this.tuck, tuckT, 7, dt);
    const ampT = Math.pow(clamp(speed / 250, 0, 1), 0.8);
    this.runAmp = snap ? ampT : damp(this.runAmp, ampT, 8, dt);

    // Run phase: one full cycle per stride; stride grows with speed. Backwards movement runs the cycle backwards.
    let moveAng = Math.atan2(leftV, fwdV) / D2R; // 0 = forward, +90 = left
    let back = false;
    if (Math.abs(moveAng) > 100) {
      back = true;
      moveAng = wrap180(moveAng + 180);
    }
    const stride = clamp(50 + speed * 0.18, 50, 115);
    if (snap && s.visualTime !== undefined) this.phase = (back ? -1 : 1) * (speed / stride) * Math.PI * 2 * s.visualTime;
    this.phase += (back ? -1 : 1) * ((speed / stride) * Math.PI * 2 * dt) * (0.35 + 0.65 * this.ground);
    const legYawT = speed > 30 ? clamp(moveAng, -65, 65) * this.ground : 0;
    this.legYaw = snap ? legYawT : damp(this.legYaw, legYawT, 8, dt);

    // Strafe lean: into the turn (yaw rate), plus the side key (sidemove < 0 = moving left = lean left).
    const side = s.sidemove ?? 0;
    const leanT = clamp(this.yawRate * 0.055 - (side / 450) * 7, -26, 26) * (0.35 + 0.65 * (1 - this.ground)) * clamp(speed / 200, 0.2, 1);
    this.lean = snap ? leanT : damp(this.lean, leanT, 6, dt);

    // --- Poses ---
    const P = this.p;
    this.idlePose(P.idle);
    this.runPose(P.run);
    this.crouchPose(P.crouch);
    this.airPose(P.air, false);
    this.airPose(P.airCrouch, true);
    mix(P.g, P.idle, P.run, this.runAmp);
    mix(P.g, P.g, P.crouch, this.crouch);
    mix(P.a, P.air, P.airCrouch, this.crouch);
    const out = mix(P.out, P.a, P.g, this.ground);

    // --- Secondary: squash spring, ears ---
    if (snap) this.squash = this.squashV = 0;
    const k = 240;
    this.squashV += (-k * this.squash - 15 * this.squashV) * dt;
    this.squash += this.squashV * dt;
    this.squash = clamp(this.squash, -0.08, 0.16);
    const e = this.ears;
    this.earTwitch -= dt;
    if (this.earTwitch < 0) {
      this.earTwitch = 2.5 + Math.random() * 4;
      if (speed < 40) e[1] += 260 * (Math.random() < 0.5 ? 1 : -1);
    }
    const earPitchT = -clamp(speed * 0.028, 0, 26) - clamp(vz * 0.035, -22, 22) * (1 - this.ground);
    const earRollT = this.lean * 0.7;
    e[1] += (110 * (earPitchT - e[0]) - 7 * e[1]) * dt;
    e[0] += e[1] * dt;
    e[3] += (110 * (earRollT - e[2]) - 7 * e[3]) * dt;
    e[2] += e[3] * dt;
    if (snap) (e[0] = earPitchT), (e[1] = 0), (e[2] = earRollT), (e[3] = 0);

    this.apply(out);
  }

  // --- Individual poses -------------------------------------------------------------------------

  private idlePose(o: Pose): void {
    o.fill(0);
    const t = this.time;
    const breath = Math.sin(t * 1.7);
    o[C.HIPS_ROLL] = Math.sin(t * 0.6) * 1.2;
    o[C.SPINE_PITCH] = 2 + breath * 0.7;
    o[C.CHEST_PITCH] = -1 - breath * 0.9;
    o[C.HEAD_PITCH] = breath * 0.4;
    for (const [tx, tz, kn, ft, side] of [[C.THIGH_X_L, C.THIGH_Z_L, C.KNEE_L, C.FOOT_L, 1], [C.THIGH_X_R, C.THIGH_Z_R, C.KNEE_R, C.FOOT_R, -1]] as const) {
      o[tx] = 3;
      o[kn] = 6;
      o[tz] = 3 - side * Math.sin(t * 0.6) * 1.2;
      o[ft] = 0;
    }
    o[C.ARM_X_L] = 4 + breath;
    o[C.ARM_X_R] = 4 + breath;
    o[C.ARM_Z_L] = 7 + breath * 0.8;
    o[C.ARM_Z_R] = 7 + breath * 0.8;
    o[C.ELBOW_L] = 14;
    o[C.ELBOW_R] = 14;
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
      o[tx] = 40 * sw + 6;
      o[kn] = 14 + 22 * Math.max(0, -sw) + 62 * Math.pow(Math.max(0, cs), 1.4);
      o[ft] = 12 * sw - 6;
    };
    leg(s, c, C.THIGH_X_L, C.KNEE_L, C.FOOT_L);
    leg(-s, -c, C.THIGH_X_R, C.KNEE_R, C.FOOT_R);
    o[C.THIGH_Z_L] = o[C.THIGH_Z_R] = 2;
    o[C.ARM_X_L] = -44 * s + 6;
    o[C.ARM_X_R] = 44 * s + 6;
    o[C.ARM_Z_L] = o[C.ARM_Z_R] = 9;
    o[C.ELBOW_L] = 78 + 18 * s;
    o[C.ELBOW_R] = 78 - 18 * s;
  }

  private crouchPose(o: Pose): void {
    o.fill(0);
    const drop = 14.5;
    const a = this.runAmp;
    const s = Math.sin(this.phase);
    o[C.HIPS_Y] = -drop;
    o[C.HIPS_PITCH] = 0;
    o[C.SPINE_PITCH] = 20;
    o[C.CHEST_PITCH] = 10;
    o[C.NECK_PITCH] = -12;
    o[C.HEAD_PITCH] = -10;
    for (const [tx, tz, kn, ft, sg] of [[C.THIGH_X_L, C.THIGH_Z_L, C.KNEE_L, C.FOOT_L, 1], [C.THIGH_X_R, C.THIGH_Z_R, C.KNEE_R, C.FOOT_R, -1]] as const) {
      const step = sg * s * a * 9;
      const [th, kn2] = legIK(1 + step, LEG.hip - drop - LEG.ankle + Math.max(0, sg * Math.cos(this.phase)) * a * 3 * -1);
      o[tx] = th;
      o[kn] = kn2;
      o[ft] = 0; // apply() keeps the sole flat
      o[tz] = 7;
    }
    o[C.ARM_X_L] = 28 - 14 * s * a;
    o[C.ARM_X_R] = 28 + 14 * s * a;
    o[C.ARM_Z_L] = o[C.ARM_Z_R] = 12;
    o[C.ELBOW_L] = o[C.ELBOW_R] = 62;
  }

  private airPose(o: Pose, crouched: boolean): void {
    o.fill(0);
    const T = this.tuck;
    if (crouched) {
      // Duck in the air: the hull shrinks from the feet up, so the legs pull right up under the body.
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
      o[C.HIPS_Y] = 0;
      o[C.SPINE_PITCH] = 5 + 4 * T;
      o[C.CHEST_PITCH] = 2;
      o[C.HEAD_PITCH] = -4;
      o[C.THIGH_X_L] = 18 + 42 * T;
      o[C.KNEE_L] = 22 + 70 * T;
      o[C.THIGH_X_R] = 6 + 30 * T;
      o[C.KNEE_R] = 34 + 52 * T;
      o[C.FOOT_L] = -18 + 6 * T;
      o[C.FOOT_R] = -22 + 8 * T;
      o[C.THIGH_Z_L] = 5;
      o[C.THIGH_Z_R] = 4;
    }
    o[C.ARM_X_L] = 14;
    o[C.ARM_X_R] = 8;
    o[C.ARM_Z_L] = 26 + 12 * T;
    o[C.ARM_Z_R] = 24 + 12 * T;
    o[C.ELBOW_L] = 38;
    o[C.ELBOW_R] = 44;
  }

  // --- Apply to bones -------------------------------------------------------------------------

  private apply(o: Pose): void {
    const b = this.bones;
    const I = BONE_INDEX;
    const set = (i: number, x: number, y: number, z: number, order: THREE.EulerOrder = "YXZ") => b[i].rotation.set(x * D2R, y * D2R, z * D2R, order);

    // Whole body faces the (smoothed) view yaw; model faces +Z so add 90 degrees.
    this.root.rotation.y = this.bodyYaw * D2R + Math.PI / 2;
    const sq = this.squash;
    this.body.scale.set(1 + sq * 0.45, 1 - sq, 1 + sq * 0.45);

    // Aim: distribute (view - body) yaw and the view pitch over the spine, neck and head.
    const aimYaw = wrap180(this.viewYaw - this.bodyYaw);
    const pitch = this.viewPitch;
    const lean = this.lean;
    const legYaw = this.legYaw;

    b[I.hips].position.y = 32 + o[C.HIPS_Y] - sq * 10;
    set(I.hips, o[C.HIPS_PITCH], o[C.HIPS_YAW] + legYaw, o[C.HIPS_ROLL] - lean);
    set(I.spine, o[C.SPINE_PITCH] + pitch * 0.08, o[C.SPINE_YAW] - legYaw * 0.5 + aimYaw * 0.2, lean * 0.15);
    set(I.chest, o[C.CHEST_PITCH] + pitch * 0.15, o[C.CHEST_YAW] - legYaw * 0.5 + aimYaw * 0.3, o[C.CHEST_ROLL] + lean * 0.1);
    set(I.neck, o[C.NECK_PITCH] + pitch * 0.25, aimYaw * 0.2, 0);
    set(I.head, o[C.HEAD_PITCH] + clamp(pitch * 0.45, -38, 40), aimYaw * 0.3, o[C.HEAD_ROLL] + lean * 0.45);

    // Legs (thigh swing forward = -X rotation, knee flex = +X, toe up = -X). Lower legs counter the hips' lean a bit.
    set(I.thighL, -o[C.THIGH_X_L], 0, o[C.THIGH_Z_L] + Math.max(0, -lean) * 0.3, "XZY");
    set(I.shinL, o[C.KNEE_L], 0, 0, "XYZ");
    set(I.footL, -(o[C.FOOT_L] + o[C.KNEE_L] - o[C.THIGH_X_L]) * 0.85, 0, 0, "XYZ");
    set(I.thighR, -o[C.THIGH_X_R], 0, -o[C.THIGH_Z_R] - Math.max(0, lean) * 0.3, "XZY");
    set(I.shinR, o[C.KNEE_R], 0, 0, "XYZ");
    set(I.footR, -(o[C.FOOT_R] + o[C.KNEE_R] - o[C.THIGH_X_R]) * 0.85, 0, 0, "XYZ");

    // Arms: banking turn raises the outer arm, drops the inner one.
    set(I.upperArmL, -o[C.ARM_X_L], 0, o[C.ARM_Z_L] - lean * 0.9, "XZY");
    set(I.foreArmL, -o[C.ELBOW_L], 0, 0, "XYZ");
    set(I.upperArmR, -o[C.ARM_X_R], 0, -o[C.ARM_Z_R] - lean * 0.9, "XZY");
    set(I.foreArmR, -o[C.ELBOW_R], 0, 0, "XYZ");

    const e = this.ears;
    set(I.earL, e[0], 0, -e[2] - 4 + Math.sin(this.time * 2.1) * 1.5, "XZY");
    set(I.earR, e[0] * 0.92, 0, -e[2] + 4 - Math.sin(this.time * 2.3 + 1) * 1.5, "XZY");
    // Head-relative axis for the near fade (world space, Three coords).
    this.uniforms.uAxisA.value.copy(this.root.position).y += 8;
    this.uniforms.uAxisB.value.copy(this.root.position).y += 60;
  }

  dispose(): void {
    this.root.removeFromParent();
    (this.mesh.material as THREE.Material).dispose();
    (this.depthMesh.material as THREE.Material).dispose();
    this.skeleton.dispose();
  }
}
