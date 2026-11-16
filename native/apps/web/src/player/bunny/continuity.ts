// Pose continuity at the CS:S animations' snaps (v0.0.42; player/bunny/model.ts). The jump sequence starts and ends
// with a snap (as in CS:S: a jump out of a run throws the feet 30 units in one frame, the landing's change back to
// the run 10), and a sequence change is the one place the body's pose is not continuous. When the animation's main
// sequence changes or restarts, the difference between the pose shown last frame and the new one is kept and eased out
// over SNAP_BLEND, so the body moves from where it was into the new sequence. Where the animation already crossfades
// (a bhop's bounce) the difference is a frame's motion and this does nothing visible.
//
// On the skinning matrices as the animation leaves them, before the posture, legs and ears. Exact in time: the same at
// any frame rate from the frame the change is seen. No allocation per frame.

/** Seconds a snap's difference takes to ease out. */
export const SNAP_BLEND = 0.1;

export class PoseContinuity {
  /** Debug / tests: the weight of the kept difference this frame (1 at the snap, 0 when done). */
  weight = 0;
  private kept: Float32Array;
  private diff: Float32Array;
  private t = Infinity;
  private has = false;
  private key = "";

  /** `n`: the floats to keep (12 per bone). */
  constructor(private n: number) {
    this.kept = new Float32Array(n);
    this.diff = new Float32Array(n);
  }

  /** `key` changes when the main sequence changes or restarts (activity + jump count). `snap`: a teleport, a seek. */
  apply(S: Float32Array, key: string, dt: number, snap: boolean): void {
    const n = this.n;
    if (snap || !this.has) this.t = Infinity;
    else if (key !== this.key) {
      for (let i = 0; i < n; i++) this.diff[i] = this.kept[i] - S[i];
      this.t = 0;
    } else this.t += dt;
    this.key = key;
    const x = this.t / SNAP_BLEND;
    this.weight = x >= 1 ? 0 : 1 - x * x * (3 - 2 * x);
    if (this.weight > 0) for (let i = 0; i < n; i++) S[i] += this.diff[i] * this.weight;
    this.kept.set(S.subarray(0, n));
    this.has = true;
  }
}
