// Bunny colourways (the cosmetic "outfit" slot in progression.ts; equipped through player/cosmetics.ts). Each fills the
// mesh's palette slots (mesh.ts SLOT order) plus the accent (visor, ear panels, stripes, soles, logo, drawstrings).

export interface Colourway {
  hoodie: number;
  trim: number;
  pants: number;
  pantsTrim: number;
  shoe: number;
  face: number;
  glove: number;
  detail: number;
  accent: number;
}

export const COLOURWAYS: Record<string, Colourway> = {
  "outfit-plush": { hoodie: 0xe8d7b9, trim: 0xc9ad85, pants: 0x373339, pantsTrim: 0x29262a, shoe: 0xf1e3cd, face: 0x252329, glove: 0x39343b, detail: 0xffedcc, accent: 0xe9ab43 },
  "outfit-bune": { hoodie: 0xf2e8d8, trim: 0xd7c9b3, pants: 0x252631, pantsTrim: 0x181a23, shoe: 0xfff3df, face: 0x13151c, glove: 0xf2e8d8, detail: 0xffffff, accent: 0xffbd43 },
  "outfit-cream": { hoodie: 0xece5d8, trim: 0xcdc3b2, pants: 0x2b303b, pantsTrim: 0x1f232b, shoe: 0xf4f6f9, face: 0x171a21, glove: 0x2a2e38, detail: 0xffffff, accent: 0xffb43c },
  "outfit-midnight": { hoodie: 0x262b38, trim: 0x1a1e28, pants: 0x14171e, pantsTrim: 0x0d0f14, shoe: 0x2f3442, face: 0x0b0d12, glove: 0x151820, detail: 0xd9dde6, accent: 0xffb43c },
  "outfit-neon": { hoodie: 0x16181d, trim: 0x0e0f12, pants: 0x1d2027, pantsTrim: 0x101216, shoe: 0x101114, face: 0x07080a, glove: 0x101114, detail: 0xff3fa4, accent: 0x7dff4a },
  "outfit-carrot": { hoodie: 0xff8a2a, trim: 0xe06a12, pants: 0x2f4a2a, pantsTrim: 0x233a20, shoe: 0xf6f1e8, face: 0x1b1712, glove: 0x2c3a26, detail: 0xffffff, accent: 0x6ee06a },
  "outfit-sakura": { hoodie: 0xffd3e2, trim: 0xf2b2c8, pants: 0xf7f2f4, pantsTrim: 0xe5dade, shoe: 0xffffff, face: 0x2a1d26, glove: 0xffffff, detail: 0xff7aa8, accent: 0xff5c95 },
  "outfit-mint": { hoodie: 0xc9f2dc, trim: 0x9fdcbc, pants: 0x24423a, pantsTrim: 0x1a312b, shoe: 0xf4fbf7, face: 0x10201b, glove: 0x24423a, detail: 0xffffff, accent: 0x2fd39a },
  "outfit-arctic": { hoodie: 0xf3f7fb, trim: 0xd5dfea, pants: 0xdde5ee, pantsTrim: 0xc3cfdc, shoe: 0xffffff, face: 0x1a2533, glove: 0xcad6e3, detail: 0x7fc8ff, accent: 0x49b6ff },
  "outfit-ember": { hoodie: 0x2a1512, trim: 0x1d0e0c, pants: 0x1a1414, pantsTrim: 0x120d0d, shoe: 0x231917, face: 0x0b0606, glove: 0x1d1210, detail: 0xffb43c, accent: 0xff5a36 },
  "outfit-void": { hoodie: 0x1d1430, trim: 0x140d22, pants: 0x120c1e, pantsTrim: 0x0b0714, shoe: 0x241a3a, face: 0x05030a, glove: 0x150f24, detail: 0xe9d8ff, accent: 0xc477ff },
  "outfit-gold": { hoodie: 0x1b1b1f, trim: 0x111114, pants: 0x1b1b1f, pantsTrim: 0x111114, shoe: 0xf1e2b0, face: 0x0b0b0c, glove: 0x141416, detail: 0xfff3c4, accent: 0xffd45e },
  // Community (progression.ts DISCORD_MEMBER): blurple hoodie with a deeper blurple trim, near-black pants and gloves, white
  // shoes, and a green "online" accent on the visor, ear panels, stripes and logo. Colour only: no logos on cosmetics.
  "outfit-blurple": { hoodie: 0x5865f2, trim: 0x4450d0, pants: 0x23262e, pantsTrim: 0x16181d, shoe: 0xf4f5ff, face: 0x0d0e14, glove: 0x23262e, detail: 0xffffff, accent: 0x57f287 },
  // Community (progression.ts DISCORD_BOOSTER): deep violet hoodie and pants, glowing pink trim, gloves and accents.
  "outfit-afterglow": { hoodie: 0x2e1a52, trim: 0xf47fff, pants: 0x1b1230, pantsTrim: 0xc77dff, shoe: 0xfde8ff, face: 0x0c0714, glove: 0xf47fff, detail: 0xffd6ff, accent: 0xff9cf5 },
  // Rank-held (progression.ts held(): overall #1 / top 2 / top 3), worn with the crown of the place.
  "outfit-reigning": { hoodie: 0xfbf6e6, trim: 0xe8b931, pants: 0x241b3a, pantsTrim: 0xe8b931, shoe: 0xfff3c4, face: 0x120d1c, glove: 0xe8b931, detail: 0xffffff, accent: 0xffd45e },
  "outfit-silverhare": { hoodie: 0xe3e8f0, trim: 0xa9b4c6, pants: 0x262c38, pantsTrim: 0xa9b4c6, shoe: 0xf4f7fb, face: 0x10141c, glove: 0xb9c3d3, detail: 0xffffff, accent: 0xcfe0ff },
  "outfit-bronzehare": { hoodie: 0xc98a52, trim: 0x8f5a2e, pants: 0x2b1e16, pantsTrim: 0x8f5a2e, shoe: 0xf2dcc2, face: 0x160e09, glove: 0x8f5a2e, detail: 0xffe2c0, accent: 0xffb36b },
  // Role-held (progression.ts role("owner")): the owner's. Royal ink-violet hoodie with carrot-orange trim and gloves (the
  // site's own orange), gold stripes, and a cyan glow on the visor, eyes and logo.
  "outfit-founder": { hoodie: 0x241450, trim: 0xff7a1a, pants: 0x120b2a, pantsTrim: 0xffc23d, shoe: 0xfff4dc, face: 0x07040f, glove: 0xff7a1a, detail: 0xffd45e, accent: 0x3ff0ff },
  // The secret (progression.ts WINGS): Tek's own head and jacket (tek.ts) over a forest-green high-collar jacket,
  // charcoal joggers, white winged sneakers with leaf-green soles and stripes.
  "outfit-tek": { hoodie: 0x1d4430, trim: 0x11281e, pants: 0x23272d, pantsTrim: 0x181b20, shoe: 0xf2f4ee, face: 0xefd6c3, glove: 0x182920, detail: 0xdfe4e6, accent: 0x6fbd55 },
  // Supporter (progression.ts SUPPORTER): the Geode. Deep teal hoodie with an amethyst trim, dark stone pants with
  // amethyst stripes, pale crystal shoes, and a crystal-aqua glow on the visor, eyes, ear panels, stripes and logo.
  // Supporter: High Roller. Casino-felt green hoodie, gold trim and stripes, black pants, cream shoes, a gold glow.
  "outfit-highroller": { hoodie: 0x0f5a3a, trim: 0xe0b13a, pants: 0x15161a, pantsTrim: 0xe0b13a, shoe: 0xf3efe2, face: 0x06100b, glove: 0x15161a, detail: 0xffe7a3, accent: 0xffcf4a },
  // Supporter: Borealis. Night-sky navy hoodie and pants, aurora-green trim, violet stripes, a green glow.
  "outfit-borealis": { hoodie: 0x101a33, trim: 0x3ff0a0, pants: 0x0b1124, pantsTrim: 0x9a6bff, shoe: 0xe8f6ff, face: 0x05070d, glove: 0x14203d, detail: 0xb8ffe0, accent: 0x5dffb0 },
  "outfit-geode": { hoodie: 0x1d6b74, trim: 0x7a5ce8, pants: 0x23232e, pantsTrim: 0x7a5ce8, shoe: 0xe6fbf8, face: 0x081417, glove: 0x23232e, detail: 0xd6fff8, accent: 0x5ff2df },
  // Batch 1 (progression.ts, research/PROGRESSION-BATCH1.md), earned by playing.
  // Home Turf: clover-green hoodie, buttercup ears and visor, soil-brown pants.
  "outfit-meadow": { hoodie: 0x4f9a3a, trim: 0x3b7a2c, pants: 0x4a3626, pantsTrim: 0x36271b, shoe: 0xf4efdc, face: 0x14200f, glove: 0x3b7a2c, detail: 0xfff6c8, accent: 0xffd23a },
  // Wayfarer (50 maps): the Backrooms' mono-yellow wallpaper, carpet-brown pants, a tube-white visor.
  "outfit-fluorescent": { hoodie: 0xd8c35a, trim: 0xb8a23f, pants: 0x7d6a45, pantsTrim: 0x5e4f33, shoe: 0xe9e4c8, face: 0x1b1a12, glove: 0xb3a45e, detail: 0xfffbe0, accent: 0xf6f7e6 },
  // Second Gear (25 T2 clears): Aero's sky blue, white trim and pants, a grass-green accent.
  "outfit-skyglass": { hoodie: 0x48b4f0, trim: 0xffffff, pants: 0xe8f4fb, pantsTrim: 0x9fd6f5, shoe: 0xffffff, face: 0x0d2a3d, glove: 0xd8eef9, detail: 0xffffff, accent: 0x7bd23c },
  // Centurion (100 maps): olive with brass trim and stripes.
  "outfit-laurel": { hoodie: 0x34452c, trim: 0xc9a24a, pants: 0x1e2419, pantsTrim: 0xc9a24a, shoe: 0xf2ead2, face: 0x0d100b, glove: 0x34452c, detail: 0xffe9b0, accent: 0xd9b45a },
  // Cartographer (150 maps): Palmera Plaza. Teal hoodie, pink trim, violet pants, a sunset-orange accent.
  // Ran the Gauntlet: the old developer texture. Grey hoodie, dev-orange trim, stripes and gloves.
  "outfit-devgrid": { hoodie: 0x8f9296, trim: 0xf08a24, pants: 0x4d5054, pantsTrim: 0xf08a24, shoe: 0xdadcdf, face: 0x151515, glove: 0xf08a24, detail: 0xffffff, accent: 0xffffff },
  // Trick or Treat (October): pumpkin hoodie, night-plum pants, vine-green gloves, a candle-glow visor.
  "outfit-pumpkin": { hoodie: 0xe0701c, trim: 0xb8550f, pants: 0x2a1f36, pantsTrim: 0x3d2a4a, shoe: 0x2e2622, face: 0x120904, glove: 0x3d6b2a, detail: 0xffe08a, accent: 0xffb43c },
  "outfit-palmera": { hoodie: 0x2bb6b0, trim: 0xff7ac0, pants: 0x6f58b8, pantsTrim: 0xff7ac0, shoe: 0xfff0f6, face: 0x1a1030, glove: 0x2bb6b0, detail: 0xffe9a8, accent: 0xffa04a },
};

export const DEFAULT_COLOURWAY = "outfit-cream";

export function colourway(id: string | null | undefined): Colourway {
  return (id && COLOURWAYS[id]) || COLOURWAYS[DEFAULT_COLOURWAY];
}

/** Palette slot order (mesh.ts SLOT). */
export function paletteOf(c: Colourway): number[] {
  return [c.hoodie, c.trim, c.pants, c.pantsTrim, c.shoe, c.face, c.glove, c.detail];
}
