// Bone setup for studio models: the client side of Source's bone_setup.cpp (public SDK 2013), on decoded animations.
//
//   InitPose -> AccumulatePose(main sequence, cycle, 1) -> AccumulatePose(older main sequences, fade weights)
//            -> AccumulatePose(each overlay layer, its cycle and weight) -> bone-to-model matrices
//
// AccumulatePose = CalcPoseSingle (up to 4 animations bilinearly blended by the sequence's two pose parameters, frames
// interpolated) + SlerpBones (per-bone `$weightlist`, delta / post-delta layers) + the sequence's autolayers
// (AddSequenceLayers). Only bones a sequence touches are processed. Quaternion blends use normalised lerp (Source's
// QuaternionBlend) rather than full slerp, which is indistinguishable at these blend weights and much cheaper.

import { STUDIO_AL_LOCAL, STUDIO_AL_NOBLEND, STUDIO_AL_POSE, STUDIO_AL_SPLINE, STUDIO_AL_XFADE, type Seq, type StudioData } from "./data";

const EPS = 1e-6;

/** Source `QuaternionScale`: rotation angle of q scaled by t, written to out[o..o+4]. */
function quatScale(x: number, y: number, z: number, w: number, t: number, out: Float32Array | number[], o: number): void {
  let sinom = Math.sqrt(x * x + y * y + z * z);
  if (sinom > 1) sinom = 1;
  const sinsom = Math.sin(Math.asin(sinom) * t);
  const k = sinsom / (sinom + EPS);
  out[o] = x * k;
  out[o + 1] = y * k;
  out[o + 2] = z * k;
  const r = Math.sqrt(Math.max(0, 1 - sinsom * sinsom));
  out[o + 3] = w < 0 ? -r : r;
}

const tmp4 = new Float32Array(4);
// Quaternion lengths below are Math.sqrt of the summed squares, not Math.hypot: V8's hypot allocates an array of its
// arguments on every call, and these run per bone per layer per frame for every model on screen.

export class BoneSetup {
  /** Current pose, bone-local (quat xyzw, position). */
  readonly q: Float32Array;
  readonly p: Float32Array;
  /** Pose parameters, normalised 0..1 (Source `m_flPoseParameter`). */
  readonly poseParams: Float32Array;
  /** Bone-to-model matrices (3x4 row-major per bone), from `buildMatrices`. */
  readonly world: Float32Array;
  private tq: Float32Array[] = [];
  private tp: Float32Array[] = [];
  /** Sequences accumulated this frame (perf counter). */
  layersThisFrame = 0;

  constructor(readonly d: StudioData) {
    const n = d.bones;
    this.q = new Float32Array(n * 4);
    this.p = new Float32Array(n * 3);
    this.world = new Float32Array(n * 12);
    this.poseParams = new Float32Array(d.info.poseParams.length);
    // Defaults: each parameter's 0 value (move_x/move_y/body_yaw/body_pitch are all centred at 0).
    d.info.poseParams.forEach((_, i) => this.setPoseParam(i, 0));
  }

  /** Makes sure scratch buffers exist for `depth` (tq[depth], tp[depth]). */
  private temp(depth: number): void {
    while (this.tq.length <= depth) {
      this.tq.push(new Float32Array(this.d.bones * 4));
      this.tp.push(new Float32Array(this.d.bones * 3));
    }
  }

  /** `Studio_SetPoseParameter`: stores the normalised value; returns the clamped real value. */
  setPoseParam(i: number, value: number): number {
    if (i < 0) return value;
    const pp = this.d.info.poseParams[i];
    if (pp.loop) {
      const wrap = (pp.start + pp.end) / 2 + pp.loop / 2;
      const shift = pp.loop - wrap;
      value = value - pp.loop * Math.floor((value + shift) / pp.loop);
    }
    let ctl = (value - pp.start) / (pp.end - pp.start);
    ctl = ctl < 0 ? 0 : ctl > 1 ? 1 : ctl;
    this.poseParams[i] = ctl;
    return ctl * (pp.end - pp.start) + pp.start;
  }

  getPoseParam(i: number): number {
    if (i < 0) return 0;
    const pp = this.d.info.poseParams[i];
    return this.poseParams[i] * (pp.end - pp.start) + pp.start;
  }

