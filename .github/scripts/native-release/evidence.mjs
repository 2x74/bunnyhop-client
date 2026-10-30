// Offline data checks only. The private consumer must authenticate GitHub provenance separately.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { validateParityReport, parityArtifactName, PINNED_WASM_SHA256, PINNED_PHYSICS, PINNED_RULES } from './parity-contract.mjs';
import { pathToFileURL } from 'node:url';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
// Stat before reading JSON/checksums; stream large archives/traces in bounded chunks.
function readBounded(path, maximum) {
  const stat = lstatSync(path);
  requireThat(stat.isFile() && stat.size <= maximum, 'File is not regular or exceeds size limit');
  return readFileSync(path);
}
function hashFile(path, maximum) {
  const stat = lstatSync(path);
  requireThat(stat.isFile() && stat.size <= maximum, 'File is not regular or exceeds size limit');
  const fd = openSync(path, 'r'), buffer = Buffer.alloc(64 * 1024), hash = createHash('sha256');
  let total = 0;
  try {
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      total += count; requireThat(total <= maximum, 'File exceeds size limit');
      hash.update(buffer.subarray(0, count));
    }
  } finally { closeSync(fd); }
  requireThat(total === stat.size, 'File size changed while hashing');
  return hash.digest('hex');
}
export const targets = { windows: 'win32/x64', macos: 'darwin/arm64', linux: 'linux/x64' };
const artifactBase = { windows: 'bunnyhop-windows-x64', macos: 'bunnyhop-macos-arm64', linux: 'bunnyhop-linux-x64' };
const hex = /^[0-9a-f]{64}$/;
const numeric = value => typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
const requireThat = (test, reason) => { if (!test) throw new Error(reason); };
export const artifactName = (target, runId, attempt) => `${artifactBase[target]}-${runId}-${attempt}`;

export function validateReport(report, version, platform) {
  requireThat(report.schema === 1 && report.releaseEligible === true, 'Package is not eligible');
  requireThat(report.version === version && report.platform === platform, 'Package version/platform mismatch');
  requireThat(/^bunnyhop-native-[A-Za-z0-9.-]+\.(?:zip|tar\.gz)$/.test(report.archive), 'Invalid archive filename');
  const expectedArchive = `bunnyhop-native-${version}-${platform.replace('/', '-')}.${platform.startsWith('linux/') ? 'tar.gz' : 'zip'}`;
  requireThat(report.archive === expectedArchive, 'Archive filename does not match target');
  requireThat(Number.isSafeInteger(report.bytes) && report.bytes > 0 && report.bytes <= MAX_ARCHIVE_BYTES && hex.test(report.sha256), 'Invalid archive digest/size');
  for (const key of ['canonicalWasmSha256', 'binarySha256', 'menuSha256', 'assetsSha256']) requireThat(hex.test(report[key]), `Missing identity: ${key}`);
  requireThat(report.wasm === `bunnyhop-web/${report.canonicalWasmSha256.slice(0, 12)}`, 'WASM identity mismatch');
  requireThat(report.canonicalWasmSha256 === PINNED_WASM_SHA256 && report.physics === PINNED_PHYSICS && report.rules === PINNED_RULES, 'Package must use pinned WASM, physics and timer rules');
  requireThat(Number.isInteger(report.physics) && report.physics > 0 && Number.isInteger(report.rules) && report.rules > 0, 'Missing physics/rules');
  const [os, arch] = platform.split('/');
  requireThat(report.binaryHashMode === (os === 'darwin' ? 'macho-code-v1' : 'sha256'), 'Unexpected binary hash mode');
  const build = sha256(['package-v1', os, arch, report.binarySha256, report.menuSha256, report.assetsSha256, report.canonicalWasmSha256].join('\0')).slice(0, 24);
  requireThat(report.build === `bunnyhop-native/${build}`, 'Native identity mismatch');
  return report;
}

export function validateEvidence(evidence) {
  requireThat(evidence.schema === 1 && evidence.kind === 'native-candidate', 'Invalid evidence schema');
  requireThat(evidence.repository === '2x74/bunnyhop-client' && /^[0-9a-f]{40}$/.test(evidence.sourceSha), 'Invalid source');
  requireThat(numeric(evidence.runId) && numeric(evidence.runAttempt), 'Invalid run identity');
  requireThat(['push', 'workflow_dispatch'].includes(evidence.event), 'PR/fork evidence is not a release candidate');
  requireThat(/^refs\/(?:heads|tags)\/[A-Za-z0-9_./-]+$/.test(evidence.ref), 'Invalid source ref');
  requireThat(evidence.workflowRef === `${evidence.repository}/.github/workflows/native-release.yml@${evidence.ref}`, 'Unexpected workflow identity');
  requireThat(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(evidence.version), 'Invalid version');
  requireThat(evidence.event !== 'push' || evidence.ref === `refs/tags/v${evidence.version}`, 'Tag/version mismatch');
  requireThat(evidence.logsUrl === `https://api.github.com/repos/${evidence.repository}/actions/runs/${evidence.runId}/attempts/${evidence.runAttempt}/logs`, 'Missing exact run-attempt logs');
  requireThat(evidence.gates?.resources === 'success' && evidence.gates?.automation === 'success', 'Failed deterministic gates');
  const keys = Object.keys(targets).filter(key => evidence.platform === 'all' || evidence.platform === key);
  requireThat(keys.length > 0 && evidence.artifacts?.length === keys.length, 'Missing/extra platform evidence');
  const ids = new Set();
  for (const key of keys) {
    requireThat(evidence.gates[key] === 'success', `Failed platform gate: ${key}`);
    const artifact = evidence.artifacts.find(a => a.target === key);
    requireThat(artifact && numeric(artifact.id) && hex.test(artifact.digest) && !ids.has(artifact.id), 'Invalid/duplicate Actions artifact');
    ids.add(artifact.id);
    requireThat(artifact.name === artifactName(key, evidence.runId, evidence.runAttempt), 'Artifact run/attempt mismatch');
    requireThat(hex.test(artifact.reportSha256), 'Missing report digest');
    validateReport(artifact.report, evidence.version, targets[key]);
    const parity = artifact.parity;
    requireThat(parity && numeric(parity.id) && hex.test(parity.digest) && !ids.has(parity.id), 'Missing/duplicate movement parity artifact');
    ids.add(parity.id);
    requireThat(parity.name === parityArtifactName(key, evidence.runId, evidence.runAttempt) && hex.test(parity.reportSha256), 'Parity artifact run/attempt/digest differs');
    validateParityReport(parity.report, targets[key], evidence);
    requireThat(artifact.report.canonicalWasmSha256 === parity.report.wasmSha256 && artifact.report.physics === parity.report.physics, 'Package/parity compatibility differs');
  }
  const compatibility = evidence.artifacts.map(a => JSON.stringify([a.report.wasm, a.report.canonicalWasmSha256, a.report.physics, a.report.rules]));
  requireThat(new Set(compatibility).size === 1, 'Platform compatibility differs');
  return evidence;
}

