// Big maps on low-memory devices. A map's page holds roughly 8 to 16 times its BSP's size at its peak (main core,
// render data, the worker core for ghosts and the self-check; measured for v0.0.41 on bhop_arcane_v2 and
// bhop_lol_plaza), plus about 400 MB for the page itself. A Chromebook with 4 GB has well under that to give one tab
// on a map over ~100 MB, and the tab is killed rather than slowed. navigator.deviceMemory (Chrome and Edge; rounded, at
// most 8) is the only signal.
//
// What is done about it: a one-line notice on the loading screen before such a map downloads, and the self-check of a
// finished run is skipped there unless the worker core is already up for the ghosts (it would load the map a second
// time right at the finish, while the run uploads). The server verifies every run either way.

/** [device memory at most (GB), BSP bytes from which a map is big for it]. */
const BIG_MAP: [number, number][] = [
  [2, 40e6],
  [4, 100e6],
];

export function deviceMemoryGB(): number | undefined {
  const m = (globalThis.navigator as { deviceMemory?: number } | undefined)?.deviceMemory;
  return typeof m === "number" && m > 0 ? m : undefined;
}

/** A map of `bytes` likely doesn't fit on a device with `gb` of memory (unknown memory: no). */
export function bigForDevice(bytes: number, gb = deviceMemoryGB()): boolean {
  if (gb === undefined) return false;
  return BIG_MAP.some(([max, from]) => gb <= max && bytes >= from);
}

export const BIG_MAP_NOTICE = "This map is big for this device's memory, so it may not load.";