  /** `Studio_LocalPoseParameter`: blend axis k of a sequence -> [fraction, index]. */
  private localPose(s: Seq, k: number, out: number[]): void {
    const iPose = s.params[k];
    if (iPose < 0) {
      out[0] = 0;
      out[1] = 0;
      return;
    }
    const pp = this.d.info.poseParams[iPose];
    let v = this.poseParams[iPose];
    const gs = s.groupSize[k];
    if (!s.poseKeys.length) {
      const ls = (s.paramStart[k] - pp.start) / (pp.end - pp.start);
      const le = (s.paramEnd[k] - pp.start) / (pp.end - pp.start);
      let t = (v - ls) / (le - ls);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      let index = 0;
      if (gs > 2) {
        index = Math.floor(t * (gs - 1));
        if (index === gs - 1) index = gs - 2;
        t = t * (gs - 1) - index;
      }
      out[0] = t;
      out[1] = index;
    } else {
      v = v * (pp.end - pp.start) + pp.start;
      const keys = s.poseKeys;
      const base = k === 0 ? 0 : s.groupSize[0];
      let index = 0;
      let t = 0;
      for (;;) {
        t = (v - keys[base + index]) / (keys[base + index + 1] - keys[base + index]);
        if (index < gs - 2 && t > 1) {
          index++;
          continue;
        }
        break;
      }
      out[0] = t < 0 ? 0 : t > 1 ? 1 : t;
      out[1] = index;
    }
  }

  private lp0 = [0, 0];
  private lp1 = [0, 0];
  private cornerA = new Int32Array(4);
  private cornerW = new Float32Array(4);

  /** `Studio_SeqAnims`: up to 4 animations and their weights; returns the count written to cornerA/cornerW. */
  private seqAnims(s: Seq): number {
    this.localPose(s, 0, this.lp0);
    this.localPose(s, 1, this.lp1);
    const s0 = this.lp0[0], i0 = this.lp0[1];
    const s1 = this.lp1[0], i1 = this.lp1[1];
    const cols = s.groupSize[0];
    const rows = s.groupSize[1];
    const x1 = Math.min(i0 + 1, cols - 1);
    const y1 = Math.min(i1 + 1, rows - 1);
    // (Per frame for every model on screen: no closure or tuple allocations here.)
    let n = this.corner(s, 0, i0, i1, (1 - s0) * (1 - s1));
    n = this.corner(s, n, x1, i1, s0 * (1 - s1));
    n = this.corner(s, n, i0, y1, (1 - s0) * s1);
    return this.corner(s, n, x1, y1, s0 * s1);
  }

  /** One corner of seqAnims' blend grid into cornerA/cornerW at `n` (skipped when its weight is ~0); the new count. */
  private corner(s: Seq, n: number, x: number, y: number, w: number): number {
    if (w <= 0.001) return n;
    this.cornerA[n] = s.anims[Math.min(s.anims.length - 1, y * s.groupSize[0] + x)];
    this.cornerW[n] = w;
    return n + 1;
  }

  /** `Studio_CPS`: cycles per second of a sequence at the current pose parameters. */
  cycleRate(seqIndex: number): number {
    const s = this.d.seqs[seqIndex];
    if (!s) return 0;
    const n = this.seqAnims(s);
    let t = 0;
    for (let k = 0; k < n; k++) {
      const a = this.d.info.anims[this.cornerA[k]];
      if (a.frames > 1) t += (a.fps / (a.frames - 1)) * this.cornerW[k];
    }
    return t;
  }

  /** Reference pose. */
  initPose(): void {
    this.q.set(this.d.restQ);
    this.p.set(this.d.restP);
    this.layersThisFrame = 0;
  }

