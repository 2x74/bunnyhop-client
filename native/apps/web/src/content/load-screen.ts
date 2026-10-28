// The loading screen's side of map content (main.ts): hosted texture download progress, the "Play without textures"
// offer when that download is slow or stalls, and the Retry / Play without textures buttons when a load fails.
//
// Play without textures (`?textures=0`): the map loads with its own pakfile only; stock materials it doesn't pack show
// as the grey checker / flat colours, the 2D sky as the gradient, stock props are left out. The props' collision models
// still download (the simulation needs them, and they're a few small files).

import { appHref, appLocation } from "../platform/navigation";
import type { LoadAction, LoadingView } from "../menu";
import { fmtBytes } from "../ui/dom";
import type { ContentProgress, PrepareContentOptions } from "./index";

/** No new bytes for this long: offer to play without textures. */
const STALL_MS = 8_000;
/** Texture download still running after this long (slow connection): offer it too. */
const SLOW_MS = 20_000;

/** This load skips hosted textures (`?textures=0`). */
export function playingWithoutTextures(): boolean {
  return appLocation().searchParams.get("textures") === "0";
}

/** Reloads the page (same map), with or without hosted textures. */
export function reloadMap(textures: boolean): void {
  const u = new URL(appHref());
  if (textures) u.searchParams.delete("textures");
  else u.searchParams.set("textures", "0");
  if (u.href === appHref()) location.reload();
  else location.replace(u.href);
}

/** Buttons for the error screen of a failed map load. `bspLoaded`: the map file itself arrived (textures may help). */
export function loadErrorActions(bspLoaded: boolean): LoadAction[] {
  const actions: LoadAction[] = [{ label: "Retry", primary: true, onClick: () => reloadMap(!playingWithoutTextures()) }];
  if (bspLoaded && !playingWithoutTextures()) actions.push({ label: "Play without textures", onClick: () => reloadMap(false) });
  return actions;
}

/**
 * Content options for buildWorld: progress on the loading screen between `from` and `to`, and the skip button. Call
 * `done()` once buildWorld has returned (or failed).
 */
export function contentLoading(loading: LoadingView, from: number, to: number): { options: Omit<PrepareContentOptions, "bsp" | "mapSha256">; done: () => void } {
  const skip = playingWithoutTextures();
  const ctl = new AbortController();
  const t0 = performance.now();
  let lastBytes = -1;
  let lastChange = t0;
  let lastPaint = 0;
  let trailing: ReturnType<typeof setTimeout> | 0 = 0;
  let finished = false;
  let offered = false;
  const label = skip ? "Downloading collision models" : "Downloading textures";

  const skipNow = () => {
    ctl.abort();
    loading.notice("Skipping the remaining textures…");
  };
  const timer = skip
    ? 0
    : setInterval(() => {
        if (finished || offered || ctl.signal.aborted) return;
        const now = performance.now();
        const stalled = now - lastChange > STALL_MS;
        if (!stalled && now - t0 < SLOW_MS) return;
        offered = true;
        loading.notice(stalled ? "The texture download is taking a while." : "Textures are still downloading.", [
          { label: "Play without textures", onClick: skipNow },
        ]);
      }, 1000);

  const paint = (p: ContentProgress) => {
    lastPaint = performance.now();
    const frac = p.totalBytes ? Math.min(1, p.bytes / p.totalBytes) : p.done / Math.max(1, p.files);
    const failed = p.failed ? ` · ${p.failed} unavailable` : "";
    void loading.stage(label, from + (to - from) * frac, `${p.done} / ${p.files} files · ${fmtBytes(p.bytes)} / ${fmtBytes(p.totalBytes)}${failed}`);
  };
  const onProgress = (p: ContentProgress) => {
    const now = performance.now();
    if (p.bytes !== lastBytes) {
      lastBytes = p.bytes;
      lastChange = now;
    }
    const complete = p.done >= p.files;
    if (trailing) clearTimeout(trailing);
    trailing = 0;
    if (complete) {
      finished = true;
      loading.notice(null);
      void loading.stage("Building world", to, skip ? "without textures" : "textures, lightmaps, geometry");
      return;
    }
    // At most every 100 ms, and the last update always shows (a trailing paint).
    if (now - lastPaint < 100) trailing = setTimeout(() => !finished && paint(p), 100 - (now - lastPaint));
    else paint(p);
  };

  return {
    options: { skip, signal: ctl.signal, onProgress },
    done: () => {
      finished = true;
      if (timer) clearInterval(timer);
      if (trailing) clearTimeout(trailing);
      loading.notice(null);
    },
  };
}
