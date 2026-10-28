// Switchable light styles on top of the core's lightmap atlas. DOM-free (render.ts, tools/verify/render-check.ts).
//
// Source faces carry up to four light styles, each with its own lightmap page: style 0 is the normal static light,
// named `light` / `light_spot` entities get their own switchable style (32+, assigned by VRAD) and Appearance presets
// (flicker, pulse, ...) use styles 1-12. The engine adds the pages, each scaled by its style's current value. The
// core's atlas (crates/core/src/lightmap.rs) holds style 0 only, so anything lit by a named light rendered dark:
// bhop_cutekittenz lights everything after its start room that way.
//
// This re-adds the other pages in the client, so it ships without a core (wasm) change: it repeats lightmap.rs's face
// selection and shelf packing to find each face's block in the atlas, checks that the style-0 texels there match its
// own encoding (any mismatch, e.g. after a core change to the packing, leaves the atlas as it was), then rewrites the
// blocks of faces that have extra styles with the sum of their pages. Style values are static: a named light's
// spawn state (spawnflag 1 "Initially dark", plus TurnOn / TurnOff / Toggle sent straight from a logic_auto at spawn),
// and animated patterns at their time-average. The core doesn't track light entities, so later TurnOn / TurnOff
// inputs (triggers, timers, buttons) don't change the lighting.

import type { Lightmap } from "./core";

// lightmap.rs constants.
const LDR_GAMMA = 2.2;
const SURF_NOLIGHT = 0x400;
const SURF_BUMPLIGHT = 0x800;
const BORDER = 1;
const WHITE_BLOCK = 4;
const MIN_EXP = -32;
const MAX_EXP = 16;
const EXP_UNIT = Array.from({ length: MAX_EXP - MIN_EXP + 1 }, (_, i) => 2 ** (i + MIN_EXP) / 255);

const LUMP_ENTITIES = 0;
const LUMP_TEXINFO = 6;
const LUMP_FACES = 7;
const LUMP_LIGHTING = 8;
const LUMP_LIGHTING_HDR = 53;
const FACE_SIZE = 56;
const TEXINFO_SIZE = 72;

/** Source's default light style patterns (CWorld::Precache), styles 0-12; 63 is "a". 'a' = off, 'm' = normal, 'z' = double. */
export const DEFAULT_PATTERNS: Record<number, string> = {
  0: "m",
  1: "mmnmmommommnonmmonqnmmo",
  2: "abcdefghijklmnopqrstuvwxyzyxwvutsrqponmlkjihgfedcba",
  3: "mmmmmaaaaammmmmaaaaaabcdefgabcdefg",
  4: "mamamamamama",
  5: "jklmnopqrstuvwxyzyxwvutsrqponmlkj",
  6: "nmonqnmomnmomomno",
  7: "mmmaaaabcdefgmmmmaaaammmaamm",
  8: "mmmaaammmaaammmabcdefaaaammmmabcdefmmmaaaa",
  9: "aaaaaaaazzzzzzzz",
  10: "mmamammmmammamamaaamammma",
  11: "abcdefghijklmnopqrrqponmlkjihgfedcba",
  12: "mmnnmmnnnmmnn",
  63: "a",
};

/** Time-averaged brightness of a pattern string, 1 = 'm' (the engine's d_lightstylevalue / 264). */
export function patternValue(pattern: string): number {
  const p = pattern.toLowerCase().replace(/[^a-z]/g, "");
  if (!p) return 256 / 264; // an unset style: the engine uses 256
  let sum = 0;
  for (let i = 0; i < p.length; i++) sum += (p.charCodeAt(i) - 97) * 22;
  return sum / p.length / 264;
}

export type Entity = Record<string, string> & { outputs?: [string, string][] };

/**
 * Brightness of every light style the map's light entities set at spawn (CLight::Spawn): a named light's style is off
 * with spawnflag 1, else its `pattern` (or its `defaultstyle` preset's pattern), else 'm'. Styles 1-12 are the world's
 * presets. Styles nobody sets are left out (the engine draws them at 256/264; see `styleValue`).
 */
