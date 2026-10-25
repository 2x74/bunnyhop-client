// Settings as something you can carry: a short code to paste in chat, or a .json file (Settings → Export / Import; the
// dialog is settings-transfer.ts). Same idea as Aimperion's settings file. DOM-free, so it's tested under vitest
// (apps/api/test/settings-io.test.ts).
//
// WHAT'S IN IT. The whole pref store (ui/settings.ts `Prefs`: mouse, FOV, crosshair, HUD layout, keys overlay, binds,
// ghosts, name tags, graphics, player model, viewmodel, audio), derived from DEFAULT_PREFS at export time, so a setting
// added later is exported the moment it exists. Not in it: the bunny colourway (an account cosmetic, saved with your
// profile) and anything account-related.
//
// TWO SPELLINGS OF ONE DOCUMENT.
//   file:  pretty JSON  { "format": "bunnyhop.lol/settings", "version": 1, "exported": ..., "settings": { ... } }
//   code:  "bhs1." + base64url(deflate-raw(the same JSON, minified))   (~1.5 KB: fits a chat message)
// Import takes either (and a JSON block fenced in ``` from a chat message, and a bare prefs object as stored in
// localStorage).
//
// EVERY VALUE THAT ARRIVES IS UNTRUSTED. Import walks DEFAULT_PREFS and adopts a value only where the default has a
// leaf of the same type that passes its rule (enums, colours, key codes; numbers are clamped to the range their control
// allows). Anything else is reported, not applied, and keys this build doesn't know are listed as skipped. Old shapes go
// through the same migration as stored prefs first. Keys missing from the document keep their current value.

import { DEFAULT_PREFS, migratePrefs, type Prefs } from "./settings";
import { PAINT_COLORS } from "../paint/prefs";
import { TRIGGER_OPACITY, TRIGGER_STYLES, TRIGGER_THICKNESS } from "../triggers/volumes";
import { COLOR_BLIND_MODES } from "../palette";
import { HUD_SCALE } from "../hud/layout";

/** What this document is; checked on import so pasting the wrong thing fails with a sentence. */
export const FORMAT = "bunnyhop.lol/settings";
/** The envelope's version (changes if the shape AROUND the settings changes; the settings migrate on their own). */
export const FORMAT_VERSION = 1;
/** Code prefix: "bhs" = bunnyhop settings, "1" = deflate-raw + base64url of the JSON document. */
export const CODE_PREFIX = "bhs1.";
/** Fallback where CompressionStream is missing: base64url of the plain JSON. */
export const CODE_PREFIX_RAW = "bhs0.";

export interface SettingsDoc {
  format: typeof FORMAT;
  version: number;
  exported: string;
  /** App version that wrote it (informational). */
  app?: string;
  settings: Partial<Prefs> & Record<string, unknown>;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

export function buildSettingsDoc(p: Prefs, o: { at?: number; app?: string } = {}): SettingsDoc {
  // Derived from the defaults' keys (see the header): only what this build knows, in the order it's declared.
  const settings = pick(DEFAULT_PREFS, p) as SettingsDoc["settings"];
  return { format: FORMAT, version: FORMAT_VERSION, exported: new Date(o.at ?? Date.now()).toISOString(), ...(o.app ? { app: o.app } : {}), settings };
}

function pick(base: unknown, v: unknown): unknown {
  if (base && typeof base === "object" && !Array.isArray(base)) {
    const out: Record<string, unknown> = {};
    const src = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    for (const k of Object.keys(base)) out[k] = pick((base as Record<string, unknown>)[k], k in src ? src[k] : (base as Record<string, unknown>)[k]);
    return out;
  }
  return clone(v === undefined ? base : v);
}

/** The file: two-space JSON (skim-readable). */
export function stringifySettings(doc: SettingsDoc): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export function settingsFilename(at = Date.now()): string {
  return `bunnyhop-settings-${new Date(at).toISOString().slice(0, 10)}.json`;
}

// ------------------------------------------------------------------------------------------------- code

const b64url = (bytes: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64url = (s: string): Uint8Array => {
  const b = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b + "=".repeat((4 - (b.length % 4)) % 4)), (c) => c.charCodeAt(0));
};
const hasStreams = () => typeof CompressionStream === "function" && typeof DecompressionStream === "function";

