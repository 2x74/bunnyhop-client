// Test-only oracle: run the existing web goals/coach on real production WASM tutorial ticks,
// plus threshold fixtures. No generated value is used by the native application.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Core, applyRestartPoint } from "../../web/src/core";
import { afterStep, makeTimer, quantize } from "../../web/src/sim";
import { StyleFilter, styleDef, styleSettings } from "../../web/src/styles";
import { parseZoneSet } from "../../web/src/zones";
import { LessonGoals, StrafeMeter } from "../../web/src/tutorial/goals";
import { Coach } from "../../web/src/tutorial/coach";
import { writeBsp } from "../../../tools/tutorial/bsp";
import { course, LIGHTING, MATERIALS, SKY } from "../../../tools/tutorial/layout";
import { Autopilot } from "../../../tools/tutorial/autopilot";
const data = JSON.parse(readFileSync("maps/bhop_lol_tutorial.tutorial.json", "utf8"));
const cases: any[] = [];
const fields = [
  "airborne",
  "speed",
  "key",
  "turn",
  "turnRate",
  "angle",
  "signedAngle",
  "edge",
  "forwardInAir",
  "band",
  "gain",
  "syncGood",
  "syncTotal",
  "sync",
  "chain",
  "bestChain",
  "hopGain",
  "lastHopSpeed",
  "jumps",
  "breaks",
  "groundTicks",
  "grounded",
];
function make(name: string, index: number, legit = false) {
  const lesson = data.lessons[index],
    m = new StrafeMeter(legit ? 5 : 2),
    c = new Coach(legit),
    g = new LessonGoals(lesson, { goldSeconds: lesson.demoSeconds ? Math.ceil(lesson.demoSeconds * 1.4) : 20 });
  // Native start() performs the same entry reset as TutorialMode.enter().
  m.reset();
  c.reset();
  const item: any = { name, index, legit, ticks: [] };
  cases.push(item);
  return {
    item,
    m,
    c,
    g,
    push(info: any, finishSeconds?: number) {
      const before = m.breaks;
      m.update(info);
      const gate = g.update(info, m);
      if (finishSeconds !== undefined) g.finish(finishSeconds);
      c.update(lesson.id, info, m, before, g.done);
      item.ticks.push({
        ...info,
        ...(finishSeconds === undefined ? {} : { finishSeconds }),
        expected: {
          meter: Object.fromEntries(fields.map((k) => [k, (m as any)[k]])),
          goals: g.goals.map((x) => ({ ...x, lower: !!x.lower })),
          gates: [...g.gatesLit],
          nudge: c.nudge,
          idleTicks: c.idleTicks,
          gate,
          done: g.done,
        },
      });
    },
  };
}
const wasm = new Uint8Array(readFileSync("apps/web/src/wasm/bunnyhop_core.wasm"));
const layout = course();
const bsp = existsSync("maps/bhop_lol_tutorial.bsp")
  ? new Uint8Array(readFileSync("maps/bhop_lol_tutorial.bsp"))
  : writeBsp({
      worldspawn: { skyname: SKY },
      boxes: layout.boxes,
      brushEntities: layout.entities,
      points: layout.points,
      materials: MATERIALS,
      lighting: { ...LIGHTING, skyRays: 4 },
      seeds: layout.seeds,
    }).bsp;
