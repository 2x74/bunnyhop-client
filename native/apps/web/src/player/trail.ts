// Fading ghost trail: a camera-facing ribbon through recent path points (three.js space, oldest first).
// Rebuilt on the CPU every frame (a few hundred vertices), one draw call. Two-tone trails (a trail cosmetic's color2,
// e.g. Geode: crystal aqua -> amethyst) shift from the main colour at the head to the second toward the tail.

import * as THREE from "three";

export class Trail {
  readonly mesh: THREE.Mesh;
  private pos: Float32Array;
  private col: Float32Array;
  private color = new THREE.Color();
  /** Tail colour; null = one colour. */
  private color2: THREE.Color | null = null;
  private geo = new THREE.BufferGeometry();

  constructor(
    color: THREE.ColorRepresentation,
    readonly max = 320,
    color2: THREE.ColorRepresentation | null = null,
  ) {
    this.setColor(color, color2);
    this.pos = new Float32Array(max * 2 * 3);
    this.col = new Float32Array(max * 2 * 4);
    const idx: number[] = [];
    for (let i = 0; i + 1 < max; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    this.geo.setIndex(idx);
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute("color", new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setDrawRange(0, 0);
    this.mesh = new THREE.Mesh(
      this.geo,
      new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 30;
  }

  /** Head colour, and the tail colour of a two-tone trail (null / absent / the same colour = one colour). */
  setColor(color: THREE.ColorRepresentation, color2: THREE.ColorRepresentation | null = null): void {
    this.color.set(color);
    const c2 = color2 == null ? null : new THREE.Color(color2);
    this.color2 = c2 && !c2.equals(this.color) ? c2 : null;
  }

  /**
   * points: xyz triples (three space), `count` of them, oldest first. Width tapers from 0 at the tail to `width` at
   * the head; alpha fades the same way.
   */
  set(points: Float32Array, count: number, camera: THREE.Vector3, opacity: number, width = 3): void {
    count = Math.min(count, this.max);
    if (count < 2) {
      this.geo.setDrawRange(0, 0);
      return;
    }
    const P = this.pos;
    const Cc = this.col;
    let { r, g, b } = this.color;
    const c2 = this.color2;
    for (let i = 0; i < count; i++) {
      const o = i * 3;
      const prev = Math.max(0, i - 1) * 3;
      const next = Math.min(count - 1, i + 1) * 3;
      const tx = points[next] - points[prev];
      const ty = points[next + 1] - points[prev + 1];
      const tz = points[next + 2] - points[prev + 2];
      const vx = camera.x - points[o];
      const vy = camera.y - points[o + 1];
      const vz = camera.z - points[o + 2];
      // side = normalize(t x v)
      let sx = ty * vz - tz * vy;
      let sy = tz * vx - tx * vz;
      let sz = tx * vy - ty * vx;
      const l = Math.hypot(sx, sy, sz) || 1;
      const f = i / (count - 1);
      const w = (width * (0.15 + 0.85 * f)) / l;
      sx *= w;
      sy *= w;
      sz *= w;
      const v = i * 6;
      P[v] = points[o] + sx;
      P[v + 1] = points[o + 1] + sy;
      P[v + 2] = points[o + 2] + sz;
      P[v + 3] = points[o] - sx;
      P[v + 4] = points[o + 1] - sy;
      P[v + 5] = points[o + 2] - sz;
      // Fade with age, and near the camera (a ribbon passing under/through the eye reads as a smear).
      const dc = Math.hypot(vx, vy, vz);
      const near = Math.min(1, Math.max(0, (dc - 40) / 160));
      const a = opacity * f * f * near * near;
      if (c2) {
        // Two-tone: the head keeps the main colour for its brightest stretch, then shifts to the tail colour (fully by
        // the middle of the ribbon, while it's still bright enough to read).
        const k = Math.min(1, Math.max(0, (0.92 - f) * 2.4));
        const s = k * k * (3 - 2 * k);
        r = this.color.r + (c2.r - this.color.r) * s;
        g = this.color.g + (c2.g - this.color.g) * s;
        b = this.color.b + (c2.b - this.color.b) * s;
      }
      const c = i * 8;
      Cc[c] = Cc[c + 4] = r;
      Cc[c + 1] = Cc[c + 5] = g;
      Cc[c + 2] = Cc[c + 6] = b;
      Cc[c + 3] = Cc[c + 7] = a;
    }
    const pa = this.geo.attributes.position as THREE.BufferAttribute;
    const ca = this.geo.attributes.color as THREE.BufferAttribute;
    pa.clearUpdateRanges();
    ca.clearUpdateRanges();
    pa.addUpdateRange(0, count * 6);
    ca.addUpdateRange(0, count * 8);
    pa.needsUpdate = ca.needsUpdate = true;
    this.geo.setDrawRange(0, (count - 1) * 6);
  }

  clear(): void {
    this.geo.setDrawRange(0, 0);
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
