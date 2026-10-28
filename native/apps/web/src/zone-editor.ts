// Zone rendering and the in-game zone editor.
// A zone is a floor outline plus a short light curtain around it: a gradient that fades upward over the bottom ~40% of
// the zone, one-sided (it faces out), so standing inside no longer tints the screen. Leaving the start zone drops its
// curtain; finishing flares the end zone's once (gold for a provisional world record). Those tweens write one uniform
// for a few hundred ms (ZoneView.frame); otherwise nothing runs per frame.
//   main start green · main end red · bonus start cyan · bonus end magenta · stage/checkpoint orange · draft white
//   (palette.ts zones: the colour-blind palettes swap these; ZoneView.recolor follows a change)
//
// Editor, a dev tool (toggle with Z on the dev server or with ?debug=1; players have no key for it, main.ts):
//   1  corner A at player feet      2  corner B at player feet (box extends 128u above the higher corner)
//   3  set box as START zone        4  set box as END zone          (of the track being edited)
//   6  add box as the next CHECKPOINT (split) of the track being edited
//   7  cycle the track being edited: main -> bonus 1 -> bonus 2 -> ... -> main
//   8  delete the zones of the edited track that the player is standing in
//   5  save (localStorage override + download <map>.zones.json)
//   0  delete the localStorage override (falls back to maps/<map>.zones.json / entities on reload)

import * as THREE from "three";
import { download } from "./pb";
import { hexNum, palette, type Palette } from "./palette";
import { normalizeZone, playerInZone, trackName, trackOf, tracksOf, zoneSetToJson, zoneStorageKey, type Zone, type ZoneKind, type ZoneSet } from "./zones";

const DRAFT = 0xffffff;

export function zoneColor(z: Pick<Zone, "kind" | "track">, c: Palette["zones"] = palette().zones): number {
  const bonus = trackOf(z) > 0;
  switch (z.kind) {
    case "start":
      return hexNum(bonus ? c.bonusStart : c.start);
    case "end":
      return hexNum(bonus ? c.bonusEnd : c.end);
    default:
      return hexNum(c.split);
  }
}

function boxMesh(z: Pick<Zone, "mins" | "maxs">, color: number, opacity = 0.16): THREE.Object3D {
  const size = [0, 1, 2].map((i) => Math.max(1, z.maxs[i] - z.mins[i]));
  // Source (x, y, z) -> three (x, z, -y)
  const geo = new THREE.BoxGeometry(size[0], size[2], size[1]);
  const fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide }));
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }));
  fill.add(edges);
  fill.position.set((z.mins[0] + z.maxs[0]) / 2, (z.mins[2] + z.maxs[2]) / 2, -(z.mins[1] + z.maxs[1]) / 2);
  fill.renderOrder = 4;
  return fill;
}

const CURTAIN_VS = `
varying float vH;
void main() {
  vH = uv.y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const CURTAIN_FS = `
