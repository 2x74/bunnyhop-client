import { applyGraphicsPreset, graphicsPreset, prefs } from "./ui/settings";

// Software rendering (no GPU: "Microsoft Basic Render Driver", SwiftShader, llvmpipe). School and office PCs often have
// the browser's hardware acceleration off or blocked, and then every pixel is drawn by the CPU: 5–20 fps at 1080p on
// the default settings (research/PERF-0.0.22.md). On the first page load that sees it, before the game's WebGL context
// exists (antialiasing is fixed at creation), untouched graphics settings go to the Lowest preset, and the player is
// told once why and how to get the GPU back.

const KEY = "bunnyhop:gfx-detect";

/** Whether a WebGL renderer string is a software rasterizer. */
export function softwareRenderer(name: string): boolean {
  return /swiftshader|basic render|llvmpipe|softpipe|software|\bwarp\b|mesa offscreen/i.test(name);
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
 * were never changed from the defaults. Returns whether the player should hear about it (software rendering seen for
 * the first time).
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
  const tuned = software && graphicsPreset(prefs.get().graphics) === "high";
  if (tuned) prefs.update((p) => applyGraphicsPreset(p.graphics, "lowest"));
  try {
    localStorage.setItem(KEY, software ? "software" : "gpu");
  } catch {
    /* storage blocked: nothing persists anyway */
  }
  return { software, tuned };
}
