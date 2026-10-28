// Floating name tag: "● WR · name  0:12.345" with an optional live delta line (+0.231 behind / -0.120 ahead).
// A canvas sprite, redrawn only when its text changes; drawn on top (no depth test, so walls never cut it in half).
// Whether it shows at all is TagSight's call: by default only while its player / ghost is in line of sight (CS:S
// mp_playerid style: no names through walls), fading with distance. Settings -> Ghost -> "Names through walls".

import * as THREE from "three";
import { palette } from "../palette";
import {
  equippedNameBadges, GIFTER_BOW, GIFTER_PATH, GIFTER_TIERS, isGifterColor, SPECIAL_BADGES,
  BOOSTER_GEM,
  BOOSTER_GIRDLE,
  BOOSTER_PINK,
  CREATOR_COLOR,
  nameEffectOf,
  nameColorHex,
  STAFF_COLOR,
  STAFF_INK,
  STAFF_SHIELD,
  STAFF_STROKES,
  SUPPORTER_LAYERS,
  TILE_MARKS,
  TILE_RECT,
  VERIFIED_BLUE,
  VERIFIED_CHECK,
  type CreatorKind,
  type PlayerMarks,
  type StaffBadge,
} from "../creators";

const W = 512;
const H = 112;
const FONT = '600 30px Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
const MONO = '600 28px ui-monospace, "SF Mono", Menlo, Consolas, monospace';

export class NameTag {
  readonly sprite: THREE.Sprite;
  private canvas = document.createElement("canvas");
  private g: CanvasRenderingContext2D;
  private tex: THREE.CanvasTexture;
  private key = "";
  private reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

