// First-person inspect runtime: the combo state machine (combo.ts) for the knife in hand, its clips posed on top of the
// viewmodel's base pose with crossfades (chain switches) and a quick blend-out (attack cancels), the weapon events
// (inspect / flip / spin / catch, events.ts) and the network / replay signals (combo.ts SIG_*).
//
//   viewmodel.ts:  press() on F, cancel("attack") when a swing starts, cancel("draw") on deploy,
//                  update(dt, F held) per frame, apply(W) after the knife hold layer.

import type { KnifeDef, KnifeState } from "../knives/types";
import { emitWeaponEvent } from "../events";
import type { VmRig } from "../rig";
import { CANCEL_BLEND, InspectCombo, SIG_NEXT, SIG_START, type ComboEvent, type ComboPose } from "./combo";
import { inspectSetFor } from "./index";
import { isQuietSet, quietSet } from "./quiet";
import { prefs } from "../../ui/settings";
import { Arm, blendPoseH } from "./kit";
import type { InspectCtx, InspectSet } from "./types";

/** The longest attack cancel (s): a knife mid-toss or turned right round comes home over this long. */
export const CANCEL_BLEND_MAX = 0.17;

/** The cancel's blend for a knife `d` units and `a` rad from the fist (CANCEL_BLEND in hand, CANCEL_BLEND_MAX far out). */
export function cancelBlend(d: number, a: number): number {
  const far = Math.min(1, Math.max(d / 6, a / 2.4));
  return CANCEL_BLEND + (CANCEL_BLEND_MAX - CANCEL_BLEND) * far * far * (3 - 2 * far);
}

export class VmInspect {
  readonly arm: Arm;
  readonly combo: InspectCombo;
  private set: InspectSet;
  private override: InspectSet | null = null;
  private knife: KnifeDef | null = null;
  private ctx: InspectCtx;
  private Wc: Float32Array;
  private Wp: Float32Array;
  private pz: ComboPose = { cur: null, prev: null, mix: 1, weight: 0 };
  private angB: number[] = [];
  private angC: number[] = [];
  /**
   * How far the inspect has the knife from where the base pose holds it, at the last full-weight frame: the handle's
   * travel (units) and turn (rad). A cancel blends out over longer the further it is (cancelBlend).
   */
  private gapD = 0;
  private gapA = 0;
  /** No weapon events (sounds): the replay viewer's viewmodel (Viewmodel.silent). */
  silent = false;
  /** START / NEXT when a trick starts (for rooms and the replay trailer; HELD is `holding`). */
  onSignal: ((sig: number) => void) | null = null;

  /** Bones blended (parents first) and their blend parents (the knife hangs off the hand, so it blends with it). */
  private blendBones: number[];
  private blendParent: (i: number) => number;
  private fingerBlend: { bones: Set<number>; w: number };
  /** The knife's own weight during a cancel (it's back in the fist by the middle of the blend: a catch). */
  private knifeBlend: { bones: Set<number>; w: number };
  private cancelGroups: { bones: Set<number>; w: number }[];

  constructor(r: VmRig) {
    this.arm = new Arm(r);
    const kp = r.bone("knife_Parent"), hand = this.arm.handBone;
    // Parents first: the rig lists parents before children; the knife (blended under the hand) goes last.
    const knife = new Set(this.arm.knife);
    this.blendBones = [...this.arm.all.filter((i) => !knife.has(i)).sort((a, b) => a - b), ...this.arm.knife];
    this.fingerBlend = { bones: new Set(Object.values(this.arm.fingers).flat()), w: 1 };
    this.knifeBlend = { bones: new Set(this.arm.knife), w: 1 };
    this.cancelGroups = [this.fingerBlend, this.knifeBlend];
    this.blendParent = (i) => (i === kp ? hand : r.parent[i]);
    const n = r.names.length * 12;
    this.Wc = new Float32Array(n);
    this.Wp = new Float32Array(n);
    this.set = inspectSetFor(null);
    this.combo = new InspectCombo(this.set.spec);
    this.ctx = { arm: this.arm, knife: null, state: null };
  }

