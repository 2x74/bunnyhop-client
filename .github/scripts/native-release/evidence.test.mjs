import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactName, collectEvidence, MAX_EVIDENCE_BYTES, sha256, targets, validateEvidence, serializeEvidence } from './evidence.mjs';
import { PINNED_WASM_SHA256, PARITY_SUITE, parityArtifactName, parityFiles, fixtureVersions, fixtureTrials, behaviorCounters } from './parity-contract.mjs';
const context = { repository: '2x74/bunnyhop-client', sourceSha: 'a'.repeat(40), ref: 'refs/heads/main', workflowRef: '2x74/bunnyhop-client/.github/workflows/native-release.yml@refs/heads/main', event: 'workflow_dispatch', runId: '1234', runAttempt: '2', version: '0.0.2', platform: 'all' };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-evidence-'));
  const needs = { version: { result: 'success' }, resources: { result: 'success' }, automation: { result: 'success' } };
  for (const [i, [target, platform]] of Object.entries(targets).entries()) {
    const [os, arch] = platform.split('/');
    const archive = `bunnyhop-native-0.0.2-${os}-${arch}.${os === 'linux' ? 'tar.gz' : 'zip'}`;
    const bytes = Buffer.from(`fixture-only archive ${platform}`);
    const report = { schema: 1, releaseEligible: true, version: '0.0.2', platform, archive, bytes: bytes.length, sha256: sha256(bytes), canonicalWasmSha256: PINNED_WASM_SHA256, binarySha256: 'c'.repeat(64), menuSha256: 'd'.repeat(64), assetsSha256: 'e'.repeat(64), wasm: `bunnyhop-web/${PINNED_WASM_SHA256.slice(0, 12)}`, physics: 22, rules: 2, binaryHashMode: os === 'darwin' ? 'macho-code-v1' : 'sha256' };
    report.build = `bunnyhop-native/${sha256(['package-v1', os, arch, report.binarySha256, report.menuSha256, report.assetsSha256, report.canonicalWasmSha256].join('\0')).slice(0, 24)}`;
    const dir = join(root, artifactName(target, context.runId, context.runAttempt));
    mkdirSync(dir);
    const name = `${archive}.json`, json = JSON.stringify(report) + '\n';
    writeFileSync(join(dir, archive), bytes);
    writeFileSync(join(dir, name), json);
    writeFileSync(join(dir, 'SHA256SUMS'), [[archive, sha256(bytes)], [name, sha256(json)]].sort(([a], [b]) => a < b ? -1 : 1).map(([file, hash]) => `${hash}  ${file}\n`).join(''));
    const parityDir = join(root, parityArtifactName(target, context.runId, context.runAttempt));
    mkdirSync(parityDir);
    const data = Buffer.from('fixture-only parity bytes'), digest = sha256(data);
    for (const file of parityFiles) writeFileSync(join(parityDir, file), data);
    const behavior = Object.fromEntries(behaviorCounters.map(key => [key, 0]));
    const parity = { schema: 1, suite: PARITY_SUITE, pass: true, platform, sourceSha: context.sourceSha, runId: context.runId, runAttempt: context.runAttempt,
      wasmSha256: PINNED_WASM_SHA256, runnerSha256: 'f'.repeat(64), physics: 22, contrastPhysics: 16, ladderContrastPhysics: 17, comparedStates: 1900, mismatchRows: 0, missingPhysics: [],
      files: parityFiles.map(name => ({ name, sha256: digest })), fixtures: Object.keys(fixtureTrials).map(name => ({
        name, mapSha256: digest, trials: fixtureTrials[name], divergentStates: 1,
        versions: fixtureVersions(name).map(physics => ({ physics, comparedStates: 100, actualStates: 100, mismatchRows: 0, firstMismatch: null, missingPhysics: [], commandsSha256: digest, wasmStatesSha256: digest, nativeStatesSha256: digest })),
        behavior: Object.fromEntries(fixtureVersions(name).map(v => [`v${v}`, name === 'material-ladder'
          ? { ...behavior, attached: v >= 18 ? 16 : 0, climbed: v >= 18 ? 16 : 0 }
          : v === 16 ? { ...behavior, speedLost: 1, edgeBugs: 1, teleported: 1 }
          : { ...behavior, landed: name === 'incline' ? 60 : 0, speedKept: name === 'incline' ? 60 : 0, jumped: 1, teleported: 40, fallRestored: 40, mapTeleport: 40 }])),
      })) };
    writeFileSync(join(parityDir, 'parity-report.json'), JSON.stringify(parity));
    needs[target] = { result: 'success', outputs: { artifact_id: String(i + 100), artifact_digest: String(i + 1).repeat(64), parity_artifact_id: String(i + 200), parity_artifact_digest: String(i + 4).repeat(64) } };
  }
  return { root, needs, clean: () => rmSync(root, { recursive: true, force: true }) };
}
function withEvidence(fn) {
  const f = fixture();
  try { return fn(collectEvidence(f.root, context, f.needs), f); } finally { f.clean(); }
}

