// A PNG / JPEG / WebP equirect panorama (a 2:1 picture: an anime sky, a stylized sky pack's PNG, a photo sphere) as a sky
// pack, in the browser. Loaded with a dynamic import only when a player adds such a sky (sky-packs/settings.ts,
// folder.ts). PNG and WebP that already fit are kept byte for byte; JPEG (not a sky pack format) and anything too big
// are drawn to a canvas, scaled to fit, and saved as WebP (PNG where the browser can't write WebP).
import { skyLighting } from "./from-hdr";
import { SKY_LIMITS, skyHash, type SkyPack } from "./manifest";
import type { HdrSkySource } from "./from-hdr";

/** The largest panorama kept: 4096x2048 (SKY_LIMITS.dimension; it decodes to 32 MB, under SKY_LIMITS.decoded). */
const MAX_W = SKY_LIMITS.dimension;
/** How far from 2:1 a picture may be and still be a panorama (a 4000x1999 export; not a 16:9 wallpaper). */
const ASPECT_SLACK = 0.02;
const LIGHTING_W = 512;

export type SkyImageMime = "image/png" | "image/jpeg" | "image/webp";

/** What a file's first bytes say it is, or null if it isn't a PNG, JPEG or WebP. */
export function skyImageMime(b: Uint8Array): SkyImageMime | null {
  const at = (i: number, s: string) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0));
  if (b.length >= 8 && b[0] === 0x89 && at(1, "PNG\r\n\x1a\n")) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && at(0, "RIFF") && at(8, "WEBP")) return "image/webp";
  return null;
}

/**
 * The size a `w` x `h` picture is kept at: exactly 2:1, at most MAX_W wide (smaller ones aren't scaled up), and
 * whether its bytes can be kept as they are. Throws for a picture that isn't a 2:1 panorama.
 */
export function skyImageSize(w: number, h: number, mime: SkyImageMime): { width: number; height: number; keep: boolean } {
  if (!(w > 0 && h > 0)) throw Error("That picture is empty.");
  if (Math.abs(w / h - 2) > 2 * ASPECT_SLACK) throw Error(`A sky picture must be a 2:1 panorama (like 4096×2048). This one is ${w}×${h}.`);
  if (h < 256) throw Error(`That picture is too small for a sky (${w}×${h}). Use at least 1024×512.`);
  const height = Math.min(MAX_W / 2, Math.round(Math.min(h, w / 2)));
  return { width: 2 * height, height, keep: mime !== "image/jpeg" && w === 2 * h && w <= MAX_W };
}

type Canvas = OffscreenCanvas | HTMLCanvasElement;
function canvas(w: number, h: number): Canvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  (c.width = w), (c.height = h);
  return c;
}
function draw(source: ImageBitmap, w: number, h: number): Canvas {
  const c = canvas(w, h);
  const g = c.getContext("2d") as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  if (!g) throw Error("This browser can't convert pictures.");
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(source, 0, 0, w, h);
  return c;
}
async function encode(c: Canvas, type: string, quality?: number): Promise<Blob> {
  if ("convertToBlob" in c) return c.convertToBlob({ type, quality });
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(Error("Couldn't save the converted sky."))), type, quality));
}

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** The sky pack for `bytes` (a PNG, JPEG or WebP file). Throws for anything that isn't a 2:1 panorama the sky runtime can draw. */
export async function skyPackFromImage(bytes: Uint8Array, src: HdrSkySource): Promise<SkyPack> {
  const mime = skyImageMime(bytes);
  if (!mime) throw Error("Sky pictures are PNG, JPEG or WebP.");
  if (bytes.length > SKY_LIMITS.compressed) throw Error("That picture is over 32 MB. Use a 4096×2048 one.");
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes.slice()], { type: mime }), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  } catch {
    throw Error("That picture couldn't be read.");
  }
  try {
    const size = skyImageSize(bitmap.width, bitmap.height, mime);
    let out = bytes, outMime = mime, { width, height } = size;
    if (!size.keep) {
      let blob = await encode(draw(bitmap, width, height), "image/webp", 0.92);
      // Safari writes PNG when asked for WebP; a detailed 4k PNG can pass the budget, and half size fits.
      if (blob.type !== "image/webp" && blob.size > SKY_LIMITS.compressed && width > 2048) {
        (width = 2048), (height = 1024);
        blob = await encode(draw(bitmap, width, height), "image/png");
      }
      out = new Uint8Array(await blob.arrayBuffer());
      outMime = skyImageMime(out) ?? mime;
      if (outMime === "image/jpeg" || out.length > SKY_LIMITS.compressed) throw Error("Couldn't save the converted sky.");
    }
    // The sun: the brightest upper-hemisphere texel of a small linear copy (an LDR picture's sun is at most 1.0).
    const lw = LIGHTING_W, lh = LIGHTING_W / 2;
    const small = draw(bitmap, lw, lh).getContext("2d") as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
    const px = small.getImageData(0, 0, lw, lh).data;
    const linear = new Float32Array(px.length);
    for (let i = 0; i < px.length; i++) linear[i] = i % 4 === 3 ? 1 : toLinear(px[i]! / 255);
    const { lighting } = skyLighting(linear, lw, lh, src.clouds === "clear" ? 1 : 0.8, src.clouds === "clear" ? 0.28 : 0.3);
    return {
      schemaVersion: 1, kind: "bunnyhop-sky", id: src.id, name: src.name.slice(0, 100), version: "1.0.0", format: "equirect", rotation: 0, exposure: 0, clouds: src.clouds,
      asset: { mime: outMime as "image/png" | "image/webp", sha256: await skyHash(out), width, height, data: base64(out) },
      lighting,
      provenance: { sourceURL: src.sourceURL, ...(src.license ? { license: src.license } : {}) },
    };
  } finally {
    bitmap.close();
  }
}