  /** The knife in hand changed (null = the carrot); `state` is its hold layer's state (extra-bone angles). */
  setKnife(k: KnifeDef | null, state: KnifeState | null): void {
    this.knife = k;
    this.ctx.knife = k;
    this.ctx.state = state;
    this.pick();
    this.publish();
  }

  /** Dev: force an inspect set (null = the knife's own). */
  setOverride(s: InspectSet | null): void {
    this.override = s;
    this.pick();
  }

  get current(): InspectSet {
    return this.set;
  }

  /**
   * The quiet style (Settings -> Viewmodel -> Inspect: Quiet) on your own viewmodel: the chain starts with the quiet
   * check. Never on the replay viewer's (silent) one: replays and rooms play the knife's own tricks.
   */
  private quiet(): boolean {
    return !this.silent && !this.override && prefs.get().viewmodel.inspect === "quiet";
  }

  private pick(): void {
    const base = this.override ?? inspectSetFor(this.knife);
    const s = this.quiet() ? quietSet(base) : base;
    if (s === this.set) return;
    this.set = s;
    this.combo.setSpec(s.spec);
  }

  get active(): boolean {
    return this.combo.active;
  }

  /** The inspect key is held during an inspect (network HELD level; not during your quiet check, which isn't sent). */
  get holding(): boolean {
    return this.combo.holding && !(this.offset && this.combo.trick === 0);
  }

  /** Tricks before the knife's own (1 with the quiet check in front): signals count the knife's own chain only. */
  private get offset(): number {
    return isQuietSet(this.set) ? 1 : 0;
  }

  press(): void {
    // (The style is read when an inspect starts: a settings change mid-inspect waits for the next one.)
    if (!this.combo.active) this.pick();
    this.handle(this.combo.press());
    this.publish();
  }

  /** Puppet input (a replay's signals, combo.ts remote): START restarts the base trick, NEXT chains now. */
  remote(sig: number): void {
    this.handle(this.combo.remote(sig));
    this.publish();
  }

  /**
   * An attack blends the inspect out: quickly with the knife in the fist (CANCEL_BLEND, CS-snappy), up to
   * CANCEL_BLEND_MAX when the trick has it far out (mid-toss, spun round): it comes home like a catch, not a jump. A draw
   * stops it at once (off screen); a switch away (the knife lowering) blends like an attack.
   */
  cancel(reason: "attack" | "draw" | "switch"): void {
    if (reason === "draw") this.handle(this.combo.cancel("draw"));
    else this.handle(this.combo.cancel("attack", cancelBlend(this.gapD, this.gapA)));
    this.publish();
  }

  update(dt: number, held: boolean): void {
    this.handle(this.combo.update(dt, held));
    this.publish();
  }

  /** Nothing playing, no history (a replay seek, an export's start). No events. */
  reset(): void {
    this.combo.reset();
    this.gapD = this.gapA = 0;
    this.publish();
  }

  /** Dev / screenshots: freeze trick `trick` at t. */
  seek(trick: number, t: number): void {
    this.combo.seek(trick, t);
    this.publish();
  }

  /** The hold's show weight for this frame (InspectClip.show through the crossfade and the inspect's weight). */
  private publish(): void {
    const st = this.ctx.state;
    if (!st) return;
    const pz = this.combo.pose(this.pz);
    const clips = this.set.clips;
    let v = 0;
    if (pz.cur && pz.weight > 0) {
      const at = (slot: { trick: number; t: number }) => clips[slot.trick]?.show?.(slot.t) ?? 0;
      v = at(pz.cur);
      if (pz.prev && pz.mix < 1) v = at(pz.prev) + (v - at(pz.prev)) * pz.mix;
      v *= pz.weight;
    }
    st.show = v;
  }

