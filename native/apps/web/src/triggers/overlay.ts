// The trigger and clip overlay in the world: volumes coloured per kind (volumes.ts), drawn in the player's style
// (Prefs.triggers: filled = translucent faces with their edges, outline = the edges, bottom = each volume's floor
// outline) with lines of the player's thickness.
//
// One or two draw calls for the whole map (faces, lines), built once. Every vertex carries its kind and its slot; a small float
// texture holds each slot's model-to-world matrix and how strongly it shows (1 on, dimmed for a disabled trigger, 0 for
// a removed one or a wall that isn't solid right now), rewritten only when a transform or state changes. Kinds, colours
// and opacity are uniforms, so the menu and the settings never rebuild anything. Triggers parented to moving brushes
// (doors, trains, rotators) follow them: their slot takes the model transform the world meshes get (`brushOrigins()`).
//
// Lines: 1px is GL lines (the cheapest). Thicker ones are WebGL's missing wide lines done by hand: one instanced quad per
// segment, widened in screen space in the vertex shader (three's LineSegments2 idea, with this overlay's slots and kind
// colours), still one draw call. Line sets other than the edges (the bottom style's, the thick versions) are built the
// first time they're shown, from the same arrays (no copies).
//
// Purely visual: it reads the core (`overlayVolumes`, `overlayStates`) and never writes to it.

import * as THREE from "three";
import type { BrushTransform, Core } from "../core";
import { buildOverlayGeometry, DEFAULT_TRIGGER_PREFS, KINDS, slotStrength, transformRows, type OverlayGeometry, type TriggerPrefs, type TriggerStyle } from "./volumes";

/** Slots per texture row (4 texels each: three matrix rows and the state). */
const ROW = 256;
const EDGE_ALPHA = 0.75;

/** The slot's transform and state and the kind's colour: shared by the face / thin line and thick line shaders. */
const SLOT = /* glsl */ `
attribute float kind;
attribute float slot;
uniform sampler2D slots;
uniform vec4 colors[${KINDS.length}];
uniform float shown[${KINDS.length}];
uniform float bias;
varying vec4 vColor;
vec4 r0, r1, r2;
/** Reads the slot's rows and sets vColor; returns its alpha (0: off). */
float fetchSlot() {
  int s = int(slot + 0.5);
  ivec2 at = ivec2((s % ${ROW}) * 4, s / ${ROW});
  r0 = texelFetch(slots, at, 0);
  r1 = texelFetch(slots, at + ivec2(1, 0), 0);
  r2 = texelFetch(slots, at + ivec2(2, 0), 0);
  float state = texelFetch(slots, at + ivec2(3, 0), 0).x;
  int k = int(kind + 0.5);
  float a = colors[k].a * shown[k] * state;
  vColor = vec4(colors[k].rgb, a);
  return a;
}
vec4 place(vec3 p) {
  return vec4(dot(r0.xyz, p) + r0.w, dot(r1.xyz, p) + r1.w, dot(r2.xyz, p) + r2.w, 1.0);
}
void finish(float a) {
  // Off: outside the clip volume, so nothing is rasterised.
  if (a <= 0.0) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
  // Edges lie on world faces as often as not: a hair nearer, so they don't flicker against them.
  gl_Position.z -= bias * gl_Position.w;
}`;

const VERTEX = /* glsl */ `
${SLOT}
void main() {
  float a = fetchSlot();
  gl_Position = projectionMatrix * modelViewMatrix * place(position);
  finish(a);
}`;

/**
 * Thick lines: `position` is the quad's corner (x 0 at the segment's start, 1 at its end; y -1 / 1 the side), each
 * instance one segment. The quad is the segment in screen space widened by `linewidth` CSS px, with square caps half
 * that long so the corners of a box meet. A segment crossing the near plane is cut at it first (else its far end would
 * project through the camera).
 */
