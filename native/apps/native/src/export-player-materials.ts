// Build-time only: the website's player materials (player/materials.ts solid and ghost, viewmodel/guns/material.ts
// guns) as OpenGL 3.3 programs for the native renderer. The web sources are taken as three.js builds them, and only
// three.js's own chunks are swapped for native ones: GPU skinning from the native bone texture, the native projection,
// the first-person offset and mirror, and the player glow's aura pass. Everything else (garments, finishes, gloves,
// hats, wigs, guns) runs the website's GLSL unchanged, in the website's Y-up world space.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ghostMaterial, playerUniforms, solidMaterial } from "../../web/src/player/materials";
import { gunMaterial } from "../../web/src/viewmodel/guns/material";
import { NO_LOOK } from "../../web/src/viewmodel/finishes/shader";

/** Vertex attribute locations, matching NativeViewmodel's vertex layout. */
const ATTRIBUTE_LOCATIONS: Record<string, number> = {
  position: 0,
  normal: 1,
  partColor: 2,
  skinIndex: 3,
  skinWeight: 4,
  accent: 5,
  finishUV: 6,
  glowNormal: 7,
  headwear: 8,
};

const VERTEX_PRELUDE = `
layout(location=0) in vec3 position;
layout(location=1) in vec3 normal;
layout(location=3) in vec4 skinIndex;
layout(location=4) in vec4 skinWeight;
layout(location=7) in vec3 glowNormal;
uniform mat4 projection, model, modelMatrix, viewMatrix;
uniform vec3 cameraPosition, offset;
uniform float mirror, auraPass, auraSize, glowTime;
out float vGlowAlpha, vHalo;
out vec2 vAuraCoord;
`;

const FRAGMENT_PRELUDE = `
uniform mat4 viewMatrix;
uniform vec3 cameraPosition;
out vec4 fragColor;
#define gl_FragColor fragColor
vec3 nativeEncode(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
`;

const COMMON = `
#define PI 3.141592653589793
#define saturate(a) clamp(a, 0.0, 1.0)
`;

const SKINNING_PARS = `
uniform sampler2D boneMatrices;
mat4 nativeBone(float index) {
  int i = int(index + 0.5);
  vec4 a = texelFetch(boneMatrices, ivec2(0, i), 0);
  vec4 b = texelFetch(boneMatrices, ivec2(1, i), 0);
  vec4 c = texelFetch(boneMatrices, ivec2(2, i), 0);
  return transpose(mat4(a, b, c, vec4(0.0, 0.0, 0.0, 1.0)));
}
`;

// The glow's aura pass inflates the body along its smooth normals (glowNormal); the halo pass is instanced, one shell
// per instance, with rising flame tongues (player/glow.ts).
const BEGIN_NORMAL = `
  vec3 objectNormal = auraPass > 0.5 ? glowNormal : normal;
  vec3 nativeAuraNormal = normalize(objectNormal);
`;

const BEGIN_VERTEX = `
  vec3 transformed = vec3(position);
  vHalo = auraPass > 1.5 ? 1.0 : 0.0;
  vGlowAlpha = 1.5;
  vAuraCoord = vec2(transformed.x + transformed.y * 0.47, transformed.z);
  if (auraPass > 1.5) {
    float width = 0.85 + float(gl_InstanceID) * 0.52;
    vec2 flow = vAuraCoord * vec2(0.27, 0.13) - vec2(0.0, glowTime * 2.4);
    flow.x += sin(flow.y * 1.7 + glowTime * 0.9) * 0.32;
    float tongue = smoothstep(0.27, 0.78, auraFlow(flow));
    transformed += nativeAuraNormal * width * (0.5 + tongue * 0.75) * auraSize;
    transformed.z += width * (0.15 + tongue * 1.4) * auraSize;
    transformed.x += sin(flow.y * 2.1 + glowTime) * width * 0.16 * tongue * auraSize;
    vGlowAlpha = 0.08 * pow(1.0 - float(gl_InstanceID) / 8.0, 1.15);
  } else if (auraPass > 0.5) {
    transformed += nativeAuraNormal * 0.45 * auraSize;
  }
`;

const VERTEX_CHUNKS: Record<string, string> = {
  common: COMMON,
  skinning_pars_vertex: SKINNING_PARS,
  beginnormal_vertex: BEGIN_NORMAL,
  skinbase_vertex: `
  mat4 skinMatrix = nativeBone(skinIndex.x) * skinWeight.x + nativeBone(skinIndex.y) * skinWeight.y
    + nativeBone(skinIndex.z) * skinWeight.z + nativeBone(skinIndex.w) * skinWeight.w;
`,
  skinnormal_vertex: `
  objectNormal = mat3(skinMatrix) * objectNormal;
  objectNormal.y *= mirror;
`,
  begin_vertex: BEGIN_VERTEX,
  skinning_vertex: `
  transformed = (skinMatrix * vec4(transformed, 1.0)).xyz + offset;
  transformed.y *= mirror;
`,
  project_vertex: `
  gl_Position = projection * model * vec4(transformed, 1.0);
`,
};

const FRAGMENT_CHUNKS: Record<string, string> = {
  tonemapping_fragment: "",
  colorspace_fragment: "  fragColor.rgb = nativeEncode(fragColor.rgb);\n",
};