export function collectEvidence(directory, context, needs) {
  requireThat(needs.version?.result === 'success', 'Version gate failed');
  const evidence = { schema: 1, kind: 'native-candidate', ...context, logsUrl: `https://api.github.com/repos/${context.repository}/actions/runs/${context.runId}/attempts/${context.runAttempt}/logs`, gates: {}, artifacts: [] };
  for (const job of ['resources', 'automation', ...Object.keys(targets)]) evidence.gates[job] = needs[job]?.result;
  for (const [target, platform] of Object.entries(targets)) {
    if (context.platform !== 'all' && context.platform !== target) continue;
    const output = needs[target]?.outputs;
    requireThat(output, `No outputs for ${target}`);
    const name = artifactName(target, context.runId, context.runAttempt);
    const root = join(directory, name);
    const files = readdirSync(root).sort();
    for (const file of files) requireThat(lstatSync(join(root, file)).isFile(), 'Only regular package files accepted');
    const reports = files.filter(file => file.endsWith('.json'));
    requireThat(reports.length === 1, 'Expected exactly one package report per platform');
    const bytes = readBounded(join(root, reports[0]), 64 * 1024);
    requireThat(bytes.length <= 64 * 1024, 'Package report too large');
    const report = validateReport(JSON.parse(bytes), context.version, platform);
    requireThat(files.join('\0') === ['SHA256SUMS', report.archive, reports[0]].sort().join('\0'), 'Unexpected package artifact files');
    const archivePath = join(root, report.archive);
    requireThat(lstatSync(archivePath).size === report.bytes && hashFile(archivePath, MAX_ARCHIVE_BYTES) === report.sha256, 'Archive bytes differ from report');
    const sums = [[report.archive, report.sha256], [reports[0], sha256(bytes)]].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([file, digest]) => `${digest}  ${file}\n`).join('');
    requireThat(readBounded(join(root, 'SHA256SUMS'), 4096).toString('utf8') === sums, 'Package checksums differ');
    const parityName = parityArtifactName(target, context.runId, context.runAttempt), parityRoot = join(directory, parityName);
    const parityBytes = readBounded(join(parityRoot, 'parity-report.json'), 64 * 1024);
    const parityReport = validateParityReport(JSON.parse(parityBytes), platform, context);
    requireThat(readdirSync(parityRoot).sort().join('\0') === ['parity-report.json', ...parityReport.files.map(f => f.name)].sort().join('\0'), 'Unexpected parity artifact files');
    let total = 0;
    for (const file of parityReport.files) {
      const path = join(parityRoot, file.name), stat = lstatSync(path);
      total += stat.size; requireThat(total <= 128 * 1024 * 1024, 'Parity artifact exceeds size limit');
      requireThat(hashFile(path, 32 * 1024 * 1024) === file.sha256, 'Parity input/output file digest differs');
    }
    evidence.artifacts.push({ target, id: output.artifact_id, digest: output.artifact_digest, name, reportSha256: sha256(bytes), report,
      parity: { id: output.parity_artifact_id, digest: output.parity_artifact_digest, name: parityName, reportSha256: sha256(parityBytes), report: parityReport } });
  }
  return validateEvidence(evidence);
}

// Keep the complete multi-platform report small enough to read by hand.
// Compact encoding changes only whitespace.
export function serializeEvidence(evidence) {
  validateEvidence(evidence);
  const bytes = JSON.stringify(evidence) + '\n';
  requireThat(Buffer.byteLength(bytes, 'utf8') <= 64 * 1024, 'Candidate evidence exceeds the input limit');
  return bytes;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const context = { repository: process.env.GITHUB_REPOSITORY, sourceSha: process.env.GITHUB_SHA, ref: process.env.GITHUB_REF, workflowRef: process.env.GITHUB_WORKFLOW_REF, event: process.env.GITHUB_EVENT_NAME, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, version: process.env.PACKAGE_VERSION, platform: process.env.PACKAGE_PLATFORM || 'all' };
  const evidence = collectEvidence(process.argv[2], context, JSON.parse(process.env.CANDIDATE_NEEDS));
  const bytes = serializeEvidence(evidence);
  writeFileSync(process.argv[3], bytes, { flag: 'wx' });
  console.log(`Candidate evidence SHA-256: ${sha256(bytes)}; production admission is not configured.`);
  if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `sha256=${sha256(bytes)}\n`, { flag: 'a' });
}
