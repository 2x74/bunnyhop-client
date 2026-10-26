// Data consistency only; the private receiver must authenticate the job/step and artifacts.
export const PINNED_WASM_SHA256 = '240b3b26afe569b98eb59a73ee4b8f809d360511bda0479ae2be9edb67b8757f';
export const PARITY_SUITE = 'rngfix-release-v1';
export const parityArtifactName = (target, runId, attempt) => `native-parity-${target}-${runId}-${attempt}`;
export const fixtureHashes = {
  incline: '28734c897cdf610bfc7ca349713557747e05754109b720777281b20784e80b98',
  edge: 'ea4c3a7b18f3bc5308785bd065a640c743f0556ac557c8f9c65062cc24d54643',
  'thin-trigger': '9284b7e5abef51bf69589276eb5bbf7e286f4365fbe3dc2b512a25ecf3e095d5',
  telehop: '9284b7e5abef51bf69589276eb5bbf7e286f4365fbe3dc2b512a25ecf3e095d5',
};
export const parityFiles = [...Object.keys(fixtureHashes).flatMap(name => [
  `${name}.bsp`, ...[16, 17].flatMap(v => ['commands', 'wasm.jsonl', 'native.jsonl', 'stderr.txt'].map(ext => `${name}-v${v}.${ext}`)),
])].sort();
const requireThat = (test, reason) => { if (!test) throw new Error(`Movement parity: ${reason}`); };
const positive = n => Number.isSafeInteger(n) && n > 0;
const hex = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
export function validateParityReport(report, platform, context) {
  requireThat(report.schema === 1 && report.suite === PARITY_SUITE && report.pass === true, 'missing successful fixture suite');
  requireThat(report.platform === platform && report.physics === 17 && report.contrastPhysics === 16, 'platform/versions differ');
  requireThat(['sourceSha', 'runId', 'runAttempt'].every(k => report[k] === context[k]), 'source/run/attempt differs');
  requireThat(report.wasmSha256 === PINNED_WASM_SHA256 && hex(report.runnerSha256), 'unpinned WASM or missing runner digest');
  requireThat(positive(report.comparedStates) && report.mismatchRows === 0 && Array.isArray(report.missingPhysics) && report.missingPhysics.length === 0, 'empty, mismatched or incomplete physics comparison');
  requireThat(Array.isArray(report.fixtures) && report.fixtures.map(f => f.name).sort().join(',') === 'edge,incline,telehop,thin-trigger', 'missing/extra fixtures');
  let total = 0;
  for (const f of report.fixtures) {
    requireThat(hex(f.mapSha256) && f.trials === ({ incline: 60, edge: 80, 'thin-trigger': 40, telehop: 40 })[f.name] && positive(f.divergentStates), `${f.name} has no map/trials/v16 contrast`);
    requireThat(f.versions?.length === 2 && f.versions.map(v => v.physics).sort().join(',') === '16,17', `${f.name} missing versions`);
    for (const v of f.versions) {
      requireThat(positive(v.comparedStates) && v.comparedStates === v.actualStates && v.mismatchRows === 0 && v.firstMismatch === null && Array.isArray(v.missingPhysics) && v.missingPhysics.length === 0, `${f.name}/v${v.physics} empty/mismatched/missing physics`);
      requireThat(['commandsSha256', 'wasmStatesSha256', 'nativeStatesSha256'].every(k => hex(v[k])), `${f.name} missing input/output digests`);
      total += v.comparedStates;
    }
    const { v16: a, v17: b } = f.behavior ?? {};
    requireThat(a && b, `${f.name} missing behavior observations`);
    for (const observation of [a, b]) for (const counter of ['landed', 'speedKept', 'speedLost', 'jumped', 'edgeBugs', 'teleported', 'fallRestored', 'mapTeleport'])
      requireThat(Number.isSafeInteger(observation[counter]) && observation[counter] >= 0 && observation[counter] <= f.trials, `${f.name} invalid behavior count`);
    if (f.name === 'incline') requireThat(b.landed === f.trials && b.speedKept === f.trials && a.speedLost > 0, 'incline does not exercise speed preservation');
    if (f.name === 'edge') requireThat(b.jumped > a.jumped && a.edgeBugs > 0 && b.edgeBugs === 0, 'edge does not exercise edge-bug prevention');
    if (f.name === 'thin-trigger') requireThat(b.teleported === f.trials && a.teleported > 0 && a.teleported < b.teleported, 'thin trigger does not exercise first-landing contact');
    if (f.name === 'telehop') requireThat(a.teleported > 0 && b.teleported > 0 && a.fallRestored === 0 && b.fallRestored === b.teleported && b.mapTeleport === b.teleported && a.mapTeleport === 0, 'telehop does not exercise fall restoration/map teleport event');
  }
  requireThat(Array.isArray(report.files) && report.files.map(f => f.name).sort().join('\0') === parityFiles.join('\0') && report.files.every(f => hex(f.sha256)), 'missing/extra input/output files');
  const digest = name => report.files.find(f => f.name === name)?.sha256;
  for (const f of report.fixtures) {
    requireThat(digest(`${f.name}.bsp`) === f.mapSha256, 'BSP file digest differs');
    for (const v of f.versions) for (const [ext, key] of [['commands', 'commandsSha256'], ['wasm.jsonl', 'wasmStatesSha256'], ['native.jsonl', 'nativeStatesSha256']])
      requireThat(digest(`${f.name}-v${v.physics}.${ext}`) === v[key], 'input/output file digest differs');
  }
  requireThat(total === report.comparedStates, 'state totals differ');
  return report;
}