test('collects immutable coordinates and verifies archive/report/checksum bytes', () => withEvidence(e => {
  assert.equal(e.artifacts.length, 3);
  assert.equal(e.artifacts[0].name, 'bunnyhop-windows-x64-1234-2');
  assert.equal(e.artifacts[0].report.physics, 22);
}));
for (const [name, mutate] of [
  ['missing parity artifact', e => { delete e.artifacts[0].parity; }],
  ['reused parity artifact ID', e => { e.artifacts[0].parity.id = e.artifacts[0].id; }],
  ['old parity attempt', e => { e.artifacts[0].parity.report.runAttempt = '1'; }],
  ['wrong parity platform', e => { e.artifacts[0].parity.report.platform = 'linux/x64'; }],
  ['unpinned parity WASM', e => { e.artifacts[0].parity.report.wasmSha256 = '0'.repeat(64); }],
  ['zero parity states', e => { e.artifacts[0].parity.report.comparedStates = 0; }],
  ['parity mismatch', e => { e.artifacts[0].parity.report.fixtures[0].versions[0].mismatchRows = 1; }],
  ['missing physics asset', e => { e.artifacts[0].parity.report.fixtures[0].versions[0].missingPhysics = ['missing.vphy']; }],
  ['flat-only fixture contrast', e => { e.artifacts[0].parity.report.fixtures[0].divergentStates = 0; }],
  ['absent incline speed preservation', e => { e.artifacts[0].parity.report.fixtures[0].behavior.v17.speedKept = 0; }],
  ['absent edge-bug prevention', e => { e.artifacts[0].parity.report.fixtures[1].behavior.v17.jumped = 0; }],
  ['absent thin-trigger contact', e => { e.artifacts[0].parity.report.fixtures[2].behavior.v17.teleported = 0; }],
  ['absent telehop fall restoration', e => { e.artifacts[0].parity.report.fixtures[3].behavior.v17.fallRestored = 0; }],
  ['missing latest RNGFix version', e => { e.artifacts[0].parity.report.fixtures[0].versions.pop(); }],
  ['absent latest RNGFix speed preservation', e => { e.artifacts[0].parity.report.fixtures[0].behavior.v22.speedKept = 0; }],
  ['absent material ladder fixture', e => { e.artifacts[0].parity.report.fixtures.pop(); }],
  ['absent material ladder contrast', e => { e.artifacts[0].parity.report.fixtures[4].divergentStates = 0; }],
  ['absent material ladder attachment', e => { e.artifacts[0].parity.report.fixtures[4].behavior.v18.attached = 0; }],
  ['absent material ladder climbing', e => { e.artifacts[0].parity.report.fixtures[4].behavior.v18.climbed = 0; }],
  ['changed historical ladder behavior', e => { e.artifacts[0].parity.report.fixtures[4].behavior.v17.attached = 16; }],
  ['missing historical ladder version', e => { e.artifacts[0].parity.report.fixtures[4].versions.shift(); }],
  ['missing parity trace', e => { e.artifacts[0].parity.report.files.pop(); }],
  ['oversized archive claim', e => { e.artifacts[0].report.bytes = 513 * 1024 * 1024; }],
  ['failed tests', e => { e.gates.linux = 'failure'; }],
  ['skipped tests', e => { e.gates.macos = 'skipped'; }],
  ['missing resource check', e => { delete e.gates.resources; }],
  ['failed automation', e => { e.gates.automation = 'failure'; }],
  ['fork repository', e => { e.repository = 'attacker/bunnyhop-client'; }],
  ['PR event', e => { e.event = 'pull_request'; }],
  ['wrong attempt logs', e => { e.logsUrl = e.logsUrl.replace('/attempts/2/', '/attempts/1/'); }],
  ['wrong workflow', e => { e.workflowRef = 'attacker/workflow'; }],
  ['wrong tag', e => { e.event = 'push'; }],
  ['missing platform', e => { e.artifacts.pop(); }],
  ['duplicate artifact ID', e => { e.artifacts[1].id = e.artifacts[0].id; }],
  ['previous attempt artifact', e => { e.runAttempt = '3'; }],
  ['changed native identity', e => { e.artifacts[0].report.build = 'bunnyhop-native/' + '0'.repeat(24); }],
  ['changed WASM', e => { e.artifacts[0].report.wasm = 'bunnyhop-web/000000000000'; }],
  ['mixed physics', e => { e.artifacts[0].report.physics = 16; }],
  ['old timer rules', e => { e.artifacts.forEach(a => { a.report.rules = 1; }); }],
  ['missing rules', e => { delete e.artifacts[0].report.rules; }],
  ['archive traversal', e => { e.artifacts[0].report.archive = '../bad.zip'; }],
  ['non-eligible package', e => { e.artifacts[0].report.releaseEligible = false; }],
]) test(`rejects ${name}`, () => withEvidence(e => { mutate(e); assert.throws(() => validateEvidence(e)); }));

