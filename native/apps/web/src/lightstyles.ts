// Switchable light styles on top of the core's lightmap atlas. DOM-free (render.ts, tools/verify/render-check.ts).
//
// Source faces carry up to four light styles, each with its own lightmap page: style 0 is the normal static light,
// named `light` / `light_spot` entities get their own switchable style (32+, assigned by VRAD) and Appearance presets
// (flicker, pulse, ...) use styles 1-12. The engine adds the pages, each scaled by its style's current value. The
// core's atlas (crates/core/src/lightmap.rs) holds style 0 only, so anything lit by a named light rendered dark:
// bhop_cutekittenz lights everything after its start room that way.
//
// This re-adds the other pages in the client: it repeats lightmap.rs's face selection and shelf packing to find each
// face's block in the atlas, checks that the style-0 texels there match its own encoding (any mismatch, e.g. after a
// core change to the packing, leaves the atlas as it was), then rewrites the blocks of faces that have extra styles
// with the sum of their pages. At load the styles take their spawn values: a named light's spawn state (spawnflag 1
// "Initially dark", plus TurnOn / TurnOff / Toggle sent straight from a logic_auto at spawn), and animated patterns at
// their time-average. After that, the styles of named lights that the map's I/O can reach follow the core's light
// states (`effect_states`: TurnOn / TurnOff / Toggle / Use from triggers, buttons, timers, relays), so a section
// that a trigger lights is dark until the player reaches it and lit after, as in CS:S. The states come from the core
// that drives the view, so restarts, replays and scrubbing follow too. Patterns stay at their time-average.

import type { Lightmap } from "./core";

// lightmap.rs constants.
const LDR_GAMMA = 2.2;
const SURF_NOLIGHT = 0x400;
const SURF_BUMPLIGHT = 0x800;
const BORDER = 1;
const WHITE_BLOCK = 4;
/** Texels between two changed blocks on a shelf that are cheaper to upload again than to split the upload over. */
const MERGE_GAP = 64;
const MIN_EXP = -32;
const MAX_EXP = 16;
const EXP_UNIT = Array.from({ length: MAX_EXP - MIN_EXP + 1 }, (_, i) => 2 ** (i + MIN_EXP) / 255);

const LUMP_ENTITIES = 0;
const LUMP_TEXINFO = 6;
const LUMP_FACES = 7;
const LUMP_LIGHTING = 8;
const LUMP_LIGHTING_HDR = 53;
const LUMP_FACES_HDR = 58;
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
    const light = { style, on: !((parseInt(e.spawnflags ?? "0", 10) || 0) & 1), pattern: lightPattern(e) };
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

/** A named light's pattern while on: its `pattern`, else its `defaultstyle` preset's, else 'm' (CLight::Spawn). */
function lightPattern(e: Readonly<Record<string, string>>): string {
  const preset = parseInt(e.defaultstyle ?? "0", 10);
  return e.pattern || (preset > 0 ? (DEFAULT_PATTERNS[preset] ?? "m") : "m");
}

/** A switchable style's lights (entity indices: the core's `effect_states` keys) and its value while they're on. */
export interface SwitchableStyle {
  ids: number[];
  on: number;
}

/**
 * The named lights' styles (32+) that the map's I/O can switch: some output (of `wired`, the entity lump with outputs)
 * names one of their lights, or a `name*` wildcard covers it. The other styles keep their spawn value. `ents` gives
 * the entity indices: the core's entity order (Core.entities).
 */
export function switchableStyles(ents: readonly Record<string, string>[], wired: Entity[]): Map<number, SwitchableStyle> {
  const names = new Set<string>();
  const prefixes: string[] = [];
  for (const e of wired) {
    for (const [, value] of e.outputs ?? []) {
      const target = (value.split(value.includes("\x1b") ? "\x1b" : ",")[0] ?? "").trim().toLowerCase();
      if (target.endsWith("*")) prefixes.push(target.slice(0, -1));
      else if (target) names.add(target);
    }
  }
  const styles = new Map<number, SwitchableStyle>();
  ents.forEach((e, id) => {
    if (!/^light(_spot)?$/i.test(e.classname ?? "") || !e.targetname) return;
    const style = parseInt(e.style ?? "0", 10);
    const name = e.targetname.toLowerCase();
    if (!(style >= 32 && style < 64) || (!names.has(name) && !prefixes.some((p) => name.startsWith(p)))) return;
    const s = styles.get(style) ?? { ids: [], on: patternValue(lightPattern(e)) };
    s.ids.push(id);
    styles.set(style, s);
  });
  return styles;
}

