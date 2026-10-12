import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve('dist/electron');
const artifacts = readdirSync(root).filter((name) => /\.(?:exe|dmg|zip|AppImage|deb|yml|blockmap)$/.test(name));
if (!artifacts.length) throw new Error('No release artifacts found');
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'inherit', ...options });
if (process.platform === 'darwin') {
  const app = path.join(root, 'mac-arm64', 'Bunnyhop.app');
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  run('xcrun', ['stapler', 'validate', app]);
  run('spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
} else if (process.platform === 'win32') {
  // Compare the configured certificate common name without interpolating it into PowerShell code.
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
    $files = @(Get-ChildItem 'dist/electron' -Filter '*.exe') + @(Get-Item 'dist/electron/win-unpacked/Bunnyhop.exe')
    if ($files.Count -lt 2) { throw 'Missing Windows release executables' }
    foreach ($file in $files) {
      $signature = Get-AuthenticodeSignature -FilePath $file.FullName
      if ($signature.Status -ne 'Valid') { throw ('Invalid signature: ' + $file.Name) }
      $publisher = $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
      if ($publisher -cne $env:WINDOWS_PUBLISHER_NAME) { throw ('Unexpected publisher: ' + $file.Name) }
    }
  `]);
}
const checksums = artifacts.sort().map((name) => `${createHash('sha256').update(readFileSync(path.join(root, name))).digest('hex')}  ${name}`).join('\n');
writeFileSync(path.join(root, 'SHA256SUMS'), `${checksums}\n`);
if (process.platform === 'linux') {
  const keyringRoot = mkdtempSync(path.join(os.tmpdir(), 'bunnyhop-release-gpg-'));
  chmodSync(keyringRoot, 0o700);
  const env = { ...process.env, GNUPGHOME: keyringRoot };
  try {
    execFileSync('gpg', ['--batch', '--import'], { env, input: process.env.LINUX_GPG_PRIVATE_KEY, stdio: ['pipe', 'inherit', 'inherit'] });
    for (const name of [...artifacts, 'SHA256SUMS']) {
      const file = path.join(root, name);
      execFileSync('gpg', ['--batch', '--yes', '--pinentry-mode', 'loopback', '--passphrase-fd', '0', '--local-user', process.env.LINUX_GPG_FINGERPRINT, '--armor', '--detach-sign', file], {
        env, input: `${process.env.LINUX_GPG_PASSPHRASE}\n`, stdio: ['pipe', 'inherit', 'inherit'],
      });
      run('gpg', ['--batch', '--verify', `${file}.asc`, file], { env });
    }
  } finally { rmSync(keyringRoot, { recursive: true, force: true }); }
}
console.log('Release signatures verified and SHA256SUMS written. Nothing published.');
