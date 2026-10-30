// Prebuild worker (prebuild.ts): builds a remote player's bunny geometry (mesh.ts bunnyGeometry, ~30k vertices, tens of
// ms, several times that on slow PCs) and headwear off the main thread, so a player joining never stalls the game.
// The same code as on the main thread; the attribute arrays are transferred back and seeded into the caches there.
//
// In:  { id, outfit, loadout, body, hat, crown }   the flags: which parts the main thread still needs
// Out: { id, key, body, hat, crown } (geometries as PlainGeometry, null when not asked for) | { id, error }
// Also the first-person viewmodel's hands + knife (viewmodel/mesh.ts, ~10 ms a pair, several times that on slow PCs),
// for the Loadout's previews and thumbnails (prebuildViewmodels):
// In:  { id, vm: [knife id, glove style][], clouds: knife id[] }
// Out: { id, vm: { knife, glove, geometry, tris }[], clouds: { knife, p, grip, n }[] } | { id, error }
// (clouds: the knives' point clouds for the grip solver, knives/hold.ts knifeCloud.)

import type * as THREE from "three";
import type { CosmeticLoadout } from "../../loadout";
import { ensureBunnyLayout, ensureViewmodelLayout } from "../../viewmodel/finishes/layout";
import { carrot } from "../../viewmodel/knives/carrot";
import { knifeById } from "../../viewmodel/knives/index";
import { viewmodelGeometry } from "../../viewmodel/mesh";
import { knifeCloud } from "../../viewmodel/knives/hold";
import type { GloveStyleId } from "../../loadout";
import { crownGeometry } from "./crown";
import { hatGeometry } from "./hats";
import { bunnyGeometry } from "./mesh";
import { bunnyParts } from "./prebuild-parts";
import type { PlainGeometry } from "./prebuild";

type InMsg = { id: number; outfit: string | null; loadout: CosmeticLoadout; body: boolean; hat: boolean; crown: boolean } | { id: number; vm: [string, GloveStyleId][]; clouds: string[] };
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
  if ("vm" in m) {
    try {
      const transfer: Transferable[] = [];
      const vm = m.vm.map(([id, glove]) => {
        const knife = knifeById(id) ?? carrot;
        const g = viewmodelGeometry(knife, glove);
        ensureViewmodelLayout(g); // the Loadout's sampleOf / the Viewmodel do this on the main thread; done here it's a no-op there
        return { knife: knife.id, glove, geometry: plain(g, transfer), tris: knife.tris ?? null };
      });
      const clouds = m.clouds.map((id) => {
        const c = knifeCloud(knifeById(id) ?? carrot);
        const p = c.p.slice(), grip = c.grip.slice();
        transfer.push(p.buffer, grip.buffer);
        return { knife: id, p, grip, n: c.n };
      });
      ctx.postMessage({ id: m.id, vm, clouds }, transfer);
    } catch (err) {
      ctx.postMessage({ id: m.id, error: String(err) }, []);
    }
    return;
  }
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
