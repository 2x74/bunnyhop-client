// Which parts of a gun take a camo (camo.ts, guns/camo.ts): each model wraps the paints of its coated parts in coat().
//
//   upper (1)   slide, receiver, top cover
//   lower (2)   frame, handguard, stock, pump, grip shells
//   mag (3)     plain magazines
//
// Never coated: sights and dots, barrels, bores, muzzles and brakes, bolts and bolt faces, triggers, pins, levers,
// screws, lenses and scopes, butt pads, and every gun's character pieces (the Furrow's carrot magazine and twine, the
// Seed Drill's pea pod, the Cottontail's tail, the Jackrabbit's ears, the Thumper's rabbit's foot, the Broadfork's
// leaf wrap), so a gun in camo still reads as that gun. Two-tone solids paint upper and lower apart; patterns run over
// all of them alike. `shade`: a darker (or lighter) paint of the same part keeps its contrast (panel lines, grip inlays).

import type { GunPaint } from "./material";

export const CAMO_ZONE = { upper: 1, lower: 2, mag: 3 } as const;
export type CamoZone = keyof typeof CAMO_ZONE;

/** `p` tagged for camo: its zone and the shade of the camo it shows (1 = the camo's own colours). */
export const coat = (p: GunPaint, zone: CamoZone, shade = 1): GunPaint => ({ ...p, camo: { zone: CAMO_ZONE[zone], shade, edge: 0 } });
