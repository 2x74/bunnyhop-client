// The website's inspect kit on real knife poses, and its inspect chain over a fixed stream of presses, holds and
// cancels. viewmodel_pose_tests.cpp runs the C++ port on the same inputs: the cancel's hierarchical blend (fingers and
// knife at their own weights), a chain crossfade, the hand idle's wrist bend and finger eases, and every frame of the
// chain (the trick, its time, the crossfade, the weight, the tricks started and the cues).
import { writeFile } from "node:fs/promises";
import { vmRig } from "../../web/src/viewmodel/rig";
import { VmProcedural, type VmAction } from "../../web/src/viewmodel/procedural";
import { KnifeHold } from "../../web/src/viewmodel/knives/hold";
import { KNIVES, knifeById } from "../../web/src/viewmodel/knives/index";
import { inspectSetFor } from "../../web/src/viewmodel/inspects/index";
import { quietSet } from "../../web/src/viewmodel/inspects/quiet";
import { Arm, blendPoseH } from "../../web/src/viewmodel/inspects/kit";
import { InspectCombo, type ComboEvent } from "../../web/src/viewmodel/inspects/combo";
import { clampFingers } from "../../web/src/viewmodel/fingers";
import type { InspectClip } from "../../web/src/viewmodel/inspects/types";

const vr = vmRig();
const arm = new Arm(vr);
const parts = [...new Set(KNIVES.flatMap((knife) => knife.joints ?? []))].map((name) => vr.bone(name));
const knifeBones = new Set(arm.knife);
const blend = [...arm.all.filter((i) => !knifeBones.has(i)).sort((a, b) => a - b), ...arm.knife, ...parts];
const knifeParent = vr.bone("knife_Parent");
const blendParent = (i: number) => (i === knifeParent ? arm.handBone : vr.parent[i]);
const def = knifeById("bunnyfly")!;
const hold = new KnifeHold(def, vr, "knit");
const proc = new VmProcedural(vr);
const set = inspectSetFor(def);

/** A knife pose as the baked clips have it (bone-to-model), from an action or a trick of the knife's chain. */
function posed(action: VmAction, t: number, clip?: InspectClip, clipT = 0): Float32Array {
  const W = new Float32Array(vr.names.length * 12);
  proc.pose(clip ? "idle" : action, clip ? 0 : t, W);
  hold.state.show = clip?.show?.(clipT) ?? 0;
  hold.apply(W, clip ? "idle" : action, clip ? 0 : t, "procedural");
  clip?.apply(W, clipT, { arm, knife: def, state: hold.state });
  hold.solve(W);
  clampFingers(W, vr);
  return W;
}

const slash = posed("slash1", 0.08);
const toss = posed("idle", 0, set.clips[1], set.clips[1].len * 0.45);
const presented = posed("idle", 0, set.clips[0], set.clips[0].enter + 0.2);
const cancel = slash.slice();
const weight = 0.6;
const k = Math.max(0, Math.min(1, (weight - 0.45) / 0.55));
const partWeight = Math.max(0, Math.min(1, (weight - 0.5) / 0.5));
const groups = [
  { bones: new Set(parts), w: partWeight * partWeight * (3 - 2 * partWeight) },
  { bones: new Set(Object.values(arm.fingers).flat()), w: Math.min(1, weight * 2) },
  { bones: knifeBones, w: k * k * (3 - 2 * k) },
];
blendPoseH(cancel, toss, weight, blend, blendParent, groups);
const jointBones = (def.joints ?? []).map((name) => vr.bone(name));
const tossAngles = [...hold.state.angles];
// posed(presented) above last set the hold: sample the toss again to read its authored joint angles.
posed("idle", 0, set.clips[1], set.clips[1].len * 0.45);
for (let i = 0; i < tossAngles.length; i++) tossAngles[i] = hold.state.angles[i];
const cancelAngles = tossAngles.map((angle) => angle * partWeight * partWeight * (3 - 2 * partWeight));
hold.state.angles = [...cancelAngles];
hold.solve(cancel);
const chain = presented.slice();
blendPoseH(chain, toss, 0.3, blend, blendParent);
posed("idle", 0, set.clips[0], set.clips[0].enter + 0.2);
const chainAngles = hold.state.angles.map((angle, i) => angle + (tossAngles[i] - angle) * 0.3);
hold.state.angles = [...chainAngles];
hold.solve(chain);
const idleHand = posed("idle", 0);
arm.wrist(idleHand, 1.3, -0.7);
const frame = arm.frame(idleHand);
arm.curl(idleHand, "index", [-4, -2, 0], 0, frame);
arm.curl(idleHand, "pinky", [-3, -1.2, 0], 0, frame);
hold.solve(idleHand);

const rig = {
  parent: Array.from(vr.parent),
  bind: Array.from(vr.bind),
  inv: Array.from(vr.inv),
  blend,
  hand: arm.hand,
  helper: arm.helper,
  knife: [...arm.knife, ...jointBones],
  parts,
  fingers: arm.fingers,
  handBone: arm.handBone,
  armBone: arm.armBone,
  knifeHandle: arm.kb,
  knifeParent,
};

// The chain: the quiet check in front of the knife's own tricks, as the quiet style plays it.
const quiet = quietSet(set);
const specs = quiet.clips.map((c) => ({
  duration: c.len,
  enter: c.enter,
  exit: c.exit,
  open: c.open,
  loop: c.loop ?? null,
  cues: (c.cues ?? []).map((cue) => [cue.t, cue.type]),
}));
const combo = new InspectCombo(quiet.spec);
const FRAME_SECONDS = [1 / 60, 1 / 144, 1 / 30, 1 / 240];
const PRESS_FRAMES = new Set([5, 40, 140, 141, 420, 700, 760]);
const frames = [];
for (let f = 0; f < 1000; f++) {
  const dt = FRAME_SECONDS[f % FRAME_SECONDS.length];
  const held = (f >= 140 && f < 330) || (f >= 760 && f < 900);
  const events: ComboEvent[] = [];
  let action = "";
  if (PRESS_FRAMES.has(f)) {
    events.push(...combo.press());
    action = "press";
  }
  if (f === 560) {
    combo.cancel("attack", 0.12);
    action = "cancel";
  }
  if (f === 880) {
    combo.cancel("draw");
    action = "draw";
  }
  events.push(...combo.update(dt, held));
  const pose = combo.pose();
  frames.push({
    dt,
    held,
    action,
    started: events.filter((e) => e.type === "start" || e.type === "trick").map((e) => (e as { trick: number }).trick),
    cues: events.filter((e) => e.type === "cue").map((e) => (e as { cue: string }).cue),
    current: pose.cur ? [pose.cur.trick, pose.cur.t] : null,
    previous: pose.prev ? [pose.prev.trick, pose.prev.t] : null,
    mix: pose.mix,
    weight: pose.weight,
  });
}

await writeFile(
  process.argv[2] ?? "viewmodel-pose-oracle.json",
  JSON.stringify({
    rig,
    jointBones,
    cancelAngles,
    chainAngles,
    poses: {
      slash: Array.from(slash),
      toss: Array.from(toss),
      presented: Array.from(presented),
      idle: Array.from(posed("idle", 0)),
      cancel: Array.from(cancel),
      chain: Array.from(chain),
      idleHand: Array.from(idleHand),
    },
    cancel: { weight, parts: groups[0].w, fingers: groups[1].w, knife: groups[2].w },
    chain: specs,
    frames,
  }),
);