async function pipe(bytes: Uint8Array, t: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(t as unknown as ReadableWritablePair<Uint8Array, Uint8Array>));
  return new Uint8Array(await out.arrayBuffer());
}

/** The short code for chat: "bhs1.<base64url(deflate-raw(json))>". */
export async function encodeSettingsCode(doc: SettingsDoc): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(doc));
  if (!hasStreams()) return CODE_PREFIX_RAW + b64url(json);
  return CODE_PREFIX + b64url(await pipe(json, new CompressionStream("deflate-raw")));
}

// ------------------------------------------------------------------------------------------------- parse

export type ParseResult = { ok: true; doc: SettingsDoc } | { ok: false; error: string };

const TOP_KEYS = new Set(Object.keys(DEFAULT_PREFS));

/**
 * Reads a pasted code / JSON block or a file's text. Never throws: `error` is a sentence to show as-is.
 */
export async function parseSettingsText(text: string): Promise<ParseResult> {
  const raw = String(text ?? "").trim();
  if (!raw) return { ok: false, error: "Nothing to import yet. Paste a settings code or choose a file." };
  if (raw.length > 500_000) return { ok: false, error: "That's far too long to be a settings code." };
  // A code pasted with chat noise around it: take the token.
  const code = /\bbhs[01]\.[A-Za-z0-9_-]+/.exec(raw)?.[0];
  if (code) {
    try {
      const body = unb64url(code.slice(CODE_PREFIX.length));
      let bytes = body;
      if (code.startsWith(CODE_PREFIX)) {
        if (!hasStreams()) return { ok: false, error: "This browser can't read compressed settings codes. Use the .json file instead." };
        bytes = await pipe(body, new DecompressionStream("deflate-raw"));
      }
      return parseJson(new TextDecoder().decode(bytes));
    } catch {
      return { ok: false, error: "That settings code is damaged or cut off. Copy the whole code, starting with bhs1." };
    }
  }
  if (/\bbhl1\.[A-Za-z0-9_-]+/.test(raw)) return { ok: false, error: "That's a HUD layout code. Paste it under Settings → HUD → Share code instead." };
  // Tolerate a block a chat message fenced as code.
  return parseJson(raw.replace(/^```[a-z]*\s*/i, "").replace(/```$/, "").trim());
}

function parseJson(text: string): ParseResult {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, error: "That isn't a settings code or a settings file. Codes start with bhs1." };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { ok: false, error: "That isn't a settings file." };
  const d = doc as Record<string, unknown>;
  if (d.format === FORMAT) {
    if (typeof d.version === "number" && d.version > FORMAT_VERSION) return { ok: false, error: "Those settings come from a newer version of bunnyhop.lol. Reload the page to update, then import again." };
    if (!d.settings || typeof d.settings !== "object" || Array.isArray(d.settings)) return { ok: false, error: "That settings file has no settings in it." };
    return { ok: true, doc: d as unknown as SettingsDoc };
  }
  // A bare prefs object (what the game stores under "bunnyhop:settings"): recognised by its keys.
  const known = Object.keys(d).filter((k) => TOP_KEYS.has(k)).length;
  if (known >= 2 && d.format === undefined) return { ok: true, doc: { format: FORMAT, version: FORMAT_VERSION, exported: "", settings: d as SettingsDoc["settings"] } };
  return { ok: false, error: "That JSON isn't bunnyhop.lol settings." };
}

// ------------------------------------------------------------------------------------------------- validate + plan

type Rule = { range: [number, number]; int?: boolean } | { oneOf: readonly (string | number)[] } | { color: true } | { codes: true };

