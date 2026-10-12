import { readFileSync, writeFileSync } from 'node:fs';

// This helper only prepares build configuration. It never calls a publishing command.
const platform = process.env.RELEASE_PLATFORM;
if (!['mac', 'win', 'linux'].includes(platform)) throw new Error('Unknown release platform');
if (process.env.GITHUB_REPOSITORY !== '8tp/bunnyhop-client') throw new Error('Release builds require the owner repository');
const tag = process.env.RELEASE_TAG || '';
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
if (tag !== `v${version}` || !/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error('Tag must match the package version');
const required = platform === 'mac'
  ? ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']
  : platform === 'win'
    ? ['CSC_LINK', 'CSC_KEY_PASSWORD', 'WINDOWS_PUBLISHER_NAME']
    : ['LINUX_GPG_PRIVATE_KEY', 'LINUX_GPG_PASSPHRASE', 'LINUX_GPG_FINGERPRINT'];
for (const key of required) if (!process.env[key]?.trim()) throw new Error(`Missing signing prerequisite: ${key}`);
if (platform === 'linux' && !/^[A-Fa-f0-9]{40}$/.test(process.env.LINUX_GPG_FINGERPRINT)) throw new Error('Invalid GPG fingerprint');
const config = {
  extends: './electron/electron-builder.yml',
  extraMetadata: { bunnyhopReleaseBuild: true },
  publish: [{ provider: 'github', owner: '8tp', repo: 'bunnyhop-client', releaseType: 'release' }],
};
if (platform === 'mac') config.mac = { forceCodeSigning: true, notarize: true };
if (platform === 'win') config.win = {
  forceCodeSigning: true,
  signExecutable: true,
  verifyUpdateCodeSignature: true,
  signtoolOptions: { publisherName: process.env.WINDOWS_PUBLISHER_NAME },
};
writeFileSync('release-builder.json', `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
console.log(`Release prerequisites checked for ${platform}; publication remains disabled.`);
