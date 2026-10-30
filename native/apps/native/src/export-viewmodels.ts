// Build-time only: compile the site's original meshes, material recipes and procedural pose clips.
// Runtime gameplay uses C++/OpenGL and Rust; this compiler is never embedded in the application.
import { mkdir, writeFile, rm } from "node:fs/promises";
import type * as THREE from "three";
import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Builder } from "../../web/src/player/bunny/builder";
import { concat, rig as bunnyRig } from "../../web/src/player/bunny/rig";
import { buildBunnyGeometry } from "../../web/src/player/bunny/mesh";
import { BunnyProcedural } from "../../web/src/player/bunny/procedural";
import { COSMETICS, HAIR_HATS, LENGTH_HATS, HAIR_LENGTH } from "../../web/src/progression";
import { COLOURWAYS } from "../../web/src/player/bunny/palettes";
import { hatGeometry, headwearKey } from "../../web/src/player/bunny/hats";
import { hatFit } from "../../web/src/player/bunny/hat-fit";
import { ensureHeadwear } from "../../web/src/player/hat-detail";
import { bakeGunAO } from "../../web/src/viewmodel/guns/ao";
import { writePlayerMaterials } from "./export-player-materials";
import { crownGeometry } from "../../web/src/player/bunny/crown";
import { vmRig } from "../../web/src/viewmodel/rig";
import { VmProcedural, PROC_DURATION, type VmAction } from "../../web/src/viewmodel/procedural";
import { buildFpHands } from "../../web/src/viewmodel/gloves/fp";
import { fpCtx, tpCtx } from "../../web/src/viewmodel/knives/ctx";
import { inspectSetFor } from "../../web/src/viewmodel/inspects/index";
import { Arm } from "../../web/src/viewmodel/inspects/kit";
import { KnifeHold } from "../../web/src/viewmodel/knives/hold";
import { KNIVES } from "../../web/src/viewmodel/knives/index";
import { gunFpCtx, gunRig } from "../../web/src/viewmodel/guns/rig";
import { GunPoser } from "../../web/src/viewmodel/guns/pose";
import { GUNS, gunById } from "../../web/src/viewmodel/guns/index";
import {
  bunnyGunGeometry,
  bunnyHold,
  bunnySilencerGeometry,
  worldGunGeometry,
} from "../../web/src/viewmodel/guns/meshes";
import { fistFrames } from "../../web/src/player/bunny/gun-hold";
import { holdData } from "./gun-hold-data";
import { FINISH_STYLE, GLOVE_STYLE, GLOVE_STYLE_IDS, HAIR_DEFAULT } from "../../web/src/loadout";
import { FINISH_CODE } from "../../web/src/viewmodel/finishes/shader";
import { clampFingers } from "../../web/src/viewmodel/fingers";
import { WHIRL_FLICK } from "../../web/src/viewmodel/knives/whirligig";
// The knives' wall-clock motion (the bayonets' idle sway, the Whirligig's thumb flicks) reads performance.now(). Freeze
// it so the baked clips don't depend on when they were built; native adds the spinner's flicks at runtime.
Object.defineProperty(performance, "now", { value: () => 0, configurable: true });
const directory = resolve(process.argv[2] ?? "target/native-assets");
// Floats per vertex: position 3, normal 3, partColor 3, skinIndex 4, skinWeight 4, accent 1, finishUV 4, headwear 1.
const STRIDE = 23;
const pieces: Buffer[] = [];
let byteOffset = 0;
const put = (data: Float32Array) => {
  const offset = byteOffset;
  pieces.push(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  byteOffset += data.byteLength;
  return offset;
};
const meshes: Record<string, any> = {},
  entries: Record<string, any> = {};
const blobs = new Map<string, number>();
const putUnique = (v: Float32Array) => {
  const key = createHash("sha256")
    .update(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))
    .digest("hex");
  const at = blobs.get(key);
  if (at !== undefined) return at;
  const offset = put(v);
  blobs.set(key, offset);
  return offset;
};
function geometry(name: string, g: any) {
  const p = g.getAttribute("position"),
    n = g.getAttribute("normal"),
    c = g.getAttribute("partColor"),
    a = g.getAttribute("accent"),
    ids = g.getAttribute("skinIndex"),
    weights = g.getAttribute("skinWeight"),
    finish = g.getAttribute("finishUV"),
    headwear = g.getAttribute("headwear");
  // Body meshes are weapon-free: selected TP weapons render as separate parts.
  if (name.startsWith("body:")) {
    const knifeBone = bunnyRig().index("bunny.Knife");
    for (let i = 0; i < p.count; i++)
      for (let j = 0; j < 4; j++)
        if (ids.array[i * 4 + j] === knifeBone && weights.array[i * 4 + j] > 0)
          throw new Error("Embedded default knife in body: " + name);
  }
  const vertices = new Float32Array(p.count * STRIDE);
  for (let i = 0; i < p.count; i++) {
    const at = i * STRIDE;
    vertices.set(
      [p.getX(i), p.getY(i), p.getZ(i), n.getX(i), n.getY(i), n.getZ(i), c.getX(i), c.getY(i), c.getZ(i)],
      at,
    );
    for (let j = 0; j < 4; j++) {
      vertices[at + 9 + j] = ids.array[i * 4 + j];
      vertices[at + 13 + j] = weights.array[i * 4 + j];
      vertices[at + 18 + j] = finish?.array[i * 4 + j] ?? 0;
    }
    vertices[at + 17] = a.getX(i);
    vertices[at + 22] = headwear?.getX(i) ?? 0;
  }
  // Index identical vertices; source builders intentionally emit triangle soup.
  const unique: number[] = [],
    indices = new Uint32Array(p.count),
    seen = new Map<string, number>();
  for (let i = 0; i < p.count; i++) {
    const view = new Uint8Array(vertices.buffer, i * STRIDE * 4, STRIDE * 4);
    const key = Buffer.from(view).toString("base64");
    let at = seen.get(key);
    if (at === undefined) {
      at = unique.length / STRIDE;
      seen.set(key, at);
      for (let j = 0; j < STRIDE; j++) unique.push(vertices[i * STRIDE + j]);
    }
    indices[i] = at;
  }
  const sums = new Map<string, [number, number, number]>();
  const keys: string[] = [];
  for (let i = 0; i < p.count; i++) {
    const key = [
      p.getX(i).toFixed(4),
      p.getY(i).toFixed(4),
      p.getZ(i).toFixed(4),
      ...Array.from(ids.array.slice(i * 4, i * 4 + 4)),
    ].join(",");
    keys.push(key);
    const sum = sums.get(key) ?? [0, 0, 0];
    sum[0] += n.getX(i);
    sum[1] += n.getY(i);
    sum[2] += n.getZ(i);
    sums.set(key, sum);
  }
  const smooth = new Float32Array((unique.length / STRIDE) * 3);
  for (let i = 0; i < p.count; i++) {
    const normal = sums.get(keys[i])!;
    const length = Math.hypot(...normal) || 1;
    smooth.set(
      normal.map((value) => value / length),
      indices[i] * 3,
    );
  }
  meshes[name] = {
    glowOffset: putUnique(smooth),
    offset: putUnique(new Float32Array(unique)),
    vertices: unique.length / STRIDE,
    indexOffset: putUnique(new Float32Array(indices.buffer)),
    indices: indices.length,
  };
  g.dispose();
}
/**
 * The website places a bunny's gun each frame with its two-handed hold (player/bunny/gun-hold.ts); its mesh is baked
 * with the grip in the right fist's bind pose and skinned to its own two bones, the gun and the magazine. Native
 * appends those two bones after the rig's (gun_hold.hpp writes them), so the mesh keeps both.
 */
