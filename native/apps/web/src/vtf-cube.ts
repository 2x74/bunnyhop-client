// Cube map VTFs (WindowImposter `$envmap`s, cubemap skies) decoded on the host, with HDR formats tone-mapped to LDR.
//
// The core's texture path (crates/core/src/materials.rs `texture_payload`) only extracts face 0 of mip 0, so cube maps
// are read here from the raw file (`Core.contentRead`). Only one mip level is decoded: the largest whose faces are at
// most `maxSize` (VTFs carry their own mip chain), so a 1024² HDR cubemap costs a 512² decode and 8 MB of GPU memory
// (RGBA8 + mips) instead of 1024² float16 (48 MB + mips).
//
// Formats (VTF image format codes):
//   24 RGBA16161616F  linear float16 (Source's float-HDR cubemaps, `*.hdr.vtf`)
//   25 RGBA16161616   linear integer HDR: value / 65535 * 16 (HDR_INPUT_MAP_SCALE in the SDK's common_ps_fxc.h)
//   12 BGRA8888       in an `.hdr` file: compressed HDR "RGBS" (rgb * a * 16, as the CS:GO sky path in core); else LDR
//   0 RGBA8888, 2 RGB888, 3 BGR888, 11 ARGB8888, 16 BGRX8888: LDR (already sRGB-encoded)
// HDR values are linear light: times `exposure`, clamped to 1 (Source's LDR output with a tonemap scale of 1), then
// sRGB-encoded into RGBA8 so the 8 bits are spent perceptually (upload as an sRGB texture: the GPU decodes on sampling).
// DXT cube maps and anything else return null (the caller keeps its old fallback).

export const VTF_RGBA8888 = 0;
export const VTF_RGB888 = 2;
export const VTF_BGR888 = 3;
export const VTF_ARGB8888 = 11;
export const VTF_BGRA8888 = 12;
export const VTF_BGRX8888 = 16;
export const VTF_RGBA16161616F = 24;
export const VTF_RGBA16161616 = 25;

const BYTES_PER_PIXEL: Record<number, number> = {
  [VTF_RGBA8888]: 4,
  [VTF_RGB888]: 3,
  [VTF_BGR888]: 3,
  [VTF_ARGB8888]: 4,
  [VTF_BGRA8888]: 4,
  [VTF_BGRX8888]: 4,
  [VTF_RGBA16161616F]: 8,
  [VTF_RGBA16161616]: 8,
};

const ENVMAP_FLAG = 0x4000;
const HIGH_RES_TAG = 0x300000; // resource tag "\x30\0\0"

export interface VtfHeader {
  minor: number;
  width: number;
  height: number;
  flags: number;
  frames: number;
  firstFrame: number;
  format: number;
  mips: number;
  /** Offset of the high-resolution image data (mips smallest first; per mip: frames, faces, slices). */
  hiStart: number;
}

export function readVtfHeader(b: Uint8Array): VtfHeader | null {
  if (b.length < 64 || b[0] !== 0x56 || b[1] !== 0x54 || b[2] !== 0x46 || b[3] !== 0) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const minor = dv.getUint32(8, true);
  const headerSize = dv.getUint32(12, true);
  const width = dv.getUint16(16, true);
  const height = dv.getUint16(18, true);
  const flags = dv.getUint32(20, true);
  const frames = Math.max(1, dv.getUint16(24, true));
  const firstFrame = dv.getUint16(26, true);
  const format = dv.getInt32(52, true);
  const mips = b[56];
  const lowFormat = dv.getInt32(57, true);
  const [lowW, lowH] = [b[61], b[62]];
  let hiStart = -1;
  if (minor >= 3) {
    if (b.length < 80) return null;
    const count = dv.getUint32(68, true);
    if (80 + count * 8 > b.length) return null;
    for (let i = 0; i < count; i++) {
      const at = 80 + i * 8;
      if (((b[at] << 16) | (b[at + 1] << 8) | b[at + 2]) === HIGH_RES_TAG) hiStart = dv.getUint32(at + 4, true);
    }
  } else {
    // Before 7.3: the DXT1 low-res thumbnail follows the header, then the image data.
    const low = lowFormat === 13 && lowW && lowH ? Math.ceil(lowW / 4) * Math.ceil(lowH / 4) * 8 : 0;
    hiStart = headerSize + low;
  }
  if (hiStart < 0 || !width || !height || !mips) return null;
  return { minor, width, height, flags, frames, firstFrame, format, mips, hiStart };
}

export interface CubeFaces {
  /** Face edge in pixels (faces are square). */
  size: number;
  /** +X, -X, +Y, -Y, +Z, -Z (VTF / D3D / GL order, Source axes), RGBA8 sRGB-encoded, rows top first. */
  faces: Uint8Array[];
  /** Mean linear colour of the decoded faces (after exposure and clamping): the Potato preset's flat colour. */
  average: [number, number, number];
  /** Largest linear channel value before clamping (1 for LDR formats). */
  peak: number;
  format: number;
  /** Mip level decoded (0 = full size) and the source size. */
  mip: number;
  sourceSize: number;
}

let halfTable: Float32Array | null = null;
/** float16 bits -> float32, for all 65536 values. */
export function halfToFloatTable(): Float32Array {
  if (halfTable) return halfTable;
  const t = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const s = h & 0x8000 ? -1 : 1;
    const e = (h >> 10) & 0x1f;
    const m = h & 0x3ff;
    t[h] = e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
  }
  return (halfTable = t);
}

/** Linear 0..1 -> sRGB-encoded byte. */
export function linearToSrgbByte(v: number): number {
  if (!(v > 0)) return 0;
  if (v >= 1) return 255;
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

const SRGB_TO_LINEAR = Float32Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
});

