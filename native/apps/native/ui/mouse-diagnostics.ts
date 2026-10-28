import { h } from "../../web/src/ui/dom";
import { registerSettingsSection } from "../../web/src/ui/settings-registry";
type Spread = { p50Ms: number; p99Ms: number; maxMs: number };
type FrameSample = { frame: Spread; longestStallMs: number; stallsOver50Ms: number };
type InputSample = { timed: boolean; lateShare: number; holdbackMs: number };
type Sample = {
  active: boolean;
  seconds: number;
  eventsPerSecond: number;
  events: number;
  peakBurst: number;
  averageAgeMs: number;
  maxAgeMs: number;
  maxPumpMs: number;
  relative: boolean;
  systemScaling: boolean;
  sdl: string;
  frame?: FrameSample;
  input?: InputSample;
};
let latest: Sample | null = null;

/** The newest diagnostics sample from the game, for feedback ("Attach game info"). */
export function latestMouseDiagnostics(): Sample | null {
  return latest;
}

function frameText(sample: Sample): string {
  const frame = sample.frame;
  if (!frame?.frame || typeof frame.frame.p99Ms !== "number") {
    return "";
  }
  const stalls = `${frame.stallsOver50Ms} stalls over 50 ms (longest ${Math.round(frame.longestStallMs)} ms)`;
  return ` · frame ${frame.frame.p99Ms.toFixed(1)} ms p99 / ${frame.frame.maxMs.toFixed(1)} ms max · ${stalls}`;
}
const listeners = new Set<() => void>();
if (typeof window !== "undefined")
  window.addEventListener("bunnyhop:mouse-diagnostics", (event) => {
    const v = (event as CustomEvent).detail;
    if (!v || typeof v !== "object") return;
    for (const k of ["seconds", "eventsPerSecond", "events", "peakBurst", "averageAgeMs", "maxAgeMs", "maxPumpMs"])
      if (typeof v[k] !== "number" || !Number.isFinite(v[k]) || v[k] < 0) return;
    latest = {
      ...v,
      active: v.active === true,
      relative: v.relative === true,
      systemScaling: v.systemScaling === true,
      sdl: typeof v.sdl === "string" ? v.sdl.slice(0, 40) : "",
    };
    for (const update of listeners) update();
  });
function sampleText(s: Sample | null): string {
  if (!s || !s.seconds) return "No sample yet.";
  const parts = [
    `${s.active ? "Now" : "Last sample"}: ${Math.round(s.eventsPerSecond).toLocaleString()} motion events/s`,
    `${s.peakBurst} peak events/frame`,
    `${s.averageAgeMs.toFixed(2)} ms mean / ${s.maxAgeMs.toFixed(2)} ms max event age`,
    `${s.maxPumpMs.toFixed(2)} ms max event processing`,
    `SDL ${s.sdl}`,
  ];
  if (s.systemScaling) parts.push("OS mouse scaling on");
  return parts.join(" · ") + frameText(s);
}

/** Settings → Mouse & view → Advanced → Mouse diagnostics: the last sample of the input stats overlay. */
export function registerMouseDiagnostics(): void {
  registerSettingsSection(
    "mouse-diagnostics",
    (ui) => {
      const value = h("small.set-readout", { role: "status" });
      const row = ui.row("Last sample", value, {
        desc:
          "Turn on Show input stats, resume play and move the mouse. This counts motion reaching the game from every " +
          "mouse, not the USB polling rate. Event age comes from SDL timestamps, not click-to-photon latency.",
        keywords: "mouse diagnostics polling hz rate events sdl input stats latency",
      });
      const paint = (): void => {
        value.textContent = sampleText(latest);
      };
      const update = (): void => {
        if (row.isConnected || !seen) paint();
        else listeners.delete(update);
        seen ||= row.isConnected;
      };
      let seen = false;
      listeners.add(update);
      paint();
      return [ui.group("Mouse diagnostics", row)];
    },
    { advancedUnder: "mouse" },
  );
}
