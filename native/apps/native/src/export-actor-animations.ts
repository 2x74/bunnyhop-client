// Explicit offline regeneration: preserve the hosted Source animation data, not sampled character gaits.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { ensureCanonicalWasm } from "../ensure-wasm";
import { Core } from "../../web/src/core";
import { StudioData } from "../../web/src/player/studio/data";
import { BoneSetup } from "../../web/src/player/studio/pose";
import { CsAnimState } from "../../web/src/player/studio/animstate";
import { rig, invert34 } from "../../web/src/player/bunny/rig";
const output = resolve(process.argv[2] ?? "target/native-assets"),
  wasm = await ensureCanonicalWasm();
const files = {
  "models/player/cs_player_shared.mdl": {
    sha256: "b290f017e35b021cbef0e3cc64a37313dc3564c1c90204389c205632bcec3c13",
    size: 2065544,
  },
  "models/player/ak_anims_ct.mdl": {
    sha256: "db5653d3d05c4dd729a2e50899b7278841a9bd9a764ebfc539d414fd682f7a0e",
    size: 99744,
  },
  "models/player/ak_anims_t.mdl": {
    sha256: "d68e3409fc4393e22c3180b961b7593897b5086cafca7c6a3e8beda84d6519b7",
    size: 99316,
  },
};
const core = await Core.create(await readFile(wasm));
core.contentMountListing("player", Object.keys(files));
for (const [name, f] of Object.entries(files)) {
  const cache = resolve(import.meta.dir, "../../../target/native-source-cache", f.sha256);
  const valid = (bytes: Uint8Array) =>
    bytes.length === f.size && createHash("sha256").update(bytes).digest("hex") === f.sha256;
  let bytes = await readFile(cache).catch(() => null);
  if (!bytes || !valid(bytes)) {
    const response = await fetch(`https://bunnyhop.lol/content/${f.sha256}`, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw Error(`hosted animation HTTP ${response.status}: ${name}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (!valid(bytes)) throw Error(`hosted animation integrity: ${name}`);
    await mkdir(dirname(cache), { recursive: true });
    await writeFile(cache, bytes);
  }
  core.contentAddFile(name, bytes);
}
core.contentResolve([]);
const handle = core.studioLoad("models/player/cs_player_shared.mdl");
if (!handle)
  throw Error("studio load failed: " + core.lastError() + " pending " + JSON.stringify(core.contentPending()));
const d = new StudioData(core, handle),
  bs = new BoneSetup(d),
  anim = new CsAnimState(d, bs);
d.warm(anim.sequences());
const used = new Set<number>(),
  seen = new Set<number>();
function visit(i: number) {
  if (i < 0 || seen.has(i)) return;
  seen.add(i);
  for (const a of d.seqs[i].anims) used.add(a);
  for (const l of d.seqs[i].layers) visit(l.seq);
}
anim.sequences().forEach(visit);
const chunks: Buffer[] = [],
  offsets: Record<string, number> = {};
let count = 0;
for (const i of used) {
  const data = d.anim(i);
  offsets[i] = count;
  chunks.push(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  count += data.length;
}
const r = rig(),
  inverse = new Float32Array(r.bind.length);
for (let i = 0; i < r.names.length; i++) invert34(r.bind, i * 12, inverse, i * 12);
await mkdir(output, { recursive: true });
await writeFile(`${output}/actor-animations.bin`, Buffer.concat(chunks));
await writeFile(
  `${output}/actor-animations.json`,
  JSON.stringify({
    version: 1,
    source: "current-web CsAnimState / hosted cs_player_shared",
    sources: files,
    info: d.info,
    offsets,
    rig: {
      names: r.names,
      bind: Array.from(r.bind),
      parent: Array.from(r.parent),
      csBones: r.csBones,
      inverse: Array.from(inverse),
      map: r.names.map((n) => d.bone(n)),
    },
  }),
);
console.log(`${used.size} original animations, ${count * 4} bytes`);
