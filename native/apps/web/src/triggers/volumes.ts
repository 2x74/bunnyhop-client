// Trigger and clip overlays (!showtriggers / !showclips / !triggers): the kinds, which of them the prefs show and how
// they look, and the geometry. DOM- and three-free, so apps/api/test/trigger-overlay.test.ts runs it.
//
// The core says what each volume is (crates/core/src/game/overlay.rs: the triggers it touches, the brushes the player's
// solid mask hits) as convex brushes given by their planes; this turns them into one triangle list and two line lists
// (every edge; the bottom style's floor outlines) for all kinds, each vertex tagged with its kind and its slot (what
// moves it and switches it on: triggers/overlay.ts).

import { OVERLAY_STATE_ACTIVE, OVERLAY_STATE_VISIBLE, type OverlayVolume } from "../core";

/** Kinds in menu order; `core` is the OVERLAY_* number the core reports. */
export const KINDS = [
  { id: "teleport", core: 0, label: "Teleports", group: "triggers", color: 0xff4040 },
  { id: "push", core: 1, label: "Boosters", group: "triggers", color: 0x3d8bff },
  { id: "gravity", core: 2, label: "Gravity and speed", group: "triggers", color: 0x3ddc84 },
  { id: "other", core: 3, label: "Other triggers", group: "triggers", color: 0xffd23d },
  { id: "clip", core: 4, label: "Player clips", group: "clips", color: 0xb35cff },
  { id: "wall", core: 5, label: "Invisible walls", group: "clips", color: 0xb4bac4 },
] as const;

export type KindId = (typeof KINDS)[number]["id"];

/** OVERLAY_WHEN_HIDDEN: the volume only blocks while its entity isn't drawn (a func_brush disabled but solid). */
export const WHEN_HIDDEN = 1;

/**
 * How volumes draw: filled (see-through faces and their edges), outline (the edges only) or bottom (only the outline of
 * each volume's floor, its downward faces: where a teleport or booster starts, without boxes in the way).
 */
export type TriggerStyle = "filled" | "outline" | "bottom";
export const TRIGGER_STYLES: readonly [TriggerStyle, string][] = [
  ["filled", "Filled"],
  ["outline", "Outline"],
  ["bottom", "Bottom"],
];

/** Settings → HUD → Triggers and clips: the slider bounds (settings-io.ts clamps imports to the same). */
export const TRIGGER_OPACITY: [number, number] = [0, 1];
export const TRIGGER_THICKNESS: [number, number] = [1, 6];

/** ui/settings.ts Prefs.triggers. */
export interface TriggerPrefs {
  /** !showtriggers: the trigger kinds. */
  show: boolean;
  /** !showclips: player clips and invisible walls. */
  clips: boolean;
  /** Kinds turned off in the !triggers menu. */
  kinds: Record<KindId, boolean>;
  /** Colour per kind, "#rrggbb" (defaults: KINDS). */
  colors: Record<KindId, string>;
  style: TriggerStyle;
  /** Opacity of the faces in the filled style. */
  opacity: number;
  /** Line width in CSS px (1 = the plain 1px lines). */
  thickness: number;
}

const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;

export const DEFAULT_TRIGGER_PREFS: TriggerPrefs = {
  show: false,
  clips: false,
  kinds: { teleport: true, push: true, gravity: true, other: true, clip: true, wall: true },
  colors: Object.fromEntries(KINDS.map((k) => [k.id, hex(k.color)])) as Record<KindId, string>,
  style: "filled",
  opacity: 0.16,
  thickness: 1,
};

/**
 * Stored or imported trigger prefs (ui/settings.ts migratePrefs, in place): a colour that isn't "#rrggbb", an unknown
 * style or a number that isn't one goes (the default takes its place); numbers are clamped to the sliders. Prefs saved
 * before colours and styles existed have none of them and get the defaults, which are the old look.
 */
export function normalizeTriggerPrefs(raw: unknown): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const t = raw as Record<string, unknown>;
  const colors = t.colors;
  if (colors && typeof colors === "object" && !Array.isArray(colors)) {
    const c = colors as Record<string, unknown>;
    for (const k of Object.keys(c)) {
      if (typeof c[k] === "string" && /^#[0-9a-f]{6}$/i.test(c[k] as string)) c[k] = (c[k] as string).toLowerCase();
      else delete c[k];
    }
  } else delete t.colors;
  if (!TRIGGER_STYLES.some(([s]) => s === t.style)) delete t.style;
  for (const [k, [lo, hi]] of [["opacity", TRIGGER_OPACITY], ["thickness", TRIGGER_THICKNESS]] as const) {
    const v = t[k];
    if (typeof v === "number" && Number.isFinite(v)) t[k] = Math.min(hi, Math.max(lo, v));
    else delete t[k];
  }
}

