import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('smoke launcher isolates credentials and uses a mock keychain on macOS without opening Electron', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bunnyhop-launch-test-'));
  let profile;
  try {
    const directory = path.join(root, 'node_modules', 'electron');
    mkdirSync(directory, { recursive: true });
    // This is an ordinary Node subprocess, not Electron or a browser.
    writeFileSync(path.join(directory, 'cli.js'), `console.log(JSON.stringify({
      args: process.argv.slice(2), settings: process.env.BUNNYHOP_SETTINGS_FILE,
      smoke: process.env.BUNNYHOP_SMOKE, updates: process.env.BUNNYHOP_DISABLE_UPDATES,
      runAsNode: process.env.ELECTRON_RUN_AS_NODE
    }));`);
    const launcher = fileURLToPath(new URL('../run-smoke.mjs', import.meta.url));
    const result = JSON.parse(execFileSync(process.execPath, [launcher], {
      cwd: root, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', BUNNYHOP_SMOKE: '1' },
    }));
    profile = path.dirname(result.settings);
    assert.equal(result.args.includes('--use-mock-keychain'), process.platform === 'darwin');
    assert.equal(result.runAsNode, undefined);
    assert.equal(result.smoke, '1');
    assert.equal(result.updates, '1');
    assert.match(path.basename(profile), /^bunnyhop-smoke-/);
    assert.equal(path.basename(result.settings), 'settings.json');
  } finally {
    rmSync(root, { recursive: true, force: true });
    if (profile) rmSync(profile, { recursive: true, force: true });
  }
});
