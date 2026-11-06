import { writeFile } from "node:fs/promises";
import { arcPoints, centreDrop, domeGeometry, minSizeScale, ringSegments } from "../../web/src/landing/marker";
const dome = domeGeometry(14, 9);
const pieces = [0, 0, 100, 200, 50, 100, 0, 0, -800, 0.5, 100, 25, 50, 200, 50, -300, 0, 0, -800, 0.15];
const arc = new Float32Array(96 * 3);
const count = arcPoints(pieces, 2, 24, 64, arc);
const distances = [1, 100, 1000, 10000];
const normals = [
  [0, 0, 1],
  [0.6, 0, 0.8],
  [-0.3, 0.4, Math.sqrt(0.75)],
];
await writeFile(
  process.argv[2],
  JSON.stringify({
    positions: Array.from(dome.positions),
    alpha: Array.from(dome.alpha),
    ring: ringSegments(14, 0.5),
    pieces,
    arc: Array.from(arc.slice(0, count * 3)),
    scales: distances.map((distance) => [distance, 600, minSizeScale(distance, 600)]),
    drops: normals.map((normal) => ({ normal, drop: centreDrop(normal) })),
  }),
);