const kindDef = (id: KindId) => KINDS.find((k) => k.id === id)!;

/** Whether kind `id` is drawn: its overlay (!showtriggers or !showclips) is on and the menu hasn't turned it off. */
export function kindShown(p: TriggerPrefs, id: KindId): boolean {
  return (kindDef(id).group === "triggers" ? p.show : p.clips) && p.kinds[id];
}

/**
 * A pick in the !triggers menu: a shown kind is turned off; a hidden one is turned on, with its overlay if that was
 * off (picking Teleports with !showtriggers off shows just the kinds left on).
 */
export function toggleKind(p: TriggerPrefs, id: KindId): void {
  if (kindShown(p, id)) {
    p.kinds[id] = false;
    return;
  }
  p.kinds[id] = true;
  if (kindDef(id).group === "triggers") p.show = true;
  else p.clips = true;
}

/** The !triggers menu's Style item: the next style, round. */
export function nextStyle(s: TriggerStyle): TriggerStyle {
  const i = TRIGGER_STYLES.findIndex(([x]) => x === s);
  return TRIGGER_STYLES[(i + 1) % TRIGGER_STYLES.length][0];
}

/** The !triggers menu's Line thickness item: 1, 2, 3, 4 px, round (a width set in Settings goes on to the next step). */
export function nextThickness(px: number): number {
  return [2, 3, 4].find((s) => s > px) ?? 1;
}

/** How much a disabled trigger shows (it may switch on later: a delayed teleport, a stage gate). */
export const DISABLED = 0.3;

/**
 * How strongly a slot shows (0..1) given its entity's `Core.overlayStates()` bits: a trigger shows while enabled and dimmed while disabled, and goes when removed (a fired
 * trigger_once, a killed entity); a clip or wall shows only while it blocks (its entity solid, and for WHEN_HIDDEN ones
 * not drawn).
 */
