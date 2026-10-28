import * as THREE from "three";
import { playerVertex, type PlayerUniforms } from "./materials";
import {
  glowColorHex,
  normalizePlayerGlow,
  type PlayerGlow,
} from "./glow-config";

// Model-space fields travel upward; deformation and shading share the same clock.
const auraNoise = /* glsl */ `
float auraHash(vec2 p) { return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
float auraNoise(vec2 p) {
  vec2 cell=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(auraHash(cell),auraHash(cell+vec2(1,0)),f.x),mix(auraHash(cell+vec2(0,1)),auraHash(cell+vec2(1,1)),f.x),f.y);
}
float auraFlow(vec2 p) { return auraNoise(p)*0.68+auraNoise(p*2.07+vec2(5.2,1.3))*0.32; }
`;
const auraFragment = /* glsl */ `
uniform vec3 uGlowColor;
uniform float uGlowStrength,uGlowDistance,uOpacity,uFinTime;
uniform vec3 uAxisA,uAxisB;
uniform vec2 uNearFade;
varying float vGlowAlpha,vHalo;
varying vec2 vAuraCoord;
varying vec3 vNormalW,vWorldPos;
${auraNoise}
void main() {
  float edge=1.0-abs(dot(normalize(vNormalW),normalize(cameraPosition-vWorldPos)));
  vec3 axis=uAxisB-uAxisA;
  float along=clamp(dot(cameraPosition-uAxisA,axis)/max(dot(axis,axis),0.001),0.0,1.0);
  float nearAlpha=uNearFade.y<=uNearFade.x?1.0:smoothstep(uNearFade.x,uNearFade.y,length(cameraPosition-uAxisA-axis*along));
  float shape=pow(edge,1.3), heat=0.0;
  if(vHalo>0.5) {
    vec2 flow=vAuraCoord*vec2(0.27,0.13)-vec2(0.0,uFinTime*2.4);
    flow.x += sin(flow.y*1.7+uFinTime*0.9)*0.32;
    float field=auraFlow(flow);
    float flame=smoothstep(0.43,0.78,field);
    float threads=pow(auraNoise(flow*vec2(1.8,0.68)+vec2(0.0,-uFinTime)),2.0);
    heat=flame;
    // Transparent gaps and narrow hot tongues make the rising flow readable.
    shape=pow(1.0-edge,0.45)*pow(edge,0.22)*(0.035+flame*1.45+threads*0.15);
  }
  float alpha=nearAlpha*uOpacity*vGlowAlpha*uGlowStrength*uGlowDistance*shape;
  if(alpha<0.002) discard;
  vec3 color=mix(uGlowColor,uGlowColor*0.65+vec3(0.55),heat*0.18);
  gl_FragColor=vec4(color*(1.35+uGlowStrength),alpha);
}
`;

const smoothed = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();
const halos = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();
/** The shell's geometry for a body: the body's, plus `glowNormal` (smoothed across seams). Cached per body. */
export function shellGeometry(source: THREE.BufferGeometry): THREE.BufferGeometry {
  const hit = smoothed.get(source);
  if (hit) return hit;
  const geometry = source.clone();
  const positions = source.getAttribute("position"),
    normals = source.getAttribute("normal"),
    bones = source.getAttribute("skinIndex");
  // Smoothed normals: vertices at the same place on the same bones (seams) share the sum of their normals. Each
  // vertex's key is made once and its group kept by index (this runs in the frame a new body first glows).
  const n = positions.count;
  const group = new Int32Array(n);
  const ids = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const k = `${positions.getX(i).toFixed(4)},${positions.getY(i).toFixed(4)},${positions.getZ(i).toFixed(4)}:${bones.getX(i)},${bones.getY(i)},${bones.getZ(i)},${bones.getW(i)}`;
    let id = ids.get(k);
    if (id === undefined) ids.set(k, (id = ids.size));
    group[i] = id;
  }
  const sums = new Float64Array(ids.size * 3);
  for (let i = 0; i < n; i++) {
    const g = group[i] * 3;
    sums[g] += normals.getX(i);
    sums[g + 1] += normals.getY(i);
    sums[g + 2] += normals.getZ(i);
  }
  // (As Vector3.normalize: times 1 / length, a zero sum stays zero.)
  for (let g = 0; g < sums.length; g += 3) {
    const inv = 1 / (Math.sqrt(sums[g] * sums[g] + sums[g + 1] * sums[g + 1] + sums[g + 2] * sums[g + 2]) || 1);
    sums[g] *= inv;
    sums[g + 1] *= inv;
    sums[g + 2] *= inv;
  }
  const result = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const g = group[i] * 3;
    result[i * 3] = sums[g];
    result[i * 3 + 1] = sums[g + 1];
    result[i * 3 + 2] = sums[g + 2];
  }
  geometry.setAttribute("glowNormal", new THREE.BufferAttribute(result, 3));
  source.addEventListener("dispose", () => {
    geometry.dispose();
    halos.get(source)?.dispose();
    smoothed.delete(source);
    halos.delete(source);
  });
  smoothed.set(source, geometry);
  return geometry;
}
/** The halo's layers: how far each is pushed out (units) and how faint it is, innermost first. */
export const HALO_LAYERS = 8;
export const haloWidth = (layer: number): number => 0.85 + layer * 0.52;
export const haloAlpha = (layer: number): number => 0.08 * (1 - layer / HALO_LAYERS) ** 1.15;

