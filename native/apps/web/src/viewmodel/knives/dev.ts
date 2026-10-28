// DEV ONLY: ?vmknife=<id> equips a registry knife (first person, your third-person bunny, ghosts that follow you) on the
// dev game page and vmlab.html. Loaded by viewmodel.ts under import.meta.env.DEV (dropped from builds). Not a
// cosmetic slot: the unlocks work wires knives into the loadout.
//
//   /?map=bhop_eazy&vmknife=karrotbit         /vmlab.html?vmknife=bunnyfly&act=idle
//   console: __vmknife.set("daikon"), __vmknife.list()

import { equipKnife } from "./equipped";
import { KNIVES, knifeById } from "./index";

export function installDevKnife(): void {
  const id = new URLSearchParams(location.search).get("vmknife") ?? "";
  const set = (id: string) => {
    const k = knifeById(id);
    if (!k) return console.warn(`vmknife: unknown knife "${id}" (${KNIVES.map((k) => k.id).join(", ")})`);
    equipKnife(k);
    console.info(`vm knife: ${k.name} (${k.id})`);
  };
  set(id);
  Object.assign(window, { __vmknife: { set, list: () => KNIVES.map((k) => `${k.id}: ${k.name}`) } });
}
