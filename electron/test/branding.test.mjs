import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { applyWindowsAppIdentity, WINDOWS_APP_ID } from '../branding.mjs';

function readText(url) {
  return readFileSync(url, 'utf8').replaceAll('\r\n', '\n');
}

test('Windows process identity matches the packaged application id', () => {
  const calls = [];
  const app = { setAppUserModelId: (value) => calls.push(value) };

  assert.equal(applyWindowsAppIdentity(app, 'win32'), true);
  assert.deepEqual(calls, [WINDOWS_APP_ID]);

  const builder = readText(new URL('../electron-builder.yml', import.meta.url));
  assert.match(builder, new RegExp(`^appId: ${WINDOWS_APP_ID}$`, 'm'));
});

test('Electron applies the Windows identity before constructing a window', () => {
  const main = readText(new URL('../main.mjs', import.meta.url));
  const identityCall = main.indexOf('\napplyWindowsAppIdentity(app);\n');
  const firstWindow = main.indexOf('new BrowserWindow');

  assert.notEqual(identityCall, -1, 'main entry point must apply the packaged identity');
  assert.notEqual(firstWindow, -1, 'main entry point must construct a window');
  assert.ok(identityCall < firstWindow, 'identity must be set before the first window');
});

test('non-Windows processes do not set a Windows identity', () => {
  const app = { setAppUserModelId: () => assert.fail('unexpected Windows identity call') };
  assert.equal(applyWindowsAppIdentity(app, 'darwin'), false);
  assert.equal(applyWindowsAppIdentity(app, 'linux'), false);
});