export function lightStyleValues(ents: Entity[]): Map<number, number> {
  const values = new Map<number, number>();
  for (const [s, p] of Object.entries(DEFAULT_PATTERNS)) values.set(+s, patternValue(p));
  // Named switchable lights, by lowercase targetname.
  const byName = new Map<string, { style: number; on: boolean; pattern: string }[]>();
  for (const e of ents) {
    if (!/^light(_spot)?$/i.test(e.classname ?? "")) continue;
    const style = parseInt(e.style ?? "0", 10);
    if (!(style >= 32 && style < 64) || !e.targetname) continue;
    const preset = parseInt(e.defaultstyle ?? "0", 10);
    const pattern = e.pattern || (preset > 0 ? (DEFAULT_PATTERNS[preset] ?? "m") : "m");
    const light = { style, on: !((parseInt(e.spawnflags ?? "0", 10) || 0) & 1), pattern };
    const name = e.targetname.toLowerCase();
    byName.set(name, [...(byName.get(name) ?? []), light]);
  }
  // Spawn-time switching straight from a logic_auto (not through relays), in delay order.
  const spawnOutputs = /^on(mapspawn|newgame|multinewmap|multinewround)$/i;
  const sends: { target: string; input: string; delay: number }[] = [];
  for (const e of ents) {
    if ((e.classname ?? "").toLowerCase() !== "logic_auto") continue;
    for (const [key, value] of e.outputs ?? []) {
      if (!spawnOutputs.test(key)) continue;
      const f = value.split(value.includes("\x1b") ? "\x1b" : ",").map((s) => s.trim());
      if (/^(turnon|turnoff|toggle)$/i.test(f[1] ?? "")) sends.push({ target: (f[0] ?? "").toLowerCase(), input: f[1].toLowerCase(), delay: parseFloat(f[3] ?? "0") || 0 });
    }
  }
  sends.sort((a, b) => a.delay - b.delay);
  for (const s of sends) {
    const prefix = s.target.endsWith("*") ? s.target.slice(0, -1) : null;
    for (const [name, lights] of byName) {
      if (prefix === null ? name !== s.target : !name.startsWith(prefix)) continue;
      for (const l of lights) l.on = s.input === "turnon" ? true : s.input === "turnoff" ? false : !l.on;
    }
  }
  for (const lights of byName.values()) for (const l of lights) values.set(l.style, l.on ? patternValue(l.pattern) : 0);
  return values;
}

/** Brightness of `style` (1 = normal); styles no entity sets are drawn at the engine's default 256/264. */
export function styleValue(values: Map<number, number>, style: number): number {
  return values.get(style) ?? 256 / 264;
}

/** Entity lump text -> entities, keeping every output (keys repeat: OnMapSpawn, OnTrigger, ...). */
export function parseEntityLump(text: string): Entity[] {
  const out: Entity[] = [];
  for (const block of text.matchAll(/\{([^{}]*)\}/g)) {
    const e: Entity = {};
    const outputs: [string, string][] = [];
    for (const kv of block[1].matchAll(/"([^"]*)"\s*"([^"]*)"/g)) {
      if (/^on/i.test(kv[1])) outputs.push([kv[1], kv[2]]);
      if (!(kv[1] in e)) e[kv[1]] = kv[2];
    }
    e.outputs = outputs;
    out.push(e);
  }
  return out;
}

interface Item {
  face: number;
  w: number;
  h: number;
  /** First style-0 sample (index into the lighting samples). */
  first: number;
  styles: number[];
  bumped: boolean;
}

/** lightmap.rs `pack`: shelf packing of items sorted by height; top-left (incl. border) per item and used height. */
function pack(items: Item[], width: number): { pos: [number, number][]; height: number } {
  const pos: [number, number][] = [];
  let x = WHITE_BLOCK;
  let y = 0;
  let shelf = WHITE_BLOCK;
  for (const it of items) {
    const bw = it.w + 2 * BORDER;
    const bh = it.h + 2 * BORDER;
    if (x + bw > width) {
      y += shelf;
      x = 0;
      shelf = 0;
    }
    pos.push([x, y]);
    x += bw;
    shelf = Math.max(shelf, bh);
  }
  return { pos, height: y + shelf };
}

function nextPow2(v: number): number {
  let p = 1;
  while (p < v) p *= 2;
  return p;
}

/**
 * lightmap.rs's encoding of linear light `v` (1 = full) as a byte. HDR atlases: `srgb(v * scale)`, done as a search over
 * the 255 linear thresholds where the byte steps up (a million luxels on the bigger maps). LDR atlases: Source's
 * `lineartolightmap` table, `0.5 * v^(1/2.2)` with v quantized to 1/1024.
 */
function encoder(lm: Lightmap): (v: number) => number {
  if (!lm.hdr) return (v) => Math.min(255, Math.round(Math.pow(Math.min(4091, Math.max(0, Math.round(v * 1024))) / 1024, 1 / LDR_GAMMA) * 127.5));
  const steps = new Float64Array(256);
  for (let k = 1; k < 256; k++) {
    const s = (k - 0.5) / 255;
    steps[k] = (s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)) / lm.scale;
  }
  return (v) => {
    let lo = 0;
    for (let bit = 128; bit; bit >>= 1) if (lo + bit < 256 && v >= steps[lo + bit]) lo += bit;
    return lo;
  };
}

