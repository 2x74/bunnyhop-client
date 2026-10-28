// The tutorial's in-world signage, drawn by the client over the map (visual only, never collides):
//  - each lesson's number and title on a board hung across the room ahead of its start (like the gate boards)
//  - an EXIT sign over each exit, dark until the lesson's goal is met; then it lights up and the doorway glows
//  - lesson 3's speed gates: a board across each gate with its number, lit once you reach that speed
//  - lessons 2 and 3: the strafe line, a slalom painted on the floor with the key inside its first bends
//  - the final course: the landing ring (where this hop comes down: white on floor, red over a pit)

import * as THREE from "three";
import type { LessonGeometry, Rect, TutorialData } from "./data";

/** Source (x, y, z) -> three (x, z, -y). */
const toThree = (x: number, y: number, z: number) => new THREE.Vector3(x, z, -y);
const FONT = '"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const ACCENT = "#ffb43a";
const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function texture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d")!);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function paintMaterial(map: THREE.Texture, opacity = 1, color = 0xffffff, additive = false): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    map,
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
    side: THREE.DoubleSide,
    ...(additive ? { blending: THREE.AdditiveBlending } : {}),
  });
}

/**
 * A plane facing back along `yaw` (Source degrees: the direction the player travels), so it reads to someone moving
 * that way: on the floor (`floor`: its top edge points along `yaw`) or upright on a wall facing the player.
 */
function plane(mat: THREE.Material, w: number, h: number, at: THREE.Vector3, yaw: number, floor: boolean): THREE.Object3D {
  const g = new THREE.Group();
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  if (floor) m.rotation.x = -Math.PI / 2;
  g.add(m);
  g.rotation.y = ((yaw - 90) * Math.PI) / 180;
  g.position.copy(at);
  m.renderOrder = 20;
  return g;
}

/** Painted floor text: drawn squashed along the view, so it reads from a standing eye height (like road markings). */
function floorText(draw: (g: CanvasRenderingContext2D, w: number, h: number) => void, width: number, stretch = 2.6, cw = 1024, ch = 256): THREE.MeshBasicMaterial {
  const tex = texture(cw, ch, (g) => draw(g, cw, ch));
  const m = paintMaterial(tex, 0.82, 0xe9e9e6);
  m.userData.depth = width * (ch / cw) * stretch;
  return m;
}

interface ExitMarks {
  sign: THREE.Mesh;
  dim: THREE.Texture;
  lit: THREE.Texture;
  glow: THREE.MeshBasicMaterial;
  /** 0 = closed, 1 = open (animated towards `target`). */
  t: number;
  target: number;
}

export class TutorialMarks {
  readonly root = new THREE.Group();
  private ring: THREE.Mesh;
  private ringMat: THREE.MeshBasicMaterial;
  private exits = new Map<number, ExitMarks>();
  private gates = new Map<string, { mesh: THREE.Mesh; lit: THREE.Texture }>();
  private clock = 0;

  constructor(
    data: TutorialData,
    titles: string[],
    keys: { left: string; right: string },
  ) {
    this.root.name = "tutorial-marks";
    data.lessons.forEach((l, i) => {
      this.title(l, i, titles[i]);
      if (l.exit) this.exit(l, i);
      l.gates?.forEach((g, k) => this.gate(l, i, k, g));
      if (l.lane) this.lane(l.lane, keys);
    });
    this.ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(18, 24, 40), this.ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.renderOrder = 31;
    this.ring.visible = false;
    this.root.add(this.ring);
  }

  // ------------------------------------------------------------------------------------------- building

  /**
   * The lesson's number and title on a board hung across the room ahead of its start, above head height: the same
   * signage as the speed gates, readable from where you arrive and clear of the HUD.
   */
  private title(l: LessonGeometry, i: number, text: string): void {
    // Centred on the start line, wall to wall where the walls are even (an L-shaped room: up to the nearer wall).
    const sy = l.start.position[1];
    const half = Math.min(sy - l.room.min[1], l.room.max[1] - sy);
    const y0 = sy - half;
    const y1 = sy + half;
    const w = y1 - y0;
    const cw = Math.min(4096, w * 2);
    const ch = Math.round((80 * cw) / w);
    const tex = texture(cw, ch, (g) => {
      g.fillStyle = "rgba(12, 14, 19, 0.88)";
      g.fillRect(0, 0, cw, ch);
      g.fillStyle = "rgba(255, 255, 255, 0.14)";
      g.fillRect(0, 0, cw, ch * 0.05);
      g.fillRect(0, ch * 0.95, cw, ch * 0.05);
      g.font = `800 ${Math.round(ch * 0.62)}px ${FONT}`;
      g.textBaseline = "middle";
      const num = String(i + 1);
      const gap = ch * 0.45;
      const nw = g.measureText(num).width;
      const tw = g.measureText(text).width;
      const x = (cw - nw - gap - tw) / 2;
      g.fillStyle = ACCENT;
      g.fillText(num, x, ch * 0.55);
      g.fillStyle = "#eef1f6";
      g.fillText(text, x + nw + gap, ch * 0.55);
    });
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    this.root.add(plane(mat, w, 80, toThree(l.start.position[0] + 1000, (y0 + y1) / 2, 344), 0, false));
  }

