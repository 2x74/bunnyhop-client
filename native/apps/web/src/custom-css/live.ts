// Live HUD numbers for custom CSS (custom-css/index.ts sets which; hud.ts writes them on #hud): --hud-speed (u/s),
// --hud-sync (%), --hud-jumps, --hud-strafes, all whole numbers, so CSS can draw with them
// (`width: calc(var(--hud-speed) * 0.2px)`) or print them (`counter-reset: s var(--hud-speed); content: counter(s)`).
// Written only while the applied CSS mentions them: nothing is set per frame for anyone else.

export const LIVE_VARS = ["speed", "sync", "jumps", "strafes"] as const;
export type LiveVar = (typeof LIVE_VARS)[number];

/** `on`: any of them; `version` bumps on every change (hud.ts clears what's no longer used). */
export const liveVars: Record<LiveVar, boolean> & { on: boolean; version: number } = { speed: false, sync: false, jumps: false, strafes: false, on: false, version: 0 };

/** Which live numbers `css` uses ("" turns them all off). */
export function setLiveVars(css: string): void {
  let changed = false;
  for (const v of LIVE_VARS) {
    const on = css.includes(`--hud-${v}`);
    if (on !== liveVars[v]) (liveVars[v] = on), (changed = true);
  }
  if (!changed) return;
  liveVars.on = LIVE_VARS.some((v) => liveVars[v]);
  liveVars.version++;
}
