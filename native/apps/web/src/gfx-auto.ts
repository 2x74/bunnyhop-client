import { applyGraphicsPreset, graphicsPreset, prefs, type GraphicsPreset } from "./ui/settings";

// Software rendering (no GPU: "Microsoft Basic Render Driver", SwiftShader, llvmpipe). School and office PCs often have
// the browser's hardware acceleration off or blocked, and then every pixel is drawn by the CPU: 5–20 fps at 1080p on
// the default settings (research/PERF-0.0.22.md). On the first page load that sees it, before the game's WebGL context
// exists (antialiasing is fixed at creation), untouched graphics settings go to the Lowest preset, and the player is
// told once why and how to get the GPU back.
//
// The same first load can also start a weaker GPU lower (DEVICE_CLASS_PRESETS, off until the owner turns it on):
// integrated graphics or a 4 GB device on Medium (no MSAA, no water reflections), clearly weak mobile and Chromebook GPUs
// or a 2 GB device on Low. Discrete cards, Apple silicon and anything not recognised stay on High. Only untouched
// defaults on a browser's first visit change; saved settings never do.

const KEY = "bunnyhop:gfx-detect";

/** First-load preset by GPU class and device memory (firstLoadPreset). Off: only software rendering is tuned. */
export const DEVICE_CLASS_PRESETS = false;

export type GpuClass = "software" | "weak" | "integrated" | "capable" | "unknown";

/** Renderer string patterns, first match wins (real strings: test/gfx-auto.test.ts). */
const GPU_CLASSES: [RegExp, GpuClass][] = [
  [/swiftshader|basic render|llvmpipe|softpipe|software|\bwarp\b|mesa offscreen/i, "software"],
  // Firefox's bucketed names and Safari's "Apple GPU" hide the card.
  [/,\s*or similar\s*$|^apple gpu$/i, "unknown"],
  // Phone and low-end Chromebook GPUs: Mali, PowerVR, Adreno up to the 600s.
  [/\bmali\b|mali-|powervr|imagination|adreno[^0-9]*[1-6]\d\d\b/i, "weak"],
  // Celeron / Pentium graphics (UHD 600 / 605, HD 500 / 505: most cheap Chromebooks) and pre-2015 Intel HD.
  [/\buhd graphics 60[05]\b|\bhd graphics (50[05]|[2-4]\d{3})\b/i, "weak"],
  [/\bintel\b.*\b(uhd|iris|hd)\b|intel\(r\) (xe )?graphics|\barc\(tm\) graphics/i, "integrated"],
  [/radeon\s*(\(tm\)|t|™)?\s*(graphics|vega|\d{3}m\b)|adreno|geforce (mx|gt)\b/i, "integrated"],
  [/geforce|rtx|gtx|quadro|nvidia|radeon|\barc\b|apple m\d/i, "capable"],
];

/** The class of a WebGL renderer string. */
export function gpuClass(renderer: string): GpuClass {
  for (const [re, c] of GPU_CLASSES) if (re.test(renderer)) return c;
  return "unknown";
}

/** The preset a first load starts on (null: leave the defaults, High). `deviceMemory`: navigator.deviceMemory (GB). */
export function firstLoadPreset(renderer: string, deviceMemory?: number): GraphicsPreset | null {
  const c = gpuClass(renderer);
  if (c === "software") return "lowest";
  if (c === "weak" || (deviceMemory !== undefined && deviceMemory <= 2)) return "low";
  if (c === "integrated" || (deviceMemory !== undefined && deviceMemory <= 4)) return "medium";
  return null;
}

/** Whether a WebGL renderer string is a software rasterizer. */
export function softwareRenderer(name: string): boolean {
  return /swiftshader|basic render|llvmpipe|softpipe|software|\bwarp\b|mesa offscreen/i.test(name);
}

const softwareContexts = new WeakMap<object, boolean>();
/**
 * Whether this WebGL context draws on a software rasterizer (the menus' 3D previews then keep their flat swatches and
 * icons: on SwiftShader each preview frame and each new shader cost the whole page seconds, research/PERF-PREVIEWS-0.0.40.md).
 */
export function softwareContext(gl: WebGLRenderingContext | WebGL2RenderingContext): boolean {
  let s = softwareContexts.get(gl);
  if (s === undefined) {
    try {
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      s = softwareRenderer(String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER)));
    } catch {
      s = false;
    }
    softwareContexts.set(gl, s);
  }
  return s;
}

/** The WebGL renderer string, from a throwaway context (lost again at once). "" without WebGL. */
function probeRenderer(): string {
  try {
    const gl = document.createElement("canvas").getContext("webgl2") ?? document.createElement("canvas").getContext("webgl");
    if (!gl) return "";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const name = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return name;
  } catch {
    return "";
  }
}

/**
 * Once per browser, before the renderer is made: on a software renderer, the Lowest preset if the graphics settings
 * were never changed from the defaults (and with DEVICE_CLASS_PRESETS, firstLoadPreset's choice). Returns whether the
 * player should hear about it (software rendering seen for the first time).
 */
export function autoTuneGraphics(): { software: boolean; tuned: boolean } {
  let seen = false;
  try {
    seen = localStorage.getItem(KEY) !== null;
  } catch {
    return { software: false, tuned: false };
  }
  if (seen) return { software: false, tuned: false };
  const name = probeRenderer();
  const software = !!name && softwareRenderer(name);
  const memory = (navigator as { deviceMemory?: number }).deviceMemory;
  const preset = software ? "lowest" : DEVICE_CLASS_PRESETS && name ? firstLoadPreset(name, memory) : null;
  const untouched = graphicsPreset(prefs.get().graphics) === "high";
  if (preset && untouched) prefs.update((p) => applyGraphicsPreset(p.graphics, preset));
  const tuned = software && untouched;
  try {
    localStorage.setItem(KEY, software ? "software" : "gpu");
  } catch {
    /* storage blocked: nothing persists anyway */
  }
  return { software, tuned };
}