function onGunBones(source: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = source.clone();
  const first = bunnyRig().names.length;
  const ids = g.getAttribute("skinIndex"),
    weights = g.getAttribute("skinWeight");
  for (let i = 0; i < ids.count; i++) {
    ids.setXYZW(i, first + (ids.getX(i) === 1 ? 1 : 0), 0, 0, 0);
    weights.setXYZW(i, 1, 0, 0, 0);
  }
  return g;
}
const vr = vmRig(),
  gr = gunRig(),
  br = bunnyRig();
/**
 * The website's last steps on a knife pose (viewmodel.ts pose): the extra bones and state.local follow the hold (the
 * balisong's halves, the Whirligig's spinner, the Karrotbit's draw twirl), then no finger bends past its range.
 */
function finishPose(hold: KnifeHold, W: Float32Array): void {
  hold.solve(W);
  clampFingers(W, vr);
}
/**
 * The Whirligig's spinner bone: its axle in bind space (the bone's local x through its origin) and the idle flicks, so
 * native turns it on the wall clock like the website (knives/whirligig.ts whirlIdle).
 */
function spinner() {
  const bone = vr.bone("Whirl_Spin"),
    at = bone * 12;
  const axis = [vr.bind[at], vr.bind[at + 4], vr.bind[at + 8]];
  const pivot = [vr.bind[at + 3], vr.bind[at + 7], vr.bind[at + 11]];
  const knives = KNIVES.filter((def) => def.joints?.includes("Whirl_Spin")).map((def) => def.id);
  return { bone, axis, pivot, knives, ...WHIRL_FLICK };
}
for (const glove of GLOVE_STYLE_IDS) {
  const b = new Builder();
  buildFpHands(b, glove);
  geometry(`hands:${glove}`, b.geometry());
}
for (const def of KNIVES) {
  const b = new Builder();
  def.build(fpCtx(b));
  geometry(`fpknife:${def.id}`, b.geometry());
  const tp = new Builder();
  def.build(tpCtx(tp, def.tp));
  geometry(`tpknife:${def.id}`, tp.geometry());
}
for (const def of GUNS) {
  const b = new Builder();
  const ctx = gunFpCtx(b);
  def.build(ctx);
  def.silencer?.build(ctx);
  // The website bakes soft occlusion into the gun's recesses (guns/ao.ts); hands neither give nor take it.
  const gun = b.geometry();
  bakeGunAO(gun);
  geometry(`fpgun:${def.id}`, gun);
  geometry(`tpgun:${def.id}`, onGunBones(bunnyGunGeometry(def)));
  geometry(`worldgun:${def.id}`, worldGunGeometry(def).clone());
  const sil = bunnySilencerGeometry(def);
  if (sil) geometry(`tpsilencer:${def.id}`, onGunBones(sil));
}
for (const glove of GLOVE_STYLE_IDS) {
  for (const def of KNIVES) {
    const proc = new VmProcedural(vr),
      hold = new KnifeHold(def, vr, glove),
      W = new Float32Array(vr.names.length * 12),
      S = new Float32Array(W.length),
      clips = [];
    for (const action of ["idle", "draw", "slash1", "slash2", "stab"] as VmAction[]) {
      const duration = action === "idle" ? 0 : PROC_DURATION[action],
        frames = duration ? Math.ceil(duration * 60) + 1 : 1,
        baked = new Float32Array(frames * S.length);
      for (let f = 0; f < frames; f++) {
        const t = Math.min(duration, f / 60);
        proc.pose(action, t, W);
        hold.apply(W, action, t, "procedural");
        finishPose(hold, W);
        for (let i = 0; i < vr.names.length; i++) concat(W, i * 12, vr.inv, i * 12, S, i * 12);
        baked.set(S, f * S.length);
      }
      clips.push({ name: action, duration, frames, offset: putUnique(baked) });
    }
    const inspect = inspectSetFor(def),
      arm = new Arm(vr);
    for (let j = 0; j < inspect.clips.length; j++) {
      const c = inspect.clips[j],
        frames = Math.ceil(c.len * 60) + 1,
        baked = new Float32Array(frames * S.length);
      for (let f = 0; f < frames; f++) {
        const t = Math.min(c.len, f / 60);
        proc.pose("idle", 0, W);
        hold.state.show = c.show?.(t) ?? 0;
        hold.apply(W, "idle", 0, "procedural");
        c.apply(W, t, { arm, knife: def, state: hold.state });
        finishPose(hold, W);
        for (let i = 0; i < vr.names.length; i++) concat(W, i * 12, vr.inv, i * 12, S, i * 12);
        baked.set(S, f * S.length);
      }
      clips.push({ name: `inspect${j}`, duration: c.len, frames, offset: putUnique(baked) });
    }
    entries[`knife:${def.id}:${glove}`] = {
      bones: vr.names.length,
      meshes: [`hands:${glove}`, `fpknife:${def.id}`],
      clips,
    };
  }
  for (const def of GUNS) {
    const clips = [];
    const actions = [
      "idle",
      "draw",
      "fire",
      "reload",
      "reloadEmpty",
      "inspect",
      ...(def.timing.shells ? ["shellStart", "shellInsert", "shellEnd"] : []),
      ...(def.silencer ? ["silencerOn", "silencerOff"] : []),
    ];
    for (const action of actions)
      for (const silenced of def.silencer && !action.startsWith("silencer") ? [false, true] : [false]) {
        const poser = new GunPoser();
        poser.setGun(def, glove);
        poser.anim.silenced = silenced;
        const duration =
          action === "idle"
            ? 0
            : action.startsWith("reload")
              ? (def.timing.reload ?? 2.5)
              : action === "fire"
                ? 0.8
                : action === "inspect"
                  ? 2.4
                  : action === "shellStart"
                    ? (def.timing.shells?.start ?? 0.45)
                    : action === "shellInsert"
                      ? (def.timing.shells?.each ?? 0.5)
                      : action === "shellEnd"
                        ? (def.timing.shells?.end ?? 0.6)
                        : action.startsWith("silencer")
                          ? 114 / 37
                          : Math.min(def.timing.draw, 1) * 0.85;
        if (action === "draw") poser.draw();
        else if (action === "fire") poser.anim.fire();
        else if (action.startsWith("reload")) poser.anim.reload(duration, action === "reloadEmpty");
        else if (action === "inspect") poser.anim.inspect();
        else if (action === "shellStart") poser.anim.shellStart(duration);
        else if (action === "shellInsert") poser.anim.shellInsert(duration);
        else if (action === "shellEnd") poser.anim.shellEnd(duration);
        else if (action.startsWith("silencer")) poser.anim.silencer(action === "silencerOn", duration);
        // Thirty pose samples/sec with interpolation retain the authored motion while bounding expanded gun assets.
        const frames = duration ? Math.ceil(duration * 30) + 1 : 1,
          matrix = new Float32Array(gr.count * 12),
          baked = new Float32Array(frames * matrix.length);
        for (let f = 0; f < frames; f++) {
          poser.update(f ? 1 / 30 : 0);
          matrix.set(poser.bonesW);
          for (let i = 0; i < gr.hands.names.length; i++)
            concat(poser.bonesW, i * 12, gr.hands.inv, i * 12, matrix, i * 12);
          baked.set(matrix, f * matrix.length);
        }
        clips.push({ name: action + (silenced ? ":silenced" : ""), duration, frames, offset: putUnique(baked) });
      }
    entries[`gun:${def.id}:${glove}`] = { bones: gr.count, meshes: [`hands:${glove}`, `fpgun:${def.id}`], clips };
  }
  console.log(`native assets: original knives/guns and ${glove} hands`);
}
for (const look of ["bunny", "tek", "plush", "bune"] as const)
  for (const body of look === "bunny" ? (["classic", "feminine"] as const) : (["classic"] as const))
    for (const glove of GLOVE_STYLE_IDS)
      for (const hood of look === "bunny" ? (["up", "down"] as const) : (["up"] as const))
        geometry(
          `body:${look}:${body}:${glove}${hood === "down" ? ":down" : ""}`,
          buildBunnyGeometry({ ...KNIVES[0], build: () => {} }, glove, look, body, hood),
        );