export interface LightStyleResult {
  /** Faces whose block was rewritten with their extra styles. */
  faces: number;
  /** Faces with any style besides 0. */
  styledFaces: number;
  /** Why nothing was applied (no extra styles, compressed lumps, layout mismatch, ...). */
  skipped?: string;
}

/**
 * Adds every face's switchable-style pages (at their spawn values) to the core's style-0 atlas `lm`, in place. `bsp`
 * is the map file the core built the atlas from.
 */
export function applyLightStyles(lm: Lightmap, bsp: Uint8Array): LightStyleResult {
  const none = (skipped: string, styledFaces = 0): LightStyleResult => ({ faces: 0, styledFaces, skipped });
  if (bsp.length < 1036) return none("not a BSP");
  const dv = new DataView(bsp.buffer, bsp.byteOffset, bsp.byteLength);
  if (dv.getUint32(0, true) !== 0x50534256) return none("not a VBSP"); // "VBSP"
  const lump = (i: number) => {
    const o = 8 + i * 16;
    const ofs = dv.getInt32(o, true);
    const len = dv.getInt32(o + 4, true);
    const compressed = dv.getInt32(o + 12, true) !== 0 || (len >= 4 && ofs + 4 <= bsp.length && dv.getUint32(ofs, true) === 0x414d5a4c); // "LZMA"
    return { ofs, len: ofs >= 0 && ofs + len <= bsp.length ? len : 0, compressed };
  };
  const faces = lump(LUMP_FACES);
  const texinfo = lump(LUMP_TEXINFO);
  // The lump lightmap.rs built the atlas from.
  const lighting = lump(lm.hdr ? LUMP_LIGHTING_HDR : LUMP_LIGHTING);
  if (faces.compressed || texinfo.compressed || lighting.compressed) return none("compressed lumps");
  const faceCount = Math.floor(faces.len / FACE_SIZE);
  const texCount = Math.floor(texinfo.len / TEXINFO_SIZE);
  const samples = Math.floor(lighting.len / 4);

  // lightmap.rs `build`: the faces that get a block, in the same order.
  const items: Item[] = [];
  let styledFaces = 0;
  for (let fi = 0; fi < faceCount; fi++) {
    const o = faces.ofs + fi * FACE_SIZE;
    const ti = dv.getInt16(o + 10, true);
    const t = Math.max(ti, 0);
    if (t >= texCount) continue;
    const flags = dv.getInt32(texinfo.ofs + t * TEXINFO_SIZE + 64, true);
    const lightOffset = dv.getInt32(o + 20, true);
    const styles = [0, 1, 2, 3].map((k) => bsp[o + 16 + k]);
    if (ti < 0 || flags & SURF_NOLIGHT || lightOffset < 0 || styles[0] === 255) continue;
    const w = dv.getInt32(o + 36, true) + 1;
    const h = dv.getInt32(o + 40, true) + 1;
    if (w <= 0 || h <= 0 || w > 1024 || h > 1024) continue;
    const first = Math.floor(lightOffset / 4);
    if (first + w * h > samples) continue;
    const n = styles.indexOf(255);
    const used = styles.slice(0, n < 0 ? 4 : n);
    if (used.length > 1) styledFaces++;
    items.push({ face: fi, w, h, first, styles: used, bumped: (flags & SURF_BUMPLIGHT) !== 0 });
  }
  if (styledFaces === 0) return none("no switchable light styles");

  const lightBase = lighting.ofs;
  // lightmap.rs `is_unlit`: the core drew the map fullbright (no atlas blocks), so there's nothing to add to.
  const visible = items.some((it) => {
    for (let i = it.first; i < it.first + it.w * it.h; i++) {
      const p = lighting.ofs + i * 4;
      if (Math.max(bsp[p], bsp[p + 1], bsp[p + 2]) * 2 ** ((bsp[p + 3] << 24) >> 24) >= 1) return true;
    }
    return false;
  });
  if (!visible) return none("fullbright map", styledFaces);

  // Stable sort, like Rust's sort_by: taller first, then wider.
  const order = items.map((it, i) => ({ it, i })).sort((a, b) => b.it.h - a.it.h || b.it.w - a.it.w || a.i - b.i).map((x) => x.it);
  const area = order.reduce((s, it) => s + (it.w + 2 * BORDER) * (it.h + 2 * BORDER), 0) + 64;
  let width = Math.min(4096, Math.max(256, nextPow2(Math.floor(Math.sqrt(area * 1.15)))));
  let packed = pack(order, width);
  while (!(packed.height <= Math.max(width, 4096) || width >= 16384)) {
    width *= 2;
    packed = pack(order, width);
  }
  const height = Math.ceil(Math.max(packed.height, WHITE_BLOCK) / 4) * 4;
  if (width !== lm.width || height !== lm.height) return none(`atlas layout differs (${width}x${height} vs ${lm.width}x${lm.height})`, styledFaces);

  const values = lightStyleValues(parseEntityLump(entityText(bsp, lump(LUMP_ENTITIES))));
  const encode = encoder(lm);
  const work: { it: Item; x: number; y: number; weights: number[] }[] = [];
  for (let k = 0; k < order.length; k++) {
    const it = order[k];
    if (it.styles.length < 2) continue;
    const weights = it.styles.map((s) => styleValue(values, s));
    // Unchanged: only style 0 at full value (every extra style off), or a page past the end of the lump.
    const pages = it.bumped ? 4 : 1;
    const n = it.w * it.h;
    if (it.styles.some((_, i) => it.first + (i * pages + 1) * n > samples)) continue;
    if (weights[0] === 1 && weights.slice(1).every((v) => v === 0)) continue;
    work.push({ it, x: packed.pos[k][0], y: packed.pos[k][1], weights });
  }

  // Check every block we'd rewrite holds this face's style-0 light (±1 for float rounding) before touching anything.
  const data = lm.data;
  const style0 = new Int16Array(EXP_UNIT.length * 256).fill(-1);
  const encode0 = (c: number, e: number) => {
    const k = (e << 8) | c;
    return style0[k] >= 0 ? style0[k] : (style0[k] = encode(c * EXP_UNIT[e]));
  };
  for (const { it, x, y } of work) {
    for (let j = 0; j < it.h; j++) {
      for (let i = 0; i < it.w; i++) {
        const p = lighting.ofs + (it.first + j * it.w + i) * 4;
        const e = Math.min(MAX_EXP, Math.max(MIN_EXP, (bsp[p + 3] << 24) >> 24)) - MIN_EXP;
        const o = ((y + BORDER + j) * lm.width + x + BORDER + i) * 4;
        for (let c = 0; c < 3; c++) {
          if (Math.abs(data[o + c] - encode0(bsp[p + c], e)) > 1) return none(`atlas block of face ${it.face} doesn't match its style-0 light`, styledFaces);
        }
      }
    }
  }

  for (const { it, x, y, weights } of work) {
    const pages = it.bumped ? 4 : 1;
    const n = it.w * it.h;
    const lit = new Float64Array(n * 3);
    for (let s = 0; s < weights.length; s++) {
      const v = weights[s];
      if (v === 0) continue;
      let p = lightBase + (it.first + s * pages * n) * 4;
      for (let i = 0; i < n * 3; i += 3, p += 4) {
        const m = v * EXP_UNIT[Math.min(MAX_EXP, Math.max(MIN_EXP, (bsp[p + 3] << 24) >> 24)) - MIN_EXP];
        lit[i] += bsp[p] * m;
        lit[i + 1] += bsp[p + 1] * m;
        lit[i + 2] += bsp[p + 2] * m;
      }
    }
    const out = new Uint8Array(n * 3);
    for (let i = 0; i < n * 3; i++) out[i] = encode(lit[i]);
    for (let j = 0; j < it.h + 2 * BORDER; j++) {
      const sy = Math.min(it.h - 1, Math.max(0, j - BORDER));
      for (let i = 0; i < it.w + 2 * BORDER; i++) {
        const sx = Math.min(it.w - 1, Math.max(0, i - BORDER));
        const s = (sy * it.w + sx) * 3;
        const o = ((y + j) * lm.width + x + i) * 4;
        data[o] = out[s];
        data[o + 1] = out[s + 1];
        data[o + 2] = out[s + 2];
        data[o + 3] = 255;
      }
    }
  }
  return { faces: work.length, styledFaces };
}

function entityText(bsp: Uint8Array, l: { ofs: number; len: number; compressed: boolean }): string {
  if (l.compressed || l.len <= 0) return "";
  let end = l.ofs + l.len;
  while (end > l.ofs && bsp[end - 1] === 0) end--;
  let s = "";
  for (let i = l.ofs; i < end; i += 0x8000) s += String.fromCharCode(...bsp.subarray(i, Math.min(end, i + 0x8000)));
  return s;
}
