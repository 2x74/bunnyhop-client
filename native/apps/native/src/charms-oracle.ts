// The website's charm on the knife (viewmodel/charms: knife.ts KnifeCharm, rig.ts, physics.ts) over scripted strafing,
// turning, hopping and an inspect-like turn of the knife; charms_tests.cpp hangs the same charm on the same fit and must
// pose the same six bones (a charm resting on the hand is chaotic: a millionth apart grows over seconds of contact, so the
// tests hold contact runs to the first seconds and free-hanging ones to every frame). The fit's clouds are the website's own, so this checks the motion alone (charm_fit.hpp's
// sampling is checked against the same clouds there).
import { writeFile } from "node:fs/promises";
import * as THREE from "three";
import { loadoutFor } from "../../web/src/loadout";
import { vmRig } from "../../web/src/viewmodel/rig";
import { KNIVES } from "../../web/src/viewmodel/knives/index";
import { KnifeCharm } from "../../web/src/viewmodel/charms/knife";
import { charmFit, charmPlaces, restPose, restView } from "../../web/src/viewmodel/charms/anchors";
import { charmDef, charmMetrics } from "../../web/src/viewmodel/charms/meshes";
import { PointCloud } from "../../web/src/viewmodel/charms/physics";
import { charmClamp } from "../../web/src/viewmodel/charms/places";
import type { CharmHang } from "../../web/src/viewmodel/charms/anchors";

const rig = vmRig();
const hangOf = (h: CharmHang | null) =>
  h && {
    bone: rig.bone(h.bone),
    at: h.at,
    colliders: h.colliders.map((c) => ({
      a: c.a,
      b: c.b,
      r: c.r,
      bone: rig.bone(c.bone),
      boneB: c.boneB ? rig.bone(c.boneB) : -1,
      hand: !!c.hand,
    })),
  };
