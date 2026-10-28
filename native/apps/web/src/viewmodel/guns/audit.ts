// Gun hand / finger audit (unit test apps/api/test/gun-audit.test.ts; dev tool; nothing in the game imports it). Plays
// every gun animation through the real GunViewmodel pose (headless: no DOM, no render) with the finger safety clamp
// OFF, so it sees the raw pose, sampled at a fixed rate, and checks each frame:
//   joints   every finger / thumb joint of BOTH hands inside fingers.ts LIMITS (nothing bends backwards)
//   gun      finger / thumb capsules of both hands vs the gun's own vertices (body, slide, pump: the held magazine and
//            shell are meant to be in the fingers): no deeper than that segment already is in the idle hold + tolerance
// and, at idle (gripReport): the right hand's wrapped fingers rest on the grip (2+ segments in contact, none hovering),
// the support hand's wrapped fingers rest on the gun or the firing hand, nothing sinks into the gun.
// Scenarios: idle, draw, holster, fire (+ a burst), dry fire, mode toggle, reload (full / empty), shotgun start / shells /
// end, the M3's pump, the inspect, and a shot cancelling an inspect midway (crossfade); a gun with a silencer: screwing
// it on and off, a seek into the middle of each (a restart / replay scrub), firing and reloading with it on, and a draw
// with it on. The silencer is part of the gun for the depth check while it's shown (the support hand's fingers rest on
// it as they rest on the grip: solved onto it, guns/hold.ts solveSilencerHand).

import type { GloveStyleId } from "../../loadout";
import { readFingers } from "../fingers";
import { PART } from "../knives/types";
import { gunRig } from "./rig";
import { gunGeometry } from "./rig";
import type { GunDef } from "./types";
import { GunPoser } from "./pose";

/** The silencer clip's length (s): CS:S add_silencer / detach_silencer, the core's lock-out. */
const SILENCER_T = 114 / 37;

export interface GunViolation {
  kind: "joint" | "gun";
  scenario: string;
  t: number;
  what: string;
  amount: number;
}

interface Seg {
  side: "R" | "L";
  digit: string;
  k: number;
  a: number[];
  b: number[];
  r: number;
}

const DIGITS: [string, string, number, number][] = [
  ["index", "Index", 0.4, 0.92],
  ["middle", "Middle", 0.42, 0.98],
  ["ring", "Ring", 0.4, 0.92],
  ["pinky", "Pinky", 0.35, 0.8],
  ["thumb", "Thumb", 0.46, 1.02],
];
const SEG_R = [1, 0.95, 0.85];

function segs(W: Float32Array): Seg[] {
  const r = gunRig().hands;
  const out: Seg[] = [];
  for (const side of ["R", "L"] as const) {
    for (const [d, n, rad, tip] of DIGITS) {
      const names = [1, 2, 3].map((k) => (side === "L" && n === "Thumb" && k === 2 ? "Left_Thumb_02" : `${side === "R" ? "Right_" : "Left_"}${n}0${k}`));
      const b = names.map((nm) => r.bone(nm));
      const p = b.map((i) => [W[i * 12 + 3], W[i * 12 + 7], W[i * 12 + 11]]);
      const x = [W[b[2] * 12], W[b[2] * 12 + 4], W[b[2] * 12 + 8]];
      const l = Math.hypot(x[0], x[1], x[2]) || 1;
      const t = [p[2][0] + (x[0] / l) * tip, p[2][1] + (x[1] / l) * tip, p[2][2] + (x[2] / l) * tip];
      [[p[0], p[1]], [p[1], p[2]], [p[2], t]].forEach(([a, bb], k) => out.push({ side, digit: d, k, a, b: bb, r: rad * SEG_R[k] }));
    }
  }
  return out;
}

function segDist(px: number, py: number, pz: number, a: number[], b: number[]): number {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const apx = px - a[0], apy = py - a[1], apz = pz - a[2];
  const l = abx * abx + aby * aby + abz * abz;
  const t = l > 1e-9 ? Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / l)) : 0;
  const dx = apx - abx * t, dy = apy - aby * t, dz = apz - abz * t;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** The gun's first-person vertices (gun-local) per bone, with grip flags; welded duplicates dropped. */
interface Cloud {
  bone: Int16Array;
  p: Float32Array;
  grip: Uint8Array;
  n: number;
}
const clouds = new Map<string, Cloud>();

