// Gun registry: every gun the client draws, built in code in our art style, keyed by the core's weapon id
// (research/WEAPONS.md): the six map guns, plus two stand-ins of their own for the weapon families no map we play
// models yet, the Furrow (rifle, as the ak47) and the Beanpole (sniper, as the awp). Every other weapon id the core
// knows borrows the closest model so a map that gives one never shows empty hands (GUN_STAND_IN): the other pistols
// a pistol, the SMGs the Seed Drill, the rifles and the M249 the Furrow, the scout and the auto snipers the Beanpole.
// A borrowed model keeps its own name on the HUD and its own animation timing; the core's timing (cycle, clip, reload
// length) still decides every shot and reload, the animations stretch to it.
//
//   gunById("glock") -> GunDef (types.ts); presenter.ts maps the core's numeric ids (core.ts WEAPON_IDS)

import { beanpole } from "./models/beanpole";
import { broadfork } from "./models/broadfork";
import { cottontail } from "./models/cottontail";
import { furrow } from "./models/furrow";
import { hedgerow } from "./models/hedgerow";
import { jackrabbit } from "./models/jackrabbit";
import { seeddrill } from "./models/seeddrill";
import { thumper } from "./models/thumper";
import type { GunDef, GunId } from "./types";

export const GUNS: readonly GunDef[] = [thumper, cottontail, jackrabbit, broadfork, hedgerow, seeddrill, furrow, beanpole];

const byId = new Map<string, GunDef>(GUNS.map((g) => [g.id, g]));

/** Stand-ins for the weapon ids without a model of their own: the closest archetype. */
export const GUN_STAND_IN: Record<string, GunId> = {
  p228: "usp",
  elite: "usp",
  deagle: "fiveseven",
  mac10: "p90",
  tmp: "p90",
  mp5navy: "p90",
  ump45: "p90",
  galil: "ak47",
  famas: "ak47",
  m4a1: "ak47",
  sg552: "ak47",
  aug: "ak47",
  m249: "ak47",
  scout: "awp",
  g3sg1: "awp",
  sg550: "awp",
};

/** A gun by its string id ("glock"), or a stand-in for ids without a model; undefined for the knife / none. */
export function gunById(id: string | null | undefined): GunDef | undefined {
  if (!id) return undefined;
  return byId.get(id) ?? byId.get(GUN_STAND_IN[id] ?? "");
}

export type { GunDef, GunId } from "./types";
