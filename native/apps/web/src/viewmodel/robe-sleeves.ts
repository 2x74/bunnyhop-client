// The Robe in first person (progression.ts ROBE_ITEM; player/bunny/robe.ts is the garment on the bunny): while it is
// worn, its sleeves over the hoodie's on the two forearms, as the wearer would see them. The wide opening round each
// forearm, edged in the collar band's colour, and the cloth hanging below it, in the robe's pattern and colours.
//
// It is one more mesh on the viewmodel's own skeleton and uniforms (the knife's and the guns' alike), added only
// while the Robe is worn and the setting is on: without it nothing here runs, and the hands are drawn exactly as they
// were. It changes nothing of the hands, gloves, hoodie sleeves, knives or guns: it is drawn round them.
//
// The cloth is robe-fx.ts's sleeve (codes 11 / 12): drawn from the forearm's line where the animation has it, over the
// arm and then straight down, so a turn of the wrist in an inspect or a reload never swings the drop round the arm.
// Toward the elbow it narrows onto the hoodie's sleeve (the camera sits beside the forearm there: a wide tube would
// swallow it), so only the opening and the drop under it are in view, low in the frame's corners. The drop lags a
// little behind the view's turns and strafes, on a short leash (FP_SLEEVE.limit).

import * as THREE from "three";
import { Builder, type Fin, type Paint } from "../player/bunny/builder";
import type { V3 } from "../player/bunny/rig";
import { solidMaterial, type PlayerUniforms } from "../player/materials";
import { FP_ARMS, FP_ROBE, fpSleeveRadius, ROBE_CODE, ROBE_ROLE, ROBE_S, robeTones } from "../player/robe-fx";
import type { CosmeticLoadout } from "../loadout";
import { ROBE_ITEM } from "../progression";

/** The drop's lag: its spring (Hz, damping), how far a strafe, forward speed and a turn of the view throw it, its leash. */
export const FP_SLEEVE = { hz: 2.3, zeta: 0.5, tipHz: 1.8, tipZeta: 0.38, strafe: 0.11, strafeV: 500, wind: 0.1, windV: 900, turn: 0.00045, limit: 0.2 } as const;

const WHITE: Paint = { code: 0, color: 0xffffff };
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

let cached: THREE.BufferGeometry | null = null;