function cloudOf(def: GunDef, stride: number): Cloud {
  const key = `${def.id}|${stride}`;
  const hit = clouds.get(key);
  if (hit) return hit;
  const r = gunRig();
  const g = gunGeometry(def, "knit");
  const P = g.getAttribute("position"), SI = g.getAttribute("skinIndex"), F = g.getAttribute("finishUV");
  const keep = new Set([r.part("Gun"), r.part("Slide"), r.part("Pump"), r.part("Sil")]);
  const seen = new Set<string>();
  const bone: number[] = [], p: number[] = [], grip: number[] = [];
  let i = 0;
  for (let v = 0; v < P.count; v++) {
    const b = SI.getX(v);
    if (!keep.has(b)) continue;
    const x = P.getX(v), y = P.getY(v), z = P.getZ(v);
    const k = `${Math.round(x * 50)},${Math.round(y * 50)},${Math.round(z * 50)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (i++ % stride) continue;
    bone.push(b);
    p.push(x, y, z);
    grip.push(F && Math.round(F.getZ(v)) === PART.grip ? 1 : 0);
  }
  const c = { bone: Int16Array.from(bone), p: Float32Array.from(p), grip: Uint8Array.from(grip), n: bone.length };
  clouds.set(key, c);
  return c;
}

/** Per segment: deepest gap to the gun (units, < 0 = inside) and to its grip parts. */
function depths(W: Float32Array, c: Cloud, ss: Seg[], out: { all: Float32Array; grip: Float32Array }): void {
  out.all.fill(Infinity);
  out.grip.fill(Infinity);
  for (let v = 0; v < c.n; v++) {
    const o = c.bone[v] * 12, l = v * 3;
    // A collapsed part (the silencer while it's off) isn't there.
    if (W[o] === 0 && W[o + 5] === 0 && W[o + 10] === 0) continue;
    const x = c.p[l], y = c.p[l + 1], z = c.p[l + 2];
    const px = W[o] * x + W[o + 1] * y + W[o + 2] * z + W[o + 3];
    const py = W[o + 4] * x + W[o + 5] * y + W[o + 6] * z + W[o + 7];
    const pz = W[o + 8] * x + W[o + 9] * y + W[o + 10] * z + W[o + 11];
    for (let s = 0; s < ss.length; s++) {
      const g = segDist(px, py, pz, ss[s].a, ss[s].b) - ss[s].r;
      if (g < out.all[s]) out.all[s] = g;
      if (c.grip[v] && g < out.grip[s]) out.grip[s] = g;
    }
  }
}

type Step = (vm: GunPoser, t: number) => void;
interface Scenario {
  name: string;
  dur: number;
  start: (vm: GunPoser) => void;
  step?: Step;
}

function scenarios(def: GunDef): Scenario[] {
  const t = def.timing;
  const out: Scenario[] = [
    { name: "idle", dur: 0.5, start: () => {} },
    { name: "draw", dur: 1.0, start: (vm) => vm.draw() },
    { name: "holster", dur: 0.3, start: (vm) => vm.anim.holster() },
    { name: "fire", dur: 1.2, start: (vm) => vm.anim.fire() },
    { name: "dry", dur: 0.4, start: (vm) => vm.anim.dryFire() },
    { name: "mode", dur: 0.4, start: (vm) => vm.anim.modeToggle() },
    { name: "inspect", dur: 3.0, start: (vm) => vm.anim.inspect() },
    {
      name: "inspect-cancel",
      dur: 1.6,
      start: (vm) => vm.anim.inspect(),
      step: (vm, s) => {
        if (Math.abs(s - 0.9) < 0.009) vm.anim.fire();
      },
    },
  ];
  if (t.burst) {
    out.push({
      name: "burst",
      dur: 1.0,
      start: (vm) => vm.anim.fire(),
      step: (vm, s) => {
        for (let k = 1; k < t.burst!.n; k++) if (Math.abs(s - k * t.burst!.gap) < 0.009) vm.anim.fire();
      },
    });
  }
  if (t.reload) {
    out.push({ name: "reload", dur: t.reload + 0.3, start: (vm) => vm.anim.reload(t.reload!, false) });
    out.push({ name: "reload-empty", dur: t.reload + 0.3, start: (vm) => vm.anim.reload(t.reload!, true) });
  }
  if (t.shells) {
    const sh = t.shells;
    out.push({
      name: "shells",
      dur: sh.start + sh.each * 3 + sh.end + 0.3,
      start: (vm) => vm.anim.shellStart(sh.start),
      step: (vm, s) => {
        for (let k = 0; k < 3; k++) if (Math.abs(s - (sh.start + k * sh.each)) < 0.009) vm.anim.shellInsert(sh.each);
        if (Math.abs(s - (sh.start + 3 * sh.each)) < 0.009) vm.anim.shellEnd(sh.end);
      },
    });
    out.push({
      name: "shell-interrupted",
      dur: 1.6,
      start: (vm) => vm.anim.shellStart(sh.start),
      step: (vm, s) => {
        if (Math.abs(s - sh.start) < 0.009) vm.anim.shellInsert(sh.each);
        if (Math.abs(s - (sh.start + sh.each * 0.5)) < 0.009) vm.anim.fire();
      },
    });
  }
  if (t.pump) out.push({ name: "fire-pump", dur: t.pump.at + t.pump.dur + 0.4, start: (vm) => vm.anim.fire() });
  if (def.silencer) {
    const T = SILENCER_T;
    const on = (vm: GunPoser) => (vm.anim.silenced = true);
    out.push({ name: "silencer-on", dur: T + 0.3, start: (vm) => vm.anim.silencer(true, T) });
    out.push({ name: "silencer-off", dur: T + 0.3, start: (vm) => (on(vm), vm.anim.silencer(false, T)) });
    out.push({ name: "silencer-on-seek", dur: T * 0.5 + 0.3, start: (vm) => vm.anim.silencer(true, T, T * 0.52) });
    out.push({ name: "silencer-off-seek", dur: T * 0.5 + 0.3, start: (vm) => (on(vm), vm.anim.silencer(false, T, T * 0.48)) });
    out.push({ name: "silenced-fire", dur: 1.0, start: (vm) => (on(vm), vm.anim.fire()) });
    out.push({ name: "silenced-draw", dur: 1.0, start: (vm) => (on(vm), vm.draw()) });
    out.push({ name: "silenced-inspect", dur: 3.0, start: (vm) => (on(vm), vm.anim.inspect()) });
    if (t.reload) out.push({ name: "silenced-reload", dur: t.reload + 0.3, start: (vm) => (on(vm), vm.anim.reload(t.reload!, false)) });
  }
  return out;
}

export interface GunAuditOptions {
  rate?: number;
  /** Every n-th gun vertex (default 2). */
  stride?: number;
  /** Degrees past a limit before a joint counts. */
  jointTol?: number;
  /** Units deeper than the idle hold before gun contact counts. */
  depthTol?: number;
  glove?: GloveStyleId;
  only?: string[];
}

export interface GunScenarioResult {
  gun: string;
  scenario: string;
  frames: number;
  joint: number;
  gun_: number;
  worst: GunViolation | null;
}

/** Plays every scenario of a gun; returns per-scenario counts (violations appended to `all` when given). */
export function auditGun(def: GunDef, o: GunAuditOptions = {}, all?: GunViolation[]): GunScenarioResult[] {
  const rate = o.rate ?? 60, jt = o.jointTol ?? 0.5, dt = o.depthTol ?? 0.25;
  const vm = new GunPoser();
  vm.clamp = false;
  vm.setGun(def, o.glove ?? "knit");
  const cloud = cloudOf(def, o.stride ?? 2);
  // The idle hold's own contact per segment (a finger resting on the grip is slightly in by design).
  vm.anim.seek("idle", 0);
  vm.update(1 / rate);
  const W = vm.bonesW;
  let ss = segs(W);
  const base = { all: new Float32Array(ss.length), grip: new Float32Array(ss.length) };
  depths(W, cloud, ss, base);
  const cur = { all: new Float32Array(ss.length), grip: new Float32Array(ss.length) };
  const results: GunScenarioResult[] = [];
  for (const sc of scenarios(def)) {
    if (o.only && !o.only.includes(sc.name)) continue;
    vm.anim.seek("idle", 0);
    vm.anim.silenced = false;
    vm.update(0);
    sc.start(vm);
    const res: GunScenarioResult = { gun: def.id, scenario: sc.name, frames: 0, joint: 0, gun_: 0, worst: null };
    const note = (v: GunViolation) => {
      all?.push(v);
      if (!res.worst || v.amount > res.worst.amount) res.worst = v;
    };
    for (let s = 0; s <= sc.dur; s += 1 / rate) {
      sc.step?.(vm, s);
      vm.update(1 / rate);
      res.frames++;
      for (const j of readFingers(W, gunRig().hands)) {
        const past = j.deg < j.range.min ? j.range.min - j.deg : j.deg > j.range.max ? j.deg - j.range.max : 0;
        if (past > jt) {
          res.joint++;
          note({ kind: "joint", scenario: sc.name, t: s, what: `${j.side} ${j.digit} ${j.joint} ${j.deg.toFixed(1)}`, amount: past });
        }
      }
      ss = segs(W);
      depths(W, cloud, ss, cur);
      for (let i = 0; i < ss.length; i++) {
        const allow = Math.min(0, base.all[i]) - dt;
        if (cur.all[i] < allow) {
          res.gun_++;
          note({ kind: "gun", scenario: sc.name, t: s, what: `${ss[i].side} ${ss[i].digit}${ss[i].k + 1} in gun ${cur.all[i].toFixed(2)} (idle ${base.all[i].toFixed(2)})`, amount: allow - cur.all[i] });
        }
      }
    }
    results.push(res);
  }
  return results;
}

export interface GunGripReport {
  /** Per side and digit: gap to the grip per segment, deepest gap into the gun. */
  hands: Record<"R" | "L", Record<string, { grip: number[]; sink: number }>>;
  wrapsR: string[];
  wrapsL: string[];
  /** Pose change between two idle frames (max matrix delta). */
  idleJitter: number;
}

/** The idle hold in a glove style: contact of the wrapped fingers, depth into the gun, idle stability. */
export function gunGripReport(def: GunDef, glove: GloveStyleId = "knit"): GunGripReport {
  const vm = new GunPoser();
  vm.setGun(def, glove);
  vm.anim.seek("idle", 0);
  vm.update(1 / 60);
  const W = vm.bonesW;
  const a = Float32Array.from(W);
  vm.update(1 / 60);
  let jitter = 0;
  for (let i = 0; i < W.length; i++) jitter = Math.max(jitter, Math.abs(W[i] - a[i]));
  const cloud = cloudOf(def, 1);
  const ss = segs(W);
  const d = { all: new Float32Array(ss.length), grip: new Float32Array(ss.length) };
  depths(W, cloud, ss, d);
  const hands = { R: {}, L: {} } as GunGripReport["hands"];
  ss.forEach((s, i) => {
    const h = (hands[s.side][s.digit] ??= { grip: [Infinity, Infinity, Infinity], sink: Infinity });
    h.grip[s.k] = d.grip[i];
    h.sink = Math.min(h.sink, d.all[i]);
  });
  return { hands, wrapsR: def.right.wrap.map((f) => f.toLowerCase()), wrapsL: def.left.wrap.map((f) => f.toLowerCase()), idleJitter: jitter };
}

export interface SilencerGripReport {
  /** Per digit of the support hand: gap to the can per segment (units, < 0 = into it), at each sampled moment. */
  digits: Record<string, number[][]>;
  /** Deepest any digit of either hand goes into the gun or the can over those moments. */
  sink: number;
  /** The digits the grip wraps onto the can. */
  wraps: string[];
}

/**
 * The support hand on the silencer (a gun with one) in a glove style: the screw-on clip sampled while the hand holds the
 * can (CS:S seconds: after it bites, mid twist, at the seat), per digit the gap of each segment to the can. Null
 * without a silencer.
 */
export function silencerGripReport(def: GunDef, glove: GloveStyleId = "knit", times = [1.16, 1.3, 2.36]): SilencerGripReport | null {
  if (!def.silencer) return null;
  const vm = new GunPoser();
  vm.clamp = false;
  vm.setGun(def, glove);
  const all = cloudOf(def, 1);
  const sil = gunRig().part("Sil");
  const idx = Array.from({ length: all.n }, (_, i) => i).filter((i) => all.bone[i] === sil);
  const can: Cloud = { bone: Int16Array.from(idx.map((i) => all.bone[i])), p: Float32Array.from(idx.flatMap((i) => [all.p[i * 3], all.p[i * 3 + 1], all.p[i * 3 + 2]])), grip: new Uint8Array(idx.length).fill(1), n: idx.length };
  const digits: Record<string, number[][]> = {};
  let sink = Infinity;
  times.forEach((s, ti) => {
    vm.anim.seek("silencer", s, SILENCER_T, false, true);
    vm.update(0);
    const W = vm.bonesW;
    const ss = segs(W);
    const d = { all: new Float32Array(ss.length), grip: new Float32Array(ss.length) };
    depths(W, can, ss, d);
    const g = { all: new Float32Array(ss.length), grip: new Float32Array(ss.length) };
    depths(W, all, ss, g);
    ss.forEach((sg, i) => {
      sink = Math.min(sink, g.all[i]);
      if (sg.side !== "L") return;
      const row = (digits[sg.digit] ??= times.map(() => [Infinity, Infinity, Infinity]));
      row[ti][sg.k] = d.all[i];
    });
  });
  return { digits, sink, wraps: def.silencer.grip.wrap.map((f) => f.toLowerCase()) };
}
