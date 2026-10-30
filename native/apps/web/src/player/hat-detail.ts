// Hat materials by graphics look (the Supporter hats and the rank crowns, player/bunny/hats.ts, crown.ts): shading
// only, the geometry and fits are untouched. A hat's faces carry fixed colours; this tags each vertex with a material
// picked by its colour (the hats' own palettes, below) in the `headwear` attribute (1 + material / 8: still > 0.5, the
// flag the head fit reads), and the solid material shades it on Source and up:
//
//   metal    crowns, coins, the visor's gold: a view-locked studio reflection tinted by the colour, a crisp glint
//   lacquer  enamel and plastic (propeller, visor shade, circlet band): the colour under a glossy coat
//   fabric   felt, satin, knit (top hat, beanie, bands): a soft sheen in the fabric's colour, no plastic highlight
//   fur      capybara, Maxwell: light caught at the silhouette
//   gem      the crowns' and the Founder Crown's stones: glossy, lit from inside a little
//
// Potato / Plain (uCosTier < 2) and every crystal / ribbon fx face (player/hat-fx.ts) shade exactly as before. Hats
// are third person only, so there is one level (Source and up are the same, and no scene reflection): a branch per
// pixel on hat faces, nothing per frame on the CPU.

import * as THREE from "three";

export const HAT_MAT = { none: 0, metal: 1, lacquer: 2, fabric: 3, fur: 5, gem: 6 } as const;

/** Hat colours (sRGB hex, as the builders paint them) -> material. Shared colours get the reading that fits all users. */
const BY_COLOUR: [number, number][] = [
  // Rank crowns (crown.ts TIERS): metal, its dark band, the stone.
  ...[0xffcf3d, 0xc8891e, 0xdfe6f0, 0x8f9bb0, 0xd9934e, 0x8f5a2e].map((c): [number, number] => [c, HAT_MAT.metal]),
  ...[0xe0213b, 0x2a6df0, 0x18b85a].map((c): [number, number] => [c, HAT_MAT.gem]),
  // Founder Crown: lavender / deep enamel, cyan stones; the orange band and leaves read as fabric (as on the beanie).
  [0xa77cff, HAT_MAT.lacquer], [0x2a1660, HAT_MAT.lacquer], [0x3ff0ff, HAT_MAT.gem],
  [0xff7a1a, HAT_MAT.fabric], [0x3fbf5a, HAT_MAT.fabric],
  // Top hat: felt, satin sheen panel. Beanie: knit.
  [0x231d33, HAT_MAT.fabric], [0x3a3150, HAT_MAT.fabric],
  [0xe8650e, HAT_MAT.fabric], [0xd95a0c, HAT_MAT.fabric], [0x2f9a48, HAT_MAT.fabric],
  // Circlet: enamel band.
  [0x231b52, HAT_MAT.lacquer], [0x342a78, HAT_MAT.lacquer], [0x4d3fa6, HAT_MAT.lacquer], [0x8f72ff, HAT_MAT.lacquer], [0x150f33, HAT_MAT.lacquer],
  // Lucky Coins: gold.
  [0xffcf4a, HAT_MAT.metal], [0xc9921f, HAT_MAT.metal], [0xffe08a, HAT_MAT.metal], [0xa8761a, HAT_MAT.metal],
  // Dealer's Visor: plastic band and shade, gold trim.
  [0x111216, HAT_MAT.lacquer], [0xe0b13a, HAT_MAT.metal], [0x1e9a5a, HAT_MAT.lacquer], [0x167a47, HAT_MAT.lacquer], [0x5fd896, HAT_MAT.lacquer],
  // Propeller cap: plastic.
  // (Its yellow is the gold crown's exact colour: it reads as metal, which suits the cap's hub too.)
  ...[0xec2342, 0x128ad1, 0x21ae70, 0x086dab, 0xffe6a0, 0x7657cd].map((c): [number, number] => [c, HAT_MAT.lacquer]),
  // Half Oni Mask (oni-mask.ts): red and black lacquer, ivory teeth and tusks under the same coat, gold lines and collars.
  ...[0xc81e2a, 0x84121d, 0x161117, 0xf3ecdc, 0xece0c2, 0xc9b78c].map((c): [number, number] => [c, HAT_MAT.lacquer]),
  [0xe6b54a, HAT_MAT.metal],
  // Capybara, Maxwell: fur.
  ...[0xa97848, 0xb88955, 0xc99c68, 0x805232, 0x161820, 0x1d202a, 0x12141b, 0x2a262c, 0xf0f3f8, 0xdad5cd].map((c): [number, number] => [c, HAT_MAT.fur]),
];
const TABLE = BY_COLOUR.map(([hex, m]) => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b, m] as const;
});