/**
 * The halo: the shell drawn HALO_LAYERS times, each layer pushed further out and fainter, in one instanced draw. The
 * layers share the shell's vertex buffers (glowWidth / glowAlpha are per layer), so a body's halo costs no geometry of
 * its own; it used to be eight copies of it (~20 MB of arrays and as much GPU memory per body). Drawn in the same
 * order (layer by layer), additively.
 */
export function haloGeometry(source: THREE.BufferGeometry): THREE.BufferGeometry {
  const hit = halos.get(source);
  if (hit) return hit;
  const base = shellGeometry(source);
  const geometry = new THREE.InstancedBufferGeometry();
  for (const [name, attr] of Object.entries(base.attributes)) geometry.setAttribute(name, attr);
  if (base.index) geometry.setIndex(base.index);
  const widths = new Float32Array(HALO_LAYERS),
    alphas = new Float32Array(HALO_LAYERS);
  for (let layer = 0; layer < HALO_LAYERS; layer++) {
    widths[layer] = haloWidth(layer);
    alphas[layer] = haloAlpha(layer);
  }
  geometry.setAttribute("glowWidth", new THREE.InstancedBufferAttribute(widths, 1));
  geometry.setAttribute("glowAlpha", new THREE.InstancedBufferAttribute(alphas, 1));
  geometry.instanceCount = HALO_LAYERS;
  // (Disposed with the shell, whose buffers it shares: see shellGeometry.)
  halos.set(source, geometry);
  return geometry;
}
/** Skinned normal extrusion: no center scaling, shared rig and cached source geometry. */
export class PlayerGlowShell {
  private group = new THREE.Group();
  private meshes: THREE.SkinnedMesh[] = [];
  private materials: THREE.ShaderMaterial[] = [];
  private config: PlayerGlow | null = null;
  private shown = true;
  private auraEnabled = true;
  private sources: THREE.SkinnedMesh[] = [];
  /**
   * `o.width` (contour width, units) and `o.strength` (a factor on the intensity): the first-person hands (viewmodel)
   * take a slimmer, softer contour than a body seen from outside.
   */
  constructor(
    parent: THREE.Object3D,
    private uniforms: PlayerUniforms,
    private o: { width?: number; strength?: number } = {},
  ) {
    parent.add(this.group);
    this.group.visible = false;
  }
  set(config: PlayerGlow | null, shown: boolean, auraEnabled = true): void {
    this.auraEnabled = auraEnabled && config?.aura !== false;
    this.config = normalizePlayerGlow(config);
    this.shown = shown;
    this.group.visible = !!this.config?.enabled && shown;
  }
  sync(sources: THREE.SkinnedMesh[], solid: boolean, order: number): void {
    this.group.visible = !!this.config?.enabled && this.shown && solid;
    if (!this.group.visible) return;
    if (
      sources.length !== this.sources.length ||
      sources.some((s, i) => s !== this.sources[i])
    )
      this.rebuild(sources);
    const color = glowColorHex(this.config?.color);
    this.meshes.forEach((mesh, i) => {
      mesh.geometry = (i % 2 ? haloGeometry : shellGeometry)(
        sources[Math.floor(i / 2)].geometry,
      );
      mesh.renderOrder = order + 2;
      if (i % 2 && !this.auraEnabled) mesh.visible = false;
      const mat = mesh.material as THREE.ShaderMaterial;
      mat.uniforms.uGlowColor.value.set(color);
      mat.uniforms.uGlowStrength.value = this.config!.intensity * (this.o.strength ?? 1);
    });
  }
  private rebuild(sources: THREE.SkinnedMesh[]): void {
    // The materials carry over (they don't depend on the body): disposing them first would release their shader
    // programs, and the new shells would compile them again in their first frame.
    const old = this.materials;
    this.group.clear();
    this.meshes = [];
    this.materials = [];
    this.sources = [...sources];
    for (const source of sources) {
      const shells: THREE.SkinnedMesh[] = [];
      // One contour draw and one batched, faint eight-layer falloff draw per body.
      for (const halo of [false, true]) {
        const material = old[this.materials.length] ?? new THREE.ShaderMaterial({
          uniforms: {
            ...this.uniforms,
            uGlowWidth: { value: this.o.width ?? 0.45 },
            uGlowColor: { value: new THREE.Color() },
            uGlowStrength: { value: 0.7 },
            uGlowAlpha: { value: 1.5 },
            uGlowDistance: { value: 1 },
          },
          vertexShader: playerVertex
            .replace(
              "#include <beginnormal_vertex>",
              "#include <beginnormal_vertex>\nobjectNormal = glowNormal;",
            )
            .replace(
              "#include <project_vertex>",
              halo
                ? `vAuraCoord=vec2(transformed.x+transformed.y*0.47,transformed.z);
vec2 flow=vAuraCoord*vec2(0.27,0.13)-vec2(0.0,uFinTime*2.4);
flow.x += sin(flow.y*1.7+uFinTime*0.9)*0.32;
float tongue=smoothstep(0.27,0.78,auraFlow(flow));
transformed += normalize(objectNormal)*glowWidth*(0.5+tongue*0.75);
transformed.z += glowWidth*(0.15+tongue*1.4);
transformed.x += sin(flow.y*2.1+uFinTime)*glowWidth*0.16*tongue;
vGlowAlpha=glowAlpha;vHalo=1.0;
#include <project_vertex>`
                : "vAuraCoord=vec2(0.0); transformed += normalize(objectNormal) * uGlowWidth; vGlowAlpha=uGlowAlpha; vHalo=0.0;\n#include <project_vertex>",
            )
            .replace(
              "void main()",
              `attribute vec3 glowNormal; attribute float glowWidth,glowAlpha; uniform float uGlowWidth,uGlowAlpha; varying float vGlowAlpha,vHalo; varying vec2 vAuraCoord;\n${auraNoise}\nvoid main()`,
            ),
          fragmentShader: auraFragment,
          side: THREE.BackSide,
          transparent: true,
          depthTest: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          toneMapped: false,
        });
        (material.defaultAttributeValues as Record<string, number[]>).headwear = [0];
        const mesh = new THREE.SkinnedMesh(
          halo ? haloGeometry(source.geometry) : shellGeometry(source.geometry),
          material,
        );
        mesh.bindMode = THREE.DetachedBindMode;
        mesh.bind(source.skeleton, source.bindMatrix);
        mesh.frustumCulled = false;
        // The body's bounds (only used to sort it among transparent objects; its renderOrder decides first). Left
        // null, three would skin every vertex on the CPU to find one in the shell's first frame: tens of ms for a
        // body, eight times that for the halo's layers.
        mesh.boundingSphere = source.boundingSphere?.clone() ?? null;
        mesh.matrixAutoUpdate = false;
        mesh.matrix.copy(source.matrix);
        shells.push(mesh);
        this.meshes.push(mesh);
        this.materials.push(material);
        this.group.add(mesh);
      }
      const point = new THREE.Vector3(),
        eye = new THREE.Vector3();
      shells[0].onBeforeRender = (_renderer, _scene, camera) => {
        point.setFromMatrixPosition(source.matrixWorld);
        const distance = point.distanceTo(camera.getWorldPosition(eye));
        const fade = 1 - THREE.MathUtils.smoothstep(distance, 1000, 1800);
        for (const shell of shells)
          (
            shell.material as THREE.ShaderMaterial
          ).uniforms.uGlowDistance.value = fade;
        // BunnyModel supplies the complete skinned body first, then headwear; hats keep the clean outline.
        shells[1].visible = this.auraEnabled && source === sources[0] && distance < 650;
      };
    }
    for (const m of old.slice(this.materials.length)) m.dispose();
  }
  private clear(): void {
    this.group.clear();
    this.materials.forEach((m) => m.dispose());
    this.meshes = [];
    this.materials = [];
  }
  dispose(): void {
    this.clear();
    this.group.removeFromParent();
  }
}