const color: Rule = { color: true };
const pct: Rule = { range: [0, 1] };
/** First matching rule wins. Paths are dotted ("hud.layout.speed.x"); `*` matches one segment. */
const RULES: [string, Rule][] = [
  ["paint.color", { oneOf: PAINT_COLORS.map(([color]) => color) }],
  ["paint.size", { oneOf: ["small", "medium", "large"] }],
  ["sensitivity", { range: [0.01, 100] }],
  ["verticalSensitivity", { range: [0.01, 100] }],
  ["dpi", { range: [50, 32000], int: true }],
  ["fov", { range: [75, 110] }],
  ["crosshair.style", { oneOf: ["cross", "cross-dot", "dot", "t", "circle", "none"] }],
  ["crosshair.color", color],
  ["crosshair.size", { range: [1, 20] }],
  ["crosshair.thickness", { range: [1, 6] }],
  ["crosshair.gap", { range: [0, 16] }],
  ["crosshair.alpha", { range: [0.2, 1] }],
  ["hud.scale", { range: [HUD_SCALE.min, HUD_SCALE.max] }],
  ["hud.layout.*.a", { range: [0, 8], int: true }],
  ["hud.layout.*.x", { range: [-1, 1] }],
  ["hud.layout.*.y", { range: [-1, 1] }],
  ["hud.layout.*.s", { range: [0.4, 3] }],
  ["hud.keys.style", { oneOf: ["classic", "keycaps", "minimal"] }],
  ["hud.keys.opacity", { range: [0.1, 1] }],
  ["hud.strafeTrainer.color", color],
  ["hud.strafeTrainer.style", { oneOf: ["classic", "detailed", "minimal"] }],
  ["hud.strafeTrainer.smoothing", { range: [1, 20], int: true }],
  ["hud.strafeTrainer.zone", { range: [2, 30] }],
  ["hud.strafeTrainer.height", { range: [0.5, 3] }],
  ["hud.strafeTrainer.dimBelow", { range: [0, 90] }],
  ["hud.keys.pressed", color],
  ["hud.keys.idle", color],
  ["hud.ssj.mode", { oneOf: ["sixth", "every", "everySixth"] }],
  ["hud.place", { oneOf: ["off", "place", "top"] }],
  ["volume", pct],
  ["audio.music", pct],
  ["audio.sfx", pct],
  ["audio.ui", pct],
  ["audio.ambience", pct],
  ["audio.musicMode", { oneOf: ["always", "menus", "off"] }],
  ["audio.announcer.lj", { oneOf: ["off", "perfect", "godlike", "holyshit"] }],
  ["audio.announcer.ljThreshold", { range: [200, 1000] }],
  ["colorBlind", { oneOf: COLOR_BLIND_MODES.map(([m]) => m) }],
  ["triggers.colors.*", color],
  ["triggers.style", { oneOf: TRIGGER_STYLES.map(([s]) => s) }],
  ["triggers.opacity", { range: TRIGGER_OPACITY }],
  ["triggers.thickness", { range: TRIGGER_THICKNESS }],
  ["ghost.opacity", { range: [0.15, 1] }],
  ["ghost.routeSource", { oneOf: ["auto", "pb", "wr", "custom"] }],
  ["ghost.routeMode", { oneOf: ["jumps", "path"] }],
  ["models.player", { oneOf: ["bunny", "runner", "css"] }],
  ["models.ghost", { oneOf: ["same", "bunny", "runner", "css"] }],
  ["models.team", { oneOf: ["ct", "t"] }],
  ["models.ct", { oneOf: ["ct_urban", "ct_gsg9", "ct_sas", "ct_gign"] }],
  ["models.t", { oneOf: ["t_phoenix", "t_leet", "t_arctic", "t_guerilla"] }],
  ["graphics.brightness", { range: [0.5, 2] }],
  ["graphics.gamma", { range: [0.5, 2.5] }],
  ["graphics.vibrance", { range: [0, 2] }],
  ["graphics.resolutionScale", { range: [0.25, 2] }],
  ["graphics.aspect", { oneOf: ["native", "4:3", "5:4", "16:10", "16:9"] }],
  ["graphics.aspectFit", { oneOf: ["stretch", "bars"] }],
  ["graphics.anisotropy", { oneOf: [1, 2, 4, 8, 16] }],
  ["graphics.menuBackground", { oneOf: ["live", "still", "off"] }],
  ["viewmodel.fov", { range: [40, 90] }],
  ["viewmodel.bob", { range: [0, 1.5] }],
  ["viewmodel.sway", { range: [0, 1.5] }],
  ["viewmodel.hand", { oneOf: ["right", "left"] }],
  ["viewmodel.x", { range: [-2, 2.5] }],
  ["viewmodel.y", { range: [-2, 2] }],
  ["viewmodel.z", { range: [-2, 2] }],
  ["binds.*", { codes: true }],
  ["autoRestart.when", { oneOf: ["off", "pb", "wr", "ghost"] }],
  ["autoRestart.action", { oneOf: ["restart", "sound"] }],
];

