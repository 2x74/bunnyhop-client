// A gun's two-handed hold data as native reads it (gun_hold.hpp parse_hold), from the website's own gunHoldData
// (player/bunny/gun-hold.ts through guns/meshes.ts bunnyHold). Shared by the asset export and the parity oracle.
import type { GunHoldData } from "../../web/src/player/bunny/gun-hold";

const matrixOrNull = (m: ArrayLike<number> | null) => (m ? Array.from(m) : null);

export function holdData(d: GunHoldData) {
  const def = d.def;
  return {
    cls: def.cls,
    long: d.long,
    scale: d.s,
    bake: matrixOrNull(d.bake),
    grip: matrixOrNull(d.grip),
    gripInv: matrixOrNull(d.gripInv),
    right: matrixOrNull(d.right),
    left: matrixOrNull(d.left),
    mag: matrixOrNull(d.mag),
    port: matrixOrNull(d.port),
    rack: matrixOrNull(d.rack),
    bolt: matrixOrNull(d.bolt),
    butt: d.butt,
    muzzle: d.muzzle,
    silencerTip: def.silencer?.tip ?? null,
    eject: { point: d.eject.p, direction: d.eject.dir },
    reload: def.timing.reload ?? null,
    shellEach: def.timing.shells?.each ?? null,
    pump: def.timing.pump ?? null,
  };
}