/**
 * Sets each switchable style in `values` from the core's light states (entity index -> on): lit while any of its
 * lights is (they share a targetname, so they switch together). A style none of whose lights is reported keeps its
 * value. Returns the styles that changed.
 */
export function followLightStates(styles: Map<number, SwitchableStyle>, states: ReadonlyMap<number, boolean>, values: Map<number, number>): number[] {
  const changed: number[] = [];
  for (const [style, s] of styles) {
    let seen = false;
    let on = false;
    for (const id of s.ids) {
      const state = states.get(id);
      if (state === undefined) continue;
      seen = true;
      if (state) {
        on = true;
        break;
      }
    }
    const v = on ? s.on : 0;
    if (seen && values.get(style) !== v) {
      values.set(style, v);
      changed.push(style);
    }
  }
  return changed;
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

/** A face's block in the atlas; `rgbe`: its pages (styles in order), kept when map I/O can switch one. */
interface Block {
  it: Item;
  x: number;
  y: number;
  rgbe: Uint8Array | null;
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
  if (!lm.hdr) {
    const table = Uint8Array.from({ length: 4092 }, (_, q) => Math.min(255, Math.round(Math.pow(q / 1024, 1 / LDR_GAMMA) * 127.5)));
    return (v) => table[Math.min(4091, Math.max(0, Math.round(v * 1024)))];
  }
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

/** The atlas with its light styles, kept in step with the core's light states. */
export interface LightStyleAtlas {
  /** Faces whose styles some map I/O can switch. */
  readonly switchable: number;
  /**
   * Re-adds the pages of the styles whose lights the core turned on or off since the last call (`states`: the core's
   * `effect_states`). Returns the atlas rectangles that changed (upload those again) and the styles that did.
   */
  update(states: ReadonlyMap<number, boolean> | undefined): { rects: AtlasRect[]; styles: number[] };
  /**
   * How far `style` is above its spawn value now (0 when it is at or below it): what model lighting adds of that
   * style's lights (core `set_light_style`). Models keep their spawn light otherwise, as before.
   */
  above(style: number): number;
  /** How far `style` is above its spawn value while its lights are on: what models in reach of it wait for. */
  full(style: number): number;
  /** The switchable styles. */
  readonly styles: number[];
}

/** Texels `x`..`x + w`, `y`..`y + h` of the atlas. */
export interface AtlasRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Adds every face's light-style pages (at their spawn values) to the core's style-0 atlas `lm`, in place. `bsp` is the
 * map file the core built the atlas from.
 */
export function applyLightStyles(lm: Lightmap, bsp: Uint8Array): LightStyleResult {
  return lightStyleAtlas(lm, bsp).result;
}

/**
 * `applyLightStyles`, plus an `atlas` that follows the core's light states afterwards when the map can switch any of
 * its styles. `ents`: the core's entities (Core.entities), whose indices the states use; the entity lump's order
 * without them.
 */
export function lightStyleAtlas(lm: Lightmap, bsp: Uint8Array, ents?: readonly Record<string, string>[]): { result: LightStyleResult; atlas: LightStyleAtlas | null } {
  const none = (skipped: string, styledFaces = 0) => ({ result: { faces: 0, styledFaces, skipped }, atlas: null });
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
  // lightmap.rs: the HDR atlas uses the HDR face lump's offsets and styles when it has the same faces.
  const ldrFaces = lump(LUMP_FACES), hdrFaces = lump(LUMP_FACES_HDR);
  const faces = lm.hdr && hdrFaces.len > 0 && hdrFaces.len === ldrFaces.len ? hdrFaces : ldrFaces;
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

  const wired = parseEntityLump(entityText(bsp, lump(LUMP_ENTITIES)));
  const values = lightStyleValues(wired);
  const switchable = switchableStyles(ents ?? wired, wired);
  const encode = encoder(lm);
  const work: Block[] = [];
  for (let k = 0; k < order.length; k++) {
    const it = order[k];
    if (it.styles.length < 2) continue;
    // A page past the end of the lump: left as the core drew it.
    const pages = it.bumped ? 4 : 1;
    const n = it.w * it.h;
    if (it.styles.some((_, i) => it.first + (i * pages + 1) * n > samples)) continue;
    const live = it.styles.some((s) => switchable.has(s));
    // Unchanged for good: only style 0 at full value, every extra style off and none switchable.
    if (!live && styleValue(values, it.styles[0]) === 1 && it.styles.slice(1).every((s) => styleValue(values, s) === 0)) continue;
    // Faces that may change keep their own copy of their pages (RGBE), the BSP isn't kept.
    let rgbe: Uint8Array | null = null;
    if (live) {
      rgbe = new Uint8Array(it.styles.length * n * 4);
      for (let s = 0; s < it.styles.length; s++) {
        const p = lighting.ofs + (it.first + s * pages * n) * 4;
        rgbe.set(bsp.subarray(p, p + n * 4), s * n * 4);
      }
    }
    work.push({ it, x: packed.pos[k][0], y: packed.pos[k][1], rgbe });
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

  /** Writes block `b` with each style's page scaled by its current value; `src`/`base`: where its pages are. */
  // Scratch for one block (faces are at most 1024 x 1024 luxels, but almost all are tiny).
  let lit = new Float64Array(0);
  let out = new Uint8Array(0);
  const write = ({ it, x, y }: Block, src: Uint8Array, base: number, pageStride: number) => {
    const n = it.w * it.h;
    if (lit.length < n * 3) {
      lit = new Float64Array(n * 3);
      out = new Uint8Array(n * 3);
    } else lit.fill(0, 0, n * 3);
    for (let s = 0; s < it.styles.length; s++) {
      const v = styleValue(values, it.styles[s]);
      if (v === 0) continue;
      let p = base + s * pageStride;
      for (let i = 0; i < n * 3; i += 3, p += 4) {
        const m = v * EXP_UNIT[Math.min(MAX_EXP, Math.max(MIN_EXP, (src[p + 3] << 24) >> 24)) - MIN_EXP];
        lit[i] += src[p] * m;
        lit[i + 1] += src[p + 1] * m;
        lit[i + 2] += src[p + 2] * m;
      }
    }
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
  };
  const writeLive = (b: Block) => write(b, b.rgbe!, 0, b.it.w * b.it.h * 4);
  for (const b of work) {
    if (b.rgbe) writeLive(b);
    else write(b, bsp, lighting.ofs + b.it.first * 4, (b.it.bumped ? 4 : 1) * b.it.w * b.it.h * 4);
  }
  const result = { faces: work.length, styledFaces };
  const live = work.filter((b) => b.rgbe);
  if (!live.length) return { result, atlas: null };
  const byStyle = new Map<number, Block[]>();
  for (const b of live) for (const s of b.it.styles) if (switchable.has(s)) byStyle.set(s, [...(byStyle.get(s) ?? []), b]);
  const spawn = new Map([...switchable.keys()].map((s) => [s, styleValue(values, s)]));
  return {
    result,
    atlas: {
      switchable: live.length,
      above: (style) => Math.max(0, styleValue(values, style) - (spawn.get(style) ?? styleValue(values, style))),
      full: (style) => Math.max(0, (switchable.get(style)?.on ?? 0) - (spawn.get(style) ?? 0)),
      styles: [...switchable.keys()],
      update(states) {
        if (!states) return { rects: [], styles: [] };
        const changed = followLightStates(switchable, states, values);
        if (!changed.length) return { rects: [], styles: [] };
        const blocks = new Set<Block>();
        for (const s of changed) for (const b of byStyle.get(s) ?? []) blocks.add(b);
        // Upload rectangles: neighbouring blocks on one shelf (they share its top) go up together, so a style's
        // scattered faces cost a few hundred small uploads instead of the whole atlas.
        const rects: AtlasRect[] = [];
        for (const b of [...blocks].sort((p, q) => p.y - q.y || p.x - q.x)) {
          writeLive(b);
          const w = b.it.w + 2 * BORDER;
          const h = b.it.h + 2 * BORDER;
          const r = rects.at(-1);
          if (r && r.y === b.y && b.x - (r.x + r.w) <= MERGE_GAP) {
            r.w = b.x + w - r.x;
            r.h = Math.max(r.h, h);
          } else rects.push({ x: b.x, y: b.y, w, h });
        }
        return { rects, styles: changed };
      },
    },
  };
}

function entityText(bsp: Uint8Array, l: { ofs: number; len: number; compressed: boolean }): string {
  if (l.compressed || l.len <= 0) return "";
  let end = l.ofs + l.len;
  while (end > l.ofs && bsp[end - 1] === 0) end--;
  let s = "";
  for (let i = l.ofs; i < end; i += 0x8000) s += String.fromCharCode(...bsp.subarray(i, Math.min(end, i + 0x8000)));
  return s;
}
