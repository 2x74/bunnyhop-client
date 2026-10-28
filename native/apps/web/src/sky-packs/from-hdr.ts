// A Radiance .hdr equirect panorama (a Poly Haven HDRI, any 2:1 .hdr) as a sky pack, in the browser. Loaded with a dynamic
// import only when a player adds such a sky (sky-packs/settings.ts); tools/sky-packs/build-curated.ts shares skyLighting.
import { FloatType } from "three";
import { HDRLoader } from "three/examples/jsm/loaders/HDRLoader.js";
import { hdrDimensions, SKY_LIMITS, skyHash, type SkyLighting, type SkyPack } from "./manifest";
import type { SkyClouds } from "./sources";

/**
 * The sun and ambient a panorama declares: the sun's direction from the brightest upper-hemisphere texel (Three.js
 * equirect coordinates) with its normalized colour; ambient = the cosine-weighted upper-hemisphere colour (texels
 * clamped at 2), normalized. Intensities are artistic choices, not measured illuminance.
 */
export function skyLighting(data: Float32Array, w: number, h: number, sunIntensity: number, ambientIntensity: number): { lighting: Required<SkyLighting>; maxLinear: number; sunElevation: number } {
  let max = 0, index = 0, weight = 0;
  let ambient = [0, 0, 0];
  for (let y = 0; y < h / 2; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, l = data[i]! * .2126 + data[i + 1]! * .7152 + data[i + 2]! * .0722;
    if (l > max) (max = l), (index = i);
    const a = Math.cos((.5 - (y + .5) / h) * Math.PI);
    for (let k = 0; k < 3; k++) ambient[k]! += Math.min(data[i + k]!, 2) * a;
    weight += a;
  }
  const pixel = index / 4, x = pixel % w, y = Math.floor(pixel / w), lat = (.5 - (y + .5) / h) * Math.PI, lon = ((x + .5) / w - .5) * 2 * Math.PI;
  const direction = [Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)] as [number, number, number];
  const rgb = Array.from(data.subarray(index, index + 3)), m = Math.max(...rgb) || 1;
  ambient = ambient.map((c) => c / (weight || 1));
  const am = Math.max(...ambient) || 1;
  return {
    lighting: {
      sun: { direction, color: rgb.map((c) => c / m) as [number, number, number], intensity: sunIntensity },
      ambient: { color: ambient.map((c) => c / am) as [number, number, number], intensity: ambientIntensity },
    },
    maxLinear: max,
    sunElevation: lat * 180 / Math.PI,
  };
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export interface HdrSkySource { id: string; name: string; clouds: SkyClouds; sourceURL: string; license?: string }

/** The sky pack for `bytes` (a .hdr file). Throws for anything the sky runtime can't draw (size, aspect, orientation). */
export async function skyPackFromHdr(bytes: Uint8Array, src: HdrSkySource): Promise<SkyPack> {
  if (bytes.length > SKY_LIMITS.compressed) throw Error("That sky is too big (32 MB at most). Use the 2k version.");
  const [w, h] = hdrDimensions(bytes);
  if (w !== 2 * h) throw Error("A sky .hdr must be a 2:1 panorama.");
  if (w > SKY_LIMITS.dimension || w * h * 16 * 4 / 3 > SKY_LIMITS.decoded) throw Error("That sky is too big. Use the 2k version.");
  const parsed = new HDRLoader().setDataType(FloatType).parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  // Clear skies get a firmer sun; cloudy photographs a softer one with more fill (as the curated packs).
  const { lighting } = skyLighting(parsed.data as Float32Array, w, h, src.clouds === "clear" ? 1 : .8, src.clouds === "clear" ? .28 : .3);
  return {
    schemaVersion: 1, kind: "bunnyhop-sky", id: src.id, name: src.name.slice(0, 100), version: "1.0.0", format: "equirect", rotation: 0, exposure: 0, clouds: src.clouds,
    asset: { mime: "image/vnd.radiance", sha256: await skyHash(bytes), width: w, height: h, data: base64(bytes) },
    lighting,
    provenance: { sourceURL: src.sourceURL, ...(src.license ? { license: src.license } : {}) },
  };
}
