import * as THREE from "three";

// Potato graphics (Settings → Graphics → Potato mode; render.ts WorldView.setPotato), for slow GPUs and laptops:
// every world material becomes its texture's average colour times the lightmap, with a faint 64-unit grid like the
// dev textures, and the opaque ones are merged into one draw call per brush model. Static props go flat the same way
// (they stay: some are solid). Water and glass are plain translucent tints without the water fog, the sky is a flat
// colour, the 3D skybox and sprite trails are off. Alpha-tested materials (grates, fences, foliage) keep their texture,
// since a flat colour would turn their holes solid. research/PERF.md has the numbers.

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const LUT = Float32Array.from({ length: 256 }, (_, i) => srgbToLinear(i / 255));

/** Average linear RGB and alpha of a texture's CPU-side data (DXT blocks or RGBA8), or null without data. */
export function averageColor(tex: THREE.Texture): [number, number, number, number] | null {
  const ct = tex as THREE.CompressedTexture;
  const srgb = tex.colorSpace === THREE.SRGBColorSpace;
  const lin = (v: number) => (srgb ? LUT[v] : v / 255);
  let r = 0, g = 0, b = 0, a = 0, n = 0;
  if (ct.isCompressedTexture) {
    const levels = ct.mipmaps as unknown as { data: Uint8Array; width: number; height: number }[];
    if (!levels?.length) return null;
    // The smallest level that is still whole blocks (its texels average the whole texture), at most ~1024 blocks read.
    let lv = levels[0];
    for (const l of levels) if (l.width >= 4 && l.height >= 4) lv = l;
    const fmt = ct.format;
    const dxt1 = fmt === THREE.RGB_S3TC_DXT1_Format || fmt === THREE.RGBA_S3TC_DXT1_Format;
    const size = dxt1 ? 8 : 16;
    const blocks = Math.floor(lv.data.length / size);
    const step = Math.max(1, Math.floor(blocks / 1024));
    const pal = new Float32Array(16);
    const alpha = new Float32Array(8);
    for (let k = 0; k < blocks; k += step) {
      const o = k * size;
      const d = lv.data;
      const c = dxt1 ? o : o + 8;
      const c0 = d[c] | (d[c + 1] << 8);
      const c1 = d[c + 2] | (d[c + 3] << 8);
      for (const [i, v] of [[0, c0], [1, c1]] as const) {
        pal[i * 4] = ((v >> 11) & 31) / 31;
        pal[i * 4 + 1] = ((v >> 5) & 63) / 63;
        pal[i * 4 + 2] = (v & 31) / 31;
        pal[i * 4 + 3] = 1;
      }
      const three = !dxt1 || c0 > c1;
      for (let ch = 0; ch < 3; ch++) {
        const p0 = pal[ch], p1 = pal[4 + ch];
        pal[8 + ch] = three ? (2 * p0 + p1) / 3 : (p0 + p1) / 2;
        pal[12 + ch] = three ? (p0 + 2 * p1) / 3 : 0;
      }
      pal[11] = 1;
      pal[15] = three ? 1 : fmt === THREE.RGBA_S3TC_DXT1_Format ? 0 : 1;
      // DXT5 alpha palette (DXT3: 4-bit explicit alpha per texel).
      if (fmt === THREE.RGBA_S3TC_DXT5_Format) {
        const a0 = d[o] / 255, a1 = d[o + 1] / 255;
        alpha[0] = a0;
        alpha[1] = a1;
        for (let i = 2; i < 8; i++) alpha[i] = a0 > a1 ? ((8 - i) * a0 + (i - 1) * a1) / 7 : i < 6 ? ((6 - i) * a0 + (i - 1) * a1) / 5 : i === 6 ? 0 : 1;
      }
      const bits = d[c + 4] | (d[c + 5] << 8) | (d[c + 6] << 16) | (d[c + 7] * 16777216);
      for (let t = 0; t < 16; t++) {
        const idx = (bits >>> (t * 2)) & 3;
        // The palette is sRGB-encoded 0..1: to 0..255 for the LUT.
        r += lin(Math.round(pal[idx * 4] * 255));
        g += lin(Math.round(pal[idx * 4 + 1] * 255));
        b += lin(Math.round(pal[idx * 4 + 2] * 255));
        let al = pal[idx * 4 + 3];
        if (fmt === THREE.RGBA_S3TC_DXT3_Format) al = ((d[o + (t >> 1)] >> ((t & 1) * 4)) & 15) / 15;
        else if (fmt === THREE.RGBA_S3TC_DXT5_Format) {
          // 48 bits of 3-bit indices after the two endpoints.
          const bit = t * 3;
          const byte = o + 2 + (bit >> 3);
          const word = d[byte] | ((d[byte + 1] ?? 0) << 8);
          al = alpha[(word >> (bit & 7)) & 7];
        }
        a += al;
        n++;
      }
    }
  } else {
    const img = tex.image as { data?: ArrayLike<number>; width?: number; height?: number } | undefined;
    const data = img?.data;
    if (!data || !img.width || !img.height) return null;
    const texels = img.width * img.height;
    const step = Math.max(1, Math.floor(texels / 4096));
    for (let t = 0; t < texels; t += step) {
      r += lin(data[t * 4]);
      g += lin(data[t * 4 + 1]);
      b += lin(data[t * 4 + 2]);
      a += data[t * 4 + 3] / 255;
      n++;
    }
  }
  return n ? [r / n, g / n, b / n, a / n] : null;
}