/** Both first-person sleeves, in the viewmodel's bind pose (built once, ~2 ms). */
export function fpRobeGeometry(): THREE.BufferGeometry {
  if (cached) return cached;
  const b = new Builder();
  const parts: { from: number; to: number; code: number; role: number }[] = [];
  FP_ARMS.forEach((arm, ai) => {
    const code = ai === 0 ? ROBE_CODE.fpRight : ROBE_CODE.fpLeft;
    const a = arm.dir;
    // As robe-fx.ts builds its frame: level and square to the arm, and square to both.
    const hl = Math.hypot(a[0], a[1]);
    const side: V3 = [a[1] / hl, -a[0] / hl, 0];
    const up: V3 = [side[1] * a[2] - side[2] * a[1], side[2] * a[0] - side[0] * a[2], side[0] * a[1] - side[1] * a[0]];
    const S0 = FP_ROBE.from, S1 = arm.length + FP_ROBE.to;
    const radius = (s: number) => fpSleeveRadius(s, arm.length);
    const depth = (s: number) => {
      const R = radius(s);
      const full = R + (FP_ROBE.drop - R) * smooth(S1 - FP_ROBE.dropFrom, S1 - 1.6, s);
      const C = FP_ROBE.corner, e = s - (S1 - C);
      return e > 0 ? full - (C - Math.sqrt(Math.max(0, C * C - e * e))) * Math.min(1, (full - R) / C) : full;
    };
    // Round under the arm for the first radius, then a flat double sheet, thin as cloth (as the bunny's own sleeves).
    const half = (D: number, dep: number, R: number) => {
      const round = R * Math.sqrt(Math.max(0, 1 - Math.min(1, D / R) ** 2));
      if (dep <= R * 1.05) return Math.max(round, 0.02);
      return Math.max(round, (FP_ROBE.gap / 2) * Math.sqrt(Math.max(0, 1 - (D / dep) ** 8)) * smooth(R * 1.05, R * 1.5, dep), 0.02);
    };
    const NS = 14, NA = 6, NH = 8;
    const ss = Array.from({ length: NS + 1 }, (_, i) => S0 + (S1 - S0) * Math.pow(i / NS, 0.8));
    const secs = ss.map((s) => {
      const dep = depth(s), R = radius(s), out: [number, number, number][] = [];
      const drops = Array.from({ length: NH }, (_, j) => (j < 4 ? R * [0.38, 0.7, 0.92, 1.12][j] : R * 1.12 + (dep - R * 1.12) * ((j - 3) / (NH - 4))) * Math.min(1, dep / (R * 1.12)));
      for (let j = NH - 1; j >= 0; j--) out.push([-half(drops[j], dep, R), 0, drops[j]]);
      for (let j = 0; j <= 2 * NA; j++) {
        const phi = -Math.PI / 2 + (j / (2 * NA)) * Math.PI;
        out.push([R * Math.sin(phi), R * Math.cos(phi), 0]);
      }
      for (let j = 0; j < NH; j++) out.push([half(drops[j], dep, R), 0, drops[j]]);
      return out;
    });
    const place = (s: number, q: [number, number, number]): V3 => {
      const c: V3 = [arm.from[0] + a[0] * s, arm.from[1] + a[1] * s, arm.from[2] + a[2] * s];
      const round = Math.min(q[2], radius(s)), u = q[1] - round;
      return [c[0] + side[0] * q[0] + up[0] * u, c[1] + side[1] * q[0] + up[1] * u, c[2] + side[2] * q[0] + up[2] * u - (q[2] - round)];
    };
    const pts = secs.map((sec, i) => sec.map((q) => place(ss[i], q)));
    // The band: the rows within `band` of the opening.
    const split = ss.findIndex((s) => s > S1 - FP_ROBE.band) - 1;
    for (const [role, i0, i1] of [[ROBE_ROLE.cloth, 0, split], [ROBE_ROLE.band, split, NS]] as const) {
      const v0 = b.vertexCount;
      b.surface(pts.slice(i0, i1 + 1), {
        closed: false,
        paint: () => WHITE,
        weight: () => [[arm.bone, 1]],
        out: (i, k) => {
          const q = secs[i0 + i][k], R = radius(ss[i0 + i]);
          return q[2] > R ? [side[0] * Math.sign(q[0]), side[1] * Math.sign(q[0]), 0] : [side[0] * q[0] + up[0] * (q[1] - q[2]), side[1] * q[0] + up[1] * (q[1] - q[2]), up[2] * (q[1] - q[2])];
        },
        fin: (i, k): Fin => [secs[i0 + i][k][0], secs[i0 + i][k][1], secs[i0 + i][k][2], (ss[i0 + i] - S0) / ROBE_S],
      });
      parts.push({ from: v0, to: b.vertexCount, code, role });
    }
  });
  const g = b.geometry();
  const F = g.getAttribute("finishUV"), C = g.getAttribute("partColor") as THREE.BufferAttribute, n = g.getAttribute("position").count;
  const fx = new Float32Array(n * 4);
  for (const part of parts)
    for (let i = part.from; i < part.to; i++) {
      fx[i * 4] = part.code;
      fx[i * 4 + 2] = F.getW(i);
      fx[i * 4 + 3] = part.role;
      C.setXYZ(i, F.getX(i), F.getY(i), F.getZ(i));
    }
  g.deleteAttribute("finishUV");
  g.setAttribute("backfx", new THREE.Float32BufferAttribute(fx, 4));
  g.setAttribute("headwear", new THREE.Float32BufferAttribute(new Float32Array(n).fill(1), 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 64);
  return (cached = g);
}

/** The sleeve's radius where it is widest and where it starts (what the shader's uRobe carries for these sleeves). */
export const fpRobeUniform = (pattern: number): [number, number, number, number] => [pattern, FP_ROBE.drop, FP_ROBE.r, 0];

export interface FpSleeveInput {
  /** Velocity (Source u/s, world) and the view's yaw (degrees). */
  velocity: ArrayLike<number>;
  yaw: number;
}

/**
 * The first-person sleeves of one viewmodel (the knife's or the guns'): a mesh on its skeleton while the Robe is worn
 * and shown, and the drops' lag.
 */
export class RobeSleeves {
  private mesh: THREE.SkinnedMesh | null = null;
  private loadout: CosmeticLoadout | null = null;
  private shown = true;
  /** The drops' lag: [x, y] offsets per unit of drop (viewmodel space: x forward, y left), their rates, and the free end's. */
  private q = new Float64Array(8);
  private yaw = 0;
  private started = false;

  constructor(private root: THREE.Object3D, private skeleton: THREE.Skeleton, private uniforms: PlayerUniforms) {}

  /** Whether the sleeves are drawn now. */
  get worn(): boolean {
    return !!this.mesh;
  }

  /** The loadout held (its back item, pattern and colours), and whether the player wants the sleeves shown. */
  set(l: CosmeticLoadout | null, shown: boolean): void {
    if (l === this.loadout && shown === this.shown) return;
    this.loadout = l;
    this.shown = shown;
    const want = shown && l?.back === ROBE_ITEM;
    if (want && !this.mesh) {
      const m = new THREE.SkinnedMesh(fpRobeGeometry(), solidMaterial(this.uniforms));
      m.bindMode = THREE.DetachedBindMode;
      m.bind(this.skeleton, new THREE.Matrix4());
      m.frustumCulled = false;
      m.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 64);
      m.name = "robe-sleeves";
      this.root.add(m);
      this.mesh = m;
      this.q.fill(0);
      this.started = false;
    } else if (!want && this.mesh) {
      this.mesh.removeFromParent();
      (this.mesh.material as THREE.Material).dispose();
      this.mesh = null;
    }
    if (want) this.tones();
  }

  /** The robe's tones from the viewmodel's colourway (call when it changes) and the loadout's colours. */
  tones(): void {
    if (!this.mesh) return;
    const u = this.uniforms, l = this.loadout, pants = u.uPalette.value[2], a = u.uAccent.value;
    robeTones([pants.r, pants.g, pants.b], [a.r, a.g, a.b], l?.robeColor, l?.robePrint).forEach((t, i) => u.uCapeTones.value[i].setRGB(t[0], t[1], t[2]));
    u.uRobe.value.fromArray(fpRobeUniform(l?.robePattern ?? 0));
  }

  /** Hidden with the hands (a viewmodel that draws nothing this frame). */
  setVisible(v: boolean): void {
    if (this.mesh) this.mesh.visible = v;
  }

  /** Steps the drops' lag by dt (s). `scale`: the viewmodel's sway setting and reduced motion (0 = still); `mirror`: the left-handed view. */
  update(dt: number, s: FpSleeveInput, scale = 1, mirror = false): void {
    if (!this.mesh) return;
    const h = Math.max(0, Math.min(dt, 0.1));
    const yaw = (s.yaw * Math.PI) / 180;
    let dyaw = yaw - this.yaw;
    dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
    this.yaw = yaw;
    if (!this.started || h <= 0) {
      this.started = true;
      return;
    }
    const F = FP_SLEEVE, cy = Math.cos(yaw), sy = Math.sin(yaw);
    const fwd = cy * s.velocity[0] + sy * s.velocity[1], left = -sy * s.velocity[0] + cy * s.velocity[1];
    // Forward speed streams the drops back toward the eye, a strafe leaves them behind to the other side, a turn of the
    // view the same.
    let tx = -F.wind * (1 - Math.exp(-Math.max(0, fwd) / F.windV));
    let ty = -F.strafe * Math.tanh(left / F.strafeV) - F.turn * Math.max(-400, Math.min(400, (dyaw / h) * (180 / Math.PI)));
    if (mirror) ty = -ty;
    (tx *= scale), (ty *= scale);
    const n = Math.max(1, Math.ceil(h / (1 / 120))), dh = h / n, q = this.q;
    const w0 = 2 * Math.PI * F.hz, kk = w0 * w0, c = 2 * F.zeta * w0, w1 = 2 * Math.PI * F.tipHz, kt = w1 * w1, ct = 2 * F.tipZeta * w1;
    for (let i = 0; i < n; i++) {
      q[2] += (kk * (tx - q[0]) - c * q[2]) * dh;
      q[3] += (kk * (ty - q[1]) - c * q[3]) * dh;
      q[0] += q[2] * dh;
      q[1] += q[3] * dh;
      q[6] += (kt * (q[0] - q[4]) - ct * q[6]) * dh;
      q[7] += (kt * (q[1] - q[5]) - ct * q[7]) * dh;
      q[4] += q[6] * dh;
      q[5] += q[7] * dh;
      for (const o of [0, 4]) {
        const m = Math.hypot(q[o], q[o + 1]);
        if (m > F.limit) (q[o] *= F.limit / m), (q[o + 1] *= F.limit / m), (q[o + 2] *= 0.5), (q[o + 3] *= 0.5);
      }
    }
    this.uniforms.uRobeL.value.set(q[0], q[1], q[4], q[5]);
    this.uniforms.uRobeR.value.set(q[0], q[1], q[4], q[5]);
  }

  dispose(): void {
    this.set(null, false);
  }
}
