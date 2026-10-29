// Prebuild worker (prebuild.ts): builds a remote player's bunny geometry (mesh.ts bunnyGeometry, ~30k vertices, tens of
// ms, several times that on slow PCs) and headwear off the main thread, so a player joining never stalls the game.
// The same code as on the main thread; the attribute arrays are transferred back and seeded into the caches there.
//
// In:  { id, outfit, loadout, body, hat, crown }   the flags: which parts the main thread still needs
// Out: { id, key, body, hat, crown } (geometries as PlainGeometry, null when not asked for) | { id, error }

import type * as THREE from "three";
import type { CosmeticLoadout } from "../../loadout";
import { ensureBunnyLayout } from "../../viewmodel/finishes/layout";
import { crownGeometry } from "./crown";
import { hatGeometry } from "./hats";
import { bunnyGeometry } from "./mesh";
import { bunnyParts } from "./prebuild-parts";
import type { PlainGeometry } from "./prebuild";

type InMsg = { id: number; outfit: string | null; loadout: CosmeticLoadout; body: boolean; hat: boolean; crown: boolean };
const ctx = self as unknown as { onmessage: ((e: MessageEvent<InMsg>) => void) | null; postMessage(m: unknown, transfer: Transferable[]): void };

function plain(g: THREE.BufferGeometry, transfer: Transferable[]): PlainGeometry {
  const attributes: PlainGeometry["attributes"] = {};
  for (const [name, a] of Object.entries(g.attributes) as [string, THREE.BufferAttribute][]) {
    // Copies: the worker's caches keep theirs (a later build here reuses them), the copies are transferred.
    const array = a.array.slice() as PlainGeometry["attributes"][string]["array"];
    transfer.push(array.buffer);
    attributes[name] = { array, itemSize: a.itemSize, normalized: a.normalized };
  }
  const b = g.boundingBox, s = g.boundingSphere;
  return {
    attributes,
    box: b ? [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z] : null,
    sphere: s ? [s.center.x, s.center.y, s.center.z, s.radius] : null,
  };
}

ctx.onmessage = (e) => {
  const m = e.data;
  try {
    const p = bunnyParts(m.outfit, m.loadout);
    const transfer: Transferable[] = [];
    let body: PlainGeometry | null = null;
    if (m.body) {
      const g = bunnyGeometry(p.knife, p.glove, p.look, p.body, p.hood);
      ensureBunnyLayout(g); // BunnyModel.applyLook does this on the main thread; done here it's a no-op there
      body = plain(g, transfer);
    }
    const hat = m.hat && p.hat ? hatGeometry(p.hat) : null;
    const crown = m.crown && p.crown ? crownGeometry(p.crown) : null;
    ctx.postMessage({ id: m.id, key: p.key, body, hat: hat && plain(hat, transfer), crown: crown && plain(crown, transfer) }, transfer);
  } catch (err) {
    ctx.postMessage({ id: m.id, error: String(err) }, []);
  }
};
