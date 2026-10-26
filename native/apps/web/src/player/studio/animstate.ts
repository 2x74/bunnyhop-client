// CS:S player animation state, ported from the public Source SDK 2013:
//   game/shared/base_playeranimstate.cpp   CBasePlayerAnimState (9-way legs, feet/body yaw, aim sequence layers)
//   game/shared/sdk/sdk_playeranimstate.cpp the CS-style template (CalcMainActivity, HandleJumping, upper-body names,
//                                           ANIM_TOPSPEED_* ground speeds, 90 degree max body yaw)
//   game/shared/sequence_Transitioner.cpp   CSequenceTransitioner (crossfades between sequences)
// plus the client's main-sequence crossfade (C_BaseAnimating::MaintainSequenceTransitions).
//
// Per frame: Update(eyeYaw, eyePitch) with the player's velocity, duck and ground flags and jump events
//   main sequence (lower body)  ACT_IDLE Idle_lower / ACT_WALK walk_lower / ACT_RUN Run_lower (9-way move_x/move_y)
//                               ACT_CROUCHIDLE / ACT_RUN_CROUCH, ACT_HOP Jump (restarted on every jump event)
//   aim layers (upper body)     <idle|walk|run|crouch_idle|crouch_walk>_upper_KNIFE, synchronised to the main cycle;
//                               the idle one always, the moving one weighted by speed / ground speed. Each carries
//                               autolayers: a static pose, a body offset and the 3x3 aim blend on body_yaw/body_pitch.
//   pose parameters             move_x/move_y (velocity relative to the eyes, scaled by speed / ground speed),
//                               body_yaw (eyes - feet, feet converge at mp_feetyawrate 720 deg/s, max 90 degrees,
//                               face front after mp_facefronttime 3 s), body_pitch (eye pitch).
//
// Deviations (documented): the SDK restarts the jump cycle with a snap (RestartMainSequence); here a jump while already
// in ACT_HOP crossfades over the sequence's fade time like any other main-sequence change, so continuous bhops blend
// landing -> take-off. A single-tick ground contact (bhop) doesn't end the jump (the CS:S client rarely sees it
// either); landing needs LAND_GRACE seconds on the ground.

import type { BoneSetup } from "./pose";
import { STUDIO_SNAP, type StudioData } from "./data";

const MOVING_MINIMUM_SPEED = 0.5;
/** SDK template: above this a moving player uses ACT_RUN, below ACT_WALK. */
const ARBITRARY_RUN_SPEED = 175;
const ANIM_TOPSPEED_WALK = 100;
/** CS:S knife max speed (CWeaponCSBase::GetMaxSpeed). */
const ANIM_TOPSPEED_RUN = 250;
const ANIM_TOPSPEED_RUN_CROUCH = 85;
const FADE_TURN_DEGREES = 45;
const MP_FEETYAWRATE = 720;
const MP_FACEFRONTTIME = 3;
const MAX_BODY_YAW = 90;
/** HandleJumping: don't check the ground for this long after a jump. */
const JUMP_GROUND_IGNORE = 0.2;
/** Ground contact needed to end a jump (see header). */
export const LAND_GRACE = 0.025;

const angleNormalize = (a: number) => {
  a = a % 360;
  if (a > 180) a -= 360;
  if (a < -180) a += 360;
  return a;
};

interface Blend {
  seq: number;
  cycle: number;
  rate: number;
  animtime: number;
  fadeOut: number;
  weight: number;
}

/** CSequenceTransitioner. */
class Transitioner {
  queue: Blend[] = [];

  private blank(): Blend {
    return { seq: -1, cycle: 0, rate: 1, animtime: 0, fadeOut: 0, weight: 1 };
  }

  check(d: StudioData, seq: number, force: boolean, interpolate: boolean): void {
    if (!this.queue.length) this.queue.push(this.blank());
    let cur = this.queue[this.queue.length - 1];
    if (cur.animtime && (cur.seq !== seq || force)) {
      const next = d.seqs[seq];
      if (!next || next.flags & STUDIO_SNAP || !interpolate) this.queue.length = 0;
      else {
        const prev = d.seqs[cur.seq];
        cur.fadeOut = Math.min(prev ? prev.fadeOut : 0, next.fadeIn);
      }
      this.queue.push(this.blank());
      cur = this.queue[this.queue.length - 1];
    }
    cur.seq = -1;
    cur.animtime = 0;
    cur.fadeOut = 0;
  }