const FAT_VERTEX = /* glsl */ `
${SLOT}
attribute vec3 instanceStart;
attribute vec3 instanceEnd;
uniform float linewidth;
uniform vec2 resolution;
void trimSegment(const in vec4 start, inout vec4 end) {
  float nearEstimate = -0.5 * projectionMatrix[3][2] / projectionMatrix[2][2];
  end.xyz = mix(start.xyz, end.xyz, (nearEstimate - start.z) / (end.z - start.z));
}
void main() {
  float a = fetchSlot();
  vec4 s = modelViewMatrix * place(instanceStart);
  vec4 e = modelViewMatrix * place(instanceEnd);
  if (projectionMatrix[2][3] == -1.0) {
    // A line on a floor or wall would lose the half of its width that lies over the surface's nearer side (the quad has
    // the line's depth): moved towards the eye along its ray (so it stays put on screen) by twice its half width in world
    // units, which is the same fraction of the distance at every depth. Covers surfaces seen down to ~30 degrees.
    float pull = 1.0 - 2.0 * linewidth / (projectionMatrix[1][1] * resolution.y);
    s.xyz *= pull;
    e.xyz *= pull;
    if (s.z < 0.0 && e.z >= 0.0) trimSegment(s, e);
    else if (e.z < 0.0 && s.z >= 0.0) trimSegment(e, s);
  }
  vec4 cs = projectionMatrix * s;
  vec4 ce = projectionMatrix * e;
  float aspect = resolution.x / resolution.y;
  vec2 dir = ce.xy / ce.w - cs.xy / cs.w;
  dir.x *= aspect;
  dir = dot(dir, dir) > 1e-12 ? normalize(dir) : vec2(1.0, 0.0);
  vec2 off = vec2(dir.y, -dir.x) * position.y + dir * (position.x < 0.5 ? -1.0 : 1.0);
  off.x /= aspect;
  // NDC is 2 units per resolution.y px: linewidth / resolution.y is half the width each side.
  off *= linewidth / resolution.y;
  gl_Position = position.x < 0.5 ? cs : ce;
  gl_Position.xy += off * gl_Position.w;
  finish(a);
}`;

const FRAGMENT = /* glsl */ `
varying vec4 vColor;
uniform float backFade;
void main() {
  gl_FragColor = vec4(vColor.rgb, vColor.a * (gl_FrontFacing ? 1.0 : backFade));
}`;

function attrs(g: OverlayGeometry["faces"]): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(g.position, 3));
  geo.setAttribute("kind", new THREE.BufferAttribute(g.kind, 1));
  geo.setAttribute("slot", new THREE.BufferAttribute(g.slot, 1));
  return geo;
}

export class TriggerOverlay {
  /** Source space (Z up): add under the world's container, it turns itself like the world root. */
  readonly root = new THREE.Group();
  readonly geometry: OverlayGeometry;
  private readonly data: Float32Array;
  private readonly texture: THREE.DataTexture;
  private readonly shown: number[] = KINDS.map(() => 0);
  private readonly materials: THREE.ShaderMaterial[] = [];
  /** Last transform written per slot (x, y, z, pitch, yaw, roll), to skip unchanged ones. */
  private readonly lastTransform: Float32Array;
  /** Slots that are triggers (dimmed when disabled) rather than walls / clips (gone when not solid). */
  private readonly triggerSlot: boolean[];
  /** Kind colours (rgb) with the faces' / the lines' alpha: uniform arrays every material shares, rewritten by setLook. */
  private readonly faceColors = KINDS.map(() => new THREE.Vector4());
  private readonly lineColors = KINDS.map(() => new THREE.Vector4());
  private readonly faces: THREE.Mesh;
  /** Line sets by `${which}:${fat}`, built on first use (`lines`). */
  private readonly lineSets = new Map<string, THREE.Object3D>();
  private readonly linewidth = { value: 1 };
  private readonly resolution = { value: new THREE.Vector2(1, 1) };
  private readonly viewport = new THREE.Vector4();

  private constructor(geometry: OverlayGeometry) {
    this.geometry = geometry;
    this.root.name = "trigger-overlay";
    this.root.rotation.x = -Math.PI / 2;
    const n = geometry.slots.length;
    const height = Math.ceil(n / ROW);
    this.data = new Float32Array(ROW * 4 * height * 4);
    this.lastTransform = new Float32Array(n * 6).fill(NaN);
    for (let s = 0; s < n; s++) this.writeState(s, 1);
    // Identity for every slot until its first transform (world space volumes keep it).
    for (let s = 0; s < n; s++) transformRows([0, 0, 0, 0, 0, 0], this.data, this.texel(s));
    this.texture = new THREE.DataTexture(this.data, ROW * 4, height, THREE.RGBAFormat, THREE.FloatType);
    this.texture.needsUpdate = true;
    this.triggerSlot = geometry.slots.map(() => false);
    const kinds = geometry.faces.kind;
    const slots = geometry.faces.slot;
    for (let i = 0; i < kinds.length; i += 3) if (KINDS[kinds[i]].group === "triggers") this.triggerSlot[slots[i]] = true;

    this.faces = this.add(new THREE.Mesh(attrs(geometry.faces), this.material(this.faceColors, 0, 0.55, false)));
    this.setLook(DEFAULT_TRIGGER_PREFS);
    this.root.visible = false;
  }

