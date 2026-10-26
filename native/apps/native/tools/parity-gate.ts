// Required release movement gate: exact pinned WASM vs the built C++ ABI runner,
// plus v16/v17 RNGFix and v17/v18 material-ladder behavioral contrasts. Artifacts retain the exact input/output.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { Core, DEFAULT_SETTINGS, setPosition, type PlayerState } from '../../web/src/core';
import { setVelocity } from '../../web/src/sim';
import { CANONICAL_WASM_SHA256, CANONICAL_WASM_BYTES, CANONICAL_WASM_URL, ensureCanonicalWasm } from '../ensure-wasm';
import { createFixtures, FIXTURE_SUITE, type Fixture } from './parity-fixtures';
// The data contract also runs under Node in the evidence collector. Dynamic import
// keeps the native-only TypeScript mirror independent of the repository's .github tree.
const { validateParityReport } = await import(resolve(import.meta.dir, '../../../../.github/scripts/native-release/parity-contract.mjs'));

export const hash = (b: Uint8Array | string): string => new Bun.CryptoHasher('sha256').update(b).digest('hex');
const f = new Float32Array(1), u = new Uint32Array(f.buffer);
const bits = (x: number) => { f[0] = x; return u[0]; };
const number = (x: number) => Math.fround(x).toPrecision(9);
export interface Row { tick: number; bits: number[]; flags: number[] }
export function row(s: PlayerState, events: number): Row {
  return { tick: s.tick, bits: [...s.position, ...s.velocity, s.viewOffsetZ, ...s.teleportAngles, ...s.angleChange,
    ...(s.touchPosition ?? [NaN, NaN, NaN])].map(bits), flags: [+s.grounded, +s.crouched, +s.onLadder, events, +(s.touchCrouched ?? false)] };
}
export function same(a: Row | undefined, b: Row | undefined): boolean {
  const nan = (x: number) => (x & 0x7f800000) === 0x7f800000 && (x & 0x007fffff) !== 0;
  return !!a && !!b && a.tick === b.tick && a.bits.length === b.bits.length && a.bits.every((x, i) => x === b.bits[i] || (nan(x) && nan(b.bits[i]))) &&
    a.flags.length === b.flags.length && a.flags.every((x, i) => x === b.flags[i]);
}
export interface Behavior { landed: number; speedKept: number; speedLost: number; jumped: number; edgeBugs: number; teleported: number; fallRestored: number; mapTeleport: number; attached: number; climbed: number }
export async function simulate(fixture: Fixture, wasm: Uint8Array, physics: number) {
  const core = await Core.create(wasm); core.loadMap(fixture.bsp);
  const missingPhysics = core.physicsMissing();
  const settings = { ...DEFAULT_SETTINGS, physics };
  const lines = [`# ${FIXTURE_SUITE} ${fixture.name} physics ${physics}`, `settings ${[settings.tickInterval, settings.airAccelerate, settings.accelerate,
    settings.friction, settings.stopSpeed, settings.gravity, settings.maxSpeed].map(number).join(' ')} ${+settings.autohop} ${physics} 0`];
  const rows: Row[] = [];
  const behavior: Behavior = { landed: 0, speedKept: 0, speedLost: 0, jumped: 0, edgeBugs: 0, teleported: 0, fallRestored: 0, mapTeleport: 0, attached: 0, climbed: 0 };
  for (const trial of fixture.trials) {
    core.setSettings(settings); core.reset(); setPosition(core, ...trial.position, 0); setVelocity(core, trial.velocity);
    lines.push('reset', `position ${[...trial.position, 0].map(number).join(' ')}`, `velocity ${trial.velocity.map(number).join(' ')}`, 'state');
    rows.push(row(core.state(), 1));
    let landed = false, jumped = false, edgeBug = false, teleported = false, attached = false, climbed = false;
    for (let tick = 0; tick < trial.ticks; tick++) {
      const previous = core.state();
      const command = [trial.forward ?? 0, 0, trial.yaw ?? 0, trial.pitch ?? 0, trial.buttons];
      const events = core.step(command[0], command[1], command[2], command[3], command[4]); const state = core.state();
      lines.push(`cmd ${command.slice(0, 4).map(number).join(' ')} ${trial.buttons}`, 'state'); rows.push(row(state, events));
      if (!attached && state.onLadder) { attached = true; behavior.attached++; }
      if (!climbed && state.onLadder && state.position[2] > trial.position[2] + 25) { climbed = true; behavior.climbed++; }
      if (!landed && state.grounded) {
        landed = true; behavior.landed++;
        const speed = Math.hypot(state.velocity[0], state.velocity[1]);
        if (speed > 399) behavior.speedKept++;
        if (speed < 350) behavior.speedLost++;
      }
      if (!jumped && events & 2) { jumped = true; behavior.jumped++; }
      if (!edgeBug && previous.velocity[2] < -100 && state.velocity[2] > previous.velocity[2] + 100 && !state.grounded && !(events & 2)) {
        edgeBug = true; behavior.edgeBugs++;
      }
      // Count the first contact only; later re-landings must not mask a missed thin trigger.
      if (!teleported && !jumped && events & 1) {
        teleported = true; behavior.teleported++;
        if (state.velocity[2] < -300) behavior.fallRestored++;
        if (events & 128) behavior.mapTeleport++;
      }
    }
  }
  return { rows, commands: lines.join('\n') + '\n', missingPhysics, behavior };
}