  update(seq: number, cycle: number, rate: number, now: number): void {
    if (!this.queue.length) this.queue.push(this.blank());
    const cur = this.queue[this.queue.length - 1];
    cur.seq = seq;
    cur.animtime = now;
    cur.cycle = cycle;
    cur.rate = rate;
    cur.weight = 1;
    for (let i = 0; i < this.queue.length - 1; ) {
      const b = this.queue[i];
      // C_AnimationLayer::GetFadeout: spline from 1 to 0 over the fade time.
      let s = b.fadeOut <= 0 ? 0 : 1 - (now - b.animtime) / b.fadeOut;
      if (s > 0 && s <= 1) s = 3 * s * s - 2 * s * s * s;
      else if (s > 1) s = 1;
      if (s > 0) {
        b.weight = s;
        i++;
      } else this.queue.splice(i, 1);
    }
  }
}

export interface AnimInput {
  /** Velocity, Source units/s. */
  vel: ArrayLike<number>;
  eyeYaw: number;
  eyePitch: number;
  /** FL_DUCKING. */
  ducking: boolean;
  /** FL_ONGROUND. */
  onGround: boolean;
  /** PLAYERANIMEVENT_JUMP this frame. */
  jumped: boolean;
}

export interface Layer {
  seq: number;
  cycle: number;
  weight: number;
}

const NUM_AIM_LAYERS = 4;

export class CsAnimState {
  /** Weapon animation suffix (`GetWeaponSuffix`). */
  suffix = "KNIFE";
  now = 0;
  // Main sequence
  seq = -1;
  cycle = 0;
  activity = "ACT_IDLE";
  private parity = 0;
  private prevParity = 0;
  private main = new Transitioner();
  // Jumping
  jumping = false;
  private firstJumpFrame = false;
  private jumpStart = 0;
  private groundTime = 0;
  /** Count of jump restarts (debug / tests). */
  jumps = 0;
  // Yaw
  private feetInit = false;
  goalFeetYaw = 0;
  feetYaw = 0;
  private lastTurnTime = 0;
  gaitYaw = 0;
  eyeYaw = 0;
  eyePitch = 0;
  bodyYaw = 0;
  maxGroundSpeed = 0;
  playbackRate = 1;
  // Aim layers (AIMSEQUENCE_LAYER .. +3)
  private idleT = new Transitioner();
  private runT = new Transitioner();
  readonly layers: Layer[] = Array.from({ length: NUM_AIM_LAYERS }, () => ({ seq: -1, cycle: 0, weight: 0 }));
  private speed = 0;
  private vx = 0;
  private vy = 0;
  private pMoveX: number;
  private pMoveY: number;
  private pBodyYaw: number;
  private pBodyPitch: number;
  private seqCache = new Map<string, number>();
  // Fire layer (CCSPlayerAnimState FIRESEQUENCE_LAYER): the knife attack gesture, played over everything else.
  private fireSeq = -1;
  private fireCycle = 0;

  constructor(
    private d: StudioData,
    private bs: BoneSetup,
  ) {
    this.pMoveX = d.pose("move_x");
    this.pMoveY = d.pose("move_y");
    this.pBodyYaw = d.pose("body_yaw");
    this.pBodyPitch = d.pose("body_pitch");
  }

  /** Every sequence this state machine can pick (for warming the animation cache). */
  sequences(): number[] {
    const names = ["Idle_Upper_", "Walk_Upper_", "Run_Upper_", "Crouch_Idle_Upper_", "Crouch_Walk_Upper_", "Idle_Shoot_", "Walk_Shoot_", "Run_Shoot_", "Crouch_Idle_Shoot_", "Crouch_Walk_Shoot_"].map((n) => n + this.suffix);
    const acts = ["ACT_IDLE", "ACT_WALK", "ACT_RUN", "ACT_CROUCHIDLE", "ACT_RUN_CROUCH", "ACT_HOP"];
    return [...names.map((n) => this.d.seq(n)), ...acts.map((a) => this.d.seqForActivity(a))].filter((i) => i >= 0);
  }

  /**
   * DoAnimationEvent(PLAYERANIMEVENT_FIRE_GUN_PRIMARY / _SECONDARY): restarts the fire layer with
   * CalcFireLayerSequence's pick for the current main activity (<Idle|Walk|Run|Crouch_Idle|Crouch_Walk>_Shoot_KNIFE).
   * The knife has one attack gesture for both buttons.
   */
  fire(): void {
    let name = "Idle_Shoot_";
    switch (this.activity) {
      case "ACT_RUN":
        name = "Run_Shoot_";
        break;
      case "ACT_WALK":
        name = "Walk_Shoot_";
        break;
      case "ACT_CROUCHIDLE":
        name = "Crouch_Idle_Shoot_";
        break;
      case "ACT_RUN_CROUCH":
        name = "Crouch_Walk_Shoot_";
        break;
    }
    this.fireSeq = this.seqIndex(name + this.suffix);
    this.fireCycle = 0;
  }

