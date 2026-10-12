export const WINDOWS_APP_ID = 'lol.bunnyhop.client';

export function applyWindowsAppIdentity(electronApp, platform = process.platform) {
  if (platform !== 'win32') return false;
  electronApp.setAppUserModelId(WINDOWS_APP_ID);
  return true;
}
