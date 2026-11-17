// Build-time only: the website's charms (viewmodel/charms) for the native first-person renderer. Every charm's mesh
// with its hardware, every wrap a knife can be tied with, and where a charm hangs on every knife with every hilt and
// glove (anchors.ts charmFit / charmHang: the tie, the wrap, the colliders, the places a knife offers) are written as
// data, so a change to the fits on the website is a re-export. The motion is C++ (charms.hpp), checked against the
// website by charms-oracle.ts. What a charm rests against (the knife's and the hand's surface) is sampled by the client
// from the meshes it already has (charm_fit.hpp), the way anchors.ts samples them.
import * as THREE from "three";
import { Builder } from "../../web/src/player/bunny/builder";
import { GLOVE_STYLE_IDS } from "../../web/src/loadout";
import { CHARM_LENGTH, CHARM_SIZE, CHARM_SWING, COSMETICS } from "../../web/src/progression";
import { vmRig } from "../../web/src/viewmodel/rig";
import { KNIVES } from "../../web/src/viewmodel/knives/index";
import { LIVE_DESIGNS } from "../../web/src/viewmodel/hilts/live/index";
import "../../web/src/viewmodel/charms/knife";
import { charmFit, charmPlaces, type CharmHang } from "../../web/src/viewmodel/charms/anchors";
import { BOTTOM_RISE, TOP_DROP, mount, mountKey, type MountSpec } from "../../web/src/viewmodel/charms/hardware";
import {
  CB,
  CHARMS,
  CHARM_BONES,
  CHARM_SCALE,
  CORD_LENGTH,
  CharmCtx,
  charmGeometry,
  charmMetrics,
} from "../../web/src/viewmodel/charms/meshes";

type Geometry = (name: string, g: THREE.BufferGeometry) => void;

/** One wrap's mesh, alone on the charm skeleton's mount bone (drawn with the charm). */
function mountGeometry(m: MountSpec): THREE.BufferGeometry {
  const b = new Builder();
  b.finish = () => [0, 0, 0, 0];
  mount(new CharmCtx(b), m);
  b.finish = null;
  return b.geometry();
}

export function writeCharms(geometry: Geometry) {
  const rig = vmRig();
  const mounts = new Map<string, string>();
  const meshOfMount = (m: MountSpec | null): string | null => {
    if (!m) return null;
    const key = mountKey(m);
    let name = mounts.get(key);
    if (!name) {
      name = `charmmount:${mounts.size}`;
      mounts.set(key, name);
      geometry(name, mountGeometry(m));
    }
    return name;
  };
  const hangOf = (h: CharmHang | null) =>
    h && {
      bone: rig.bone(h.bone),
      at: h.at,
      mount: meshOfMount(h.mount),
      how: h.how,
      colliders: h.colliders.map((c) => ({
        a: c.a,
        b: c.b,
        r: c.r,
        bone: rig.bone(c.bone),
        boneB: c.boneB ? rig.bone(c.boneB) : -1,
        hand: !!c.hand,
      })),
    };
  // Where a charm hangs, per knife, per hilt that brings its own pieces ("" for every other hilt), per glove style. The
  // hangs and the rest holds repeat a lot, so each is written once and the fits name them by index.
  const unique = <T>(list: string[], index: Map<string, number>, value: T): number => {
    const key = JSON.stringify(value);
    let at = index.get(key);
    if (at === undefined) {
      at = list.length;
      list.push(key);
      index.set(key, at);
    }
    return at;
  };
  const hangs: string[] = [],
    hangIndex = new Map<string, number>(),
    holds: string[] = [],
    holdIndex = new Map<string, number>();
  const fits: Record<string, [number, number, number]> = {};
  const hilts = ["", ...LIVE_DESIGNS.map((d) => d.id)];
  for (const knife of KNIVES)
    for (const hilt of hilts)
      for (const glove of GLOVE_STYLE_IDS) {
        const fit = charmFit(knife, hilt || null, glove);
        const joints = fit.joints.map((j) => ({ bone: rig.bone(j.bone), p: j.p }));
        fits[`${knife.id}|${hilt}|${glove}`] = [
          unique(hangs, hangIndex, hangOf(fit.guard)),
          fit.pommel ? unique(hangs, hangIndex, hangOf(fit.pommel)) : -1,
          unique(holds, holdIndex, joints),
        ];
      }
  const charms: Record<string, unknown> = {};
  for (const def of CHARMS) {
    geometry(`charm:${def.id}`, charmGeometry(def, { mount: null }).clone());
    const m = charmMetrics(def);
    charms[def.id] = {
      mesh: `charm:${def.id}`,
      link: m.link,
      radius: m.radius,
      lift: m.lift,
      balls: m.balls,
      life: def.life ?? null,
    };
  }
  const known = new Set(CHARMS.map((c) => c.id));
  for (const item of COSMETICS.filter((c) => c.slot === "charm"))
    if (!known.has(item.id)) throw new Error(`Charm without a mesh: ${item.id}`);
  return {
    bones: CHARM_BONES,
    boneOf: CB,
    cordLength: CORD_LENGTH,
    scale: CHARM_SCALE,
    topDrop: TOP_DROP,
    bottomRise: BOTTOM_RISE,
    ranges: { length: CHARM_LENGTH, size: CHARM_SIZE, swing: CHARM_SWING },
    places: Object.fromEntries(KNIVES.map((k) => [k.id, charmPlaces(k.id)])),
    charms,
    hangs: hangs.map((h) => JSON.parse(h)),
    holds: holds.map((h) => JSON.parse(h)),
    fits,
  };
}
