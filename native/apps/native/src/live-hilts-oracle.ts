// The website's living hilts (viewmodel/hilts/live: state.ts PlaySignals and each design's animate and look) over a
// scripted stretch of play; live_hilts_tests.cpp replays the same and must write the same uniforms.
import { writeFile } from "node:fs/promises";
import { loadLiveHilts } from "./live-hilt-modules";

const { LIVE_DESIGNS, PieceCtx, PlaySignals, liveUniforms, hiltAnchors, pivots } = await loadLiveHilts();
const { KNIVES } = await import("../../web/src/viewmodel/knives/index");
const { vmRig } = await import("../../web/src/viewmodel/rig");
const rig = vmRig();
const knifeBone = rig.bone("Knife_Handle");
const knifeBind = Array.from(rig.bind.subarray(knifeBone * 12, knifeBone * 12 + 12));

interface Frame {
  dt: number;
  velocity: [number, number, number];
  grounded: boolean;
  landed: number;
  yaw: number;
  inspecting: boolean;
  still: boolean;
  reset: boolean;
  camera: { pos: number[]; right: number[]; up: number[] };
}

/**
 * Hops in a chain (some clean, some held on the ground past the chain's break), turning, an inspect, a stretch held
 * still and a reset, at uneven frame times.
 */
function stream(): Frame[] {
  const frames: Frame[] = [];
  let t = 0,
    vz = 0,
    wasGrounded = true;
  for (let i = 0; i < 900; i++) {
    const dt = i % 11 === 0 ? 1 / 30 : i % 3 === 0 ? 1 / 144 : 1 / 60;
    t += dt;
    const speed = Math.min(1300, t * 260);
    const yaw = 70 * Math.sin(t * 1.3) + (t > 6 ? 40 * t : 0);
    // A hop every 0.6 s: 0.5 s in the air, then 0.04 s on the ground (a clean hop) or, from 5 s to 6.5 s, standing.
    const phase = t % 0.6;
    const standing = t > 5 && t < 6.5;
    const grounded = standing || phase >= 0.5 || t < 0.3;
    vz = grounded ? 0 : 290 - 800 * (phase % 0.5);
    const landed = grounded && !wasGrounded ? -(160 + ((i * 37) % 700)) : 0;
    wasGrounded = grounded;
    const heading = (yaw * Math.PI) / 180;
    frames.push({
      dt,
      velocity: [speed * Math.cos(heading), speed * Math.sin(heading), vz],
      grounded,
      landed,
      yaw,
      inspecting: t > 3 && t < 4.4,
      still: t > 9 && t < 9.6,
      reset: i === 700,
      camera: {
        pos: [6 + Math.sin(t), -3 + Math.cos(t * 0.7), 2 + 0.5 * Math.sin(t * 2.1)],
        right: [Math.cos(t * 0.3), Math.sin(t * 0.3), 0],
        up: [0, 0, 1],
      },
    });
  }
  return frames;
}

const RECORD_EVERY = 3;
const frames = stream();
const knives = ["carrot", "karrotbit", "bunnyfly"];
const runs = [];
for (const design of LIVE_DESIGNS)
  for (const id of knives) {
    const knife = KNIVES.find((k: { id: string }) => k.id === id)!;
    const u = liveUniforms();
    const ctx = new PieceCtx(u, hiltAnchors(knife), knife, false);
    const signals = new PlaySignals();
    for (const c of u.uChan.value) c.set(1, 1, 1, 0);
    let now = 0;
    const records: number[][] = [];
    frames.forEach((f, i) => {
      if (f.reset) {
        signals.reset();
        for (const k of Object.keys(ctx.mem)) delete ctx.mem[k];
      }
      now += f.dt;
      signals.still = f.still;
      signals.update(f.dt, now, f, f.inspecting);
      design.animate(signals, ctx, f.dt);
      design.look?.(f.camera, ctx);
      if (i % RECORD_EVERY) return;
      records.push([
        ...u.uPiece.value.flatMap((m: { elements: number[] }) => Array.from(m.elements)),
        ...u.uMorph.value,
        ...u.uChan.value.flatMap((v: { toArray(): number[] }) => v.toArray()),
        ...u.uLive.value.flatMap((v: { toArray(): number[] }) => v.toArray()),
      ]);
    });
    runs.push({ design: design.id, knife: id, pivots: pivots(design.id, knife), records });
  }
await writeFile(process.argv[2], JSON.stringify({ recordEvery: RECORD_EVERY, knifeBind, frames, runs }));
