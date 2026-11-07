// Bounded native/WASM identity proof: old physics retain their states, v27 ON is v26, and OFF toggles per command.
// Generated evidence stays outside Git. No replay is submitted.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { IN_NO_LANDFIX } from "../../web/src/core";
import { createFixtures } from "./parity-fixtures";
import { simulate, same, hash, type Row } from "./parity-gate";
import { ensureCanonicalWasm, CANONICAL_WASM_SHA256 } from "../ensure-wasm";
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    baseline: { type: "string" },
    output: { type: "string" },
    runner: { type: "string" },
  },
});
if (!values.baseline || !values.output) throw Error("--baseline V26.wasm --output EMPTY_DIRECTORY");
const directory = resolve(values.output);
mkdirSync(directory, { recursive: true });
if (readdirSync(directory).length) throw Error("Output must be empty");
const wasm = readFileSync(await ensureCanonicalWasm());
const baseline = readFileSync(values.baseline);
const oldHash = "08de4923bdfc4f01678420c1f4e62ca5567c4e2501e4c36bfdef45ebb1871d58";
if (hash(baseline) !== oldHash) throw Error("Expected the retained v26 production baseline");
const runner = resolve(
  values.runner ?? `apps/native/build/bunnyhop-native-runner${process.platform === "win32" ? ".exe" : ""}`,
);
const results: object[] = [];
let states = 0,
  legacyStates = 0,
  onIdentityStates = 0;
let offDifferences = 0,
  toggleDifferences = 0;
const equal = (a: Row[], b: Row[], label: string) => {
  if (a.length !== b.length) throw Error(label + ": row count differs");
  const mismatch = a.findIndex((state, tick) => !same(state, b[tick]));
  if (mismatch >= 0) throw Error(`${label}: mismatch at row ${mismatch}`);
};
const fixtures = createFixtures();
const floor = fixtures.find((fixture) => fixture.name === "edge")!;
fixtures.push({
  ...floor,
  name: "landfix-floor",
  trials: [0.03125, 1, 16, 32, 64].flatMap((height) =>
    [2, 6].map((buttons) => ({
      position: [-200, 0, height] as [number, number, number],
      velocity: [0, 0, 0] as [number, number, number],
      buttons,
      ticks: 300,
    })),
  ),
});
for (const fixture of fixtures) {
  const map = join(directory, fixture.name + ".bsp");
  writeFileSync(map, fixture.bsp);
  for (let physics = 1; physics <= 27; ++physics) {
    const on = await simulate(fixture, wasm, physics);
    if (physics <= 26) {
      const old = await simulate(fixture, baseline, physics);
      equal(on.rows, old.rows, `${fixture.name}/v${physics} historical identity`);
      legacyStates += on.rows.length;
    } else {
      const previous = await simulate(fixture, baseline, 26);
      equal(on.rows, previous.rows, `${fixture.name} v27 ON vs v26`);
      onIdentityStates += on.rows.length;
    }
    for (const mode of ["on", "off", "toggle"] as const) {
      const simulation =
        mode === "on"
          ? on
          : await simulate(
              fixture,
              wasm,
              physics,
              (tick, buttons) => buttons | (mode === "off" || (tick >= 50 && tick < 180) ? IN_NO_LANDFIX : 0),
            );
      if (physics <= 26) equal(on.rows, simulation.rows, `${fixture.name}/v${physics} ignores ${mode}`);
      else if (mode !== "on") {
        const differences = on.rows.filter((state, tick) => !same(state, simulation.rows[tick])).length;
        if (mode === "off") offDifferences += differences;
        else toggleDifferences += differences;
      }
      const prefix = `${fixture.name}-v${physics}-${mode}`;
      const commands = join(directory, prefix + ".commands");
      writeFileSync(commands, simulation.commands);
      const child = Bun.spawn([runner, "--map", map, "--commands", commands], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, CONTENT_CACHE_DIR: join(directory, "empty-content-cache") },
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (code || simulation.missingPhysics.length) throw Error(`${prefix}: ${stderr}`);
      const actual = stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Row);
      equal(simulation.rows, actual, prefix);
      states += actual.length;
      writeFileSync(join(directory, prefix + ".native.jsonl"), stdout);
      writeFileSync(
        join(directory, prefix + ".wasm.jsonl"),
        simulation.rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
      );
      results.push({
        fixture: fixture.name,
        physics,
        mode,
        states: actual.length,
        commandSha256: hash(simulation.commands),
        nativeSha256: hash(stdout),
      });
    }
  }
  console.log(`${fixture.name}: v1–27 ON/OFF/toggle parity and v1–26 historical identity passed`);
}
if (!offDifferences || !toggleDifferences)
  throw Error("The v27 fixtures must exercise OFF and mid-run toggle behavior");
const report = {
  passed: true,
  platform: `${process.platform}/${process.arch}`,
  wasmSha256: CANONICAL_WASM_SHA256,
  baselineSha256: oldHash,
  runnerSha256: hash(readFileSync(runner)),
  states,
  legacyStates,
  onIdentityStates,
  offDifferences,
  toggleDifferences,
  results,
};
writeFileSync(join(directory, "proof.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ ...report, results: results.length }));