  /** ClearAnimationState: e.g. after teleports / seeks. Feet snap to the eyes on the next update. */
  reset(visualTime?: number): void {
    if (visualTime !== undefined) this.now = visualTime;
    this.groundTime = 0;
    this.cycle = 0;
    this.fireSeq = -1;
    this.feetInit = false;
    this.main.queue.length = 0;
    this.idleT.queue.length = 0;
    this.runT.queue.length = 0;
    this.jumping = false;
    this.firstJumpFrame = false;
    this.seq = -1;
  }

  /**
   * Starts mid-jump, `elapsed` seconds after the take-off (after a seek or teleport into the air, where no jump
   * event was seen): ACT_HOP at the matching cycle instead of running in the air until the next hop.
   */
  startAirborne(elapsed: number): void {
    const hop = this.d.seqForActivity("ACT_HOP");
    if (hop < 0) return;
    this.jumping = true;
    this.firstJumpFrame = false;
    this.jumpStart = this.now - elapsed;
    this.seq = hop;
    this.activity = "ACT_HOP";
    this.cycle = Math.max(0, Math.min(1, elapsed * this.bs.cycleRate(hop)));
  }

  private seqIndex(name: string): number {
    let i = this.seqCache.get(name);
    if (i === undefined) {
      i = this.d.seq(name);
      this.seqCache.set(name, i);
    }
    return i;
  }

  /** CBasePlayerAnimState::Update + the client's FrameAdvance for one frame of dt seconds. */
  update(dt: number, s: AnimInput, sampledTime?: number): void {
    this.now += dt;
    this.vx = s.vel[0];
    this.vy = s.vel[1];
    this.speed = Math.hypot(this.vx, this.vy);
    this.groundTime = s.onGround ? this.groundTime + dt : 0;
    if (s.jumped) {
      // DoAnimationEvent( PLAYERANIMEVENT_JUMP )
      this.jumping = true;
      this.firstJumpFrame = true;
      this.jumpStart = this.now;
    }
    this.eyeYaw = angleNormalize(s.eyeYaw);
    this.eyePitch = angleNormalize(s.eyePitch);

    // ComputeSequences
    this.computeMainSequence(s);
    this.maxGroundSpeed = this.currentMaxGroundSpeed();
    // Pose parameters (computed before the aim layers here so the moving layer's weight uses this frame's speed).
    this.bs.setPoseParam(this.pBodyPitch, Math.max(-90, Math.min(90, this.eyePitch)));
    this.computeBodyYaw(dt);
    this.computeMoveYaw();

    // FrameAdvance (playback rate stays 1 with 9-way legs; speed scales the move_x/move_y blend instead).
    const rate = this.bs.cycleRate(this.seq);
    const looping = this.d.seqs[this.seq]?.looping ?? true;
    let c = sampledTime !== undefined && s.onGround && looping ? sampledTime * rate * this.playbackRate : this.cycle + dt * rate * this.playbackRate;
    if (c < 0 || c >= 1) c = looping ? c - Math.floor(c) : c < 0 ? 0 : 1;
    this.cycle = c;
    // MaintainSequenceTransitions
    this.main.check(this.d, this.seq, this.parity !== this.prevParity, true);
    this.prevParity = this.parity;
    this.main.update(this.seq, this.cycle, this.playbackRate, this.now);

    this.computeAimSequence();
    // ComputeFireSequence (UpdateLayerSequenceGeneric): advance; done after one cycle.
    if (this.fireSeq >= 0) {
      this.fireCycle += dt * this.bs.cycleRate(this.fireSeq);
      if (this.fireCycle > 1) this.fireSeq = -1;
    }
  }

  /** Accumulates this frame's pose into the bone setup (InitPose, main sequence + transitions, aim layers). */
  apply(): void {
    const bs = this.bs;
    bs.initPose();
    bs.accumulate(this.seq, this.cycle, 1);
    const q = this.main.queue;
    for (let i = q.length - 2; i >= 0; i--) {
      const b = q[i];
      if (b.seq < 0) continue;
      let c = b.cycle + (this.now - b.animtime) * b.rate * bs.cycleRate(b.seq);
      const looping = this.d.seqs[b.seq]?.looping ?? true;
      if (c < 0 || c >= 1) c = looping ? c - Math.floor(c) : c < 0 ? 0 : 1;
      bs.accumulate(b.seq, c, b.weight);
    }
    for (const l of this.layers) if (l.weight > 0 && l.seq >= 0) bs.accumulate(l.seq, l.cycle, l.weight);
    if (this.fireSeq >= 0) bs.accumulate(this.fireSeq, this.fireCycle, 1);
  }

