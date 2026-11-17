// Build-time only: the website's hop effects (player/hop-fx.ts recipes, player/hop-layer.ts shaders) for the native
// renderer (hop_effects.hpp). The recipes go out with every default resolved, so the client reads plain numbers; a
// field the spawn maths only draws a random number for when it is set keeps that as a flag. The shaders are the
// website's GLSL with three.js's names swapped for native ones.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  HOP_EXITS,
  HOP_FRAME_CAP,
  HOP_FX,
  HOP_GAP,
  HOP_GLOW_CAP,
  HOP_INHERIT_CAP,
  HOP_ORIENTS,
  HOP_RECORD,
  HOP_SHAPES,
  NO_CUT,
  linearRgb,
  type HopColor,
  type HopPart,
} from "../../web/src/player/hop-fx";
import { HOP_TRAIL_DEFAULT } from "../../web/src/loadout";
import { HOP_POOL, HOP_SLOTS, REACH_FAR, REACH_REFINE, REACH_STEP, REACH_STEPS } from "../../web/src/player/hop-layer";

/** A colour: the trail's first (-1) or second (-2) colour, else a fixed linear colour. */
function color(c: HopColor): number[] {
  if (c === "tint") return [-1, 0, 0];
  if (c === "tint2") return [-2, 0, 0];
  return linearRgb(c);
}

function part(p: HopPart) {
  const span = (r: readonly [number, number] | undefined) => (r ? [r[0], r[1]] : null);
  return {
    shape: HOP_SHAPES.indexOf(p.shape),
    orient: HOP_ORIENTS.indexOf(p.orient),
    exit: HOP_EXITS.indexOf(p.exit ?? "fade"),
    n: p.n,
    life: [p.life[0], p.life[1]],
    size: [p.size[0], p.size[1]],
    jitter: p.jitter ?? 0.15,
    ease: p.ease ?? 2,
    aspect: p.aspect ?? 1,
    out: span(p.out),
    up: span(p.up),
    swirl: p.swirl ?? 0,
    ring: p.ring ?? 0,
    lift: p.lift ?? 0,
    rim: !!p.rim,
    radial: !!p.radial,
    arc: p.arc ?? 360,
    aim: p.aim ?? null,
    spread: p.spread ?? (p.rim ? 0 : 0.3),
    inherit: p.inherit ?? 0,
    gravity: p.gravity ?? 0,
    drag: p.drag ?? 0,
    tilt: p.tilt ?? Math.PI,
    spin: p.spin ?? 0,
    turn: p.turn ?? 0,
    flutter: p.flutter ? [p.flutter[0], p.flutter[1]] : [0, 0],
    rock: p.rock ?? 0,
    lean: p.lean ?? 0,
    color: color(p.color),
    color2: color(p.color2 ?? p.color),
    white: p.white ?? 0,
    cool: p.cool ?? 0.3,
    soft: p.soft ?? 0.6,
    flicker: p.flicker ?? 0,
    char: p.char ?? 0,
    alpha: p.alpha ?? 1,
    glow: p.glow ?? 0,
    hold: p.hold ?? 0.5,
    pop: p.pop ?? 0.6,
    over: p.over ?? 0.12,
    attack: p.attack ?? 0.07,
    param: p.param ?? 0,
    wait: p.wait ?? 0,
    delay: p.delay ?? 0,
  };
}

const ATTRIBUTES = ["iA", "iB", "iC", "iD", "iE", "iF", "iG", "iH", "iI", "iJ", "iK", "iL", "iM"];

/** A `const NAME = /* glsl *\/ `...`;` literal from hop-layer.ts, with its one interpolation filled in. */
function literal(source: string, name: string): string {
  const found = source.match(new RegExp(`const ${name} = /\\* glsl \\*/ \x60([\\s\\S]*?)\x60;`))?.[1];
  if (!found) throw new Error(`Missing upstream hop shader ${name}`);
  return found.replaceAll("${HOP_SLOTS}", String(HOP_SLOTS));
}

/**
 * macOS's OpenGL draws nothing when the fragment shader reads vC1's alpha after its shape code (the program links and
 * every other output works), so the alpha travels in a varying of its own.
 */
function ownAlpha(source: string, stage: "vertex" | "fragment"): string {
  const replace = (text: string, from: string, to: string) => {
    if (!text.includes(from)) throw new Error(`Hop shader changed: ${from}`);
    return text.replace(from, to);
  };
  if (stage === "vertex")
    return replace(
      replace(source, "varying vec4 vC1;", "varying vec4 vC1;\nvarying float vAlpha;"),
      "vC1 = vec4(iD.rgb, a);",
      "vC1 = vec4(iD.rgb, a);\n  vAlpha = a;",
    );
  return replace(source, "varying vec4 vC1;", "varying vec4 vC1;\nvarying float vAlpha;").replaceAll("vC1.a", "vAlpha");
}

function vertexShader(source: string): string {
  let out = ownAlpha(source, "vertex");
  ATTRIBUTES.forEach((name, i) => {
    const declaration = `attribute vec4 ${name};`;
    if (!out.includes(declaration)) throw new Error(`Hop shader attribute ${name} missing`);
    out = out.replace(declaration, `layout(location=${i + 1}) in vec4 ${name};`);
  });
  if (out.includes("attribute ")) throw new Error("Hop shader has an attribute native doesn't bind");
  return (
    "#version 330 core\nlayout(location=0) in vec3 position;\nuniform mat4 modelViewMatrix, projectionMatrix;\n" +
    out.replace(/\bvarying\b/g, "out")
  );
}

function fragmentShader(source: string): string {
  const encode = `out vec4 fragColor;
vec4 linearToOutputTexel(vec4 c) {
  vec3 x = max(c.rgb, vec3(0.0));
  return vec4(mix(x * 12.92, 1.055 * pow(x, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), x)), c.a);
}
`;
  return (
    "#version 330 core\n" +
    encode +
    ownAlpha(source, "fragment")
      .replace(/\bvarying\b/g, "in")
      .replace(/\bgl_FragColor\b/g, "fragColor")
  );
}

/** Writes hop-fx.json, hop-vertex.glsl and hop-fragment.glsl into `directory`. */
export async function writeHopEffects(directory: string): Promise<void> {
  const layer = await readFile(resolve(import.meta.dir, "../../web/src/player/hop-layer.ts"), "utf8");
  const recipes = {
    record: HOP_RECORD,
    pool: HOP_POOL,
    slots: HOP_SLOTS,
    frameCap: HOP_FRAME_CAP,
    gap: HOP_GAP,
    inheritCap: HOP_INHERIT_CAP,
    glowCap: HOP_GLOW_CAP,
    noCut: NO_CUT,
    reach: { step: REACH_STEP, steps: REACH_STEPS, refine: REACH_REFINE, far: REACH_FAR },
    defaultTrail: HOP_TRAIL_DEFAULT,
    effects: Object.fromEntries(Object.entries(HOP_FX).map(([id, def]) => [id, def.parts.map(part)])),
  };
  await writeFile(resolve(directory, "hop-fx.json"), JSON.stringify(recipes));
  await writeFile(resolve(directory, "hop-vertex.glsl"), vertexShader(literal(layer, "VERTEX")));
  await writeFile(resolve(directory, "hop-fragment.glsl"), fragmentShader(literal(layer, "FRAGMENT")));
}
