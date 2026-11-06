import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function configuredAbsentPlatforms(version, platform = 'all') {
  const policy = JSON.parse(readFileSync(new URL('../../../native/apps/native/packaging/release-platforms.json', import.meta.url)));
  if (platform !== 'all' || policy.version !== version) return [];
  const supported = ['darwin/arm64', 'linux/x64', 'win32/x64'];
  const absent = policy.absentPlatforms;
  if (policy.schema !== 1 || !Array.isArray(absent) || absent.length >= supported.length ||
      new Set(absent).size !== absent.length || absent.some(value => !supported.includes(value)))
    throw new Error('Invalid absent-platform policy');
  return absent;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(`macos_absent=${configuredAbsentPlatforms(process.argv[2]).includes('darwin/arm64')}`);