export async function runGate(runner: string | string[], output: string, wasmPath?: string) {
  mkdirSync(output, { recursive: true });
  if (readdirSync(output).length) throw new Error('Parity output must be empty (refuse stale evidence)');
  const wasm = readFileSync(wasmPath ?? await ensureCanonicalWasm());
  if (wasm.length !== CANONICAL_WASM_BYTES || hash(wasm) !== CANONICAL_WASM_SHA256) throw new Error('Gate requires exact pinned canonical WASM bytes');
  const report: any = { schema: 1, suite: FIXTURE_SUITE, pass: false, platform: `${process.platform}/${process.arch}`,
    sourceSha: process.env.GITHUB_SHA ?? null, runId: process.env.GITHUB_RUN_ID ?? null, runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    wasmSha256: hash(wasm), wasmBytes: wasm.length, wasmUrl: CANONICAL_WASM_URL, runnerSha256: hash(readFileSync(typeof runner === 'string' ? runner : runner[0])), physics: 18, contrastPhysics: 16, ladderContrastPhysics: 17, comparedStates: 0, mismatchRows: 0, missingPhysics: [], fixtures: [] };
  try {
    for (const fixture of createFixtures()) {
      writeFileSync(join(output, `${fixture.name}.bsp`), fixture.bsp);
      const simulations = await Promise.all(fixture.versions.map(async physics => [physics, await simulate(fixture, wasm, physics)] as const));
      const previous = simulations[0][1], current = simulations[1][1];
      const item: any = { name: fixture.name, mapSha256: hash(fixture.bsp), trials: fixture.trials.length, versions: [],
        divergentStates: current.rows.filter((r, i) => !same(r, previous.rows[i])).length, behavior: Object.fromEntries(simulations.map(([v, s]) => [`v${v}`, s.behavior])) };
      for (const [physics, simulation] of simulations) {
        const prefix = `${fixture.name}-v${physics}`;
        const commandsPath = join(output, `${prefix}.commands`);
        writeFileSync(commandsPath, simulation.commands);
        writeFileSync(join(output, `${prefix}.wasm.jsonl`), simulation.rows.map(r => JSON.stringify(r)).join('\n') + '\n');
        const child = Bun.spawn([...(typeof runner === 'string' ? [runner] : runner), '--map', join(output, `${fixture.name}.bsp`), '--commands', commandsPath], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, CONTENT_CACHE_DIR: join(output, 'empty-content-cache') } });
        const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        writeFileSync(join(output, `${prefix}.native.jsonl`), stdout); writeFileSync(join(output, `${prefix}.stderr.txt`), stderr);
        if (exit !== 0) throw new Error(`Runner failed (${exit}): ${stderr}`);
        const actual: Row[] = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        const mismatchRows = Array.from({ length: Math.max(actual.length, simulation.rows.length) }, (_, i) => i).filter(i => !same(actual[i], simulation.rows[i]));
        item.versions.push({ physics, comparedStates: simulation.rows.length, actualStates: actual.length, mismatchRows: mismatchRows.length,
          firstMismatch: mismatchRows[0] ?? null, missingPhysics: simulation.missingPhysics, commandsSha256: hash(simulation.commands),
          wasmStatesSha256: hash(readFileSync(join(output, `${prefix}.wasm.jsonl`))), nativeStatesSha256: hash(stdout) });
        report.comparedStates += simulation.rows.length; report.mismatchRows += mismatchRows.length; report.missingPhysics.push(...simulation.missingPhysics);
      }
      report.fixtures.push(item);
    }
    report.files = readdirSync(output).filter(name => name !== 'parity-report.json').sort().map(name => ({ name, sha256: hash(readFileSync(join(output, name))) }));
    report.pass = true;
    validateParityReport(report, report.platform, { sourceSha: report.sourceSha, runId: report.runId, runAttempt: report.runAttempt });
  } catch (error) { report.pass = false; report.error = String(error); throw error; }
  finally {
    report.files = readdirSync(output).filter(name => name !== 'parity-report.json').sort().map(name => ({ name, sha256: hash(readFileSync(join(output, name))) }));
    writeFileSync(join(output, 'parity-report.json'), JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify(report, null, 2));
  return report;
}
if (import.meta.main) {
  const { values } = parseArgs({ args: Bun.argv.slice(2), options: { runner: { type: 'string' }, output: { type: 'string' }, wasm: { type: 'string' } } });
  await runGate(resolve(values.runner ?? `apps/native/build/bunnyhop-native-runner${process.platform === 'win32' ? '.exe' : ''}`), resolve(values.output ?? 'target/native-parity'), values.wasm && resolve(values.wasm));
}