/**
 * Where a draw group goes in potato mode: merged with the other groups of the same `key` (one draw call), or alone
 * (a unique key), or nowhere (null: not drawn).
 */
export type PotatoSlot = { key: string; material: () => THREE.Material } | null;

/**
 * A copy of `geo` for potato mode: the same vertex buffers (plus `color` if given), its groups regrouped by slot into
 * a new index buffer, merged slots first. Returns the geometry and its material array.
 */
export function potatoGeometry(
  geo: THREE.BufferGeometry,
  color: THREE.BufferAttribute | null,
  slotOf: (material: number) => PotatoSlot,
  cache: Map<string, THREE.Material>,
): { geometry: THREE.BufferGeometry; materials: THREE.Material[] } {
  const src = geo.getIndex()!.array as Uint32Array;
  const buckets = new Map<string, { slot: NonNullable<PotatoSlot>; ranges: [number, number][] }>();
  for (const g of geo.groups) {
    const slot = slotOf(g.materialIndex ?? 0);
    if (!slot) continue;
    const b = buckets.get(slot.key) ?? buckets.set(slot.key, { slot, ranges: [] }).get(slot.key)!;
    b.ranges.push([g.start, g.count]);
  }
  let total = 0;
  for (const b of buckets.values()) for (const [, n] of b.ranges) total += n;
  const index = new Uint32Array(total);
  const out = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(geo.attributes)) out.setAttribute(name, attr);
  if (color) out.setAttribute("color", color);
  const materials: THREE.Material[] = [];
  let at = 0;
  for (const [key, b] of buckets) {
    const start = at;
    for (const [s, n] of b.ranges) {
      index.set(src.subarray(s, s + n), at);
      at += n;
    }
    let m = cache.get(key);
    if (!m) cache.set(key, (m = b.slot.material()));
    out.addGroup(start, at - start, materials.length);
    materials.push(m);
  }
  out.setIndex(new THREE.BufferAttribute(index, 1));
  return { geometry: out, materials };
}

/** Grid line spacing (Source units) of the potato world: the 64-unit blocks bhop maps are built from. */
const GRID = 64;

/**
 * Faint world-space grid lines on a flat material, along the face's dominant axis plane, fading out with distance
 * (no shimmer). A few ALU ops per pixel, no texture.
 */
export function withGrid<M extends THREE.Material>(m: M): M {
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vGridPos;\nvarying vec3 vGridN;")
      .replace(
        "#include <project_vertex>",
        "#include <project_vertex>\n  vGridPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\n  vGridN = mat3(modelMatrix) * normal;",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vGridPos;\nvarying vec3 vGridN;")
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
  {
    vec3 an = abs(vGridN);
    vec2 q = (an.x > an.y && an.x > an.z ? vGridPos.yz : an.y > an.z ? vGridPos.xz : vGridPos.xy) / ${GRID.toFixed(1)};
    vec2 w = fwidth(q);
    vec2 d = abs(fract(q - 0.5) - 0.5) / max(w, vec2(1e-4));
    float line = 1.0 - clamp(min(d.x, d.y) - 0.5, 0.0, 1.0);
    float fade = 1.0 - smoothstep(0.08, 0.3, max(w.x, w.y));
    diffuseColor.rgb *= 1.0 - 0.16 * line * fade;
  }`,
      );
  };
  m.customProgramCacheKey = () => "potato-grid";
  return m;
}
