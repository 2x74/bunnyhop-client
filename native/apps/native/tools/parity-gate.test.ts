import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createFixtures } from "./parity-fixtures";
import { hash, same, runGate, type Row } from "./parity-gate";
const root = resolve(import.meta.dir, "../../..");
const runner =
  process.env.NATIVE_PARITY_RUNNER ??
  join(root, `apps/native/build/bunnyhop-native-runner${process.platform === "win32" ? ".exe" : ""}`);
const wasm = process.env.NATIVE_PARITY_WASM ?? join(root, "apps/web/src/wasm/bunnyhop_core.wasm");
const { fixtureHashes, validateParityReport } = await import(
  resolve(root, "../.github/scripts/native-release/parity-contract.mjs")
);

test("procedural BSP bytes are stable and cover the pinned non-flat suite", () => {
  const a = createFixtures(),
    b = createFixtures();
  expect(a.map((f) => f.name)).toEqual(["incline", "edge", "thin-trigger", "telehop", "material-ladder"]);
  for (let i = 0; i < a.length; i++) {
    expect(a[i].versions).toEqual(a[i].name === "material-ladder" ? [17, 18, 22] : [16, 17, 21, 22]);
    expect(hash(a[i].bsp)).toBe(fixtureHashes[a[i].name]);
    expect(a[i].bsp).toEqual(b[i].bsp);
  }
});
test("exact row comparator rejects finite bits, signed zero, flags and missing states", () => {
  const a: Row = { tick: 1, bits: [0, 0x7fc00000], flags: [0, 0, 0, 0, 0] };
  expect(same(a, { ...a, bits: [0, 0x7fc00001] })).toBe(true);
  expect(same(a, { ...a, bits: [0x80000000, 0x7fc00000] })).toBe(false);
  expect(same(a, { ...a, bits: [1, 0x7fc00000] })).toBe(false);
  expect(same(a, { ...a, bits: [0] })).toBe(false);
  expect(same(a, { ...a, flags: [0, 0, 0, 128, 0] })).toBe(false);
  expect(same(a, undefined)).toBe(false);
});
for (const [from, to] of [
  [17, 16],
  [18, 17],
])
  test(`real ABI mutation (silently run v${to} for v${from} commands) fails the full gate`, async () => {
    const scratch = mkdtempSync(join(tmpdir(), "native-parity-mutation-"));
    const wrapper = join(scratch, "mutated-runner.ts");
    // Execute the built C++ ABI runner with an adversarially downgraded command stream.
    // Both healthy and mutated native processes run real movement over the same BSP.
    writeFileSync(
      wrapper,
      `import {readFileSync, writeFileSync} from 'node:fs';
const [runner,...args] = Bun.argv.slice(2);
const i=args.indexOf('--commands')+1, path=args[i]+'.mutated';
writeFileSync(path,readFileSync(args[i],'utf8').replace(/^(settings .*) ${from} 0$/m,'$1 ${to} 0'));
args[i]=path;
const p=Bun.spawn([runner,...args],{stdout:'inherit',stderr:'inherit'});process.exit(await p.exited);\n`,
    );
    // Keep the adversary's files out of the exact evidence directory.
    const output = join(scratch, "evidence");
    // Wrapper writes alongside commands; drop its transient copy before manifest collection.
    const source = readFileSync(wrapper, "utf8").replace(
      "args[i]+'.mutated'",
      JSON.stringify(join(scratch, "mutated.commands")),
    );
    writeFileSync(wrapper, source);
    try {
      await expect(runGate([process.execPath, wrapper, runner], output, wasm)).rejects.toThrow(/mismatched/);
      const report = JSON.parse(readFileSync(join(output, "parity-report.json"), "utf8"));
      expect(report.pass).toBe(false);
      expect(report.mismatchRows).toBeGreaterThan(0);
      const affected = report.fixtures.filter((f: any) => (f.name === "material-ladder") === (from === 18));
      expect(affected.length).toBe(from === 18 ? 1 : 4);
      for (const f of affected) expect(f.versions.find((v: any) => v.physics === from).mismatchRows).toBeGreaterThan(0);
      console.log(
        `Adversarial ABI v${from}->v${to} mutation rejected: ${report.mismatchRows}/${report.comparedStates} state mismatches across ${affected.length} features`,
      );
      const absentContrast = structuredClone(report);
      absentContrast.pass = true;
      absentContrast.mismatchRows = 0;
      for (const f of absentContrast.fixtures) {
        f.divergentStates = 0;
        for (const v of f.versions) {
          v.mismatchRows = 0;
          v.firstMismatch = null;
        }
      }
      expect(() => validateParityReport(absentContrast, report.platform, report)).toThrow(/contrast/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 120_000);
