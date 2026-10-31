// Which colour each thing wears in Analytics, and which slices and rings a chart draws (pure: apps/web/test/analytics-charts.test.ts).
//
// Colour follows the entity, never its rank: Native is the same hue in every chart, in any window, so slices keep the
// slot order of their dimension instead of sorting by size. The values are CSS variables in admin.css, validated against
// the panel's ground with the dataviz palette checks:
//   --s-1 to --s-8    categorical, fixed order (adjacent pairs pass; other pairs rely on the gaps, the legend and the readout)
//   --s-1-1 to --s-4-5  shades of slots 1 to 4, for entities that share a parent: GPU families of a vendor, versions of a client
//   --o-1 to --o-9    one hue, dark to light, for ordered things (buckets, polling rates, tiers); more is brighter
//   --s-other, --s-none  greys: everything folded together, and "hidden by the browser"

export const OTHER = "var(--s-other)";
export const NONE = "var(--s-none)";
/** More than this and the smallest fold into Other. */
export const MAX_SLICES = 8;
/** A ranked list's rings; the rest are in the table. */
export const MAX_RINGS = 8;
/** Shades a parent's hue has: past this many children, the smallest fold into Other. */
const MAX_SHADES = 5;

const slot = (n: number) => `var(--s-${n})`;
const shade = (n: number, step: number) => `var(--s-${n}-${step})`;

/** Slot of each entity, per dimension. Absent: a grey. */
const FIXED: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  client: { browser: 1, desktop: 2, native: 3, wavedash: 4 },
  browser: { Chrome: 1, Edge: 2, Firefox: 3, Safari: 4, Opera: 5, "Opera GX": 6, Brave: 7, Vivaldi: 8 },
  os: { Windows: 1, macOS: 2, Linux: 3, ChromeOS: 4, Android: 5, iOS: 6 },
  gpu_vendor: { NVIDIA: 1, AMD: 2, Intel: 3, Apple: 4, Qualcomm: 5, Arm: 6, Imagination: 7, Software: 8 },
  raw_input: { raw: 1, os: 2 },
  track: { main: 1, bonus: 2 },
  // Segmented would be a ninth: it reads as a grey beside these.
  style: { autohop: 1, autostrafe: 2, legit: 3, lowgrav: 4, hsw: 5, scroll: 6, wonly: 7, sideways: 8 },
};

/** Dimensions whose values have an order: a ramp, kept in that order, not a set of hues. */
const ORDERED = new Set(["poll_hz", "screen", "tier", "fps_bucket", "sens_bucket", "dpi_bucket", "cores", "board_size"]);

/** The ramp step for position i of n, darkest first. Skips the very darkest unless every step is needed. */
export function ramp(i: number, n: number): string {
  if (n <= 1) return "var(--o-6)";
  const low = n >= 9 ? 1 : 2;
  return `var(--o-${low + Math.round((i * (9 - low)) / (n - 1))})`;
}

/** The vendor's slot from a GPU family or model name ("RTX 40 series", "RX 7700 XT", "UHD 730"). */
export function vendorSlot(name: string): number | null {
  if (/^(RTX|GTX|GT |MX |GeForce|NVIDIA)/.test(name)) return FIXED.gpu_vendor.NVIDIA;
  if (/^(RX|Radeon|AMD)/.test(name)) return FIXED.gpu_vendor.AMD;
  if (/^(UHD|HD |Iris|Arc|Intel)/.test(name)) return FIXED.gpu_vendor.Intel;
  if (/^Apple/.test(name)) return FIXED.gpu_vendor.Apple;
  if (/^(Adreno|Qualcomm)/.test(name)) return FIXED.gpu_vendor.Qualcomm;
  if (/^(Mali|Arm)/.test(name)) return FIXED.gpu_vendor.Arm;
  if (/^(PowerVR|Imagination)/.test(name)) return FIXED.gpu_vendor.Imagination;
  if (/^Software/.test(name)) return FIXED.gpu_vendor.Software;
  return null;
}

/** A version wears its client's hue. */
const versionSlot = (name: string): number | null => (/^Desktop/.test(name) ? FIXED.client.desktop : /^Native/.test(name) ? FIXED.client.native : null);

/** The hue an entity wears wherever it appears, as a slot number; null: a grey. */
function slotOf(dim: string, key: string | number | null, label: string): number | null {
  if (key === null) return null;
  if (dim === "gpu_family" || dim === "gpu_model") return vendorSlot(label);
  if (dim === "version") return versionSlot(label);
  return FIXED[dim]?.[String(key)] ?? null;
}

export interface Part {
  key: string | number | null;
  label: string;
  /** The slice's size, as a percentage of the whole. */
  part: number;
  players: number;
  runs: number;
}

export type Coloured<T> = T & { color: string };

