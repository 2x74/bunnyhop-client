// Test-only oracle: runs the web JHUD (apps/web/src/ssj/jhud.ts) over deterministic tick streams and records the input
// and every report, band and printed line, so src/jhud_tests.cpp can replay the same input through the C++ port. No
// generated value is used by the native application.
//
// Every input is a 32-bit float, as a real command and player state are, so the C++ reads exactly what the web code did.
import { writeFileSync } from "node:fs";
import {
  gainBand,
  JHUD_BANDS,
  JhudTracker,
  jhudBand,
  jhudLines,
  speedBand,
  type JhudPrefs,
  type JhudReport,
} from "../../web/src/ssj/jhud";
import { stream, type Tick } from "./ssj_oracle";

const f = Math.fround;
const IN_JUMP = 1 << 1;
const SPEED_COLORS = [1, 6, 16];
const LINE_PREFS: Pick<JhudPrefs, "sync" | "jss" | "analyzer">[] = [false, true].flatMap((sync) =>
  [false, true].flatMap((jss) => [false, true].map((analyzer) => ({ sync, jss, analyzer }))),
);

function exact(t: Tick): Tick {
  return {
    ...t,
    px: f(t.px),
    py: f(t.py),
    pz: f(t.pz),
    vx: f(t.vx),
    vy: f(t.vy),
    vz: f(t.vz),
    forward: f(t.forward),
    side: f(t.side),
    yaw: f(t.yaw),
  };
}

/** A clean hop chain on pace, so the speed table's rows and every band come up, with the view turning `turn` a tick. */
function chain(jumps: number, speedAt: (jump: number) => number, turn: number, side: number, forward: number): Tick[] {
  const ticks: Tick[] = [];
  let yaw = 170;
  const push = (grounded: boolean, jumped: boolean, speed: number) => {
    yaw += turn;
    if (yaw > 180) yaw -= 360;
    ticks.push({
      px: 0,
      py: 0,
      pz: 0,
      vx: speed,
      vy: 0,
      vz: 0,
      grounded,
      onLadder: false,
      forward,
      side,
      yaw,
      buttons: jumped ? IN_JUMP : 0,
      jumped,
      teleported: false,
      inStart: false,
      noclip: false,
      time: null,
    });
  };
  for (let jump = 1; jump <= jumps; jump++) {
    const speed = speedAt(jump);
    push(true, true, speed);
    if (jump < jumps) for (let air = 0; air < 70; air++) push(false, false, speed);
  }
  return ticks;
}

function lines(report: JhudReport) {
  return LINE_PREFS.map((prefs) => jhudLines(report, prefs));
}

function expected(report: JhudReport) {
  return { ...report, bands: SPEED_COLORS.map((colors) => jhudBand(report, colors)), lines: lines(report) };
}

function run(name: string, ticks: Tick[]) {
  const tracker = new JhudTracker();
  const input = ticks.map(exact);
  const reports = input.map((t) => {
    const report = tracker.tick(
      { position: [t.px, t.py, t.pz], velocity: [t.vx, t.vy, t.vz], grounded: t.grounded, onLadder: t.onLadder },
      { forward: t.forward, side: t.side, yaw: t.yaw, buttons: t.buttons },
      { jumped: t.jumped, inStart: t.inStart, noclip: t.noclip, time: t.time },
    );
    return report && expected(report);
  });
  return { name, ticks: input, reports };
}

/** Reports the trackers rarely reach: the f32 cuts, gain below zero, no sync, no JSS, very long numbers. */
const edgeReports: JhudReport[] = [
  { jump: 1, speed: 289, gain: null, sync: null, jss: null },
  { jump: 6, speed: 613, gain: 84.21, sync: 90.5, jss: 0.987 },
  { jump: 6, speed: 613, gain: 87.52, sync: 92.4, jss: 1.1 },
  { jump: 6, speed: 613, gain: 5.93, sync: 100, jss: 1 },
  { jump: 7, speed: 2000, gain: 100, sync: 0, jss: 0.5 },
  { jump: 2, speed: 300, gain: -0.001, sync: 0.004, jss: 0 },
  { jump: 2, speed: 300, gain: -1234.56, sync: 33.33, jss: 315.2 },
  { jump: 40, speed: 3500, gain: 90, sync: null, jss: null },
  { jump: 13, speed: 900, gain: 79.99, sync: null, jss: 2 },
  { jump: 17, speed: 400, gain: 95, sync: 50, jss: 0.999 },
].map((report) => ({
  ...report,
  gain: report.gain === null ? null : f(report.gain),
  sync: report.sync === null ? null : f(report.sync),
}));

const chains = [
  run(
    "on pace",
    chain(20, (jump) => 240 + jump * 52, 1.3, 400, 0),
  ),
  run(
    "slow",
    chain(20, (jump) => 200 + jump * 30, 0.6, 400, 0),
  ),
  run(
    "fast",
    chain(20, (jump) => 300 + jump * 70, 4, -400, 0),
  ),
  run(
    "into the speed",
    chain(9, () => 600, 0, 0, 400),
  ),
  run(
    "keyless",
    chain(9, () => 600, 0, 0, 0),
  ),
];
const streams = [11, 97, 4242, 7001].map((seed) => run(`stream ${seed}`, stream(seed, 2600)));

const out = process.argv[2];
if (!out) throw new Error("usage: jhud_oracle.ts <output.json>");
writeFileSync(
  out,
  JSON.stringify({
    speedColors: SPEED_COLORS,
    linePrefs: LINE_PREFS,
    bandNames: JHUD_BANDS,
    cases: [...chains, ...streams],
    edgeReports: edgeReports.map(expected),
    gainBands: [-5, 0, 59.99, 60, 69.99, 70, 79.99, 80, 89.99, 90, 100].map((gain) => ({ gain, band: gainBand(gain) })),
    speedBands: Array.from({ length: 16 }, (_, row) => row + 1).flatMap((jump) =>
      Array.from({ length: 60 }, (_, step) => 250 + step * 15).map((speed) => ({
        jump,
        speed,
        band: speedBand(jump, speed),
      })),
    ),
  }),
);
const total = [...chains, ...streams].reduce((n, c) => n + c.reports.filter(Boolean).length, 0);
console.log(`JHUD oracle: ${chains.length + streams.length} cases, ${total} reports`);
