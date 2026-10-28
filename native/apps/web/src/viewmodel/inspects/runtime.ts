// First-person inspect runtime: the combo state machine (combo.ts) for the knife in hand, its clips posed on top of the
// viewmodel's base pose with crossfades (chain switches) and a quick blend-out (attack cancels), the weapon events
// (inspect / flip / spin / catch, events.ts) and the network / replay signals (combo.ts SIG_*).
//
//   viewmodel.ts:  press() on F, cancel("attack") when a swing starts, cancel("draw") on deploy,
//                  update(dt, F held) per frame, apply(W) after the knife hold layer.

import type { KnifeDef, KnifeState } from "../knives/types";
import { emitWeaponEvent } from "../events";
import type { VmRig } from "../rig";
import { InspectCombo, SIG_NEXT, SIG_START, type ComboEvent, type ComboPose } from "./combo";
import { inspectSetFor } from "./index";
import { Arm, blendPoseH } from "./kit";
import type { InspectCtx, InspectSet } from "./types";

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
  /** START / NEXT when a trick starts (for rooms and the replay trailer; HELD is `holding`). */
  onSignal: ((sig: number) => void) | null = null;

  /** Bones blended (parents first) and their blend parents (the knife hangs off the hand, so it blends with it). */
  private blendBones: number[];
  private blendParent: (i: number) => number;
  private fingerBlend: { bones: Set<number>; w: number };

  constructor(r: VmRig) {
    this.arm = new Arm(r);
    const kp = r.bone("knife_Parent"), hand = this.arm.handBone;
    // Parents first: the rig lists parents before children; the knife (blended under the hand) goes last.
    const knife = new Set(this.arm.knife);
    this.blendBones = [...this.arm.all.filter((i) => !knife.has(i)).sort((a, b) => a - b), ...this.arm.knife];
    this.fingerBlend = { bones: new Set(Object.values(this.arm.fingers).flat()), w: 1 };
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

  private pick(): void {
    const s = this.override ?? inspectSetFor(this.knife);
    if (s === this.set) return;
    this.set = s;
    this.combo.setSpec(s.spec);
  }

  get active(): boolean {
    return this.combo.active;
  }

  /** The inspect key is held during an inspect (network HELD level). */
  get holding(): boolean {
    return this.combo.holding;
  }

  press(): void {
    this.handle(this.combo.press());
    this.publish();
  }

  cancel(reason: "attack" | "draw"): void {
    this.handle(this.combo.cancel(reason));
    this.publish();
  }

  update(dt: number, held: boolean): void {
    this.handle(this.combo.update(dt, held));
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
        emitWeaponEvent({ type: "inspect", source: "local", trick: e.trick, name: c?.id });
        this.onSignal?.(e.type === "start" ? SIG_START : SIG_NEXT);
      } else if (e.type === "cue") emitWeaponEvent({ type: e.cue, source: "local", trick: e.trick });
    }
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
    if (ang && pz.weight < 1) for (let i = 0; i < ang.length; i++) ang[i] = this.angB[i] + (ang[i] - this.angB[i]) * pz.weight;
    // Cancel blend-out: the fingers hold the inspect's pose through the first half while the knife comes home, then
    // close on it (closing them in step with a knife that is still travelling drags the fingertips through it).
    if (pz.weight < 1) this.fingerBlend.w = Math.min(1, pz.weight * 2);
    blendPoseH(W, R, pz.weight, this.blendBones, this.blendParent, pz.weight < 1 ? this.fingerBlend : undefined);
  }
}