function replaceChunks(source: string, chunks: Record<string, string>): string {
  return source.replace(/^[ \t]*#include <(\w+)>[ \t]*$/gm, (_line, name: string) => {
    const chunk = chunks[name];
    if (chunk === undefined) throw new Error(`No native replacement for three.js chunk <${name}>`);
    return chunk;
  });
}

function nativeAttributes(source: string): string {
  return source.replace(/^([ \t]*)attribute (\w+) (\w+);/gm, (_line, indent: string, type: string, name: string) => {
    const location = ATTRIBUTE_LOCATIONS[name];
    if (location === undefined) throw new Error(`No native location for attribute ${name}`);
    return `${indent}layout(location=${location}) in ${type} ${name};`;
  });
}

function glsl330(source: string, stage: "vertex" | "fragment"): string {
  return source
    .replace(/\bvarying\b/g, stage === "vertex" ? "out" : "in")
    .replace(/\btexture2D\b/g, "texture")
    .replace(/\btextureCube\b/g, "texture");
}

function insertAfter(source: string, anchor: string, addition: string): string {
  const at = source.indexOf(anchor);
  if (at < 0) throw new Error(`Native material anchor missing: ${anchor}`);
  return source.slice(0, at + anchor.length) + addition + source.slice(at + anchor.length);
}

function vertexShader(source: string, glowNoise: string): string {
  const prelude = VERTEX_PRELUDE + glowNoise;
  return glsl330(prelude + nativeAttributes(replaceChunks(source, VERTEX_CHUNKS)), "vertex");
}

/** The player glow (player/glow.ts auraFragment) as a function the solid program calls on its aura passes. */
function glowFunction(source: string, noise: string): string {
  const body = source.slice(source.indexOf("void main()"));
  const renames: [RegExp, string][] = [
    [/void main\(\)/, "vec4 glowShade()"],
    [/\buFinTime\b/g, "glowTime"],
    [/\buGlowStrength\b/g, "playerGlowIntensity"],
    [/\buOpacity\b/g, "glowOpacity"],
    [/\buGlowColor\b/g, "playerGlowColor"],
    [/\buAxisA\b/g, "glowAxisA"],
    [/\buAxisB\b/g, "glowAxisB"],
    [/\buNearFade\b/g, "glowNearFade"],
    [/gl_FragColor\s*=/g, "return "],
  ];
  let glow = body;
  for (const [from, to] of renames) glow = glow.replace(from, to);
  return `
uniform bool playerGlowEnabled;
uniform vec3 playerGlowColor, glowAxisA, glowAxisB;
uniform float playerGlowIntensity, glowOpacity, glowTime, uGlowDistance, auraPass;
uniform vec2 glowNearFade;
in float vGlowAlpha, vHalo;
in vec2 vAuraCoord;
${noise}
${glow}
`;
}

function solidFragment(source: string, glow: string): string {
  let fragment = replaceChunks(source, FRAGMENT_CHUNKS);
  // The glow function reads vNormalW / vWorldPos, so it goes after the solid material's own declarations.
  fragment = fragment.replace("void main() {", `${glow}\nvoid main() {`);
  fragment = insertAfter(
    fragment,
    `${glow}\nvoid main() {`,
    "\n  if (playerGlowEnabled && auraPass > 0.5) {\n    fragColor = glowShade();\n    return;\n  }",
  );
  return glsl330(FRAGMENT_PRELUDE + fragment, "fragment");
}

function ghostFragment(source: string): string {
  return glsl330(FRAGMENT_PRELUDE + replaceChunks(source, FRAGMENT_CHUNKS), "fragment");
}

async function glowSources(): Promise<{ noise: string; fragment: string }> {
  const source = await readFile(resolve(import.meta.dir, "../../web/src/player/glow.ts"), "utf8");
  const literal = (name: string) => {
    const found = source.match(new RegExp(`const ${name} = /\\* glsl \\*/ \x60([\\s\\S]*?)\x60;`))?.[1];
    if (!found) throw new Error(`Missing upstream glow shader ${name}`);
    return found;
  };
  const noise = literal("auraNoise");
  return { noise, fragment: literal("auraFragment").replace("${auraNoise}", "") };
}

/** Writes player-{vertex,solid,ghost,gun-vertex,gun}.glsl into `directory`. */
export async function writePlayerMaterials(directory: string): Promise<void> {
  const uniforms = playerUniforms();
  const solid = solidMaterial(uniforms, NO_LOOK);
  const ghost = ghostMaterial(uniforms, false);
  const gun = gunMaterial(uniforms, NO_LOOK, { flash: true });
  const glow = await glowSources();
  const files: [string, string][] = [
    ["player-vertex.glsl", vertexShader(solid.vertexShader, glow.noise)],
    ["player-solid.glsl", solidFragment(solid.fragmentShader, glowFunction(glow.fragment, glow.noise))],
    ["player-ghost.glsl", ghostFragment(ghost.fragmentShader)],
    ["player-gun-vertex.glsl", vertexShader(gun.vertexShader, glow.noise)],
    ["player-gun.glsl", solidFragment(gun.fragmentShader, glowFunction(glow.fragment, glow.noise))],
  ];
  for (const [name, source] of files) await writeFile(resolve(directory, name), source);
}
