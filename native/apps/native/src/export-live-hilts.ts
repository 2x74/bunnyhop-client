// Build-time only: the website's living hilts (viewmodel/hilts/live) for the native first-person renderer. Every
// design's pieces are built on every knife exactly as the website builds them (liveMeshes, in the viewmodel's bind
// space), the two materials are translated like the player materials, and each design's knife-dependent pivots are
// written as data. The per-frame motion (state.ts and each design's animate) is C++ (live_hilts.hpp), checked against
// the website by live-hilts-oracle.ts.
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { loadLiveHilts } from "./live-hilt-modules";
import {
  FRAGMENT_CHUNKS,
  FRAGMENT_PRELUDE,
  VERTEX_CHUNKS,
  VERTEX_PRELUDE,
  glsl330,
  nativeAttributes,
  replaceChunks,
} from "./export-player-materials";

const web = "../../web/src/viewmodel";
const { LIVE_DESIGNS, liveMeshes, glowMaterial, litMaterial, liveUniforms, PIECES, CHANNELS, pivots, TEETH } =
  await loadLiveHilts();
const { KNIVES } = await import(`${web}/knives/index`);
const { vmRig } = await import(`${web}/rig`);
const { playerUniforms } = await import("../../web/src/player/materials");

/** Attribute locations of the two meshes (live_hilt_layer.hpp binds the same). */
const LIT_LOCATIONS: Record<string, number> = {
  position: 0,
  normal: 1,
  partColor: 2,
  skinIndex: 3,
  skinWeight: 4,
  accent: 5,
  finishUV: 6,
  position2: 8,
  normal2: 9,
};
const GLOW_LOCATIONS: Record<string, number> = {
  position: 0,
  skinIndex: 3,
  skinWeight: 4,
  pb: 8,
  gc: 9,
  gk: 10,
  gcol: 11,
};
/** Floats per vertex, in this order: the attribute name and its size. Every piece rides on one bone (skinIndex.x). */
const LIT_LAYOUT: [string, number][] = [
  ["position", 3],
  ["normal", 3],
  ["position2", 3],
  ["normal2", 3],
  ["partColor", 3],
  ["accent", 1],
  ["finishUV", 4],
  ["skinIndex", 1],
];
const GLOW_LAYOUT: [string, number][] = [
  ["position", 3],
  ["pb", 3],
  ["gc", 2],
  ["gk", 3],
  ["gcol", 4],
  ["skinIndex", 1],
];

interface Geometry {
  getAttribute(name: string): { count: number; itemSize: number; array: ArrayLike<number> } | undefined;
}

const pieces: Buffer[] = [];
let byteOffset = 0;

/** Interleaves, indexes identical vertices and stores one deflated block: its place and counts. */
function store(g: Geometry | null, layout: [string, number][]) {
  if (!g) return null;
  const count = g.getAttribute("position")!.count;
  const stride = layout.reduce((sum, [, size]) => sum + size, 0);
  const unique: number[] = [];
  const indices = new Uint32Array(count);
  const seen = new Map<string, number>();
  const vertex = new Float32Array(stride);
  for (let i = 0; i < count; i++) {
    let at = 0;
    for (const [name, size] of layout) {
      const attribute = g.getAttribute(name)!;
      for (let k = 0; k < size; k++) vertex[at++] = attribute.array[i * attribute.itemSize + k];
    }
    const key = Buffer.from(vertex.buffer).toString("base64");
    let index = seen.get(key);
    if (index === undefined) {
      index = unique.length / stride;
      seen.set(key, index);
      unique.push(...vertex);
    }
    indices[i] = index;
  }
  const vertices = new Float32Array(unique);
  const raw = Buffer.concat([Buffer.from(vertices.buffer), Buffer.from(indices.buffer)]);
  const packed = deflateSync(raw, { level: 9 });
  const block = { offset: byteOffset, bytes: packed.byteLength, vertices: vertices.length / stride, indices: count };
  pieces.push(packed);
  byteOffset += packed.byteLength;
  return block;
}