  // --- Main sequence ------------------------------------------------------------------------------

  private handleJumping(s: AnimInput): boolean {
    if (this.jumping) {
      if (this.firstJumpFrame) {
        this.firstJumpFrame = false;
        // RestartMainSequence (crossfaded when already hopping, see header).
        if (this.activity === "ACT_HOP") this.parity++;
        this.cycle = 0;
        this.jumps++;
      }
      if (this.now - this.jumpStart > JUMP_GROUND_IGNORE && s.onGround && this.groundTime >= LAND_GRACE) {
        this.jumping = false;
        this.cycle = 0;
      }
    }
    return this.jumping;
  }

  private calcMainActivity(s: AnimInput): string {
    if (this.handleJumping(s)) return "ACT_HOP";
    if (s.ducking) return this.speed > MOVING_MINIMUM_SPEED ? "ACT_RUN_CROUCH" : "ACT_CROUCHIDLE";
    if (this.speed > MOVING_MINIMUM_SPEED) return this.speed > ARBITRARY_RUN_SPEED ? "ACT_RUN" : "ACT_WALK";
    return "ACT_IDLE";
  }

  private computeMainSequence(s: AnimInput): void {
    const ideal = this.calcMainActivity(s);
    this.activity = ideal;
    let want = this.d.seqForActivity(ideal);
    if (want < 0) want = 0;
    const curAct = this.seq >= 0 ? this.d.seqs[this.seq].activity : "";
    if (this.seq >= 0 && curAct === this.d.seqs[want].activity) return;
    // ResetSequence: a new sequence (or a non-looping restart) bumps the parity -> client crossfade.
    const changed = want !== this.seq;
    this.seq = want;
    if (changed || !this.d.seqs[want].looping) this.parity++;
  }

  private currentMaxGroundSpeed(): number {
    const act = this.d.seqs[this.seq]?.activity;
    if (act === "ACT_WALK" || act === "ACT_IDLE") return ANIM_TOPSPEED_WALK;
    if (act === "ACT_RUN") return ANIM_TOPSPEED_RUN;
    if (act === "ACT_RUN_CROUCH") return ANIM_TOPSPEED_RUN_CROUCH;
    return 0;
  }

  /** CalcMovementPlaybackRate: [rate, moving]. */
  private movementRate(): [number, boolean] {
    if (this.speed <= MOVING_MINIMUM_SPEED) return [1, false];
    const g = this.maxGroundSpeed;
    if (g < 0.001) return [0.01, true];
    return [Math.max(0.01, Math.min(10, this.speed / g)), true];
  }

  // --- Aim layers ------------------------------------------------------------------------------

  private aimSequence(forceIdle: boolean): number {
    const sfx = this.suffix;
    const act = this.activity;
    if (forceIdle) return this.seqIndex((act === "ACT_CROUCHIDLE" ? "Crouch_Idle_Upper_" : "Idle_Upper_") + sfx);
    switch (act) {
      case "ACT_RUN":
        return this.seqIndex("Run_Upper_" + sfx);
      case "ACT_WALK":
      case "ACT_RUNTOIDLE":
      case "ACT_IDLETORUN":
        return this.seqIndex("Walk_Upper_" + sfx);
      case "ACT_CROUCHIDLE":
        return this.seqIndex("Crouch_Idle_Upper_" + sfx);
      case "ACT_RUN_CROUCH":
        return this.seqIndex("Crouch_Walk_Upper_" + sfx);
      default:
        return this.seqIndex("Idle_Upper_" + sfx);
    }
  }

  private updateAimLayers(cycle: number, first: number, forceIdle: boolean, t: Transitioner, weightScale: number): void {
    let seq = this.aimSequence(forceIdle);
    if (seq < 0) seq = 0;
    t.check(this.d, seq, false, true);
    t.update(seq, cycle, this.playbackRate, this.now);
    const d0 = this.layers[first];
    const d1 = this.layers[first + 1];
    const q = t.queue;
    if (q.length === 1) {
      d0.seq = q[0].seq;
      d0.weight = 1;
      d1.weight = 0;
    } else {
      d0.seq = q[0].seq;
      d1.seq = q[1].seq;
      d0.weight = q[0].weight;
      d1.weight = 1 - d0.weight;
    }
    d0.weight = Math.max(0, Math.min(1, d0.weight * weightScale));
    d1.weight = Math.max(0, Math.min(1, d1.weight * weightScale));
    d0.cycle = d1.cycle = cycle;
  }