/** The number of faces stored: 7 before VTF 7.5 when firstFrame is -1 (the spheremap), else 6. */
function storedFaces(h: VtfHeader, bpp: number, fileLength: number): number {
  let perFace = 0;
  for (let m = 0; m < h.mips; m++) perFace += Math.max(1, h.width >> m) * Math.max(1, h.height >> m) * bpp * h.frames;
  // Trust the file size when it settles it (some tools write firstFrame 0 with a spheremap, or the reverse).
  if (h.hiStart + perFace * 7 === fileLength) return 7;
  if (h.hiStart + perFace * 6 <= fileLength && h.hiStart + perFace * 7 > fileLength) return 6;
  return h.minor < 5 && h.firstFrame === 0xffff ? 7 : 6;
}

/**
 * Decodes the six faces of a cube map VTF at the largest stored mip whose edge is at most `maxSize` (a 25 % allowance
 * keeps odd sizes such as 524² at full size under a 512 cap). `hdr`: the file is an HDR texture (`*.hdr.vtf`); only
 * changes how BGRA8888 is read. Null for anything that isn't a cube map in a supported format.
 */
export function decodeVtfCube(bytes: Uint8Array, opts: { maxSize: number; hdr?: boolean; exposure?: number }): CubeFaces | null {
  const h = readVtfHeader(bytes);
  if (!h || !(h.flags & ENVMAP_FLAG) || h.width !== h.height) return null;
  const bpp = BYTES_PER_PIXEL[h.format];
  if (!bpp) return null;
  const faces = storedFaces(h, bpp, bytes.length);
  const mipBytes = (m: number) => Math.max(1, h.width >> m) * Math.max(1, h.height >> m) * bpp;
  // Largest mip that fits the cap (the smallest stored one if none does).
  let mip = 0;
  while (mip < h.mips - 1 && Math.max(1, h.width >> mip) > opts.maxSize * 1.25) mip++;
  const size = Math.max(1, h.width >> mip);
  // Skip the smaller mips (stored first), then this mip's frame 0 faces.
  let at = h.hiStart;
  for (let m = h.mips - 1; m > mip; m--) at += mipBytes(m) * h.frames * faces;
  const faceBytes = mipBytes(mip);
  if (at + faceBytes * 6 > bytes.length) return null;

  const exposure = opts.exposure ?? 1;
  const out: Uint8Array[] = [];
  const sum = [0, 0, 0];
  let peak = 0;
  const half = h.format === VTF_RGBA16161616F ? halfToFloatTable() : null;
  // float16 / uint16 channel -> linear value and sRGB byte, by table (65536 entries each).
  let lin16: Float32Array | null = null;
  let enc16: Uint8Array | null = null;
  if (h.format === VTF_RGBA16161616F || h.format === VTF_RGBA16161616) {
    lin16 = new Float32Array(65536);
    enc16 = new Uint8Array(65536);
    for (let v = 0; v < 65536; v++) {
      const raw = half ? half[v] : (v / 65535) * 16;
      const x = Number.isFinite(raw) ? Math.max(0, raw * exposure) : 0;
      lin16[v] = x;
      enc16[v] = linearToSrgbByte(x);
    }
  }
  const rgbs = h.format === VTF_BGRA8888 && !!opts.hdr;
  for (let f = 0; f < 6; f++) {
    const src = bytes.subarray(at + f * faceBytes, at + (f + 1) * faceBytes);
    const n = size * size;
    const dst = new Uint8Array(n * 4);
    if (lin16 && enc16) {
      const u16 = src.byteOffset % 2 === 0 ? new Uint16Array(src.buffer, src.byteOffset, src.byteLength / 2) : new Uint16Array(src.slice().buffer);
      for (let i = 0; i < n; i++) {
        for (let k = 0; k < 3; k++) {
          const v = u16[i * 4 + k];
          const x = lin16[v];
          if (x > peak) peak = x;
          sum[k] += Math.min(1, x);
          dst[i * 4 + k] = enc16[v];
        }
        dst[i * 4 + 3] = 255;
      }
    } else if (rgbs) {
      for (let i = 0; i < n; i++) {
        const scale = (src[i * 4 + 3] / 255) * 16 * exposure;
        for (let k = 0; k < 3; k++) {
          const x = SRGB_TO_LINEAR[src[i * 4 + 2 - k]] * scale;
          if (x > peak) peak = x;
          sum[k] += Math.min(1, x);
          dst[i * 4 + k] = linearToSrgbByte(x);
        }
        dst[i * 4 + 3] = 255;
      }
    } else {
      // LDR: reorder to RGBA (the bytes are already sRGB-encoded colour).
      const order: Record<number, [number, number, number]> = {
        [VTF_RGBA8888]: [0, 1, 2],
        [VTF_RGB888]: [0, 1, 2],
        [VTF_BGR888]: [2, 1, 0],
        [VTF_ARGB8888]: [1, 2, 3],
        [VTF_BGRA8888]: [2, 1, 0],
        [VTF_BGRX8888]: [2, 1, 0],
      };
      const [r, g, b] = order[h.format];
      for (let i = 0; i < n; i++) {
        const o = i * bpp;
        dst[i * 4] = src[o + r];
        dst[i * 4 + 1] = src[o + g];
        dst[i * 4 + 2] = src[o + b];
        dst[i * 4 + 3] = 255;
        sum[0] += SRGB_TO_LINEAR[src[o + r]];
        sum[1] += SRGB_TO_LINEAR[src[o + g]];
        sum[2] += SRGB_TO_LINEAR[src[o + b]];
      }
      peak = 1;
    }
    out.push(dst);
  }
  const count = size * size * 6;
  return { size, faces: out, average: [sum[0] / count, sum[1] / count, sum[2] / count], peak, format: h.format, mip, sourceSize: h.width };
}
