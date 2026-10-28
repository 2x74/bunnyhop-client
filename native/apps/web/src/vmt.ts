// Lenient VMT (KeyValues) parsing on the host, for the few shaders the renderer draws itself (imposter.ts). The core
// resolves every other material (crates/core/src/materials.rs); this mirrors its tokenizer: quoted or bare tokens,
// `//` comments, braces, case-insensitive keys, `patch` materials (include + replace / insert).

/**
 * Shaders the core resolves as missing (no `$basetexture` by design) that the renderer draws itself (imposter.ts). Not
 * counted as missing materials (content status, thumbnails, the load log).
 */
export const CLIENT_DRAWN_SHADERS: ReadonlySet<string> = new Set(["windowimposter", "aftershock"]);

export type KvValue = string | KvPair[];
export type KvPair = [string, KvValue];

export interface Vmt {
  /** Shader name, lowercase (`windowimposter`, `aftershock`, ...). */
  shader: string;
  /** Top-level `$params`, lowercase keys, the last value wins. */
  params: Record<string, string>;
  /** The `Proxies` block, if any (proxy names lowercase, their keys lowercase). */
  proxies: { name: string; params: Record<string, string> }[];
}

function tokenize(src: string): (string | "{" | "}")[] {
  const out: (string | "{" | "}")[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "{" || c === "}") {
      out.push(c);
      i++;
    } else if (c === '"') {
      const end = src.indexOf('"', i + 1);
      const stop = end < 0 ? src.length : end;
      out.push(src.slice(i + 1, stop));
      i = stop + 1;
    } else if (/\s/.test(c)) {
      i++;
    } else {
      let j = i;
      while (j < src.length && !/[\s{}"]/.test(src[j])) j++;
      out.push(src.slice(i, j));
      i = j;
    }
  }
  return out;
}

/** Brace-block bodies as key/value pairs; tokens that don't fit (a key at the end, a stray brace) are dropped. */
function parseBody(toks: (string | "{" | "}")[], at: { i: number }): KvPair[] {
  const out: KvPair[] = [];
  while (at.i < toks.length) {
    const t = toks[at.i++];
    if (t === "}") break;
    if (t === "{") {
      parseBody(toks, at); // an unnamed block: skip it
      continue;
    }
    const v = toks[at.i];
    if (v === undefined) break;
    if (v === "{") {
      at.i++;
      out.push([t.toLowerCase(), parseBody(toks, at)]);
    } else if (v === "}") {
      continue; // a key with no value before the block ends
    } else {
      at.i++;
      out.push([t.toLowerCase(), v]);
    }
  }
  return out;
}

/** The shader name and its block, or null if the text isn't a VMT. */
export function parseKeyValues(text: string): { shader: string; body: KvPair[] } | null {
  const toks = tokenize(text.replace(/^﻿/, ""));
  if (toks.length < 2 || typeof toks[0] !== "string" || toks[0] === "{" || toks[1] !== "{") return null;
  const at = { i: 2 };
  return { shader: toks[0].toLowerCase(), body: parseBody(toks, at) };
}

function flatten(body: KvPair[], vmt: Vmt): void {
  for (const [k, v] of body) {
    if (typeof v === "string") vmt.params[k] = v;
    else if (k === "proxies") {
      for (const [name, p] of v) {
        if (typeof p === "string") continue;
        const params: Record<string, string> = {};
        for (const [pk, pv] of p) if (typeof pv === "string") params[pk] = pv;
        vmt.proxies.push({ name, params });
      }
    }
  }
}

/** `materials/<name>.vmt` for a material name (texdata or `$include` value). */
export function vmtPath(name: string): string {
  let n = name.toLowerCase().replace(/\\/g, "/").replace(/^\/+/, "");
  if (n.startsWith("materials/")) n = n.slice("materials/".length);
  if (!n.endsWith(".vmt")) n += ".vmt";
  return `materials/${n}`;
}

/** `materials/<name>.vtf` for a texture parameter value (`cubemaps/foo.hdr` -> `materials/cubemaps/foo.hdr.vtf`). */
export function vtfPath(name: string): string {
  let n = name.trim().toLowerCase().replace(/\\/g, "/").replace(/^\/+/, "");
  if (n.startsWith("materials/")) n = n.slice("materials/".length);
  if (n.endsWith(".vtf")) n = n.slice(0, -4);
  return `materials/${n}.vtf`;
}

/**
 * Parses a VMT, following `patch` includes through `read` (path -> bytes, null if absent). Null when the file or an
 * include is missing or unparsable.
 */
export function loadVmt(path: string, read: (path: string) => Uint8Array | null, depth = 0): Vmt | null {
  if (depth > 4) return null;
  const bytes = read(path);
  if (!bytes) return null;
  const kv = parseKeyValues(new TextDecoder("latin1").decode(bytes));
  if (!kv) return null;
  if (kv.shader === "patch") {
    const include = kv.body.find(([k, v]) => k === "include" && typeof v === "string")?.[1] as string | undefined;
    if (!include) return null;
    const base = loadVmt(vmtPath(include), read, depth + 1);
    if (!base) return null;
    for (const [k, v] of kv.body) if ((k === "replace" || k === "insert") && typeof v !== "string") flatten(v, base);
    return base;
  }
  const vmt: Vmt = { shader: kv.shader, params: {}, proxies: [] };
  flatten(kv.body, vmt);
  return vmt;
}

export function vmtFloat(vmt: Vmt, key: string): number | undefined {
  const v = vmt.params[key];
  if (v === undefined) return undefined;
  const n = parseFloat(v.trim());
  return Number.isFinite(n) ? n : undefined;
}

/** `[r g b]` (0..1) or `{r g b}` (0..255); a single number is grey. */
export function vmtColor(vmt: Vmt, key: string): [number, number, number] | undefined {
  const v = vmt.params[key]?.trim();
  if (!v) return undefined;
  const scale = v.startsWith("{") ? 1 / 255 : 1;
  const nums = v
    .replace(/[[\]{}]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
    .filter(Number.isFinite);
  if (nums.length >= 3) return [nums[0] * scale, nums[1] * scale, nums[2] * scale];
  if (nums.length === 1) return [nums[0] * scale, nums[0] * scale, nums[0] * scale];
  return undefined;
}

export function vmtFlag(vmt: Vmt, key: string): boolean {
  const n = vmtFloat(vmt, key);
  return n !== undefined && n !== 0;
}