  private computeAimSequence(): void {
    for (const l of this.layers) l.weight = 0;
    const cycle = this.cycle;
    this.updateAimLayers(cycle, 0, true, this.idleT, 1);
    const act = this.activity;
    if (act === "ACT_RUN" || act === "ACT_WALK" || act === "ACT_RUNTOIDLE" || act === "ACT_RUN_CROUCH") {
      const [rate, moving] = this.movementRate();
      if (moving) this.updateAimLayers(cycle, 2, false, this.runT, rate);
    }
    // OptimizeLayerWeights: the idle layer gets 1 - (sum of the others); fully covered layers below are dropped.
    let total = 0;
    for (let i = 1; i < NUM_AIM_LAYERS; i++) if (this.layers[i].weight > 0) total += this.layers[i].weight;
    const l0 = this.layers[0];
    if (l0.weight > 0) l0.weight = Math.max(0, 1 - total);
    let last = -1;
    for (let i = 0; i < NUM_AIM_LAYERS; i++) if (this.layers[i].weight > 0.99) last = i;
    for (let i = last - 1; i >= 0; i--) this.layers[i].weight = 0;
  }

  // --- Pose parameters -------------------------------------------------------------------------

  private computeBodyYaw(dt: number): void {
    const moving = this.speed > MOVING_MINIMUM_SPEED;
    if (!this.feetInit) {
      this.feetInit = true;
      this.goalFeetYaw = this.feetYaw = this.eyeYaw;
      this.lastTurnTime = 0;
    } else if (moving) {
      // 9-way legs: the feet point where the eyes do; the blend runs them in any direction.
      this.goalFeetYaw = this.eyeYaw;
    } else if (this.now - this.lastTurnTime > MP_FACEFRONTTIME) {
      this.goalFeetYaw = this.eyeYaw;
    } else {
      const diff = angleNormalize(this.goalFeetYaw - this.eyeYaw);
      if (Math.abs(diff) > MAX_BODY_YAW) this.goalFeetYaw += diff > 0 ? -MAX_BODY_YAW : MAX_BODY_YAW;
    }
    this.goalFeetYaw = angleNormalize(this.goalFeetYaw);
    if (this.feetYaw !== this.goalFeetYaw) {
      this.convergeFeet(dt);
      this.lastTurnTime = this.now;
    }
    this.bodyYaw = this.bs.setPoseParam(this.pBodyYaw, angleNormalize(this.eyeYaw - this.feetYaw));
  }

  /** ConvergeAngles(goal, mp_feetyawrate, max body yaw, dt, current). */
  private convergeFeet(dt: number): void {
    const diff = angleNormalize(this.goalFeetYaw - this.feetYaw);
    const abs = Math.abs(diff);
    let scale = 1;
    if (abs <= FADE_TURN_DEGREES) scale = Math.max(0.01, Math.min(1, abs / FADE_TURN_DEGREES));
    let maxmove = MP_FEETYAWRATE * dt * scale;
    if (abs > MAX_BODY_YAW) maxmove = abs - MAX_BODY_YAW;
    if (abs < maxmove) this.feetYaw = this.goalFeetYaw;
    else this.feetYaw += diff > 0 ? maxmove : -maxmove;
    this.feetYaw = angleNormalize(this.feetYaw);
  }

  private computeMoveYaw(): void {
    // EstimateYaw
    if (this.speed > MOVING_MINIMUM_SPEED) this.gaitYaw = angleNormalize((Math.atan2(this.vy, this.vx) * 180) / Math.PI);
    let yaw = -(this.eyeYaw - this.gaitYaw);
    yaw = yaw - Math.trunc(yaw / 360) * 360;
    if (yaw < -180) yaw += 360;
    else if (yaw > 180) yaw -= 360;
    const [rate, moving] = this.movementRate();
    let x = 0;
    let y = 0;
    if (moving) {
      x = Math.cos((yaw * Math.PI) / 180) * rate;
      y = -Math.sin((yaw * Math.PI) / 180) * rate;
    }
    this.bs.setPoseParam(this.pMoveX, x);
    this.bs.setPoseParam(this.pMoveY, y);
  }
}