const headwearMesh = (name: string, g: THREE.BufferGeometry) => {
  const copy = g.clone();
  ensureHeadwear(copy);
  geometry(name, copy);
};
for (const tier of [1, 2, 3] as const) headwearMesh(`crown:${tier}`, crownGeometry(tier));
const HAT_IDS = COSMETICS.filter((c) => c.slot === "hat").map((c) => c.id);
const BODY_LOOKS = ["bunny", "tek", "plush", "bune"] as const;
const hatMeshes: Record<string, Record<string, string>> = {};
for (const id of HAT_IDS) {
  hatMeshes[id] = {};
  for (const look of BODY_LOOKS) {
    const key = headwearKey(id, look);
    const g = hatGeometry(key);
    if (!g) continue;
    if (!meshes[key]) headwearMesh(key, g);
    hatMeshes[id][look] = key;
  }
}
const hatFits = Object.fromEntries(
  BODY_LOOKS.map((look) => [look, Object.fromEntries(["", ...HAT_IDS].map((id) => [id, hatFit(look, id || null)]))]),
);
{
  const clips = [];
  for (const action of ["idle", "run", "crouch", "air", "fall"])
    for (const pitch of [-60, 0, 60]) {
      const random = Math.random;
      Math.random = () => 0;
      const actor = new BunnyProcedural();
      Math.random = random;
      const velocity =
        action === "run"
          ? [250, 0, 0]
          : action === "air"
            ? [100, 0, 200]
            : action === "fall"
              ? [100, 0, -300]
              : [0, 0, 0];
      const state = {
        position: [0, 0, 0],
        velocity,
        yaw: 0,
        pitch,
        crouched: action === "crouch",
        grounded: action !== "air" && action !== "fall",
      };
      const duration = action === "run" ? 115 / 250 : 2,
        frames = Math.ceil(duration * 60) + 1,
        skin = new Float32Array(br.names.length * 12),
        baked = new Float32Array(frames * skin.length);
      for (let f = 0; f < frames; f++) {
        actor.update(f ? 1 / 60 : 0, state, velocity, f === 0, false, skin);
        for (let i = br.csBones; i < br.names.length; i++) {
          const parent = br.parent[i];
          if (parent >= 0) skin.copyWithin(i * 12, parent * 12, parent * 12 + 12);
        }
        baked.set(skin, f * skin.length);
      }
      clips.push({ name: `${action}:${pitch}`, duration, frames, offset: putUnique(baked) });
    }
  entries.bunny = { bones: br.names.length, meshes: [], clips };
}
const ids = [
  "",
  "knife",
  "glock",
  "usp",
  "p228",
  "deagle",
  "elite",
  "fiveseven",
  "m3",
  "xm1014",
  "mac10",
  "tmp",
  "mp5navy",
  "ump45",
  "p90",
  "galil",
  "famas",
  "ak47",
  "m4a1",
  "sg552",
  "aug",
  "scout",
  "awp",
  "g3sg1",
  "sg550",
  "m249",
];
await mkdir(directory, { recursive: true });
const compressed = deflateSync(Buffer.concat(pieces), { level: 9 });
await writeFile(resolve(directory, "viewmodels.bin.z"), compressed);
await rm(resolve(directory, "viewmodels.bin"), { force: true });
await writeFile(
  resolve(directory, "viewmodels.json"),
  JSON.stringify({
    version: 3,
    stride: STRIDE,
    bytes: byteOffset,
    weapons: ids.map((id) => (id === "knife" ? id : (gunById(id)?.id ?? ""))),
    meshes,
    entries,
    gunMuzzles: Object.fromEntries(
      GUNS.map((d) => [
        d.id,
        {
          point: d.muzzle,
          part: gr.part(d.cls === "pistol" ? "Slide" : "Gun"),
          ...(d.silencer ? { silPoint: d.silencer.tip, silPart: gr.part("Sil") } : {}),
        },
      ]),
    ),
    ghostColors: Object.fromEntries(
      COSMETICS.filter((c) => c.slot === "ghost" || c.slot === "trail").map((c) => [
        c.id,
        [c.color, c.color2 ?? c.color],
      ]),
    ),
    actorRig: { names: br.names, parent: Array.from(br.parent), bind: Array.from(br.bind), csBones: br.csBones },
    gunHolds: Object.fromEntries(GUNS.map((def) => [def.id, holdData(bunnyHold(def))])),
    fists: Object.fromEntries(Object.entries(fistFrames(br)).map(([key, m]) => [key, Array.from(m)])),
    outfits: COLOURWAYS,
    hats: hatMeshes,
    hatFits,
    hair: { hats: HAIR_HATS, lengthHats: LENGTH_HATS, length: HAIR_LENGTH, defaultColor: HAIR_DEFAULT },
    gloves: GLOVE_STYLE,
    inspects: Object.fromEntries(
      KNIVES.map((def) => [
        def.id,
        inspectSetFor(def).clips.map((c) => ({
          duration: c.len,
          enter: c.enter,
          exit: c.exit,
          open: c.open,
          loop: c.loop,
          cues: (c.cues ?? []).map((cue) => [cue.t, cue.type]),
        })),
      ]),
    ),
    spinner: spinner(),
    finishes: Object.fromEntries(Object.entries(FINISH_STYLE).map(([id, spec]) => [id, FINISH_CODE[spec.kind]])),
  }),
);
await writePlayerMaterials(directory);
// Shader pieces older builds compiled from; the player materials above replace them.
for (const name of [
  "cosmetic-vertex-pars",
  "cosmetic-vertex-main",
  "cosmetic-fragment-pars",
  "cosmetic-fragment-albedo",
  "cosmetic-fragment-light",
  "hat-vertex-pars",
  "hat-vertex-normal",
  "hat-vertex-position",
  "hat-fragment-pars",
  "hat-fragment-solid",
  "glow-noise",
  "glow-fragment",
])
  await rm(resolve(directory, name + ".glsl"), { force: true });
console.log(
  `native original meshes/poses/cosmetics: ${(byteOffset / 1048576).toFixed(1)} MiB native data, ${(compressed.byteLength / 1048576).toFixed(1)} MiB packaged -> ${directory}`,
);

// Hosted actor clips share the pinned verifier decoder; package no procedural-only release.
const actorExport = Bun.spawnSync(
  [process.execPath, resolve(import.meta.dir, "export-actor-animations.ts"), directory],
  { stdout: "inherit", stderr: "inherit" },
);
if (actorExport.exitCode) throw new Error("Hosted actor animation export failed");

const gestureExport = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "export-tp-inspects.ts"), directory], {
  stdout: "inherit",
  stderr: "inherit",
});
if (gestureExport.exitCode) throw new Error("Third-person inspect export failed");

const avatarExport = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "export-avatar.ts"), directory], {
  stdout: "inherit",
  stderr: "inherit",
});
if (avatarExport.exitCode) throw new Error("Avatar pose export failed");

const runnerExport = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "export-runner.ts"), directory], {
  stdout: "inherit",
  stderr: "inherit",
});
if (runnerExport.exitCode) throw new Error("Original runner export failed");