function litShaders() {
  const material = litMaterial(playerUniforms(), liveUniforms());
  const vertex = glsl330(
    VERTEX_PRELUDE + nativeAttributes(replaceChunks(material.vertexShader, VERTEX_CHUNKS), LIT_LOCATIONS),
    "vertex",
  );
  const fragment = glsl330(FRAGMENT_PRELUDE + replaceChunks(material.fragmentShader, FRAGMENT_CHUNKS), "fragment");
  return { vertex, fragment };
}

/** One edit to the website's source; it must apply exactly once, or the export stops. */
function edit(source: string, from: string, to: string): string {
  const at = source.indexOf(from);
  if (at < 0 || source.indexOf(from, at + 1) >= 0) throw new Error(`Living hilt glow shader changed near: ${from}`);
  return source.replace(from, to);
}

/**
 * The glow's camera-facing quads are made in view space. Native's first-person draw has no modelViewMatrix of its own:
 * the vertex is skinned in the viewmodel's space, offset and mirrored as the player programs do (project_vertex), and
 * the draw passes the view and projection apart (live_hilt_layer.hpp).
 */
function glowShaders() {
  const material = glowMaterial(liveUniforms());
  let vertex = material.vertexShader as string;
  vertex = edit(vertex, "a = bindMatrixInverse * (bm * (bindMatrix * a));", "a = bm * a;");
  vertex = edit(vertex, "b = bindMatrixInverse * (bm * (bindMatrix * b));", "b = bm * b;");
  vertex = edit(
    vertex,
    "  vec4 va = modelViewMatrix * a",
    "  a.xyz += offset;\n  a.y *= mirror;\n  b.xyz += offset;\n  b.y *= mirror;\n  vec4 va = modelViewMatrix * a",
  );
  vertex = `uniform mat4 modelViewMatrix, projectionMatrix;\n${vertex}`;
  return {
    vertex: glsl330(VERTEX_PRELUDE + nativeAttributes(replaceChunks(vertex, VERTEX_CHUNKS), GLOW_LOCATIONS), "vertex"),
    fragment: glsl330(FRAGMENT_PRELUDE + replaceChunks(material.fragmentShader, FRAGMENT_CHUNKS), "fragment"),
  };
}

const directory = resolve(process.argv[2] ?? "target/native-assets");
const rig = vmRig();
const knifeBone = rig.bone("Knife_Handle");
const designs: Record<string, unknown> = {};
let triangles = 0;
for (const design of LIVE_DESIGNS) {
  const knives: Record<string, unknown> = {};
  for (const knife of KNIVES) {
    const meshes = liveMeshes(design, knife);
    triangles = Math.max(triangles, meshes.tris);
    knives[knife.id] = {
      lit: store(meshes.lit, LIT_LAYOUT),
      glow: store(meshes.glow, GLOW_LAYOUT),
      pivots: pivots(design.id, knife),
    };
  }
  designs[design.id] = knives;
}
const lit = litShaders(),
  glow = glowShaders();
await writeFile(resolve(directory, "live-hilts.bin"), Buffer.concat(pieces));
await writeFile(
  resolve(directory, "live-hilts.json"),
  JSON.stringify({
    pieces: PIECES,
    channels: CHANNELS,
    litLayout: LIT_LAYOUT,
    glowLayout: GLOW_LAYOUT,
    litLocations: LIT_LOCATIONS,
    glowLocations: GLOW_LOCATIONS,
    knifeBind: Array.from(rig.bind.subarray(knifeBone * 12, knifeBone * 12 + 12)),
    teeth: TEETH,
    designs,
  }),
);
await writeFile(resolve(directory, "live-hilt-vertex.glsl"), lit.vertex);
await writeFile(resolve(directory, "live-hilt-fragment.glsl"), lit.fragment);
await writeFile(resolve(directory, "live-glow-vertex.glsl"), glow.vertex);
await writeFile(resolve(directory, "live-glow-fragment.glsl"), glow.fragment);
console.log(
  `native living hilts: ${LIVE_DESIGNS.length} designs on ${KNIVES.length} knives, at most ${triangles} triangles, ` +
    `${(byteOffset / 1048576).toFixed(1)} MiB packed`,
);