  /** The player's look (Prefs.triggers): colours, style, fill opacity, line thickness. Cheap: uniforms and visibility. */
  setLook(t: TriggerPrefs): void {
    const c = new THREE.Color();
    KINDS.forEach((k, i) => {
      c.set(t.colors?.[k.id] ?? DEFAULT_TRIGGER_PREFS.colors[k.id]);
      this.faceColors[i].set(c.r, c.g, c.b, t.opacity);
      this.lineColors[i].set(c.r, c.g, c.b, EDGE_ALPHA);
    });
    const style: TriggerStyle = t.style;
    this.faces.visible = style === "filled";
    const fat = t.thickness > 1;
    this.linewidth.value = t.thickness;
    const want = this.lines(style === "bottom" ? "bottom" : "edges", fat);
    for (const o of this.lineSets.values()) o.visible = o === want && o.userData.segments > 0;
  }

  /** The line set for a style (the edges, or the bottom style's), thin or thick; built and added the first time. */
  private lines(which: "edges" | "bottom", fat: boolean): THREE.Object3D {
    const id = `${which}:${fat}`;
    const have = this.lineSets.get(id);
    if (have) return have;
    const g = this.geometry[which];
    let o: THREE.Object3D;
    if (!fat) o = new THREE.LineSegments(attrs(g), this.material(this.lineColors, 0.00002, 1, false));
    else {
      // One quad (two triangles) per segment, its ends and kind / slot per instance, read straight from the line arrays.
      const geo = new THREE.InstancedBufferGeometry();
      geo.setIndex([0, 1, 2, 2, 1, 3]);
      geo.setAttribute("position", new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 0, 1, 0, 1, 1, 0], 3));
      const ends = new THREE.InstancedInterleavedBuffer(g.position, 6, 1);
      geo.setAttribute("instanceStart", new THREE.InterleavedBufferAttribute(ends, 3, 0));
      geo.setAttribute("instanceEnd", new THREE.InterleavedBufferAttribute(ends, 3, 3));
      geo.setAttribute("kind", new THREE.InterleavedBufferAttribute(new THREE.InstancedInterleavedBuffer(g.kind, 2, 1), 1, 0));
      geo.setAttribute("slot", new THREE.InterleavedBufferAttribute(new THREE.InstancedInterleavedBuffer(g.slot, 2, 1), 1, 0));
      geo.instanceCount = g.position.length / 6;
      const mesh = new THREE.Mesh(geo, this.material(this.lineColors, 0.00002, 1, true));
      // Widths are in CSS px of the view it's drawn into (LineSegments2 does the same).
      mesh.onBeforeRender = (renderer) => {
        renderer.getViewport(this.viewport);
        this.resolution.value.set(Math.max(1, this.viewport.z), Math.max(1, this.viewport.w));
      };
      o = mesh;
    }
    // (A map without volumes has no segments: never shown.)
    o.userData.segments = g.position.length / 6;
    this.lineSets.set(id, this.add(o));
    return o;
  }

  private material(colors: THREE.Vector4[], bias: number, backFade: number, fat: boolean): THREE.ShaderMaterial {
    const m = new THREE.ShaderMaterial({
      uniforms: {
        slots: { value: this.texture },
        colors: { value: colors },
        shown: { value: this.shown },
        bias: { value: bias },
        backFade: { value: backFade },
        ...(fat ? { linewidth: this.linewidth, resolution: this.resolution } : {}),
      },
      vertexShader: fat ? FAT_VERTEX : VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      // Faces often lie on a world face (a teleport on the floor, a clip against a wall): pulled forward a little so
      // they win instead of z-fighting.
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -4,
      fog: false,
    });
    this.materials.push(m);
    return m;
  }

  private add<T extends THREE.Object3D>(o: T): T {
    o.frustumCulled = false;
    o.renderOrder = 3; // after the world's translucent faces (water, glass)
    // Camera raycasts (attract.ts, third person) go through it like it isn't there.
    o.raycast = () => {};
    this.root.add(o);
    return o;
  }

  /** From the live core (a full map load: walls need its face data); null on wasm builds without the overlay. */
  static build(core: Core): TriggerOverlay | null {
    const t = performance.now();
    const volumes = core.overlayVolumes();
    if (!volumes) return null;
    const o = new TriggerOverlay(buildOverlayGeometry(volumes));
    const g = o.geometry;
    console.info(
      `trigger overlay: ${KINDS.map((k, i) => `${g.counts[i]} ${k.id}`).join(", ")}; ${g.faces.position.length / 9} triangles, ` +
        `${g.edges.position.length / 6} edges (${g.bottom.position.length / 6} bottom), ${g.slots.length} slots, built in ${(performance.now() - t).toFixed(0)} ms`,
    );
    return o;
  }

  /**
   * Where the volumes of kind `i` are now (world-space bounds per slot, Source units): for tools placing a camera on
   * them (tools/triggers/shots.ts through the dev hook).
   */
  bounds(i: number): { slot: number; lo: number[]; hi: number[] }[] {
    const g = this.geometry.faces;
    const out = new Map<number, { slot: number; lo: number[]; hi: number[] }>();
    for (let v = 0; v < g.kind.length; v++) {
      if (g.kind[v] !== i) continue;
      const s = g.slot[v];
      const m = this.data.subarray(this.texel(s), this.texel(s) + 12);
      const [x, y, z] = [g.position[v * 3], g.position[v * 3 + 1], g.position[v * 3 + 2]];
      const p = [0, 1, 2].map((r) => m[r * 4] * x + m[r * 4 + 1] * y + m[r * 4 + 2] * z + m[r * 4 + 3]);
      const b = out.get(s) ?? { slot: s, lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity] };
      for (let k = 0; k < 3; k++) {
        b.lo[k] = Math.min(b.lo[k], Math.round(p[k]));
        b.hi[k] = Math.max(b.hi[k], Math.round(p[k]));
      }
      out.set(s, b);
    }
    return [...out.values()];
  }

  /** Volumes of kind `i` (KINDS order) on this map. */
  count(i: number): number {
    return this.geometry.counts[i];
  }

  /** Which kinds draw (KINDS order). */
  setKinds(on: readonly boolean[]): void {
    for (let i = 0; i < KINDS.length; i++) this.shown[i] = on[i] ? 1 : 0;
    this.root.visible = on.some((v, i) => v && this.geometry.counts[i] > 0);
  }

  /** Every frame it's visible: brush transforms (`brushOrigins()`) and entity states (`Core.overlayStates()`). */
  update(transforms: Map<number, BrushTransform>, states: Uint32Array | null): void {
    let changed = false;
    const slots = this.geometry.slots;
    for (let s = 1; s < slots.length; s++) {
      const slot = slots[s];
      if (slot.model >= 0) {
        const t = transforms.get(slot.model);
        if (t && this.moved(s, t)) {
          transformRows(t, this.data, this.texel(s));
          changed = true;
        }
      }
      const state = states && slot.entity >= 0 ? slotStrength(this.triggerSlot[s], slot.flags, states[slot.entity] ?? 0) : 1;
      if (this.data[this.texel(s) + 12] !== state) {
        this.writeState(s, state);
        changed = true;
      }
    }
    if (changed) this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const o of this.root.children) (o as THREE.Mesh).geometry.dispose();
    for (const m of this.materials) m.dispose();
    this.texture.dispose();
  }

  /** Float offset of slot `s`'s first texel (rows are exactly ROW slots wide, so slots are simply consecutive). */
  private texel(s: number): number {
    return s * 16;
  }

  private writeState(s: number, state: number): void {
    this.data[this.texel(s) + 12] = state;
  }

  private moved(s: number, t: BrushTransform): boolean {
    const last = this.lastTransform;
    let moved = false;
    for (let k = 0; k < 6; k++) {
      if (last[s * 6 + k] !== Math.fround(t[k])) {
        last[s * 6 + k] = t[k];
        moved = true;
      }
    }
    return moved;
  }
}
