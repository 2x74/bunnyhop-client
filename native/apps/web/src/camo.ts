// Gun camos (v0.0.38): one camo for every gun you're handed, a Loadout slot of its own ("camo"; progression.ts holds
// the catalogue and the unlocks). DOM-free and three-free like loadout.ts: the client (viewmodel/guns/camo.ts draws
// them), the API and the tests share it.
//
// A camo is a fixed design, the same for everyone: a pattern kind, up to four colours and a size. No seed, no wear, no
// float: the pattern is laid out in the gun's own space (gun-local Source units, viewmodel/guns/types.ts), so every
// gun shows the same camo at the same size, and the parts that move (slide, magazine, pump) carry it with them.
//
// What takes a camo (viewmodel/guns/camo-zones.ts tags each model's paints): the upper (slide, receiver), the lower
// (frame, handguard, stock, pump) and plain magazines. Sights, barrels, bolts, triggers, pins, lenses and the guns'
// own character pieces (the Furrow's carrot magazine, the Seed Drill's pea pod, the Cottontail's tail, the hare's ears,
// the Thumper's rabbit's foot) stay as they are, so a gun in camo still reads as that gun.

export type CamoKind = "solid" | "blobs" | "digital" | "stripes" | "splat" | "stamps" | "veins" | "carbon" | "check" | "grid" | "ribbons" | "facets" | "argyle";
/** Shader code of each kind (viewmodel/guns/camo.ts GUN_CAMO). Append only. */
export const CAMO_KIND_CODE: Readonly<Record<CamoKind, number>> = { solid: 0, blobs: 1, digital: 2, stripes: 3, splat: 4, stamps: 5, veins: 6, carbon: 7, check: 8, grid: 9, ribbons: 10, facets: 11, argyle: 12 };

export type CamoStamp = "carrot" | "paw" | "daisy" | "sprinkle" | "leaf" | "tracks" | "firefly";
/** Shader code of each stamp (viewmodel/guns/camo.ts CAMO_STAMP). Append only. */
export const CAMO_STAMP_CODE: Readonly<Record<CamoStamp, number>> = { carrot: 0, paw: 1, daisy: 2, sprinkle: 3, leaf: 4, tracks: 5, firefly: 6 };

/**
 * How the coated parts shade: "coat" a matte paint (polymer), "metal" satin steel, "gloss" a lacquer (dark steel's
 * sharp highlight over the colour). Grips keep their checkering under any of them.
 */
export type CamoSheen = "coat" | "metal" | "gloss";

export interface CamoStyle {
  kind: CamoKind;
  /**
   * sRGB colours. solid: upper, lower, magazine. Patterns: the base colour first, then the pattern's colours (what each
   * means per kind: viewmodel/guns/camo.ts).
   */
  colors: readonly [number, number, number, number];
  /** Feature size in gun-local units (a pistol is about 7 long, a rifle about 30). */
  scale: number;
  sheen: CamoSheen;
  /** Per-kind shape values (thresholds, widths; viewmodel/guns/camo.ts). */
  p?: readonly [number, number, number, number];
  /** stamps: what's stamped. */
  stamp?: CamoStamp;
}

const S = (kind: CamoKind, colors: [number, number, number, number], scale: number, sheen: CamoSheen = "coat", p?: [number, number, number, number], stamp?: CamoStamp): CamoStyle => ({ kind, colors, scale, sheen, p, stamp });

/**
 * Every camo's render data, by its progression.ts "camo-*" id. Ids are stable forever (saved loadouts, rosters and
 * replay trailers carry them). The UI swatch is the catalogue's `color`.
 */