const ruleFor = (path: string): Rule | null => {
  const segs = path.split(".");
  for (const [pat, r] of RULES) {
    const ps = pat.split(".");
    if (ps.length === segs.length && ps.every((x, i) => x === "*" || x === segs[i])) return r;
  }
  return null;
};

const CODE_RE = /^[A-Za-z0-9]{1,24}$/;

/** The value to adopt for a leaf, or undefined if it's invalid. */
function accept(path: string, def: unknown, v: unknown): unknown {
  const r = ruleFor(path);
  if (Array.isArray(def)) {
    if (!Array.isArray(v) || v.length > 4 || !v.every((x) => typeof x === "string" && (!r || !("codes" in r) || CODE_RE.test(x)))) return undefined;
    return [...new Set(v as string[])];
  }
  if (typeof def !== typeof v) return undefined;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return undefined;
    if (r && "oneOf" in r) return r.oneOf.includes(v) ? v : undefined;
    if (r && "range" in r) {
      const n = Math.min(r.range[1], Math.max(r.range[0], v));
      return r.int ? Math.round(n) : n;
    }
    return v;
  }
  if (typeof v === "string") {
    if (r && "oneOf" in r) return r.oneOf.includes(v) ? v : undefined;
    if (r && "color" in r) return /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : undefined;
    return v.length <= 64 ? v : undefined;
  }
  return v; // boolean
}

export interface ImportPlan {
  /** The prefs after the import (a fresh object; apply with prefs.update). */
  next: Prefs;
  /** Paths adopted from the document (valid values, changed or not). */
  applied: string[];
  /** Of those, the ones that differ from the current prefs. */
  changed: string[];
  /** Present but wrong (type, unknown option, bad colour / key): left as they were. */
  invalid: string[];
  /** Keys this build doesn't know (a newer version, or junk): ignored. */
  skipped: string[];
}

/** Decides what importing `doc` over `current` would do, without applying it. */
export function planSettingsImport(doc: SettingsDoc, current: Prefs): ImportPlan {
  const raw = migratePrefs(clone(doc.settings) as Record<string, unknown>);
  const next = clone(current);
  const plan: ImportPlan = { next, applied: [], changed: [], invalid: [], skipped: [] };
  walk(DEFAULT_PREFS as unknown as Record<string, unknown>, raw, next as unknown as Record<string, unknown>, "", plan);
  return plan;
}

function walk(def: Record<string, unknown>, src: Record<string, unknown>, out: Record<string, unknown>, at: string, plan: ImportPlan): void {
  for (const k of Object.keys(src)) if (!(k in def)) plan.skipped.push(at + k);
  for (const k of Object.keys(def)) {
    if (!(k in src)) continue;
    const path = at + k;
    const d = def[k];
    const v = src[k];
    if (d && typeof d === "object" && !Array.isArray(d)) {
      if (!v || typeof v !== "object" || Array.isArray(v)) {
        plan.invalid.push(path);
        continue;
      }
      if (!out[k] || typeof out[k] !== "object") out[k] = clone(d);
      walk(d as Record<string, unknown>, v as Record<string, unknown>, out[k] as Record<string, unknown>, path + ".", plan);
      continue;
    }
    const ok = accept(path, d, v);
    if (ok === undefined) {
      plan.invalid.push(path);
      continue;
    }
    plan.applied.push(path);
    if (JSON.stringify(out[k]) !== JSON.stringify(ok)) plan.changed.push(path);
    out[k] = ok;
  }
}