  /** `CalcPoseSingle` into (tq, tp) for the sequence's active bones. */
  private calcPoseSingle(s: Seq, cycle: number, tq: Float32Array, tp: Float32Array): void {
    if (cycle < 0 || cycle >= 1) {
      if (s.looping) {
        cycle -= Math.trunc(cycle);
        if (cycle < 0) cycle += 1;
      } else cycle = cycle < 0 ? 0 : 1;
    }
    const n = this.seqAnims(s);
    const nb = this.d.bones;
    const act = s.active;
    for (let k = 0; k < n; k++) {
      const animIdx = this.cornerA[k];
      const w = this.cornerW[k];
      const info = this.d.info.anims[animIdx];
      const d = this.d.anim(animIdx);
      const f = cycle * (info.frames - 1);
      const f0 = Math.min(info.frames - 1, Math.floor(f));
      const f1 = Math.min(info.frames - 1, f0 + 1);
      const t = f - f0;
      const r0 = f0 * nb * 7;
      const r1 = f1 * nb * 7;
      for (let j = 0; j < act.length; j++) {
        const b = act[j];
        const a0 = r0 + b * 7;
        const a1 = r1 + b * 7;
        let x = d[a0], y = d[a0 + 1], z = d[a0 + 2], ww = d[a0 + 3];
        if (t > 0) {
          let bx = d[a1], by = d[a1 + 1], bz = d[a1 + 2], bw = d[a1 + 3];
          if (x * bx + y * by + z * bz + ww * bw < 0) (bx = -bx), (by = -by), (bz = -bz), (bw = -bw);
          x += (bx - x) * t;
          y += (by - y) * t;
          z += (bz - z) * t;
          ww += (bw - ww) * t;
        }
        const px = d[a0 + 4] + (d[a1 + 4] - d[a0 + 4]) * t;
        const py = d[a0 + 5] + (d[a1 + 5] - d[a0 + 5]) * t;
        const pz = d[a0 + 6] + (d[a1 + 6] - d[a0 + 6]) * t;
        const qo = b * 4;
        const po = b * 3;
        if (k === 0) {
          tq[qo] = x * w;
          tq[qo + 1] = y * w;
          tq[qo + 2] = z * w;
          tq[qo + 3] = ww * w;
          tp[po] = px * w;
          tp[po + 1] = py * w;
          tp[po + 2] = pz * w;
        } else {
          const sg = tq[qo] * x + tq[qo + 1] * y + tq[qo + 2] * z + tq[qo + 3] * ww < 0 ? -w : w;
          tq[qo] += x * sg;
          tq[qo + 1] += y * sg;
          tq[qo + 2] += z * sg;
          tq[qo + 3] += ww * sg;
          tp[po] += px * w;
          tp[po + 1] += py * w;
          tp[po + 2] += pz * w;
        }
      }
    }
    // Normalise (frame lerp + corner blend); corner weights sum to ~1 so positions need no rescale.
    let wsum = 0;
    for (let k = 0; k < n; k++) wsum += this.cornerW[k];
    const inv = wsum > 0 ? 1 / wsum : 1;
    for (let j = 0; j < act.length; j++) {
      const qo = act[j] * 4;
      const l = Math.sqrt(tq[qo] * tq[qo] + tq[qo + 1] * tq[qo + 1] + tq[qo + 2] * tq[qo + 2] + tq[qo + 3] * tq[qo + 3]) || 1;
      tq[qo] /= l;
      tq[qo + 1] /= l;
      tq[qo + 2] /= l;
      tq[qo + 3] /= l;
      if (inv !== 1) {
        const po = act[j] * 3;
        tp[po] *= inv;
        tp[po + 1] *= inv;
        tp[po + 2] *= inv;
      }
    }
  }

