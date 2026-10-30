// The finishUV attribute on the meshes the cosmetic loadout paints (layout: player/bunny/builder.ts header and
// viewmodel/knives/types.ts PART): blades come with it from the knife registry (KnifeCtx.blade) and glove styles from
// their builders (viewmodel/gloves/fp.ts, tp.ts: seams, wear, PART.glove); this adds what neither writes: a fallback
// blade layout for meshes built before the registry (the code-built carrot in viewmodel/mesh.ts and
// player/bunny/mesh.ts), so finishes show on them too. Skipped as soon as a mesh has its own PART.blade vertices.
// Runs once per geometry (cached), in place; ~10k vertices, well under a millisecond.

import * as THREE from "three";
import { frame, norm, smoothstep } from "../../player/bunny/builder";
import { invert34, rig as bunnyRig, xform, type V3 } from "../../player/bunny/rig";
import { vmRig } from "../rig";

/** finishUV.z part ids (same numbers as viewmodel/knives/types.ts PART). */
export const PART = { none: 0, blade: 1, guard: 2, grip: 3, glove: 4, cuff: 5 } as const;

const done = new WeakSet<THREE.BufferGeometry>();

const near = (c: THREE.Color, r: number, g: number, b: number) => Math.abs(c.r - r) + Math.abs(c.g - g) + Math.abs(c.b - b) < 0.02;
const CARROT = new THREE.Color(0xff7a1a), CARROT_DARK = new THREE.Color(0xd95a0c);
const isCarrot = (r: number, g: number, b: number) => near(CARROT, r, g, b) || near(CARROT_DARK, r, g, b);
const edgeOf = (u: number, v: number) => Math.max(smoothstep(0.6, 1, Math.abs(v)), smoothstep(0.85, 1, u));

function finishAttr(g: THREE.BufferGeometry): THREE.BufferAttribute {
  let a = g.getAttribute("finishUV") as THREE.BufferAttribute | undefined;
  if (!a) {
    a = new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute("position").count * 4), 4);
    g.setAttribute("finishUV", a);
  }
  return a;
}

const hasBlade = (F: THREE.BufferAttribute) => {
  for (let i = 0; i < F.count; i++) if (Math.abs(F.getZ(i) - PART.blade) < 0.5) return true;
  return false;
};

/** First-person hands + knife (viewmodel/mesh.ts or the knife registry's build). */
/** A geometry laid out elsewhere (the prebuild worker, its finishUV transferred with it): ensureViewmodelLayout skips it. */
export function markViewmodelLayout(g: THREE.BufferGeometry): void {
  done.add(g);
}

export function ensureViewmodelLayout(g: THREE.BufferGeometry): void {
  if (done.has(g)) return;
  done.add(g);
  const r = vmRig();
  const F = finishAttr(g);
  // Fallback blade: the code-built carrot on Knife_Handle (local z along the blade from 2.3 to 11.2, y across).
  if (!hasBlade(F)) {
    const kb = r.bone("Knife_Handle");
    const inv = new Float32Array(12);
    invert34(r.bind, kb * 12, inv, 0);
    const P = g.getAttribute("position"), C = g.getAttribute("partColor"), A = g.getAttribute("accent");
    const SI = g.getAttribute("skinIndex"), SW = g.getAttribute("skinWeight");
    for (let i = 0; i < P.count; i++) {
      if (SI.getX(i) !== kb || SW.getX(i) < 0.99) continue;
      const k = xform(inv, 0, [P.getX(i), P.getY(i), P.getZ(i)]);
      const accent = Math.round(A.getX(i));
      if (accent === 1) F.setXYZW(i, 0, 0, PART.guard, 0);
      else if (accent === 0 && k[2] > 2.25 && isCarrot(C.getX(i), C.getY(i), C.getZ(i))) {
        const u = Math.min(1, Math.max(0, (k[2] - 2.3) / 8.9));
        const rad = 0.8 * Math.pow(1 - u, 0.85) + 0.04;
        const v = Math.min(1, Math.max(-1, k[1] / rad));
        F.setXYZW(i, u, v, PART.blade, edgeOf(u, v));
      } else if (accent === 0 && k[2] < 1.7) F.setXYZW(i, 0, 0, PART.grip, 0);
    }
  }
  F.needsUpdate = true;
}

/** Third-person bunny (player/bunny/mesh.ts, plus the registry's third-person knife twins when they land). */
export function ensureBunnyLayout(g: THREE.BufferGeometry): void {
  if (done.has(g)) return;
  done.add(g);
  const r = bunnyRig();
  const F = finishAttr(g);
  if (!hasBlade(F)) {
    // The code-built carrot: authored in R_Hand's bind frame from O along d (s 5.3 .. 15.6), width along v0.
    const hand = r.bone("R_Hand");
    const inv = new Float32Array(12);
    invert34(r.bind, hand * 12, inv, 0);
    const O: V3 = [2.05, -1.45, 3.1];
    const d = norm([0.53, 0.1, -0.84]);
    const [, , v0] = frame(d, [0, 1, 0]);
    const P = g.getAttribute("position"), C = g.getAttribute("partColor"), A = g.getAttribute("accent");
    const SI = g.getAttribute("skinIndex");
    for (let i = 0; i < P.count; i++) {
      if (SI.getX(i) !== hand || Math.round(A.getX(i)) !== 0 || !isCarrot(C.getX(i), C.getY(i), C.getZ(i))) continue;
      const h = xform(inv, 0, [P.getX(i), P.getY(i), P.getZ(i)]);
      const q: V3 = [h[0] - O[0], h[1] - O[1], h[2] - O[2]];
      const s = q[0] * d[0] + q[1] * d[1] + q[2] * d[2];
      const u = Math.min(1, Math.max(0, (s - 5.3) / 10.3));
      const rad = 1.25 * Math.pow(1 - u, 0.85) + 0.05;
      const v = Math.min(1, Math.max(-1, (q[0] * v0[0] + q[1] * v0[1] + q[2] * v0[2]) / rad));
      F.setXYZW(i, u, v, PART.blade, edgeOf(u, v));
    }
  }
  F.needsUpdate = true;
}