  constructor(private color: string) {
    this.canvas.width = W;
    this.canvas.height = H;
    this.g = this.canvas.getContext("2d")!;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.generateMipmaps = false;
    this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex, depthTest: false, depthWrite: false, transparent: true }));
    this.sprite.center.set(0.5, 0);
    this.sprite.renderOrder = 40;
  }

  /**
   * Redraws if anything changed. delta: seconds (negative = you are ahead of this ghost) or null. marks: the room's
   * staff shield / Verified check / creator icon / Server Booster gem / Supporter badge (other players only), drawn
   * right after the name; a supporter's name look for the name. The tags are canvas textures redrawn only when they
   * change, so the look is drawn still: the colour; glow as a soft glow; gradient as the gradient; shine as the plain
   * colour (it needs motion).
   */
  set(name: string, time: string, delta: string | null, ahead: boolean, marks?: PlayerMarks | null): void {
    const equipped = marks ? equippedNameBadges(marks) : [];
    const motion = marks?.gifterAnimated !== false && !this.reducedMotion.matches;
    const clock = motion && equipped.some(id => id === "gifter-prism" || id === "gifter-gold" || SPECIAL_BADGES[id]?.gold) ? Math.floor(performance.now() / 66) : 0;
    // Special badges draw from their SVG as an image: redraw once each has loaded.
    const loading = equipped.filter((id) => SPECIAL_BADGES[id] && !specialImage(id)).join(",");
    const key = `${clock}|${loading}|${equipped.join(",")}|${marks?.gifterColors?.join(",") ?? ""}|${marks?.gifterAnimated ?? ""}|${name}|${time}|${delta}|${ahead}|${marks?.staff ?? ""}${marks?.verified ? 1 : 0}${marks?.creator ?? ""}${marks?.booster ? 1 : 0}${marks?.supporter ? 1 : 0}|${marks?.nameColor ?? ""}|${marks?.nameEffect ?? ""}|${marks?.nameColor2 ?? ""}`;
    if (key === this.key) return;
    this.key = key;
    const g = this.g;
    g.clearRect(0, 0, W, H);
    g.font = FONT;
    const nameW = Math.min(g.measureText(name).width, W - 120);
    const marksW = equipped.length * (MARK + 6);
    g.font = MONO;
    const timeW = g.measureText(time).width;
    const pillW = Math.min(W - 4, 30 + nameW + marksW + 18 + timeW + 22);
    const x0 = (W - pillW) / 2;
    g.fillStyle = "rgba(11, 13, 18, 0.62)";
    roundRect(g, x0, 2, pillW, 50, 25);
    g.fill();
    g.fillStyle = this.color;
    g.beginPath();
    g.arc(x0 + 24, 27, 8, 0, Math.PI * 2);
    g.fill();
    g.textBaseline = "middle";
    g.font = FONT;
    const fx = nameEffectOf(marks?.nameEffect);
    const base = nameColorHex(marks?.nameColor) ?? "#eef1f6";
    g.fillStyle = base;
    if (fx === "paint") {
      // The gradient across the name, to the second colour (or a paler shade of the first) and back.
      const c2 = nameColorHex(marks?.nameColor2) ?? mixHex(base, "#ffffff", 0.55);
      const grad = g.createLinearGradient(x0 + 40, 0, x0 + 40 + nameW, 0);
      grad.addColorStop(0, base);
      grad.addColorStop(0.5, c2);
      grad.addColorStop(1, base);
      g.fillStyle = grad;
    } else if (fx === "glow") {
      g.shadowColor = base;
      g.shadowBlur = 14;
    }
    g.fillText(name, x0 + 40, 28, W - 120);
    g.shadowBlur = 0;
    g.shadowColor = "transparent";
    let mx = x0 + 40 + nameW + 6;
    for (const id of equipped) {
      if (id === "staff") drawStaff(g, marks!.staff!, mx, 27 - MARK / 2);
      else if (id === "verified") drawVerified(g, mx, 27 - MARK / 2);
      else if (id === "creator") drawCreator(g, marks!.creator!, mx, 27 - MARK / 2);
      else if (id === "booster") drawBooster(g, mx, 27 - MARK / 2);
      else if (id === "supporter") drawSupporter(g, mx, 27 - MARK / 2);
      else {
        const img = SPECIAL_BADGES[id] ? specialImage(id) : null;
        if (img) drawSpecial(g, img, !!SPECIAL_BADGES[id].gold && motion, mx, 27 - MARK / 2);
        const tier = img ? undefined : GIFTER_TIERS.find((t) => t.id === id);
        if (tier) {
          g.save();
          g.translate(mx, 27 - MARK / 2);
          g.scale(MARK / 24, MARK / 24);
          const colors =
            tier.goal === 100
              ? marks?.gifterColors?.filter(isGifterColor)?.length
                ? marks.gifterColors.filter(isGifterColor)
                : ["#b98cff", "#7fcfff", "#ffb9db"]
              : undefined;
          g.fillStyle = colors?.[0] ?? tier.color;
          // Prism: its colours flow left to right through the gift (one pass every 4 s), as ui/marks.css.
          if (motion && tier.goal === 100 && (colors?.length ?? 0) > 1) {
            const P = 30;
            const x0 = -P + P * ((performance.now() / 4000) % 1);
            const grad = g.createLinearGradient(x0, 0, x0 + 2 * P, 0);
            const loop = [...colors!, ...colors!, colors![0]];
            loop.forEach((c, i) => grad.addColorStop(i / (loop.length - 1), c));
            g.fillStyle = grad;
          }
          g.strokeStyle = "#000";
          g.lineWidth = 0.7;
          g.lineJoin = "round";
          const bow = new Path2D(GIFTER_BOW);
          g.fill(bow, "evenodd");
          g.stroke(bow);
          const path = new Path2D(GIFTER_PATH);
          g.fill(path);
          g.stroke(path);
          // Gold: a glint sweeps across in the first third of every 3.2 s.
          const glint = (performance.now() % 3200) / 3200 / 0.35;
          if (motion && tier.goal === 25 && glint < 1) {
            const x = -16 + glint * 56;
            const shine = g.createLinearGradient(x - 8, -4, x + 8, 4);
            shine.addColorStop(0, "rgba(255,248,214,0)");
            shine.addColorStop(0.5, "rgba(255,248,214,0.95)");
            shine.addColorStop(1, "rgba(255,248,214,0)");
            for (const [shape, rule] of [[bow, "evenodd"], [path, "nonzero"]] as const) {
              g.save();
              g.clip(shape, rule);
              g.fillStyle = shine;
              g.fillRect(0, 0, 24, 24);
              g.restore();
            }
          }
          g.restore();
        }
      }
      mx += MARK + 6;
    }
    g.font = MONO;
    g.fillStyle = "#a3abba";
    g.fillText(time, x0 + 40 + nameW + marksW + 18, 28);
    if (delta) {
      g.font = MONO;
      const dw = g.measureText(delta).width + 28;
      g.fillStyle = "rgba(11, 13, 18, 0.62)";
      roundRect(g, (W - dw) / 2, 60, dw, 44, 22);
      g.fill();
      g.fillStyle = ahead ? palette().gain : palette().loss;
      g.textAlign = "center";
      g.fillText(delta, W / 2, 83);
      g.textAlign = "left";
    }
    this.tex.needsUpdate = true;
  }

  /** Places the tag (bottom-centre at `pos`) at a roughly constant on-screen size. */
  place(pos: THREE.Vector3, camera: THREE.Vector3, opacity: number): void {
    this.sprite.position.copy(pos);
    const d = pos.distanceTo(camera);
    const s = 0.09 * Math.max(1, d / 260);
    this.sprite.scale.set(W * s, H * s, 1);
    (this.sprite.material as THREE.SpriteMaterial).opacity = opacity;
    this.sprite.visible = opacity > 0.01;
  }

  dispose(): void {
    this.sprite.removeFromParent();
    this.tex.dispose();
    (this.sprite.material as THREE.Material).dispose();
  }
}