test('rejects mutated archive and checksum bytes', () => withEvidence((e, f) => {
  const a = e.artifacts[0], path = join(f.root, a.name, a.report.archive);
  writeFileSync(path, 'changed');
  assert.throws(() => collectEvidence(f.root, context, f.needs), /Archive bytes/);
}));
test('rejects mutated checksum file', () => withEvidence((e, f) => {
  writeFileSync(join(f.root, e.artifacts[0].name, 'SHA256SUMS'), 'forged');
  assert.throws(() => collectEvidence(f.root, context, f.needs), /checksums/);
}));
test('rejects unexpected files', () => withEvidence((e, f) => {
  writeFileSync(join(f.root, e.artifacts[0].name, 'extra.sh'), 'bad');
  assert.throws(() => collectEvidence(f.root, context, f.needs), /Unexpected/);
}));
test('workflow template remains identical and cannot issue production tokens', () => {
  const workflow = readFileSync(new URL('../../workflows/native-release.yml', import.meta.url), 'utf8');
  const template = readFileSync(new URL('../../../native/apps/native/packaging/workflows/native-packages.yml', import.meta.url), 'utf8');
  assert.equal(workflow, template);
  assert.doesNotMatch(workflow, /secrets\.|pull_request_target|workflow_run|id-token:|contents: write/);
});

test('collector rejects modified parity trace bytes', () => withEvidence((e, f) => {
  writeFileSync(join(f.root, e.artifacts[0].parity.name, 'edge-v17.native.jsonl'), 'changed');
  assert.throws(() => collectEvidence(f.root, context, f.needs), /Parity input\/output file digest/);
}));
test('collector rejects oversized reports before parsing', () => withEvidence((e, f) => {
  writeFileSync(join(f.root, e.artifacts[0].name, e.artifacts[0].report.archive + '.json'), ' '.repeat(65537));
  assert.throws(() => collectEvidence(f.root, context, f.needs), /size limit/);
}));
test('both workflows require movement gates, evidence and immediate Windows exit handling', () => {
  const workflow = readFileSync(new URL('../../workflows/native-release.yml', import.meta.url), 'utf8');
  const build = readFileSync(new URL('../../../native/apps/native/packaging/windows/build.ps1', import.meta.url), 'utf8');
  assert.match(build, /Run 'bun' @\('apps\/native\/tools\/parity-gate.ts'\)/);
  assert.match(workflow, /release-check.ts --package \$package.FullName\n          if \(\$LASTEXITCODE -ne 0\)/);
  assert.match(workflow, /windows-exit.test.ps1/);
  for (const platform of ['windows', 'macos', 'linux']) {
    assert.match(workflow, new RegExp(`name: native-parity-${platform}-`));
  }
  assert.equal((workflow.match(/parity_artifact_id:/g) ?? []).length, 3);
  assert.equal((workflow.match(/bun apps\/native\/tools\/parity-gate.ts/g) ?? []).length, 2);
});

 test('complete v18 all-platform evidence fits the bounded input', () => withEvidence(e => {
  assert.ok(Buffer.byteLength(JSON.stringify(e, null, 2)) > 64 * 1024);
  const bytes = serializeEvidence(e);
  assert.ok(Buffer.byteLength(bytes) <= MAX_EVIDENCE_BYTES);
  assert.deepEqual(JSON.parse(bytes), e);
  assert.throws(() => serializeEvidence({ ...e, oversized: 'x'.repeat(MAX_EVIDENCE_BYTES) }), /input limit/);
}));