export const CAMO_STYLE: Readonly<Record<string, CamoStyle>> = {
  // --- Solids and two-tones (solid: upper, lower, magazine).
  "camo-field": S("solid", [0x6b6f4a, 0xb9a77c, 0x55593a, 0], 1),
  // Graphite (v0.0.41: lighter and metallic, a pencil lead's silver grey; it was a gloss near-black like Carbon).
  "camo-graphite": S("solid", [0x7b818b, 0x454a52, 0x5e636c, 0], 1, "metal"),
  "camo-split": S("solid", [0xeae2cf, 0x24252a, 0x24252a, 0], 1),
  // --- Classic camos in the game's palette.
  // Woodland (v0.0.41: it was army blobs): the woodland floor, fallen leaves in olive and brown over moss.
  "camo-woodland": S("stamps", [0x4f6b3a, 0xa3ab52, 0xc9843a, 0x3d552e], 1.5, "coat", [0.9, 0.7, 0, 0], "leaf"),
  // blobs: base, large blobs, second blobs, small dark strokes; p = thresholds of the three (higher = less), stretch.
  // Flagstone (v0.0.41: it was Desert, sand blobs): a crazy-paved garden path, sandstone flags with dark joints.
  // facets: three face tones and the line between faces; p[0] the line's half width (0 = a hairline, Geode's).
  "camo-desert": S("facets", [0xe0cda2, 0xc9ae7e, 0xb0906a, 0x5e4c36], 1.7, "coat", [0.085, 0, 0, 0]),
  // Fireflies (v0.0.41: it was Night Woodland, navy blobs): a garden after dark, fireflies glowing over the leaves.
  "camo-night": S("stamps", [0x18203a, 0xfff3a6, 0xb9dd4e, 0x24345a], 1.15, "coat", [0.5, 1, 0, 0], "firefly"),
  "camo-whiteout": S("blobs", [0xf4f6fb, 0xdfe5f2, 0xb8c8ff, 0xffffff], 3.6, "gloss", [0.5, 0.6, 0.66, 0.6]),
  // digital: as blobs, on square pixels of p[3] units.
  "camo-urban": S("digital", [0x8c9096, 0x5d6168, 0xc4c7cc, 0x2c2f34], 3.0, "coat", [0.53, 0.58, 0.64, 0.42]),
  // Snowfield (v0.0.41: it was white digital): a bunny's tracks across fresh snow, soft drifts under them.
  "camo-snow": S("stamps", [0xf3f6fa, 0x8fa5c4, 0x8fa5c4, 0xdfe7f1], 1.9, "coat", [0.85, 0.9, 0, 0], "tracks"),
  // stripes: base, stripe, second stripe; p = warp, slant, width, axis (0 bands across the gun, 1 lines along it).
  "camo-reeds": S("stripes", [0x8a9a5b, 0x4f6b38, 0xc9c48a, 0], 1.6, "coat", [1.4, 0.35, 0.34, 0]),
  "camo-crab": S("stripes", [0xf08a4b, 0x7a1f1a, 0xfff1e0, 0], 1.5, "coat", [1.8, 0.55, 0.3, 0]),
  "camo-backrooms": S("stripes", [0xd9c46a, 0xc2ab52, 0xe8d98c, 0], 0.55, "coat", [0, 0, 0.22, 1]),
  // --- Game-native.
  // splat: base, three paint colours.
  "camo-splat": S("splat", [0xf2ead8, 0xff7a1a, 0x2fb7a8, 0xff6fae], 2.2),
  // stamps: base, stamp, its second colour, an accent.
  "camo-carrot-patch": S("stamps", [0x6b4a32, 0xff7a1a, 0x58c64a, 0x7d5a3e], 1.7, "coat", [0.75, 0.5, 0, 0], "carrot"),
  "camo-paws": S("stamps", [0x7a5236, 0xf2e6d0, 0xf2a7a0, 0x6b4630], 1.5, "coat", [0.6, 0.6, 0, 0], "paw"),
  "camo-meadow": S("stamps", [0x5f9a4a, 0xfff8ec, 0xffc93a, 0x7fbf5a], 1.3, "coat", [0.7, 1, 0, 0], "daisy"),
  "camo-sprinkles": S("stamps", [0xfff1e6, 0xff6fae, 0x4fa8ff, 0xffc93a], 0.9, "gloss", [1, 1, 0, 0], "sprinkle"),
  // check: light, mid, dark; p[0] 1 = a plain checkerboard (light and dark).
  "camo-picnic": S("check", [0xfff5ec, 0xf08a8a, 0xc83a3a, 0], 0.9, "coat", [0, 0, 0, 0]),
  "camo-finish-line": S("check", [0xf4f4f6, 0, 0x16171b, 0], 0.8, "gloss", [1, 0, 0, 0]),
  // carbon: two weave colours, a fibre sheen.
  // (v0.0.41: Carbon's weave is bigger and its sheen brighter, so it reads as a weave in the hand, not as plain black.)
  "camo-carbon": S("carbon", [0x101216, 0x474d58, 0xa9b6c9, 0], 0.5, "gloss"),
  "camo-gold-weave": S("carbon", [0x2a2214, 0xb8902e, 0xffd45e, 0], 0.32, "metal"),
  // grid: base, minor lines, major lines, filled squares; p = major every n, minor strength, squares, line width.
  "camo-devgrid": S("grid", [0x4d5054, 0x6b6e73, 0xe8862a, 0xe8862a], 0.5, "coat", [4, 0.8, 0.05, 0.05]),
  // veins: base, vein, halo; p = warp, frequency, width, ridged (1: caustic lines, not marble veins).
  "camo-gilded": S("veins", [0x17171b, 0xe0b13a, 0x5a4520, 0], 3.2, "gloss", [3.2, 1.3, 0.065, 0]),
  "camo-lapis": S("veins", [0x26307a, 0xd9b45a, 0x4a58c8, 0], 3.0, "gloss", [3.0, 1.2, 0.075, 0]),
  "camo-riptide": S("veins", [0x0e2a4a, 0x9fdcff, 0x1a4fd8, 0], 2.6, "gloss", [0, 1, 0.07, 1]),
  // ribbons: base, ribbon, second ribbon, sparkles; p = warp, frequency, width, sparkle density.
  "camo-flare": S("ribbons", [0x1c1218, 0xe0479f, 0xff9a3c, 0xffd0e8], 5.0, "gloss", [2.2, 1, 0.16, 0]),

  // --- Supporter (one per set).
  "camo-geode": S("facets", [0x2a1f5c, 0x7a5ce8, 0x1d6b74, 0x5ff2df], 0.9, "gloss"),
  "camo-highroller": S("argyle", [0x0f5a3a, 0x111114, 0xe0b13a, 0], 1.3, "coat"),
  "camo-borealis": S("ribbons", [0x14203d, 0x3ff0a0, 0x9a6bff, 0xe8f6ff], 5.0, "gloss", [2.6, 1, 0.2, 0.04]),
  "camo-tidepool": S("veins", [0x2f8f86, 0xf3ece2, 0x5fc8b8, 0], 2.4, "gloss", [0, 1, 0.08, 1]),

  // --- Role sets.
  "camo-lookout": S("digital", [0x1b2740, 0x2e3d5c, 0x5d6b86, 0xc8f53a], 3.0, "coat", [0.53, 0.6, 0.7, 0.42]),
  "camo-workbench": S("grid", [0x2b3448, 0x3fd4c6, 0xc9a24a, 0x3fd4c6], 0.5, "coat", [4, 0.55, 0, 0.045]),
  // Draftsman (Contributor): a blueprint, white lines on blueprint blue, a heavier line every fifth.
  "camo-draftsman": S("grid", [0x1d4f91, 0xbfe0ff, 0xf4f8ff, 0x1d4f91], 0.5, "coat", [5, 0.4, 0, 0.04]),
  "camo-keyholder": S("veins", [0x5a1420, 0xcfd6e0, 0x3a0c14, 0], 2.6, "metal", [3.6, 1.6, 0.04, 0]),
  "camo-founder": S("stamps", [0x241450, 0xffc23d, 0xff7a1a, 0x3a2470], 1.6, "gloss", [0.7, 0.35, 0, 0], "carrot"),
};

/** Render data of a camo id, or null (none, unknown). */
export const camoStyle = (id: string | null | undefined): CamoStyle | null => (id && CAMO_STYLE[id]) || null;