uniform vec3 uColor;
uniform float uLevel;
varying float vH;
void main() {
  float a = 1.0 - vH;
  gl_FragColor = vec4(uColor, a * a * 0.42 * uLevel);
}`;

const GOLD = new THREE.Color(0xffd45e);

interface ZoneMesh {
  zone: Zone;
  root: THREE.Object3D;
  curtain: THREE.ShaderMaterial;
  color: THREE.Color;
  line: THREE.LineBasicMaterial;
  /** Curtain level at rest (stages and checkpoints are fainter). */
  rest: number;
}

interface Tween {
  m: ZoneMesh;
  t0: number;
  ms: number;
  /** Levels at 0, the middle and the end (a flare goes up and back). */
  from: number;
  peak: number | null;
  to: number;
  gold: boolean;
}

/** The four outward-facing walls of a zone's curtain, `h` units tall from its floor (three.js coordinates). */
function curtainGeometry(z: Pick<Zone, "mins" | "maxs">, h: number): THREE.BufferGeometry {
  // Source (x, y, z) -> three (x, z, -y)
  const y0 = z.mins[2];
  const y1 = y0 + h;
  const c = [(z.mins[0] + z.maxs[0]) / 2, -(z.mins[1] + z.maxs[1]) / 2];
  const corners: [number, number][] = [
    [z.mins[0], -z.mins[1]],
    [z.maxs[0], -z.mins[1]],
    [z.maxs[0], -z.maxs[1]],
    [z.mins[0], -z.maxs[1]],
  ];
  const pos: number[] = [];
  const uv: number[] = [];
  for (let i = 0; i < 4; i++) {
    let a = corners[i];
    let b = corners[(i + 1) % 4];
    // Wind each wall so its front faces away from the centre: (b - a) x up must point outward.
    const nx = -(b[1] - a[1]);
    const nz = b[0] - a[0];
    const mx = (a[0] + b[0]) / 2 - c[0];
    const mz = (a[1] + b[1]) / 2 - c[1];
    if (nx * mx + nz * mz < 0) [a, b] = [b, a];
    pos.push(a[0], y0, a[1], b[0], y0, b[1], b[0], y1, b[1], a[0], y0, a[1], b[0], y1, b[1], a[0], y1, a[1]);
    uv.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

function zoneMesh(z: Zone, color: number, rest: number): ZoneMesh {
  const root = new THREE.Group();
  const col = new THREE.Color(color);
  const height = Math.max(1, z.maxs[2] - z.mins[2]);
  const curtain = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: col.clone() }, uLevel: { value: rest } },
    vertexShader: CURTAIN_VS,
    fragmentShader: CURTAIN_FS,
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
  });
  const wall = new THREE.Mesh(curtainGeometry(z, Math.min(height, Math.max(24, height * 0.4))), curtain);
  wall.renderOrder = 4;
  // The floor outline, a hair above the floor.
  const f = z.mins[2] + 0.5;
  const loop = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(z.mins[0], f, -z.mins[1]),
    new THREE.Vector3(z.maxs[0], f, -z.mins[1]),
    new THREE.Vector3(z.maxs[0], f, -z.maxs[1]),
    new THREE.Vector3(z.mins[0], f, -z.maxs[1]),
  ]);
  const lineMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 });
  const line = new THREE.LineLoop(loop, lineMat);
  line.renderOrder = 4;
  root.add(wall, line);
  return { zone: z, root, curtain, color: col, line: lineMat, rest };
}

export class ZoneView {
  readonly root = new THREE.Group();
  private draft: THREE.Object3D | null = null;
  private zones: ZoneMesh[] = [];
  private tweens: Tween[] = [];

  private drop(o: THREE.Object3D): void {
    this.root.remove(o);
    o.traverse((c) => {
      if (c instanceof THREE.Mesh || c instanceof THREE.Line) {
        c.geometry.dispose();
        (c.material as THREE.Material).dispose();
      }
    });
  }

  set(zones: readonly Zone[]): void {
    for (const c of [...this.root.children]) if (c !== this.draft) this.drop(c);
    this.tweens = [];
    this.zones = zones.map((z) => zoneMesh(z, zoneColor(z), z.kind === "stage" || z.kind === "checkpoint" ? 0.5 : 1));
    for (const m of this.zones) this.root.add(m.root);
  }

  /** The colour-blind palette changed: every zone takes its colour from it (a flare under way carries on from it). */
  recolor(): void {
    for (const m of this.zones) {
      m.color.set(zoneColor(m.zone));
      (m.curtain.uniforms.uColor.value as THREE.Color).copy(m.color);
      m.line.color.copy(m.color);
    }
  }

  setDraft(z: Pick<Zone, "mins" | "maxs"> | null): void {
    if (this.draft) this.drop(this.draft);
    this.draft = z ? boxMesh(z, DRAFT, 0.12) : null;
    if (this.draft) this.root.add(this.draft);
  }

  private tween(m: ZoneMesh, to: number, ms: number, peak: number | null = null, gold = false): void {
    this.tweens = this.tweens.filter((t) => t.m !== m);
    this.tweens.push({ m, t0: performance.now(), ms, from: m.curtain.uniforms.uLevel.value as number, peak, to, gold });
  }

  /** A run on `track` started: its start curtain drops. */
  startRun(track: number): void {
    for (const m of this.zones) if (m.zone.kind === "start" && trackOf(m.zone) === track) this.tween(m, 0, 250);
  }

  /** Finished on `track`: its end zone flares once (gold: faster than the known world record). */
  finish(track: number, gold: boolean): void {
    for (const m of this.zones) if (m.zone.kind === "end" && trackOf(m.zone) === track) this.tween(m, m.rest, 400, 2.6, gold);
  }

  /** Back to the start (restart): dropped curtains come back up. */
  reset(): void {
    for (const m of this.zones) if ((m.curtain.uniforms.uLevel.value as number) < m.rest) this.tween(m, m.rest, 250);
  }

  /** Per rendered frame: advances the curtain tweens (a no-op when none is running). */
  frame(now: number): void {
    if (!this.tweens.length) return;
    this.tweens = this.tweens.filter((t) => {
      const k = Math.min(1, Math.max(0, (now - t.t0) / t.ms));
      const u = t.m.curtain.uniforms;
      let v: number;
      if (t.peak === null) v = t.from + (t.to - t.from) * (1 - (1 - k) * (1 - k));
      else v = k < 0.3 ? t.from + (t.peak - t.from) * (k / 0.3) : t.peak + (t.to - t.peak) * ((k - 0.3) / 0.7);
      u.uLevel.value = v;
      const c = u.uColor.value as THREE.Color;
      if (t.gold) c.copy(t.m.color).lerp(GOLD, k < 1 ? Math.min(1, 2 * (1 - k)) : 0);
      return k < 1;
    });
  }
}

export class ZoneEditor {
  active = false;
  /** Track that 3/4/6/8 act on. */
  track = 0;
  private a: number[] | null = null;
  private b: number[] | null = null;
  private lastDraft = "";

  constructor(
    private set: ZoneSet,
    private view: ZoneView,
    private playerFeet: () => readonly number[],
    private onChange: (set: ZoneSet) => void,
    private notify: (msg: string) => void,
  ) {}

  private box(): Zone | null {
    if (!this.a) return null;
    const b = this.b ?? this.a;
    const top = Math.max(this.a[2], b[2]) + 128;
    return normalizeZone("start", [this.a[0], this.a[1], Math.min(this.a[2], b[2])], [b[0], b[1], top]);
  }

  help(): string {
    return `ZONE EDITOR [${trackName(this.track)}] · 1 corner A · 2 corner B · 3 start · 4 end · 6 checkpoint · 7 track · 8 delete here · 5 save · 0 clear override · Z exit`;
  }

  private commit(zones: Zone[], msg: string): void {
    const prov = this.set.provenance;
    this.set = {
      ...this.set,
      zones,
      source: "editor (unsaved)",
      provenance: { source: "editor", basedOn: prov?.source === "editor" ? prov.basedOn : (prov?.source ?? this.set.source ?? null), editedAt: new Date().toISOString() },
    };
    this.onChange(this.set);
    this.notify(msg);
  }

  /** Returns true if the key was consumed. */
  onKey(code: string): boolean {
    if (code === "KeyZ") {
      this.active = !this.active;
      if (!this.active) this.view.setDraft(null);
      this.notify(this.active ? this.help() : "zone editor off");
      return true;
    }
    if (!this.active) return false;
    const feet = this.playerFeet();
    const zones = this.set.zones;
    switch (code) {
      case "Digit1":
        this.a = [Math.round(feet[0]), Math.round(feet[1]), Math.round(feet[2])];
        this.b = null;
        break;
      case "Digit2":
        if (!this.a) return this.notify("place corner A first (1)"), true;
        this.b = [Math.round(feet[0]), Math.round(feet[1]), Math.round(feet[2])];
        break;
      case "Digit3":
      case "Digit4":
      case "Digit6": {
        const box = this.box();
        if (!box || !this.b) return this.notify("place corners A (1) and B (2) first"), true;
        const kind: ZoneKind = code === "Digit3" ? "start" : code === "Digit4" ? "end" : "checkpoint";
        const t = this.track;
        if (kind === "checkpoint") {
          const index = 1 + Math.max(0, ...zones.filter((z) => (z.kind === "checkpoint" || z.kind === "stage") && trackOf(z) === t).map((z) => z.index ?? 0));
          this.a = this.b = null;
          this.commit([...zones, normalizeZone("checkpoint", box.mins, box.maxs, t, index)], `${trackName(t)} checkpoint ${index} added · press 5 to save`);
        } else {
          this.a = this.b = null;
          this.commit(
            [...zones.filter((z) => !(z.kind === kind && trackOf(z) === t)), normalizeZone(kind, box.mins, box.maxs, t)],
            `${trackName(t)} ${kind} zone set · press 5 to save`,
          );
        }
        break;
      }
      case "Digit7": {
        const max = Math.max(0, ...zones.map(trackOf));
        this.track = this.track >= max + 1 ? 0 : this.track + 1;
        const exists = tracksOf(zones).includes(this.track);
        this.notify(`editing ${trackName(this.track)}${exists ? "" : " (new: set a start and an end zone)"} · ${this.help()}`);
        break;
      }
      case "Digit8": {
        const keep = zones.filter((z) => !(trackOf(z) === this.track && playerInZone(feet, false, z)));
        if (keep.length === zones.length) return this.notify(`not standing in any ${trackName(this.track)} zone`), true;
        this.commit(keep, `deleted ${zones.length - keep.length} ${trackName(this.track)} zone(s) · press 5 to save`);
        break;
      }
      case "Digit5": {
        const json = zoneSetToJson(this.set, true);
        localStorage.setItem(zoneStorageKey(this.set.map), json);
        download(new TextEncoder().encode(json), `${this.set.map}.zones.json`, "application/json");
        this.notify(`saved ${this.set.map}.zones.json (localStorage + download; copy into maps/ to share)`);
        break;
      }
      case "Digit0":
        localStorage.removeItem(zoneStorageKey(this.set.map));
        this.notify("zone override cleared (reload to use map defaults)");
        break;
      default:
        return false;
    }
    this.view.setDraft(this.box());
    return true;
  }

  /** Live-updates the draft box while corner B isn't placed yet. */
  frame(): void {
    if (!this.active || !this.a || this.b) return;
    const f = this.playerFeet().map(Math.round);
    const key = f.join(",");
    if (key === this.lastDraft) return;
    this.lastDraft = key;
    const top = Math.max(this.a[2], f[2]) + 128;
    this.view.setDraft(normalizeZone("start", [this.a[0], this.a[1], Math.min(this.a[2], f[2])], [f[0], f[1], top]));
  }
}