  private handle(ev: ComboEvent[]): void {
    for (const e of ev) {
      if (e.type === "start" || e.type === "trick") {
        const c = this.set.clips[e.trick];
        if (!this.silent) emitWeaponEvent({ type: "inspect", source: "local", trick: e.trick, name: c?.id });
        // Rooms, the replay trailer and your third-person bunny see the knife's own chain: your quiet check sends
        // nothing, the first trick after it starts their inspect.
        const k = e.trick - this.offset;
        if (k >= 0) this.onSignal?.(k === 0 ? SIG_START : SIG_NEXT);
      } else if (e.type === "cue" && !this.silent) emitWeaponEvent({ type: e.cue, source: "local", trick: e.trick });
    }
  }

  /** The knife handle's travel and turn between the base pose (W) and the inspect's (R). */
  private measureGap(W: Float32Array, R: Float32Array): void {
    const o = this.arm.kb * 12;
    this.gapD = Math.hypot(R[o + 3] - W[o + 3], R[o + 7] - W[o + 7], R[o + 11] - W[o + 11]);
    // Rotation angle between the two frames: acos((trace(Ra^T Rb) - 1) / 2).
    let tr = 0;
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) tr += W[o + r * 4 + c] * R[o + r * 4 + c];
    this.gapA = Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2)));
  }

  /** Poses the inspect over W (the base pose with the knife hold applied). Cheap no-op when idle. */
  apply(W: Float32Array): void {
    const pz = this.combo.pose(this.pz);
    if (!pz.cur || pz.weight <= 0) return;
    const clips = this.set.clips;
    const st = this.ctx.state;
    const ang = st?.angles;
    if (ang) {
      this.angB.length = this.angC.length = ang.length;
      for (let i = 0; i < ang.length; i++) this.angB[i] = ang[i];
    }
    const Wc = this.Wc;
    Wc.set(W);
    clips[pz.cur.trick].apply(Wc, pz.cur.t, this.ctx);
    let R = Wc;
    if (pz.prev && pz.mix < 1) {
      if (ang) for (let i = 0; i < ang.length; i++) (this.angC[i] = ang[i]), (ang[i] = this.angB[i]);
      const Wp = this.Wp;
      Wp.set(W);
      clips[pz.prev.trick].apply(Wp, pz.prev.t, this.ctx);
      blendPoseH(Wp, Wc, pz.mix, this.blendBones, this.blendParent);
      if (ang) for (let i = 0; i < ang.length; i++) ang[i] += (this.angC[i] - ang[i]) * pz.mix;
      R = Wp;
    }
    // Cancel blend-out of the knife's moving parts (a balisong's handles, a spinner): home in the first half, before
    // the fingers close on the handle (below), so a cancel mid-flip doesn't close the fist on a handle still swinging.
    if (ang && pz.weight < 1) {
      const k = Math.max(0, Math.min(1, (pz.weight - 0.5) / 0.5)), w = k * k * (3 - 2 * k);
      for (let i = 0; i < ang.length; i++) ang[i] = this.angB[i] + (ang[i] - this.angB[i]) * w;
    }
    if (pz.weight >= 1) this.measureGap(W, R);
    // Cancel blend-out: the knife comes home into the fist in the first half (a catch: a knife mid-toss slerping
    // home in step with the arm hangs off the open hand on the way), the fingers hold the inspect's pose through that
    // half, then close on it (closing them in step with a knife that is still travelling drags the fingertips through it).
    if (pz.weight < 1) {
      this.fingerBlend.w = Math.min(1, pz.weight * 2);
      const k = Math.max(0, Math.min(1, (pz.weight - 0.45) / 0.55));
      this.knifeBlend.w = k * k * (3 - 2 * k);
    }
    blendPoseH(W, R, pz.weight, this.blendBones, this.blendParent, pz.weight < 1 ? this.cancelGroups : undefined);
  }
}
