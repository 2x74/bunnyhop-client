// The GPU behind the game's WebGL context (feedback reports' "Attach game info", device fingerprints: device.ts).
// UNMASKED_RENDERER / UNMASKED_VENDOR when the browser exposes them, else the masked strings.

export interface GpuInfo {
  renderer: string;
  vendor: string;
  version: string;
  maxTexture: number;
}

/**
 * The renderer's existing WebGL2 context (getContext returns it; three.js creates it at startup), or a throwaway one
 * when `fallback` and the game canvas isn't there yet. null without WebGL.
 */
export function gpuInfo(fallback = false): GpuInfo | null {
  try {
    const c = document.getElementById("game") as HTMLCanvasElement | null;
    let gl = (c?.getContext("webgl2") ?? null) as WebGL2RenderingContext | null;
    if (!gl && fallback) gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) return null;
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return {
      renderer: String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER)),
      vendor: String(gl.getParameter(ext ? ext.UNMASKED_VENDOR_WEBGL : gl.VENDOR)),
      version: String(gl.getParameter(gl.VERSION)),
      maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    };
  } catch {
    return null;
  }
}

/** WebGL capabilities as one string (extensions + a few limits): part of the device fingerprint. */
export function glCaps(): string {
  try {
    const c = document.getElementById("game") as HTMLCanvasElement | null;
    const own = c ? (c.getContext("webgl2") as WebGL2RenderingContext | null) : null;
    const gl = own ?? document.createElement("canvas").getContext("webgl2");
    if (!gl) return "";
    const p = [gl.MAX_RENDERBUFFER_SIZE, gl.MAX_VERTEX_ATTRIBS, gl.MAX_VARYING_VECTORS, gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS, gl.MAX_SAMPLES].map((x) => String(gl.getParameter(x)));
    return [...(gl.getSupportedExtensions() ?? [])].sort().join(",") + "|" + p.join(",");
  } catch {
    return "";
  }
}