const floats = (a: Float32Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString("base64");

interface Case {
  knife: string;
  hilt: string | null;
  glove: "knit" | "paws";
  choice: Record<string, unknown>;
  left: boolean;
  /** When the charm starts resting on the hand or the knife ("start", "late") or never ("none"). */
  contact: "none" | "late" | "start";
  /** Without the clouds: only the capsules it rests on. */
  bare?: boolean;
}
const RESTING: Case[] = [
  { knife: "carrot", hilt: null, glove: "knit", choice: { charm: "charm-bun" }, left: false, contact: "late" },
  {
    knife: "karrotbit",
    hilt: null,
    glove: "knit",
    choice: { charm: "charm-lantern", charmSwing: 100 },
    left: true,
    contact: "late",
  },
  {
    knife: "bunnyfly",
    hilt: "hilt-watcher",
    glove: "paws",
    choice: { charm: "charm-star", charmPommel: true, charmLength: 200, charmSize: 140 },
    left: false,
    contact: "none",
  },
  {
    knife: "thornback",
    hilt: null,
    glove: "knit",
    choice: { charm: "charm-loaf", charmLength: 50 },
    left: false,
    contact: "late",
  },
  {
    knife: "bayonet",
    hilt: null,
    glove: "knit",
    choice: { charm: "charm-heart", charmPommel: true },
    left: false,
    contact: "start",
  },
  // Clamped: the Cleaver draws a 50% cord at 100% and a 140% charm at 120%.
  {
    knife: "cleaver",
    hilt: null,
    glove: "knit",
    choice: { charm: "charm-bell", charmLength: 50, charmSize: 140 },
    left: false,
    contact: "start",
  },
];
const CASES: Case[] = [...RESTING, ...RESTING.map((c) => ({ ...c, bare: true }))];

const FRAMES = 600;
const runs = [];
for (const c of CASES) {
  const knife = KNIVES.find((k) => k.id === c.knife)!;
  const loadout = loadoutFor({ ...c.choice, knife: `knife-${c.knife}`, hilt: c.hilt, glove: `glove-${c.glove}` });
  const charm = new KnifeCharm(new THREE.Group());
  charm.set(loadout, knife);
  if (c.bare) {
    const fields = charm as unknown as { solid: unknown; hands: unknown };
    fields.solid = fields.hands = null;
  }
  const fit = charmFit(knife, c.hilt, c.glove);
  const W = restPose(knife, c.glove);
  const rest = W.slice();
  const kb = rig.bone("Knife_Handle");
  const view = restView();
  const frames = [];
  let t = 0;
  for (let i = 0; i < FRAMES; i++) {
    const dt = i % 13 === 0 ? 1 / 30 : i % 4 === 0 ? 1 / 144 : 1 / 60;
    t += dt;
    // The feel: a bob and a sway; from 4 s to 5 s the knife turns in the hand (the hand leaves its rest hold).
    const V = view.slice();
    V[3] += 0.4 * Math.sin(t * 7);
    V[11] += 0.25 * Math.sin(t * 9.4);
    const turn = t > 4 && t < 5 ? Math.sin((t - 4) * Math.PI) * 1.2 : 0;
    W.set(rest);
    if (turn) {
      const m = new THREE.Matrix4().set(...(Array.from(rest.subarray(kb * 12, kb * 12 + 12)) as number[]), 0, 0, 0, 1);
      m.multiply(new THREE.Matrix4().makeRotationZ(turn));
      const e = m.elements;
      W.set([e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14]], kb * 12);
    }
    const speed = Math.min(900, t * 300);
    const yaw = 80 * Math.sin(t * 1.4) + (t > 7 ? 25 * (t - 7) : 0);
    const heading = (yaw * Math.PI) / 180;
    const vz = t % 0.7 < 0.6 ? 280 - 800 * (t % 0.7) : 0;
    const s = {
      velocity: [speed * Math.cos(heading), speed * Math.sin(heading), vz],
      yaw,
      pitch: 20 * Math.sin(t * 0.8),
    };
    const off: [number, number, number] = [1.5, c.left ? 0.6 : -0.6, -0.9];
    charm.update(dt, s, W, rig, V, off, c.left, t);
    frames.push({
      dt,
      clock: t,
      velocity: s.velocity,
      yaw: s.yaw,
      pitch: s.pitch,
      view: Array.from(V),
      knifeTurn: turn,
      bones: Array.from(charm.rig["bm"] as Float32Array),
    });
  }
  // The cloud's push itself, at points round the knife.
  const cloud = new PointCloud(fit.solid);
  const pushes = [];
  for (let i = 0; i < 400; i++) {
    const q = [Math.sin(i * 1.7) * 1.5, Math.cos(i * 2.3) * 1.5, -3 + ((i * 0.37) % 8)];
    const r = 0.05 + ((i * 0.13) % 0.5);
    const out = new Float64Array(3);
    const hit = cloud.push(q[0], q[1], q[2], r, out);
    pushes.push({ q, r, hit, out: Array.from(out) });
  }
  const def = charmDef(loadout.charm)!;
  const m = charmMetrics(def);
  runs.push({
    case: c,
    loadout: {
      length: loadout.charmLength,
      size: loadout.charmSize,
      swing: loadout.charmSwing,
      pommel: !!loadout.charmPommel,
    },
    charm: { id: def.id, link: m.link, radius: m.radius, lift: m.lift, balls: m.balls, life: def.life ?? null },
    fit: {
      guard: hangOf(fit.guard),
      pommel: hangOf(fit.pommel),
      joints: fit.joints.map((j) => ({ bone: rig.bone(j.bone), p: j.p })),
      places: charmPlaces(c.knife),
      clamps: [false, true].map((pommel) => {
        const low = charmClamp(c.knife, pommel, 50, 80);
        const high = charmClamp(c.knife, pommel, 200, 140);
        return [low.cord, high.cord, low.size, high.size];
      }),
      solid: floats(fit.solid),
      hands: floats(fit.hands),
    },
    pushes,
    rest: Array.from(rest),
    knifeBone: kb,
    frames,
  });
}
await writeFile(process.argv[2], JSON.stringify({ runs }));