export function slotStrength(trigger: boolean, flags: number, bits: number): number {
  const active = (bits & OVERLAY_STATE_ACTIVE) !== 0;
  const visible = (bits & OVERLAY_STATE_VISIBLE) !== 0;
  if (trigger) return active ? 1 : visible ? DISABLED : 0;
  return active && !(flags & WHEN_HIDDEN && visible) ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------
// Geometry

/** Far beyond any map (Source's coordinates stop at ±16384, CS:GO's ±32768). */
const HUGE = 131072;
/** vbsp's ON_EPSILON: points this close to a plane count as on it. */
const EPS = 0.01;

type Vec3 = [number, number, number];

/** A square on plane (n, d) much larger than any map, wound counter-clockwise seen from the front (outside). */
function baseWinding(n: Vec3, d: number): Vec3[] {
  // Up: the world axis least aligned with the normal, made perpendicular to it.
  const ax = Math.abs(n[0]);
  const ay = Math.abs(n[1]);
  const az = Math.abs(n[2]);
  let up: Vec3 = az >= ax && az >= ay ? [1, 0, 0] : [0, 0, 1];
  const k = up[0] * n[0] + up[1] * n[1] + up[2] * n[2];
  up = [up[0] - k * n[0], up[1] - k * n[1], up[2] - k * n[2]];
  const l = Math.hypot(...up);
  up = [up[0] / l, up[1] / l, up[2] / l];
  // Right = up × n: (right, up, n) is right-handed, so right → up turns counter-clockwise seen along -n.
  const right: Vec3 = [up[1] * n[2] - up[2] * n[1], up[2] * n[0] - up[0] * n[2], up[0] * n[1] - up[1] * n[0]];
  const o: Vec3 = [n[0] * d, n[1] * d, n[2] * d];
  const at = (r: number, u: number): Vec3 => [o[0] + right[0] * r + up[0] * u, o[1] + right[1] * r + up[1] * u, o[2] + right[2] * r + up[2] * u];
  return [at(-HUGE, -HUGE), at(HUGE, -HUGE), at(HUGE, HUGE), at(-HUGE, HUGE)];
}

/** Keeps the part of `w` behind plane (n, d) (n·p <= d). */
function clipBehind(w: Vec3[], n: Vec3, d: number): Vec3[] {
  const out: Vec3[] = [];
  const dist = w.map((p) => p[0] * n[0] + p[1] * n[1] + p[2] * n[2] - d);
  for (let i = 0; i < w.length; i++) {
    const a = w[i];
    const b = w[(i + 1) % w.length];
    const da = dist[i];
    const db = dist[(i + 1) % w.length];
    if (da <= EPS) out.push(a);
    if ((da < -EPS && db > EPS) || (da > EPS && db < -EPS)) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
  }
  return out;
}

/**
 * The faces of the convex brush bounded by `planes` (nx, ny, nz, d per plane, outward), each a polygon wound
 * counter-clockwise seen from outside. Planes that don't touch the brush (vbsp's extra bevels) give no face.
 */
export function brushFaces(planes: ArrayLike<number>): Vec3[][] {
  const count = Math.floor(planes.length / 4);
  const faces: Vec3[][] = [];
  const same = (i: number, j: number) => [0, 1, 2, 3].every((k) => planes[i * 4 + k] === planes[j * 4 + k]);
  for (let i = 0; i < count; i++) {
    // A plane listed twice gives one face.
    let dup = false;
    for (let j = 0; j < i && !dup; j++) dup = same(i, j);
    if (dup) continue;
    const n: Vec3 = [planes[i * 4], planes[i * 4 + 1], planes[i * 4 + 2]];
    let w = baseWinding(n, planes[i * 4 + 3]);
    for (let j = 0; j < count && w.length >= 3; j++) {
      if (j !== i) w = clipBehind(w, [planes[j * 4], planes[j * 4 + 1], planes[j * 4 + 2]], planes[j * 4 + 3]);
    }
    if (w.length >= 3 && area(w) > 0.01) faces.push(w);
  }
  return faces;
}

/** Points closer than this (1/8 unit) are one point when edges are matched up. */
const pointKey = (p: Vec3) => `${Math.round(p[0] * 8)},${Math.round(p[1] * 8)},${Math.round(p[2] * 8)}`;

/**
 * The bottom style's lines for one brush (its `brushFaces`): the outline of its floor, i.e. the edges of the faces that
 * look down which no other downward face shares (a box gives its bottom face's four edges; a brush whose underside is
 * two slopes gives their rim, not the crease between them). In the brush's own space: a rotated brush keeps the floor
 * it was built with.
 */
export function bottomEdges(faces: readonly Vec3[][]): [Vec3, Vec3][] {
  const edges = new Map<string, { a: Vec3; b: Vec3; n: number }>();
  for (const f of faces) {
    // Newell's normal: faces are wound counter-clockwise seen from outside, so it points out.
    const n: Vec3 = [0, 0, 0];
    for (let i = 0; i < f.length; i++) {
      const a = f[i];
      const b = f[(i + 1) % f.length];
      n[0] += (a[1] - b[1]) * (a[2] + b[2]);
      n[1] += (a[2] - b[2]) * (a[0] + b[0]);
      n[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    const len = Math.hypot(n[0], n[1], n[2]);
    const nz = len > 0 ? n[2] / len : 0;
    // Down, not sideways: a wall's face is never part of the floor.
    if (nz > -0.01) continue;
    for (let i = 0; i < f.length; i++) {
      const a = f[i];
      const b = f[(i + 1) % f.length];
      const ka = pointKey(a);
      const kb = pointKey(b);
      if (ka === kb) continue;
      const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const e = edges.get(k);
      if (e) e.n++;
      else edges.set(k, { a, b, n: 1 });
    }
  }
  return [...edges.values()].filter((e) => e.n === 1).map((e) => [e.a, e.b]);
}

function area(w: Vec3[]): number {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 1; i + 1 < w.length; i++) {
    const a = [w[i][0] - w[0][0], w[i][1] - w[0][1], w[i][2] - w[0][2]];
    const b = [w[i + 1][0] - w[0][0], w[i + 1][1] - w[0][1], w[i + 1][2] - w[0][2]];
    x += a[1] * b[2] - a[2] * b[1];
    y += a[2] * b[0] - a[0] * b[2];
    z += a[0] * b[1] - a[1] * b[0];
  }
  return Math.hypot(x, y, z) / 2;
}

/** What places and switches on a group of volumes: an entity's model transform and state, or nothing (slot 0). */
export interface Slot {
  /** Entity index, -1 for world brushes. */
  entity: number;
  /** Brush model (its `brushOrigins()` transform), -1 for world space. */
  model: number;
  /** WHEN_HIDDEN or 0. */
  flags: number;
}

export interface OverlayGeometry {
  /** Triangles: xyz per vertex in its slot's model space; kind index (KINDS order) and slot per vertex. */
  faces: { position: Float32Array; kind: Float32Array; slot: Float32Array };
  /** Line segments (pairs of vertices), same layout. */
  edges: { position: Float32Array; kind: Float32Array; slot: Float32Array };
  /** The bottom style's line segments (`bottomEdges` of every volume), same layout. */
  bottom: { position: Float32Array; kind: Float32Array; slot: Float32Array };
  /** Slot 0 is the static world (identity, always on). */
  slots: Slot[];
  /** Volumes per kind (KINDS order), for the menu. */
  counts: number[];
}

/** Builds the overlay geometry from the core's volumes (`Core.overlayVolumes`). */
export function buildOverlayGeometry(volumes: readonly OverlayVolume[]): OverlayGeometry {
  const slots: Slot[] = [{ entity: -1, model: -1, flags: 0 }];
  const slotOf = new Map<string, number>();
  const counts = KINDS.map(() => 0);
  const fp: number[] = [];
  const fk: number[] = [];
  const fs: number[] = [];
  const ep: number[] = [];
  const ek: number[] = [];
  const es: number[] = [];
  const bp: number[] = [];
  const bk: number[] = [];
  const bs: number[] = [];
  for (const v of volumes) {
    const kind = KINDS.findIndex((k) => k.core === v.kind);
    if (kind < 0) continue;
    let slot = 0;
    if (v.entity >= 0 || v.model >= 0) {
      const key = `${v.entity}:${v.model}:${v.flags}`;
      slot = slotOf.get(key) ?? -1;
      if (slot < 0) {
        slot = slots.length;
        slots.push({ entity: v.entity, model: v.model, flags: v.flags });
        slotOf.set(key, slot);
      }
    }
    const faces = brushFaces(v.planes);
    if (!faces.length) continue;
    counts[kind]++;
    // Edges shared by two faces of the brush are drawn once.
    const seen = new Set<string>();
    for (const [a, b] of bottomEdges(faces)) {
      bp.push(a[0], a[1], a[2], b[0], b[1], b[2]);
      bk.push(kind, kind);
      bs.push(slot, slot);
    }
    for (const f of faces) {
      for (let i = 1; i + 1 < f.length; i++) {
        for (const p of [f[0], f[i], f[i + 1]]) fp.push(p[0], p[1], p[2]);
        fk.push(kind, kind, kind);
        fs.push(slot, slot, slot);
      }
      for (let i = 0; i < f.length; i++) {
        const a = f[i];
        const b = f[(i + 1) % f.length];
        const ka = pointKey(a);
        const kb = pointKey(b);
        if (ka === kb) continue;
        const e = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        if (seen.has(e)) continue;
        seen.add(e);
        ep.push(a[0], a[1], a[2], b[0], b[1], b[2]);
        ek.push(kind, kind);
        es.push(slot, slot);
      }
    }
  }
  return {
    faces: { position: new Float32Array(fp), kind: new Float32Array(fk), slot: new Float32Array(fs) },
    edges: { position: new Float32Array(ep), kind: new Float32Array(ek), slot: new Float32Array(es) },
    bottom: { position: new Float32Array(bp), kind: new Float32Array(bk), slot: new Float32Array(bs) },
    slots,
    counts,
  };
}

/**
 * Source's AngleMatrix (Rz(yaw) · Ry(pitch) · Rx(roll)) with the origin as the 4th column: the three rows of a 3x4
 * model-to-world matrix, for a `brushOrigins()` transform [x, y, z, pitch, yaw, roll].
 */
export function transformRows(t: ArrayLike<number>, out: Float32Array, at: number): void {
  const D = Math.PI / 180;
  const [sp, cp] = [Math.sin(t[3] * D), Math.cos(t[3] * D)];
  const [sy, cy] = [Math.sin(t[4] * D), Math.cos(t[4] * D)];
  const [sr, cr] = [Math.sin(t[5] * D), Math.cos(t[5] * D)];
  out.set([cp * cy, sr * sp * cy - cr * sy, cr * sp * cy + sr * sy, t[0]], at);
  out.set([cp * sy, sr * sp * sy + cr * cy, cr * sp * sy - sr * cy, t[1]], at + 4);
  out.set([-sp, sr * cp, cr * cp, t[2]], at + 8);
}