  /** `SlerpBones`: blends (tq, tp) into the current pose by weight * per-bone weight. */
  private slerpBones(s: Seq, tq: Float32Array, tp: Float32Array, weight: number): void {
    if (weight <= 0) return;
    if (weight > 1) weight = 1;
    const Q = this.q;
    const P = this.p;
    const act = s.active;
    const w = s.w;
    if (s.delta) {
      for (let j = 0; j < act.length; j++) {
        const b = act[j];
        const s2 = weight * w[b];
        if (s2 <= 0) continue;
        const qo = b * 4;
        const po = b * 3;
        quatScale(tq[qo], tq[qo + 1], tq[qo + 2], tq[qo + 3], s2, tmp4, 0);
        const dx = tmp4[0], dy = tmp4[1], dz = tmp4[2], dw = tmp4[3];
        const ax = Q[qo], ay = Q[qo + 1], az = Q[qo + 2], aw = Q[qo + 3];
        let x, y, z, ww;
        if (s.post) {
          // QuaternionMA: q = q * scale(delta)
          x = aw * dx + ax * dw + ay * dz - az * dy;
          y = aw * dy - ax * dz + ay * dw + az * dx;
          z = aw * dz + ax * dy - ay * dx + az * dw;
          ww = aw * dw - ax * dx - ay * dy - az * dz;
        } else {
          // QuaternionSM: q = scale(delta) * q
          x = dw * ax + dx * aw + dy * az - dz * ay;
          y = dw * ay - dx * az + dy * aw + dz * ax;
          z = dw * az + dx * ay - dy * ax + dz * aw;
          ww = dw * aw - dx * ax - dy * ay - dz * az;
        }
        const l = Math.sqrt(x * x + y * y + z * z + ww * ww) || 1;
        Q[qo] = x / l;
        Q[qo + 1] = y / l;
        Q[qo + 2] = z / l;
        Q[qo + 3] = ww / l;
        P[po] += tp[po] * s2;
        P[po + 1] += tp[po + 1] * s2;
        P[po + 2] += tp[po + 2] * s2;
      }
      return;
    }
    for (let j = 0; j < act.length; j++) {
      const b = act[j];
      const s2 = weight * w[b];
      if (s2 <= 0) continue;
      const qo = b * 4;
      const po = b * 3;
      if (s2 >= 1) {
        Q[qo] = tq[qo];
        Q[qo + 1] = tq[qo + 1];
        Q[qo + 2] = tq[qo + 2];
        Q[qo + 3] = tq[qo + 3];
        P[po] = tp[po];
        P[po + 1] = tp[po + 1];
        P[po + 2] = tp[po + 2];
        continue;
      }
      const s1 = 1 - s2;
      let bx = tq[qo], by = tq[qo + 1], bz = tq[qo + 2], bw = tq[qo + 3];
      if (Q[qo] * bx + Q[qo + 1] * by + Q[qo + 2] * bz + Q[qo + 3] * bw < 0) (bx = -bx), (by = -by), (bz = -bz), (bw = -bw);
      const x = Q[qo] * s1 + bx * s2;
      const y = Q[qo + 1] * s1 + by * s2;
      const z = Q[qo + 2] * s1 + bz * s2;
      const ww = Q[qo + 3] * s1 + bw * s2;
      const l = Math.sqrt(x * x + y * y + z * z + ww * ww) || 1;
      Q[qo] = x / l;
      Q[qo + 1] = y / l;
      Q[qo + 2] = z / l;
      Q[qo + 3] = ww / l;
      P[po] = P[po] * s1 + tp[po] * s2;
      P[po + 1] = P[po + 1] * s1 + tp[po + 1] * s2;
      P[po + 2] = P[po + 2] * s1 + tp[po + 2] * s2;
    }
  }

  /** `AccumulatePose`: blends sequence `seqIndex` at `cycle` into the current pose (with its autolayers). */
  accumulate(seqIndex: number, cycle: number, weight: number, depth = 0): void {
    if (seqIndex < 0 || weight <= 0 || depth > 6) return;
    if (weight > 1) weight = 1;
    const s = this.d.seqs[seqIndex];
    if (!s) return;
    this.layersThisFrame++;
    this.temp(depth);
    const tq = this.tq[depth], tp = this.tp[depth];
    this.calcPoseSingle(s, cycle, tq, tp);
    this.slerpBones(s, tq, tp, weight);
    // AddSequenceLayers
    for (const l of s.layers) {
      if (l.flags & STUDIO_AL_LOCAL) continue;
      let layerCycle = cycle;
      let layerWeight = weight;
      if (l.start !== l.end) {
        let sw = 1;
        let index: number;
        if (!(l.flags & STUDIO_AL_POSE)) index = cycle;
        else index = l.pose >= 0 ? this.getPoseParam(l.pose) : 0;
        if (index < l.start || index >= l.end) continue;
        if (index < l.peak && l.start !== l.peak) sw = (index - l.start) / (l.peak - l.start);
        else if (index > l.tail && l.end !== l.tail) sw = (l.end - index) / (l.end - l.tail);
        if (l.flags & STUDIO_AL_SPLINE) sw = sw * sw * (3 - 2 * sw);
        if (l.flags & STUDIO_AL_XFADE && index > l.tail) layerWeight = (sw * weight) / (1 - weight + sw * weight);
        else if (l.flags & STUDIO_AL_NOBLEND) layerWeight = sw;
        else layerWeight = weight * sw;
        if (!(l.flags & STUDIO_AL_POSE)) layerCycle = (cycle - l.start) / (l.end - l.start);
      }
      this.accumulate(l.seq, layerCycle, layerWeight, depth + 1);
    }
  }

