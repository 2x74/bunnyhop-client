// A brush entity's render keys (rendermode, renderamt, rendercolor, renderfx) as CS:S draws them. The core simulates none
// of this; the renderer reads the keys the map spawns with. Render only: a brush that isn't drawn is as solid as before.
//
// SDK 2013 game/client/c_baseentity.cpp:
//   ShouldDraw: rendermode 10 (kRenderNone, "Don't render") is never drawn.
//   ComputeFxBlend: the entity's blend, 0..255. Without a renderfx it is 255 in rendermode 0 (Normal: renderamt is
//     ignored) and renderamt in every other mode. The pulse, strobe, flicker, distort and hologram effects compute it
//     from the map time or the view, in every mode.
//   GetRenderGroup and view.cpp DrawTranslucentRenderable: a blend of 0 is "totally gone"; anything under 255 is drawn
//     blended with that alpha. For a brush the render mode chooses nothing else: how it blends is its material's business.
//   GetColorModulation: rendercolor, in every mode, opaque brushes included.
//
// Left as they draw today (see the lane report): FadeSlow / FadeFast (5, 6: they lose alpha once per rendered frame,
// so when they vanish depends on the frame rate and on when the brush first came into view), and any brush whose keys
// the map changes while it runs (`dynamicRenderTargets`), since the core doesn't carry that state.

/** rendermode 10. */
export const RENDER_NONE = 10;

export interface RenderKeys {
  mode: number;
  /** renderamt, 0..255. */
  amount: number;
  /** rendercolor as 0..1, or null for white (no modulation). */
  color: [number, number, number] | null;
  fx: number;
}

const FX_PULSE_SLOW = 1;
const FX_PULSE_FAST = 2;
const FX_PULSE_SLOW_WIDE = 3;
const FX_PULSE_FAST_WIDE = 4;
const FX_FADE_SLOW = 5;
const FX_FADE_FAST = 6;
const FX_STROBE_SLOW = 9;
const FX_STROBE_FAST = 10;
const FX_STROBE_FASTER = 11;
const FX_FLICKER_SLOW = 12;
const FX_FLICKER_FAST = 13;
const FX_DISTORT = 15;
const FX_HOLOGRAM = 16;
const FX_PULSE_FAST_WIDER = 24;
const TIMED = new Set([FX_PULSE_SLOW, FX_PULSE_FAST, FX_PULSE_SLOW_WIDE, FX_PULSE_FAST_WIDE, FX_STROBE_SLOW, FX_STROBE_FAST, FX_STROBE_FASTER, FX_FLICKER_SLOW, FX_FLICKER_FAST, FX_DISTORT, FX_HOLOGRAM, FX_PULSE_FAST_WIDER]);

const key = (e: Record<string, string>, k: string) => Object.entries(e).find(([n]) => n.toLowerCase() === k)?.[1];
/** C `atoi`: leading whitespace, an optional sign, digits; 0 otherwise. */
const atoi = (v: string | undefined) => Number(/^\s*([+-]?\d+)/.exec(v ?? "")?.[1] ?? 0);
const byte = (n: number) => Math.min(255, Math.max(0, n));

/** The entity's render keys (CBaseEntity::KeyValue: missing keys are rendermode 0, renderamt 255, white, no effect). */
export function renderKeys(e: Record<string, string>): RenderKeys {
  const amount = key(e, "renderamt");
  const rgb = (key(e, "rendercolor") ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 3).map((v) => byte(atoi(v)));
  // UTIL_StringToColor32 reads up to four numbers into a colour that starts at 0 0 0; a key with no numbers is black.
  const color = key(e, "rendercolor") === undefined ? [255, 255, 255] : [rgb[0] ?? 0, rgb[1] ?? 0, rgb[2] ?? 0];
  return {
    mode: atoi(key(e, "rendermode")) & 0xff,
    amount: amount === undefined ? 255 : byte(atoi(amount)),
    color: color.every((c) => c === 255) ? null : [color[0] / 255, color[1] / 255, color[2] / 255],
    fx: atoi(key(e, "renderfx")) & 0xff,
  };
}

/** Whether the blend changes while the map runs (a renderfx computed from the time or the view). */
export const fxIsTimed = (k: RenderKeys): boolean => TIMED.has(k.fx);

