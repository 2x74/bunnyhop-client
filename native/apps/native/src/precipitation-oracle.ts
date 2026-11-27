// Test vectors for precipitation_tests.cpp from the website's map-effects/precipitation.ts (the module native ports):
// volume parsing, instance data, the column map over a small traced world, and spans. Run: bun precipitation-oracle.ts
import * as THREE from "three";
import {
  buildColumns,
  fieldCount,
  fieldInstances,
  precipitationKind,
  precipitationSpan,
  precipitationVolumes,
  PRECIP_KINDS,
} from "../../web/src/map-effects/precipitation";

/** FNV-1a over the float32 bit patterns. */
function fnv(data: Float32Array): number {
  const words = new Uint32Array(data.buffer, data.byteOffset, data.length);
  let h = 0x811c9dc5;
  for (const w of words)
    for (let b = 0; b < 4; b++) {
      h ^= (w >>> (b * 8)) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  return h >>> 0;
}

// The traced world (precipitation_tests.cpp has the same): ground at z <= 0, a roof slab 200..216 over x, y in
// [100, 300], and solid sky from z 1000 up. Vertical lines only; the fraction comes back as a float, as from the core.
const inRoof = (x: number, y: number) => x >= 100 && x <= 300 && y >= 100 && y <= 300;
const inside = (x: number, y: number, z: number) => z <= 0 || z >= 1000 || (inRoof(x, y) && z >= 200 && z <= 216);
function trace(sx: number, sy: number, sz: number, _ex: number, _ey: number, ez: number): number {
  if (inside(sx, sy, sz)) return 0;
  let hit: number | null = null;
  if (ez < sz) {
    for (const top of [0, ...(inRoof(sx, sy) && sz > 216 ? [216] : [])])
      if (top <= sz && top >= ez && (hit === null || top > hit)) hit = top;
  } else {
    for (const bottom of [1000, ...(inRoof(sx, sy) && sz < 200 ? [200] : [])])
      if (bottom >= sz && bottom <= ez && (hit === null || bottom < hit)) hit = bottom;
  }
  return Math.fround(hit === null ? 1 : (sz - hit) / (sz - ez));
}

const box = (a: number[], b: number[]) => new THREE.Box3(new THREE.Vector3(...a), new THREE.Vector3(...b));
const bounds = new Map([
  [1, box([-201, -201, 49], [601, 601, 1201])],
  [2, box([-1, -1, 299], [401, 401, 901])],
  [3, box([0, 0, 0], [10, 10, 10])],
]);
const entities: Record<string, string>[] = [
  { classname: "worldspawn" },
  { classname: "func_precipitation", model: "*1", preciptype: "3" },
  { classname: "Func_Precipitation", model: "*2", preciptype: "0", renderamt: "100" },
  { classname: "func_precipitation", model: "*3", preciptype: "2" },
  { classname: "func_precipitation", model: "*2", PRECIPTYPE: " 7 ", renderamt: "x" },
  { classname: "func_precipitation", model: "*2", preciptype: "1", renderamt: "60" },
];
const volumes = precipitationVolumes(entities, bounds);
const columns = buildColumns(volumes, trace, { maxCells: 4096 });
const spans = [
  [0, 50, 50, 500, 100],
  [0, 200, 200, 150, 100],
  [0, 200, 200, 300, 100],
  [0, 550, 550, 980, 100],
  [1, 50, 50, 600, 100],
  [1, 50, 50, 20, 100],
  [1, 200, 200, 250, 900],
  [2, 350, 350, 400, 100],
].map(([k, x, y, z, eye]) => {
  const s = precipitationSpan(PRECIP_KINDS[k], volumes, columns, x, y, z, eye);
  return s ? [Math.fround(s.floor), Math.fround(s.top)] : null;
});
console.log(
  JSON.stringify({
    kinds: [-1, 0, 1, 2, 3, 4, 5, 7, 2.9, NaN].map((t) => precipitationKind(t)),
    volumes: volumes.map((v) => [v.kind, v.entity, ...v.min, ...v.max, v.amount]),
    counts: PRECIP_KINDS.map((k) => [fieldCount(k), fieldCount(k, 100), fieldCount(k, 5000)]),
    instances: PRECIP_KINDS.map((k) => {
      const d = fieldInstances(k, fieldCount(k));
      return [d.length / 12, fnv(d), Array.from(d.subarray(12 * 7, 12 * 8))];
    }),
    columns: {
      width: columns.width,
      height: columns.height,
      traces: columns.traces,
      truncated: columns.truncated,
      layout: columns.layout,
      hash: fnv(columns.data),
    },
    spans,
  }),
);