  /** Bone-to-model matrices (3x4, row-major) from the current pose; parents precede children in studio order. */
  buildMatrices(): Float32Array {
    const Q = this.q;
    const P = this.p;
    const W = this.world;
    const par = this.d.parent;
    const n = this.d.bones;
    for (let i = 0; i < n; i++) {
      const x = Q[i * 4], y = Q[i * 4 + 1], z = Q[i * 4 + 2], w = Q[i * 4 + 3];
      // QuaternionMatrix
      const l00 = 1 - 2 * y * y - 2 * z * z, l01 = 2 * x * y - 2 * w * z, l02 = 2 * x * z + 2 * w * y;
      const l10 = 2 * x * y + 2 * w * z, l11 = 1 - 2 * x * x - 2 * z * z, l12 = 2 * y * z - 2 * w * x;
      const l20 = 2 * x * z - 2 * w * y, l21 = 2 * y * z + 2 * w * x, l22 = 1 - 2 * x * x - 2 * y * y;
      const l03 = P[i * 3], l13 = P[i * 3 + 1], l23 = P[i * 3 + 2];
      const o = i * 12;
      const pi = par[i];
      if (pi < 0) {
        W[o] = l00, W[o + 1] = l01, W[o + 2] = l02, W[o + 3] = l03;
        W[o + 4] = l10, W[o + 5] = l11, W[o + 6] = l12, W[o + 7] = l13;
        W[o + 8] = l20, W[o + 9] = l21, W[o + 10] = l22, W[o + 11] = l23;
      } else {
        const p = pi * 12;
        for (let r = 0; r < 3; r++) {
          const a0 = W[p + r * 4], a1 = W[p + r * 4 + 1], a2 = W[p + r * 4 + 2], a3 = W[p + r * 4 + 3];
          W[o + r * 4] = a0 * l00 + a1 * l10 + a2 * l20;
          W[o + r * 4 + 1] = a0 * l01 + a1 * l11 + a2 * l21;
          W[o + r * 4 + 2] = a0 * l02 + a1 * l12 + a2 * l22;
          W[o + r * 4 + 3] = a0 * l03 + a1 * l13 + a2 * l23 + a3;
        }
      }
    }
    return W;
  }
}

/** out (4x4 column-major, three.js) = a (3x4 row-major) * b (3x4 row-major). */
export function concat34To44(a: Float32Array, ao: number, b: Float32Array, bo: number, out: Float32Array, oo: number): void {
  for (let r = 0; r < 3; r++) {
    const a0 = a[ao + r * 4], a1 = a[ao + r * 4 + 1], a2 = a[ao + r * 4 + 2], a3 = a[ao + r * 4 + 3];
    out[oo + r] = a0 * b[bo] + a1 * b[bo + 4] + a2 * b[bo + 8];
    out[oo + 4 + r] = a0 * b[bo + 1] + a1 * b[bo + 5] + a2 * b[bo + 9];
    out[oo + 8 + r] = a0 * b[bo + 2] + a1 * b[bo + 6] + a2 * b[bo + 10];
    out[oo + 12 + r] = a0 * b[bo + 3] + a1 * b[bo + 7] + a2 * b[bo + 11] + a3;
  }
  out[oo + 3] = 0;
  out[oo + 7] = 0;
  out[oo + 11] = 0;
  out[oo + 15] = 1;
}

/** out (3x4) = a (3x4) * b (3x4). */
export function concat34(a: Float32Array | number[], ao: number, b: Float32Array | number[], bo: number, out: Float32Array | number[], oo: number): void {
  for (let r = 0; r < 3; r++) {
    const a0 = a[ao + r * 4], a1 = a[ao + r * 4 + 1], a2 = a[ao + r * 4 + 2], a3 = a[ao + r * 4 + 3];
    out[oo + r * 4] = a0 * b[bo] + a1 * b[bo + 4] + a2 * b[bo + 8];
    out[oo + r * 4 + 1] = a0 * b[bo + 1] + a1 * b[bo + 5] + a2 * b[bo + 9];
    out[oo + r * 4 + 2] = a0 * b[bo + 2] + a1 * b[bo + 6] + a2 * b[bo + 10];
    out[oo + r * 4 + 3] = a0 * b[bo + 3] + a1 * b[bo + 7] + a2 * b[bo + 11] + a3;
  }
}
