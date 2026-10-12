import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const cli = path.resolve('node_modules', 'electron', 'cli.js');
delete process.env.ELECTRON_RUN_AS_NODE;
// Test profiles contain no real account credentials. Electron's own macOS
// tests use this switch so unsigned rebuilds never request the login keychain.
const testKeychainArgs = process.platform === 'darwin' ? ['--use-mock-keychain'] : [];
const child = spawn(process.execPath, [cli, '.', '--windowed', ...testKeychainArgs], {
  env: {
    ...process.env,
    BUNNYHOP_SMOKE: process.env.BUNNYHOP_SMOKE || '1',
    BUNNYHOP_SETTINGS_FILE: path.join(mkdtempSync(path.join(os.tmpdir(),'bunnyhop-smoke-')), 'settings.json'),
    BUNNYHOP_DISABLE_UPDATES: '1',
  },
  stdio: 'inherit',
  windowsHide: true,
});
child.once('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  if (signal) console.error(`Electron smoke test ended with ${signal}`);
  process.exitCode = code ?? 1;
});