  private exit(l: LessonGeometry, i: number): void {
    const e = l.exit!;
    const cy = (e.min[1] + e.max[1]) / 2;
    const width = e.max[1] - e.min[1];
    const sign = (lit: boolean) =>
      texture(512, 160, (g) => {
        g.fillStyle = lit ? "rgba(26, 18, 3, 0.92)" : "rgba(12, 14, 19, 0.88)";
        g.beginPath();
        g.roundRect(4, 4, 504, 152, 18);
        g.fill();
        g.lineWidth = 6;
        g.strokeStyle = lit ? ACCENT : "rgba(255, 255, 255, 0.16)";
        g.stroke();
        g.font = `800 96px ${FONT}`;
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillStyle = lit ? ACCENT : "#59606d";
        g.fillText("EXIT", 256, 86);
      });
    const dim = sign(false);
    const lit = sign(true);
    const signMat = new THREE.MeshBasicMaterial({ map: dim, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    // On the wall behind the exit, above the doorway, facing back into the room.
    const sg = plane(signMat, 288, 90, toThree(l.room.max[0] - 1, cy, 432), 0, false);
    // The doorway: a glow rising from the floor, faded in when the exit opens.
    const glowTex = texture(4, 256, (g) => {
      const gr = g.createLinearGradient(0, 256, 0, 0);
      gr.addColorStop(0, "rgba(255, 180, 58, 0.75)");
      gr.addColorStop(0.45, "rgba(255, 180, 58, 0.18)");
      gr.addColorStop(1, "rgba(255, 180, 58, 0)");
      g.fillStyle = gr;
      g.fillRect(0, 0, 4, 256);
    });
    const glow = paintMaterial(glowTex, 0, 0xffffff, true);
    const gl = plane(glow, width, 256, toThree(l.room.max[0] - 2, cy, 128), 0, false);
    this.root.add(sg, gl);
    this.exits.set(i, { sign: sg.children[0] as THREE.Mesh, dim, lit, glow, t: 0, target: 0 });
  }

  private gate(l: LessonGeometry, i: number, k: number, g: { x: number; speed: number }): void {
    const board = (lit: boolean) =>
      texture(1024, 128, (c) => {
        c.fillStyle = lit ? "rgba(26, 18, 3, 0.9)" : "rgba(12, 14, 19, 0.82)";
        c.fillRect(0, 0, 1024, 128);
        c.fillStyle = lit ? ACCENT : "rgba(255, 255, 255, 0.14)";
        c.fillRect(0, 0, 1024, 6);
        c.fillRect(0, 122, 1024, 6);
        c.font = `800 92px ${FONT}`;
        c.textAlign = "center";
        c.textBaseline = "middle";
        c.fillStyle = lit ? ACCENT : "#8a93a6";
        c.fillText(String(g.speed), 512, 68);
      });
    const dim = board(false);
    const lit = board(true);
    const mat = new THREE.MeshBasicMaterial({ map: dim, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const y0 = l.room.min[1] + 64;
    const y1 = l.room.max[1] - 64;
    const p = plane(mat, y1 - y0, 80, toThree(g.x - 33, (y0 + y1) / 2, 344), 0, false);
    this.root.add(p);
    this.gates.set(`${i}:${k}`, { mesh: p.children[0] as THREE.Mesh, lit });
  }

  /** The strafe line (the map's slalom, layout.ts), with the key painted inside its first few bends. */
  private lane(pts: [number, number, number][], keys: { left: string; right: string }): void {
    const pos: number[] = [];
    const W = 3;
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0, k] = pts[i - 1];
      const [x1, y1] = pts[i];
      if (k === 0) continue;
      const dx = x1 - x0;
      const dy = y1 - y0;
      const len = Math.hypot(dx, dy);
      if (len < 1 || len > 200) continue;
      const nx = (-dy / len) * W;
      const ny = (dx / len) * W;
      const a = toThree(x0 + nx, y0 + ny, 0.6);
      const b = toThree(x0 - nx, y0 - ny, 0.6);
      const c = toThree(x1 + nx, y1 + ny, 0.6);
      const d = toThree(x1 - nx, y1 - ny, 0.6);
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, b.x, b.y, b.z, d.x, d.y, d.z, c.x, c.y, c.z);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    const line = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xf2f2ee, transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, side: THREE.DoubleSide }));
    line.renderOrder = 19;
    this.root.add(line);
    // The key at the first bends, inside each turn: the key that bends the line that way.
    let shown = 0;
    for (let i = 1; i < pts.length - 1 && shown < 4; i++) {
      const [x, y, k] = pts[i];
      const apex = (y - pts[i - 1][1]) * (pts[i + 1][1] - y) <= 0 && y !== pts[i - 1][1];
      if (!apex || k === 0) continue;
      const side = k < 0 ? 1 : -1; // the left key bends the line left (+y)
      const label = k < 0 ? keys.left : keys.right;
      const mat = floorText((g, w, h) => {
        g.fillStyle = "#fff";
        g.font = `800 ${Math.round(h * 0.8)}px ${FONT}`;
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillText(label, w / 2, h / 2 + h * 0.05);
      }, 64, 2.4, 256, 256);
      this.root.add(plane(mat, 64, mat.userData.depth as number, toThree(x, y + side * 60, 0.6), 0, true));
      shown++;
    }
  }

  // ------------------------------------------------------------------------------------------- state

  /** Lights lesson i's exit (the goal is met) or puts it out. */
  setExit(i: number, open: boolean): void {
    const e = this.exits.get(i);
    if (!e) return;
    e.target = open ? 1 : 0;
    (e.sign.material as THREE.MeshBasicMaterial).map = open ? e.lit : e.dim;
    if (still()) e.t = e.target;
  }

  lightGate(i: number, k: number): void {
    const g = this.gates.get(`${i}:${k}`);
    if (g) (g.mesh.material as THREE.MeshBasicMaterial).map = g.lit;
  }

  frame(dt: number): void {
    this.clock += dt;
    const calm = still();
    for (const e of this.exits.values()) {
      e.t += Math.sign(e.target - e.t) * Math.min(Math.abs(e.target - e.t), dt * 1.6);
      e.glow.opacity = e.t * (calm ? 0.9 : 0.75 + 0.2 * Math.sin(this.clock * 2.4));
    }
  }

  /**
   * Landing marker for `lesson` (only lessons with pits): ballistic landing point of the current hop on the floor
   * plane (z 0), ignoring air control. Hidden on the ground and when already below the floor.
   */
  landing(lesson: LessonGeometry | null, pos: readonly number[], vel: readonly number[], grounded: boolean, show: boolean): void {
    const pits = lesson?.pits ?? [];
    if (!show || !lesson || !pits.length || grounded || pos[2] < 0) {
      this.ring.visible = false;
      return;
    }
    const vz = vel[2];
    const t = (vz + Math.sqrt(Math.max(0, vz * vz + 1600 * pos[2]))) / 800;
    const x = pos[0] + vel[0] * t;
    const y = pos[1] + vel[1] * t;
    const inR = (r: Rect, m: number) => x > r.x0 - m && x < r.x1 + m && y > r.y0 - m && y < r.y1 + m;
    const pit = pits.some((r) => inR(r, -14)) && !(lesson.islands ?? []).some((r) => inR(r, 14));
    this.ringMat.color.set(pit ? 0xff5d5d : 0xffffff);
    this.ring.position.copy(toThree(x, y, 1.5));
    this.ring.visible = true;
  }

  dispose(): void {
    const textures = new Set<THREE.Texture>();
    for (const e of this.exits.values()) textures.add(e.dim).add(e.lit);
    for (const g of this.gates.values()) textures.add(g.lit);
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.geometry.dispose();
      const mat = m.material as THREE.MeshBasicMaterial;
      if (mat.map) textures.add(mat.map);
      mat.dispose();
    });
    for (const t of textures) t.dispose();
    this.root.removeFromParent();
  }
}