for (const [index, legit] of [
  [0, false],
  [0, true],
  [1, false],
  [2, false],
  [3, false],
] as const) {
  const core = await Core.create(wasm as Uint8Array<ArrayBuffer>);
  core.loadMap(bsp);
  core.setSettings(styleSettings(legit ? "legit" : "autohop"));
  core.reset();
  const L = data.lessons[index];
  applyRestartPoint(core, index === 3 ? data.bonusStart : L.start);
  const pilot = new Autopilot({
    route: L.route,
    pits: L.pits,
    islands: L.islands,
    legit,
    noStrafe: index === 0,
    maxSpeed: [0, 400, 600, 560][index],
    swing: index === 1 || index === 2 ? 20 : undefined,
    perHop: index === 1 || index === 2,
    yaw: L.start.yaw,
  });
  const timer = makeTimer(
    parseZoneSet(JSON.parse(readFileSync("maps/bhop_lol_tutorial.zones.json", "utf8")), "bhop_lol_tutorial", "file")!
      .zones,
    styleSettings(legit ? "legit" : "autohop"),
    290,
    styleDef(legit ? "legit" : "autohop"),
  );
  const filter = new StyleFilter(styleDef(legit ? "legit" : "autohop")),
    o = make(`real-wasm-${L.id}-${legit ? "legit" : "autohop"}`, index, legit);
  for (let i = 0; i < 6000; i++) {
    const pre = core.state(),
      cmd = filter.apply(quantize(...pilot.command(pre)), pre);
    const events = core.step(cmd.forward, cmd.side, cmd.yaw, cmd.pitch, cmd.buttons);
    const stepped = afterStep(core, timer, cmd, events),
      post = stepped.state;
    o.push({ pre, post, cmd, events }, stepped.update.finished ? timer.time() : undefined);
    if (o.g.done) break;
  }
  if (!o.g.done) throw new Error(`${o.item.name} did not complete`);
}
function synthetic(name: string, index: number, fn: (i: number) => any, n = 340, legit = false) {
  const o = make(name, index, legit),
    pos = data.lessons[index].start.position;
  for (let i = 0; i < n; i++) {
    const x = fn(i);
    const pre = { position: pos, velocity: [500, 0, 0], grounded: false, ...x.pre },
      post = { ...pre, velocity: [501, 0, 0], ...x.post };
    const raw = { forward: 0, side: -450, yaw: Math.fround(i * 0.45), pitch: 0, buttons: 2, ...x.cmd };
    const cmd = Object.fromEntries(
      Object.entries(raw).map(([k, v]) => [k, typeof v === "number" ? Math.fround(v) : v]),
    );
    o.push({ pre, post, cmd, events: x.events ?? 0 });
  }
}
synthetic("forward-hold-and-linger", 1, (i) => ({ cmd: { forward: i < 30 ? 450 : 0 } }));
synthetic("opposite-key", 1, (i) => ({ cmd: { side: 450 } }), 80);
synthetic("mouse-left-threshold", 1, (i) => ({ cmd: { yaw: 0 } }), 50);
synthetic("mouse-right-threshold", 1, (i) => ({ cmd: { yaw: 0, side: 450 } }), 50);
synthetic("key-left-threshold", 1, (i) => ({ cmd: { side: 0 } }), 55);
synthetic("key-right-threshold", 1, (i) => ({ cmd: { side: 0, yaw: -i * 0.45 } }), 55);
synthetic("slower-threshold", 2, (i) => ({ cmd: { yaw: 100 + i * 0.001 }, post: { velocity: [499, 0, 0] } }), 70);
synthetic("final-w-only-is-allowed", 3, (i) => ({ cmd: { side: 0, forward: 450 } }), 50);
for (const legit of [false, true])
  synthetic(
    `hop-chain-break-${legit}`,
    0,
    (i) => ({
      pre: { grounded: i % 12 === 0 },
      post: { grounded: i > 30 },
      events: i === 0 || i === 12 ? 2 : 0,
      cmd: { forward: 450, side: 0, yaw: 0 },
    }),
    310,
    legit,
  );
synthetic(
  "final-fall-edge",
  3,
  (i) => ({ pre: { position: i === 0 ? [0, 0, -20] : data.lessons[3].start.position }, events: i === 0 ? 1 : 0 }),
  270,
);
synthetic("teleport-resets-sync", 1, (i) => ({ events: i === 30 ? 1 : 0 }), 65);
writeFileSync(process.argv[2] ?? "/tmp/native-tutorial-oracle.json", JSON.stringify({ data, cases }));
console.log(`Web tutorial oracle: ${cases.length} cases, ${cases.reduce((n, c) => n + c.ticks.length, 0)} ticks`);