/** Mark size on the tag canvas (px), drawn from the same 24-unit geometry as the UI's SVG (creators.ts). */
const MARK = 26;

function drawVerified(g: CanvasRenderingContext2D, x: number, y: number): void {
  g.save();
  g.translate(x, y);
  g.scale(MARK / 24, MARK / 24);
  g.fillStyle = VERIFIED_BLUE;
  g.beginPath();
  g.arc(12, 12, 11, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = "#fff";
  g.lineWidth = 2.6;
  g.lineCap = "round";
  g.lineJoin = "round";
  g.stroke(new Path2D(VERIFIED_CHECK));
  g.restore();
}

/** The staff shield (creators.ts STAFF_SVG): the role's colour, dark chevrons / the crown. */
function drawStaff(g: CanvasRenderingContext2D, b: StaffBadge, x: number, y: number): void {
  g.save();
  g.translate(x, y);
  g.scale(MARK / 24, MARK / 24);
  g.fillStyle = STAFF_COLOR[b];
  g.fill(new Path2D(STAFF_SHIELD));
  g.strokeStyle = STAFF_INK;
  g.lineCap = "round";
  g.lineJoin = "round";
  for (const s of STAFF_STROKES[b]) {
    g.lineWidth = s.width;
    g.stroke(new Path2D(s.d));
  }
  g.restore();
}

/** "#rrggbb" a + (b - a) * t. */
function mixHex(a: string, b: string, t: number): string {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, "0")).join("")}`;
}

/** The Supporter badge (creators.ts SUPPORTER_LAYERS, the shown SUPPORTER_BADGE): its layers back to front. */
function drawSupporter(g: CanvasRenderingContext2D, x: number, y: number): void {
  g.save();
  g.translate(x, y);
  g.scale(MARK / 24, MARK / 24);
  g.lineJoin = "round";
  g.lineCap = "round";
  for (const l of SUPPORTER_LAYERS) {
    const path = new Path2D(l.d);
    if (l.fill) {
      g.fillStyle = l.fill;
      g.fill(path);
    }
    if (l.stroke) {
      g.strokeStyle = l.stroke;
      g.lineWidth = l.width ?? 1;
      g.stroke(path);
    }
  }
  g.restore();
}

/** The Server Booster gem (creators.ts BOOSTER_SVG): pink disc, white gem, girdle line. */
function drawBooster(g: CanvasRenderingContext2D, x: number, y: number): void {
  g.save();
  g.translate(x, y);
  g.scale(MARK / 24, MARK / 24);
  g.fillStyle = BOOSTER_PINK;
  g.beginPath();
  g.arc(12, 12, 11, 0, Math.PI * 2);
  g.fill();
  const gem = new Path2D(BOOSTER_GEM);
  g.fillStyle = "#fff";
  g.strokeStyle = "#fff";
  g.lineWidth = 0.6;
  g.lineJoin = "round";
  g.fill(gem);
  g.stroke(gem);
  g.strokeStyle = BOOSTER_PINK;
  g.lineWidth = 1.5;
  g.stroke(new Path2D(BOOSTER_GIRDLE));
  g.restore();
}

function drawCreator(g: CanvasRenderingContext2D, kind: CreatorKind, x: number, y: number): void {
  g.save();
  g.translate(x, y);
  g.scale(MARK / 24, MARK / 24);
  g.fillStyle = CREATOR_COLOR[kind];
  if (kind === "tiktok" || kind === "x") {
    // Tile marks (creators.ts TILE_MARKS): the same primitives as their SVG.
    const m = TILE_MARKS[kind];
    roundRect(g, TILE_RECT.x, TILE_RECT.y, TILE_RECT.size, TILE_RECT.size, TILE_RECT.r);
    g.fillStyle = m.tile;
    g.fill();
    g.strokeStyle = m.edge;
    g.lineWidth = 1;
    g.stroke();
    g.lineCap = "round";
    g.lineJoin = "round";
    for (const st of m.strokes) {
      g.save();
      g.translate(st.dx ?? 0, st.dy ?? 0);
      g.strokeStyle = st.color;
      g.lineWidth = st.width;
      g.stroke(new Path2D(st.d));
      g.restore();
    }
  } else if (kind === "youtube") {
    roundRect(g, 1.5, 4.8, 21, 14.4, 4.4);
    g.fill();
    g.fillStyle = "#fff";
    g.fill(new Path2D("M10 8.7v6.6l5.6-3.3z"));
  } else {
    g.fill(new Path2D("M5 2.5 3 6.6v13h4.6V22h2.6l2.4-2.4h3.8L21 15V2.5z"));
    g.fillStyle = "#fff";
    g.fill(new Path2D("M10.6 7h2v5.6h-2zM15.2 7h2v5.6h-2z"));
  }
  g.restore();
}

/**
 * Line of sight in Source units: the clear fraction 0..1 of the segment from -> to through the world (core traceRay
 * with radius 0: world, props, solid brush entities; players and ghosts never block).
 */
export type SightTrace = (from: ArrayLike<number>, to: ArrayLike<number>) => number;

/** Seconds between line-of-sight checks per tag (staggered, so 20 players cost ~2-4 traces per frame). */
const SIGHT_INTERVAL = 0.1;
const FADE_IN = 8; // per second
const FADE_OUT = 5;

/**
 * Tag visibility: occlusion by world geometry (throttled ray casts from the camera to the head, then the chest) with a
 * short fade so tags don't flicker at corners, times a distance fade. `place()` takes the result as its opacity factor.
 */
export class TagSight {
  private a = -1;
  private seen = true;
  private wait = Math.random() * SIGHT_INTERVAL;
  private from = [0, 0, 0];
  private to = [0, 0, 0];

  constructor(
    /** Full opacity up to `near` units from the camera, gone at `far`. */
    private near: number,
    private far: number,
  ) {}

  /**
   * 0..1 for a tag whose bottom-centre sits at `tag` (three.js space, just above the head), seen from `camera`.
   * trace null or throughWalls: no occlusion (distance fade only).
   */
  update(dt: number, camera: THREE.Vector3, tag: THREE.Vector3, trace: SightTrace | null, throughWalls: boolean): number {
    let target = 1;
    if (trace && !throughWalls) {
      this.wait -= dt;
      if (this.wait <= 0 || this.a < 0) {
        this.wait = SIGHT_INTERVAL;
        // three (x, y, z) -> Source (x, -z, y)
        this.from[0] = camera.x, this.from[1] = -camera.z, this.from[2] = camera.y;
        this.seen = this.clear(trace, tag, 14) || this.clear(trace, tag, 42);
      }
      target = this.seen ? 1 : 0;
    }
    if (this.a < 0) this.a = target;
    else if (target > this.a) this.a = Math.min(target, this.a + dt * FADE_IN);
    else this.a = Math.max(target, this.a - dt * FADE_OUT);
    const d = camera.distanceTo(tag);
    const dist = d <= this.near ? 1 : d >= this.far ? 0 : 1 - (d - this.near) / (this.far - this.near);
    return this.a * dist;
  }

  /** The point `below` units under the tag is visible (hits within a few units of it count: heads touch ceilings). */
  private clear(trace: SightTrace, tag: THREE.Vector3, below: number): boolean {
    const to = this.to;
    to[0] = tag.x, to[1] = -tag.z, to[2] = tag.y - below;
    const len = Math.hypot(to[0] - this.from[0], to[1] - this.from[1], to[2] - this.from[2]);
    return (1 - trace(this.from, to)) * len < 10;
  }

  /** Forget the last check (teleports, camera cuts): the next update re-checks and snaps. */
  reset(): void {
    this.a = -1;
  }
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// ---------------------------------------------------------------------------------------------
// Special badges (creators.ts SPECIAL_BADGES): their SVG drawn as an image (gradients and all, as in the UI), with Gold
// Gifter's glint over the gold ones, painted only where the icon is (source-atop on a scratch canvas).

const specialImages = new Map<string, HTMLImageElement>();
function specialImage(id: string): HTMLImageElement | null {
  let img = specialImages.get(id);
  if (!img) {
    img = new Image();
    img.src = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 24 24">${SPECIAL_BADGES[id].svg}</svg>`)}`;
    specialImages.set(id, img);
  }
  return img.complete && img.naturalWidth ? img : null;
}

let scratch: CanvasRenderingContext2D | null = null;
function drawSpecial(g: CanvasRenderingContext2D, img: HTMLImageElement, shine: boolean, x: number, y: number): void {
  const glint = (performance.now() % 3200) / 3200 / 0.35;
  if (!shine || glint >= 1) return void g.drawImage(img, x, y, MARK, MARK);
  scratch ??= Object.assign(document.createElement("canvas"), { width: 96, height: 96 }).getContext("2d")!;
  const c = scratch;
  c.globalCompositeOperation = "source-over";
  c.clearRect(0, 0, 96, 96);
  c.drawImage(img, 0, 0, 96, 96);
  c.globalCompositeOperation = "source-atop";
  const sx = -64 + glint * 224;
  const band = c.createLinearGradient(sx - 32, -16, sx + 32, 16);
  band.addColorStop(0, "rgba(255,248,214,0)");
  band.addColorStop(0.5, "rgba(255,248,214,0.95)");
  band.addColorStop(1, "rgba(255,248,214,0)");
  c.fillStyle = band;
  c.fillRect(0, 0, 96, 96);
  g.drawImage(c.canvas, x, y, MARK, MARK);
}
