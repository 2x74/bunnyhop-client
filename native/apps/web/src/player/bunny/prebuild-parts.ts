// What a remote player's bunny is built from (prebuild.ts), worked out the same way BunnyModel does it: the body
// geometry's knife / glove style / look / build (mesh.ts bunnyGeometry) and the headwear (hats.ts headwear). Shared by
// the main thread and the prebuild worker so both agree on the cache keys.

import type { CosmeticLoadout } from "../../loadout";
import { gloveStyle, isWig } from "../../loadout";
import { knifeById } from "../../viewmodel/knives/index";
import type { KnifeDef } from "../../viewmodel/knives/types";
import { bunnyGeometryKey, type BunnyHood } from "./mesh";
import { headwearKey, isHat } from "./hats";
import { lookOf } from "./look";

export interface BunnyParts {
  key: string;
  knife: KnifeDef | null;
  glove: ReturnType<typeof gloveStyle>["style"];
  look: ReturnType<typeof lookOf>;
  body: "classic" | "feminine";
  /** Down while a wig is on the standard bunny (mesh.ts). */
  hood: BunnyHood;
  /** Headwear: a hat geometry key (hats.ts headwearKey), else a crown tier, else neither (Tek wears none). */
  hat: string | null;
  crown: 1 | 2 | 3 | null;
}

export function bunnyParts(outfit: string | null | undefined, l: CosmeticLoadout): BunnyParts {
  const k = knifeById(l.knife);
  const knife = k && k.id !== "carrot" ? k : null; // equip.ts knifeOf
  const glove = gloveStyle(l.glove).style;
  const look = lookOf(outfit);
  const body = l.body === "body-b" ? "feminine" : "classic";
  const hood: BunnyHood = hoodOf(look, l.hat);
  const hat = look !== "tek" && isHat(l.hat) ? headwearKey(l.hat!, look) : null;
  const crown = look !== "tek" && !hat && l.crown ? l.crown : null;
  return { key: bunnyGeometryKey(knife, glove, look, body, hood), knife, glove, look, body, hood, hat, crown };
}

/** The hood for a look and hat: down for a wig on the standard bunny (Plush / Bun-E / Tek keep their own heads). */
export function hoodOf(look: ReturnType<typeof lookOf>, hat: string | null | undefined): BunnyHood {
  return look === "bunny" && isWig(hat) ? "down" : "up";
}
