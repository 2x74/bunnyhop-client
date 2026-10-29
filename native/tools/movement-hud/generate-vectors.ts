// Runs the website's own trackers and views from a git revision, without loading the game or network code.
// Usage: bun tools/movement-hud/generate-vectors.ts --web /path/to/bunnyhop [--ref origin/main]
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { web: { type: "string" }, ref: { type: "string", default: "origin/main" }, out: { type: "string" } },
});
if (!values.web) throw new Error("Pass --web /path/to/bunnyhop");
const web = resolve(values.web);
const revision = values.ref!;
const output = resolve(values.out ?? resolve(import.meta.dir, "../../apps/native/src/movement_hud_vectors.json.gz"));
const mirror = resolve(import.meta.dir, "../../target/movement-hud-oracle");
const hashes: Record<string, string> = {};
function source(path: string): string {
  const result = Bun.spawnSync(["git", "-C", web, "show", `${revision}:apps/web/src/${path}`]);
  if (result.exitCode) throw new Error(result.stderr.toString());
  const text = result.stdout.toString();
  hashes[path] = createHash("sha256").update(text).digest("hex");
  return text;
}
function put(path: string, text: string): void {
  const file = resolve(mirror, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}
function exportedFunction(text: string, name: string): string {
  const match = text.match(new RegExp(`export function ${name}\\([^]*?^}`, "m"));
  if (!match) throw new Error(`Missing website function ${name}`);
  return match[0];
}
for (const path of [
  "ssj/stats.ts",
  "ssj/view.ts",
  "hud/jumps.ts",
  "hud/strafe-trainer.ts",
  "hud/strafe-trainer-view.ts",
  "movement-stats/stats.ts",
]) {
  put(
    path,
    source(path)
      .replace(/^import type .*;\n/gm, "")
      .replace(/^import "[^\"]+\.css";\n/gm, ""),
  );
}
put("timer.ts", exportedFunction(source("timer.ts"), "formatTime") + "\nexport const EVENT_RESPAWNED = 8;\n");
put("autostrafe.ts", exportedFunction(source("autostrafe.ts"), "yawDelta"));
put("core.ts", "export const EVENT_JUMPED = 2, EVENT_LANDED = 4, EVENT_TELEPORTED = 1;\n");
put(
  "palette.ts",
  source("palette.ts").replace(/^import .*;$/m, "const DEFAULT_TRIGGER_PREFS = { colors: {} }; const KINDS = [];"),
);
// Views receive an in-memory DOM. All labels, rounding, hidden states and CSS values still come from their render methods.
put(
  "ui/dom.ts",
  `
class Element {
  children = []; hidden = false; dataset = {}; attributes = {}; values = {}; classes = new Set();
  style = { setProperty: (key, value) => this.values[key] = value };
  classList = { toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name) };
  constructor(children = []) { this.children = children; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  set textContent(text) { this.children = [text]; }
  get textContent() { return this.children.map(child => typeof child === 'string' ? child : child.textContent).join(''); }
}
export function h(tag, props, ...children) { const el = new Element(children); el.tag = tag; return el; }
`,
);

interface Element {
  children: (Element | string)[];
  textContent: string;
  hidden: boolean;
  dataset: Record<string, string>;
  style: Record<string, string>;
  classes: Set<string>;
}
interface Report {
  jump: number;
  speed: number;
  diff: number | null;
  height: number | null;
  gain: number | null;
  sync: number | null;
  eff: number | null;
  strafes: number | null;
  time: number | null;
}
type Fields = Record<"speed" | "diff" | "gain" | "sync" | "strafes" | "eff" | "height" | "time", boolean>;
interface State {
  position: number[];
  velocity: number[];
  grounded: boolean;
  onLadder: boolean;
  crouched: boolean;
  tick: number;
  jumpStatsValid: boolean;
}
interface Command {
  forward: number;
  side: number;
  yaw: number;
  pitch: number;
  buttons: number;
}
interface Info {
  jumped: boolean;
  teleported: boolean;
  inStart: boolean;
  noclip: boolean;
  time: number | null;
}
interface Sample {
  speed: number;
  grounded: boolean;
  onLadder: boolean;
  tick: number;
  dt: number;
  maxSpeed: number;
  airAccelerate: number;
  style: string;
  interrupted: boolean;
  jumped: boolean;
}
interface Reading {
  cue: string;
  pace: number | null;
  side: number;
}
interface Tracker {
  tick(pre: State, cmd: Command, info: Info): Report | null;
  reset(): void;
}
interface Trainer {
  feed(cmd: Command, sample: Sample): void;
  reading: Reading;
  smoothing: number;
  zone: number;
  reset(): void;
  takeLanding(): number | null;
}
interface StartPre {
  tick(pre: State, info: Info): number | null | undefined;
  reset(): void;
}
interface SsjView {
  el: Element;
  show(report: Report | null, fields: Fields): boolean;
}
interface TrainerView {
  el: Element;
  configure(prefs: object): void;
  render(reading: Reading): void;
}
const ssj = (await import(resolve(mirror, "ssj/stats.ts"))) as {
  SsjTracker: new (mode: string) => Tracker;
  StartPreTracker: new () => StartPre;
  DEFAULT_SSJ: { fields: Fields };
  ssjText(report: Report, fields: Fields): string;
  ssjItems(report: Report, fields: Fields): (string | { n: string; good?: boolean })[][];
};
const { SsjView } = (await import(resolve(mirror, "ssj/view.ts"))) as { SsjView: new () => SsjView };
const trainer = (await import(resolve(mirror, "hud/strafe-trainer.ts"))) as {
  StrafeTrainer: new () => Trainer;
  trainerPosition(pace: number, side: number, follow: boolean): number;
};
const { StrafeTrainerView } = (await import(resolve(mirror, "hud/strafe-trainer-view.ts"))) as {
  StrafeTrainerView: new () => TrainerView;
};
const movement = (await import(resolve(mirror, "movement-stats/stats.ts"))) as {
  OffsetTracker: new () => {
    feed(
      cmd: Command,
      state: State,
      events: number,
      style: string,
    ): { ticks: number; overlap: boolean; gap: boolean } | null;
    reset(): void;
  };
  FirstJumpTracker: new () => { feed(sample: object): number | undefined; reset(): void };
  offsetText(report: object): string;
  fjtText(ticks: number, dt?: number): string;
  ljText(report: object): string;
  ljTier(report: object): number;
  TIER_COLORS: string[];
};
interface JumpTracker {
  sync: number;
  onJump: ((chain: number, speed: number, gain: number) => void) | null;
  reset(): void;
  feed(side: number, yaw: number, speed: number, grounded: boolean, jumped: boolean): void;
}
const { JumpTracker } = (await import(resolve(mirror, "hud/jumps.ts"))) as { JumpTracker: new () => JumpTracker };
const allFields = Object.fromEntries(Object.keys(ssj.DEFAULT_SSJ.fields).map((key) => [key, true])) as Fields;
const fields: Fields[] = [
  ssj.DEFAULT_SSJ.fields,
  allFields,
  ...Object.keys(allFields).map((key) => ({ ...allFields, [key]: false })),
  { ...ssj.DEFAULT_SSJ.fields, speed: false },
  Object.fromEntries(Object.keys(allFields).map((key) => [key, false])) as Fields,
];
const palette = (await import(resolve(mirror, "palette.ts"))) as {
  paletteFor(mode: string): {
    gain: string;
    loss: string;
    syncOk: string;
    trainer: Record<string, string>;
    lj: string[];
  };
};
const palettes = ["off", "redGreen", "blueYellow"].map((mode) => ({ mode, ...palette.paletteFor(mode) }));
function ssjExpected(report: Report) {
  return fields.map((field) => {
    const view = new SsjView();
    view.show(report, field);
    return {
      fields: field,
      chat: ssj.ssjText(report, field),
      hud: view.el.children
        .filter((child): child is Element => typeof child !== "string" && !child.hidden)
        .map((child) => child.textContent)
        .join("\n"),
      accent: ssj
        .ssjItems(report, field)
        .flat()
        .some((item) => typeof item !== "string" && item.good),
    };
  });
}
function state(tick: number): State {
  return {
    tick,
    position: [tick * 3, 0, 64],
    velocity: [300, 0, 0],
    grounded: false,
    onLadder: false,
    crouched: false,
    jumpStatsValid: true,
  };
}
function scenario(style: string, mode: string) {
  const tracker = new ssj.SsjTracker(mode),
    coach = new trainer.StrafeTrainer(),
    preTracker = new ssj.StartPreTracker();
  const offsets = new movement.OffsetTracker(),
    first = new movement.FirstJumpTracker();
  const ticks = [];
  const jumpHud = new JumpTracker();
  let jumpReport: { chain: number; speed: number; gain: number } | null = null;
  jumpHud.onJump = (chain, speed, gain) => {
    jumpReport = { chain, speed, gain };
  };
  let yaw = 179,
    jumps = 0,
    startTick = 0;
  for (let index = 0; index < 600; index++) {
    const reset = index === 310;
    if (reset) {
      tracker.reset();
      coach.reset();
      preTracker.reset();
      offsets.reset();
      first.reset();
      jumpHud.reset();
      jumps = 0;
      startTick = index;
    }
    const tick = index + 1,
      phase = (index % 310) % 20;
    const pre = state(tick - 1),
      post = state(tick);
    pre.grounded = phase === 0 || (index >= 280 && index < 295);
    const jumped = phase === 0;
    post.grounded = pre.grounded && !jumped;
    const inStart = index < 2 || reset;
    const side = index % 40 < 20 ? 450 : -450;
    // Includes turn binds: their angle is in the command, just like mouse yaw.
    const rate = [0, 0.5, 1, 1.15, 2.5][Math.floor(index / 15) % 5];
    yaw = Math.fround(yaw + (side < 0 ? 1 : -1) * rate * 3);
    const cmd: Command = {
      forward: index % 9 === 0 ? 450 : 0,
      side: index % 43 < 4 ? 0 : side,
      yaw,
      pitch: 0,
      buttons: (side < 0 ? 512 : 1024) | (jumped ? 2 : 0) | (index % 9 === 0 ? 8 : 0) | (index % 60 < 8 ? 128 : 0),
    };
    if (index % 97 === 0) cmd.yaw = Math.fround(yaw + (side < 0 ? -6 : 6));
    const speed = Math.fround(280 + (index % 180) * 2.5);
    pre.velocity = [speed, Math.fround(Math.sin(index) * 20), 0];
    post.velocity = [Math.fround(speed + 8), 0, 0];
    const info: Info = {
      jumped,
      teleported: index === 450,
      inStart,
      noclip: index >= 410 && index < 415,
      time: index > startTick ? (index - startTick) * 0.01 : null,
    };
    const sample: Sample = {
      speed: Math.hypot(post.velocity[0], post.velocity[1]),
      grounded: post.grounded,
      onLadder: index >= 390 && index < 395,
      tick,
      dt: 0.01,
      maxSpeed: index < 500 ? (style === "scroll" ? 250 : 260) : 15,
      airAccelerate: index < 550 ? (style === "scroll" ? 100 : 1000) : Math.fround(0.1),
      style,
      interrupted: info.teleported || info.noclip,
      jumped,
    };
    post.onLadder = sample.onLadder;
    coach.smoothing = index < 200 ? 8 : 3;
    coach.zone = index < 200 ? 10 : 5;
    coach.feed(cmd, sample);
    jumpReport = null;
    jumpHud.feed(cmd.side, cmd.yaw, Math.sqrt(post.velocity[0] ** 2 + post.velocity[1] ** 2), post.grounded, jumped);
    const view = new StrafeTrainerView();
    view.configure({
      follow: true,
      zone: coach.zone,
      dimBelow: 40,
      color: "#ffffff",
      height: 1,
      style: "classic",
      hints: true,
      showPace: true,
    });
    view.render(coach.reading);
    const rail = view.el.children[0] as Element,
      reading = view.el.children[1] as Element;
    const marker = rail.children[2] as Element;
    const report = tracker.tick(pre, cmd, info),
      startPre = preTracker.tick(pre, info);
    const offset = offsets.feed(cmd, post, info.teleported ? 1 : 0, style);
    if (jumped) jumps++;
    const fjt = first.feed({
      jumped,
      jumps,
      ticks: tick - startTick,
      running: !inStart,
      inStart,
      broken: info.teleported,
    });
    const reported = jumpReport as { chain: number; speed: number; gain: number } | null;
    ticks.push({
      reset,
      pre,
      post,
      cmd,
      info,
      sample,
      smoothing: coach.smoothing,
      zone: coach.zone,
      report,
      jumpHud: {
        sync: jumpHud.sync,
        report: reported,
        band: webPerf.jumpBand(Math.round(jumpHud.sync)),
        gainText: reported ? webPerf.jumpGain(reported.gain) : null,
      },
      ssj: report ? ssjExpected(report) : null,
      startPre: startPre === undefined ? "keep" : startPre,
      trainer: {
        ...coach.reading,
        text: (reading.children[0] as Element).textContent,
        hint: (reading.children[1] as Element).textContent,
        zone: view.el.dataset.zone,
        dim: view.el.classes.has("st-dim"),
        markerHidden: marker.hidden,
        position: Number.parseFloat(marker.style.left) / 100,
        landing: coach.takeLanding(),
      },
      offset,
      offsetText: offset ? movement.offsetText(offset) : null,
      first: fjt ?? null,
      firstHud: fjt === undefined ? null : movement.fjtText(fjt),
      firstChat: fjt === undefined ? null : movement.fjtText(fjt, 0.01),
      jumps,
      startTick,
    });
  }
  return { style, mode, ticks };
}
// Extract the live HUD's own perf label and visibility expression, retaining their original arithmetic.
const hudSource = source("hud.ts"),
  sessionSource = source("session.ts");
const perfLines = hudSource.match(/    const perfHidden =[^]*?    const perf =[^]*?;\n/)?.[0];
const gainExpression = hudSource.slice(hudSource.indexOf("private gainTick(")).match(/el.textContent = (.*);/)?.[1];
if (!gainExpression) throw new Error("Missing website jump gain text");
const jumpBandExpression = hudSource.match(/this.syncFill.className = (.*);/)?.[1];
if (!jumpBandExpression) throw new Error("Missing website jump sync colours");
const perfectExpression = sessionSource.match(/perfectHop: (.*),\n/)?.[1];
if (!perfLines || !perfectExpression) throw new Error("Missing website perf presentation");
put(
  "perf.ts",
  `export function perf(f, audio) { ${perfLines} return perf.slice(3); }
export function perfect(t) { return ${perfectExpression}; }
export function jumpBand(sync) { return (${jumpBandExpression}).split(" ")[1]; }
export function jumpGain(gain) { return ${gainExpression}; }`,
);
const webPerf = (await import(resolve(mirror, "perf.ts"))) as {
  perf: (this: object, frame: object, audio: object) => string;
  perfect: (this: object, timer: object) => boolean;
  jumpBand(sync: number): string;
  jumpGain(gain: number): string;
};
const perfCases = ["autohop", "scroll", "legit"].flatMap((style) =>
  [0, 1, 3, 7].flatMap((measured) =>
    [0, 1, 34, 35, 36].flatMap((age) =>
      [0.01, Math.fround(0.01), 0.02].map((interval) => {
        const timer = { measuredJumps: measured, lastPerfectTick: 10, lastTick: 10 + age, tickInterval: interval };
        const perfect = webPerf.perfect.call({ runStyle: style, unranked: false }, timer);
        const percent = measured ? 100 / measured : null;
        const text = webPerf.perf.call(
          { p: { hud: { layout: { sync: { on: false } } } } },
          { perf: percent, perfectHop: false },
          { perfHud: true, perfectIndicator: true },
        );
        return { style, measured, tick: timer.lastTick, lastPerfectTick: 10, interval, percent, text, perfect };
      }),
    ),
  ),
);
const reports: Report[] = [0, -0.01, 59.99, 60, 70, 79.99, 80, 89.99, 90, 99.96, 100, -12.5].map((gain) => ({
  jump: 6,
  speed: 1013,
  diff: 0,
  height: -2,
  gain: Math.fround(gain),
  sync: Math.fround(99.96),
  eff: 78.9,
  strafes: 1,
  time: 72.3455,
}));
const commit = Bun.spawnSync(["git", "-C", web, "rev-parse", revision]).stdout.toString().trim();
writeFileSync(
  output,
  Bun.gzipSync(
    JSON.stringify({
      generator: "native/tools/movement-hud/generate-vectors.ts",
      web: { commit, hashes },
      scenarios: ["autohop", "scroll", "legit", "hsw", "wonly"].flatMap((style) =>
        ["sixth", "every", "everySixth"].map((mode) => scenario(style, mode)),
      ),
      palettes,
      defaults: ssj.DEFAULT_SSJ,
      perf: perfCases,
      formatting: reports.map((report) => ({ report, expected: ssjExpected(report) })),
      offsets: [-2, -1, 0, 1, 2].map((ticks) => {
        const report = { ticks, overlap: false, gap: true };
        return { report, text: movement.offsetText(report) };
      }),
      longjumps: [249.5, 250, 254.125, 254.375, 254.625, 254.875, 259.5, 260, 268, 275].flatMap((distance) =>
        ["LJ", "BH"].flatMap((kind) =>
          [false, true].map((failed) => {
            const report = { kind, distance, pre: 278.5, max: 342.5, strafes: 6, sync: 90.5, failed };
            return { report, text: movement.ljText(report), tier: movement.ljTier(report) };
          }),
        ),
      ),
    }) + "\n",
  ),
);
console.log(`15 scenarios, 9000 ticks -> ${output}`);