/** FadeSlow / FadeFast: not drawn differently here (see the top of the file). */
export const fxIsFrameFade = (k: RenderKeys): boolean => k.fx === FX_FADE_SLOW || k.fx === FX_FADE_FAST;

export interface FxInputs {
  /** Map time in seconds. */
  time: number;
  /** De-syncs the effects between entities (the entity index in CS:S). */
  index: number;
  /** Units from the eye to the entity's origin along the view direction (Hologram). */
  depth: number;
  /** A fresh integer in -32..31 (Distort and Hologram flicker). */
  jitter(): number;
}

/** C_BaseEntity::ComputeFxBlend: the blend, 0..255 (0: not drawn, 255: drawn as its materials are). */
export function fxBlend(k: RenderKeys, i: FxInputs): number {
  const a = k.amount;
  const offset = i.index * 363;
  const t = i.time;
  /** `blend = 20 * wave; blend < 0 ? 0 : renderamt`. */
  const gate = (wave: number) => (20 * wave < 0 ? 0 : a);
  let blend: number;
  switch (k.fx) {
    case FX_PULSE_SLOW_WIDE: blend = a + 0x40 * Math.sin(t * 2 + offset); break;
    case FX_PULSE_FAST_WIDE: blend = a + 0x40 * Math.sin(t * 8 + offset); break;
    case FX_PULSE_FAST_WIDER: blend = 0xff * Math.abs(Math.sin(t * 12 + offset)); break;
    case FX_PULSE_SLOW: blend = a + 0x10 * Math.sin(t * 2 + offset); break;
    case FX_PULSE_FAST: blend = a + 0x10 * Math.sin(t * 8 + offset); break;
    case FX_STROBE_SLOW: blend = gate(Math.sin(t * 4 + offset)); break;
    case FX_STROBE_FAST: blend = gate(Math.sin(t * 16 + offset)); break;
    case FX_STROBE_FASTER: blend = gate(Math.sin(t * 36 + offset)); break;
    case FX_FLICKER_SLOW: blend = gate(Math.sin(t * 2) + Math.sin(t * 17 + offset)); break;
    case FX_FLICKER_FAST: blend = gate(Math.sin(t * 16) + Math.sin(t * 23 + offset)); break;
    case FX_HOLOGRAM:
    case FX_DISTORT: {
      // Distort turns the distance fade off; both set renderamt to 180.
      const dist = k.fx === FX_DISTORT ? 1 : i.depth;
      if (dist <= 0) blend = 0;
      else blend = (dist <= 100 ? 180 : (1 - (dist - 100) * (1 / 400)) * 180) + i.jitter();
      break;
    }
    default:
      blend = k.mode === 0 ? 255 : a;
  }
  // The engine keeps it in an int (truncated towards zero), clamped.
  return byte(Math.trunc(blend));
}

/**
 * Indices of the entities whose render keys an output changes while the map runs: the target of an `Alpha` or `Color`
 * input, or of an `AddOutput` of a render key, by name (a trailing `*` matches a prefix), by classname, or the entity
 * firing at `!self` / `!caller`. `entities`: every key / value pair of each entity, repeated output keys included.
 */
export function dynamicRenderEntities(entities: readonly (readonly (readonly [string, string])[])[]): Set<number> {
  const names = new Set<string>();
  const out = new Set<number>();
  entities.forEach((pairs, index) => {
    for (const [, value] of pairs) {
      const f = value.split(value.includes("\x1b") ? "\x1b" : ",");
      if (f.length < 4) continue;
      const input = f[1].trim().toLowerCase();
      if (input !== "alpha" && input !== "color" && !(input === "addoutput" && /^\s*render(mode|amt|color|fx)\b/i.test(f[2]))) continue;
      const target = f[0].trim().toLowerCase();
      if (target === "!self" || target === "!caller") out.add(index);
      else if (target) names.add(target);
    }
  });
  if (!names.size) return out;
  const named = (v: string | undefined) => {
    const n = v?.toLowerCase();
    if (!n) return false;
    for (const t of names) if (t.endsWith("*") ? n.startsWith(t.slice(0, -1)) : t === n) return true;
    return false;
  };
  entities.forEach((pairs, index) => {
    if (pairs.some(([k, v]) => (k.toLowerCase() === "targetname" || k.toLowerCase() === "classname") && named(v))) out.add(index);
  });
  return out;
}