/**
 * The `headwear` attribute of a hat / crown geometry with its materials (once per geometry; the head-fit flag stays,
 * every value is >= 1). Faces whose colour isn't in the table keep plain shading (1).
 */
export function ensureHeadwear(geo: THREE.BufferGeometry): void {
  if (geo.hasAttribute("headwear")) return;
  const C = geo.getAttribute("partColor");
  const n = geo.getAttribute("position").count;
  const hw = new Float32Array(n).fill(1);
  if (C)
    for (let i = 0; i < n; i++) {
      const r = C.getX(i), g = C.getY(i), b = C.getZ(i);
      for (const t of TABLE)
        if (Math.abs(t[0] - r) + Math.abs(t[1] - g) + Math.abs(t[2] - b) < 0.004) {
          hw[i] = 1 + t[3] / 8;
          break;
        }
    }
  geo.setAttribute("headwear", new THREE.Float32BufferAttribute(hw, 1));
}

/** Fragment declarations (solid material; needs the hat-fx pars for vFx, and uCosTier). */
export const HAT_DETAIL_FRAGMENT_PARS = /* glsl */ `
varying float vHw;
// A small studio seen in glossy hat parts, fixed to the view (Rv: view-space reflection): bright sky with a strip,
// a hot horizon, a dark band under it, a dim warm floor.
vec3 hatStudio(vec3 Rv, float rough) {
  float y = Rv.y, w = 0.02 + rough * 0.5;
  vec3 sky = mix(vec3(1.25, 1.27, 1.32), vec3(0.34, 0.36, 0.42), smoothstep(0.0, 0.5 + rough, y));
  sky += vec3(0.8) * smoothstep(0.48 - w, 0.54, y) * (1.0 - smoothstep(0.62, 0.7 + w, y)) * (1.0 - rough);
  vec3 fl = mix(vec3(0.06, 0.06, 0.07), vec3(0.36, 0.33, 0.3), smoothstep(-0.05 - w, -0.45 - w, y));
  return mix(fl, sky, smoothstep(-w, w, y));
}`;

/** Fragment (solid material), after the hat fx: `col` shaded per hat material on Source and up. */
export const HAT_DETAIL_FRAGMENT_SOLID = /* glsl */ `
  float hm = floor((vHw - 1.0) * 8.0 + 0.5);
  // Plain hat faces, and the Lucky Coins (gold faces on the Gem Orbit fx; the gems keep their crystal shading).
  if (vHw > 1.05 && uCosTier > 1.5 && (vFx < 0.5 || (vFx == 1.0 && hm < 1.5))) {
    vec3 hR = reflect(-V, n);
    vec3 hRv = (viewMatrix * vec4(hR, 0.0)).xyz;
    float hnv = max(dot(n, V), 0.0), hfc = pow(1.0 - hnv, 5.0);
    float hnh = max(dot(n, normalize(L + V)), 0.0);
    vec3 hb = vColor;
    if (hm < 1.5) {
      // Metal.
      vec3 F = hb + (1.0 - hb) * hfc;
      col = hatStudio(hRv, 0.08) * F * 0.82 + hb * (ambient * 0.25 + key * 0.22);
      col += mix(vec3(1.0), hb, 0.3) * (pow(hnh, 180.0) * 2.0 + pow(hnh, 26.0) * 0.25) * (0.3 + 0.7 * key);
      // A coin keeps the shine that crosses it after its pop.
      if (vFx == 1.0) col += vec3(1.0) * fxGlint(vFxP.x, vFxP.y / 1.6) * 1.3;
    } else if (hm < 2.5) {
      // Lacquer / plastic: a glossy coat over the colour.
      col += hatStudio(hRv, 0.04) * (0.05 + 0.95 * hfc) * 0.5 + vec3(pow(hnh, 140.0) * 1.1 + pow(hnh, 20.0) * 0.06) * (0.25 + 0.75 * key);
    } else if (hm < 3.5) {
      // Fabric: no plastic rim, a soft sheen in its own colour.
      col = hb * (ambient + key * vec3(0.78, 0.74, 0.68)) + hb * pow(1.0 - hnv, 2.0) * 0.35 * (0.55 + 0.45 * key);
    } else if (hm < 5.5) {
      // Fur: light caught in the fibres at the silhouette.
      col += (hb * 0.6 + 0.04) * pow(1.0 - hnv, 1.6) * 0.45 * (0.5 + 0.5 * key);
    } else {
      // Gem: glossy, a little light from inside, a sharp glint.
      col = hb * (ambient * 0.5 + key * 0.45) + hb * (0.3 + 0.3 * (1.0 - hnv)) + hatStudio(hRv, 0.02) * (0.08 + 0.92 * hfc) * 0.6;
      col += vec3(pow(hnh, 220.0) * 2.0);
    }
  }`;