/** `keep`, and everything in `rest` as one Other. */
function withOther<T extends Part>(keep: T[], rest: T[]): T[] {
  if (!rest.length) return keep;
  const sum = (f: (p: T) => number) => rest.reduce((a, p) => a + f(p), 0);
  return [...keep, { ...rest[0], key: null, label: "Other", part: Math.round(sum((p) => p.part) * 10) / 10, players: sum((p) => p.players), runs: sum((p) => p.runs) }];
}

/** Keeps the biggest `max - 1` and folds the rest, and any Other the server already folded, into one. */
function fold<T extends Part>(parts: T[], max: number): T[] {
  if (parts.length <= max) return parts;
  const biggest = new Set(parts.filter((p) => p.key !== null).sort((a, b) => b.part - a.part).slice(0, max - 1));
  return withOther(parts.filter((p) => biggest.has(p)), parts.filter((p) => !biggest.has(p)));
}

/** Greys after the hues: what has no colour of its own, then Other. */
function greys<T extends Part>(dim: string, parts: T[]): Coloured<T>[] {
  return [...parts.filter((p) => p.key !== null && slotOf(dim, p.key, p.label) === null).map((p) => ({ ...p, color: NONE })), ...parts.filter((p) => p.key === null).map((p) => ({ ...p, color: OTHER }))];
}

/** Steps spread over the five shades, light to dark, so neighbours stay apart. */
const shadeSteps = (n: number) => (n === 1 ? [3] : n === 2 ? [2, 4] : n === 3 ? [1, 3, 5] : n === 4 ? [1, 2, 4, 5] : [1, 2, 3, 4, 5]);

/** A vendor's families or a client's versions, in shades of the parent's hue, biggest (lightest) first. */
function shaded<T extends Part>(dim: string, parts: T[]): Coloured<T>[] {
  const count = new Map<number, number>();
  const within: T[] = [];
  const over: T[] = [];
  for (const p of [...parts].sort((a, b) => b.part - a.part)) {
    const s = slotOf(dim, p.key, p.label);
    if (p.key === null) over.push(p);
    else if (s === null || (count.get(s) ?? 0) < MAX_SHADES) {
      if (s !== null) count.set(s, (count.get(s) ?? 0) + 1);
      within.push(p);
    } else over.push(p);
  }
  const kept = fold(withOther(within, over), MAX_SLICES);
  const groups = new Map<number, T[]>();
  for (const p of kept) {
    const s = slotOf(dim, p.key, p.label);
    if (s !== null) groups.set(s, [...(groups.get(s) ?? []), p]);
  }
  const out: Coloured<T>[] = [];
  for (const s of [...groups.keys()].sort((a, b) => a - b)) {
    const list = groups.get(s)!;
    const steps = shadeSteps(list.length);
    list.forEach((p, i) => out.push({ ...p, color: s <= 4 ? shade(s, steps[i]) : slot(s) }));
  }
  return [...out, ...greys(dim, kept)];
}

/**
 * The slices of a part-to-whole chart: at most MAX_SLICES, in the dimension's fixed order, each in its entity's colour. A
 * vendor's families and a client's versions wear shades of the parent's hue.
 */
export function arrangeParts<T extends Part>(dim: string, parts: T[]): Coloured<T>[] {
  if (ORDERED.has(dim)) {
    const kept = fold(parts, MAX_SLICES);
    const named = kept.filter((p) => p.key !== null);
    return kept.map((p) => ({ ...p, color: p.key === null ? OTHER : ramp(named.indexOf(p), named.length) }));
  }
  if (dim === "gpu_family" || dim === "version") return shaded(dim, parts);
  const kept = fold(parts, MAX_SLICES);
  const known = kept.filter((p) => slotOf(dim, p.key, p.label) !== null).sort((a, b) => slotOf(dim, a.key, a.label)! - slotOf(dim, b.key, b.label)!);
  return [...known.map((p) => ({ ...p, color: slot(slotOf(dim, p.key, p.label)!) })), ...greys(dim, kept)];
}

/**
 * The rings of a circular bar chart, outermost first. Ordered things keep their order and wear the ramp. A ranked list keeps
 * its biggest MAX_RINGS (Other isn't a rank, so it stays in the table), in its entities' colours where they have one.
 */
export function arrangeRings<T extends { key: string | number | null; label: string; value: number }>(dim: string, rows: T[]): Coloured<T>[] {
  const named = rows.filter((r) => r.key !== null);
  if (ORDERED.has(dim)) return named.map((r, i) => ({ ...r, color: ramp(i, named.length) }));
  return [...named]
    .sort((a, b) => b.value - a.value)
    .slice(0, MAX_RINGS)
    .map((r) => {
      const s = slotOf(dim, r.key, r.label);
      return { ...r, color: s !== null ? slot(s) : dim === "map" ? slot(1) : NONE };
    });
}
