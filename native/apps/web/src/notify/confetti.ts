// Confetti for big moments (world / server records, level-ups, rare unlocks): one full-screen canvas that exists only
// while particles are in the air (a second or two), then is removed. Never while a run is going (notify/index.ts
// checks), never with reduced motion. Brand colours: the amber accent, cream hoodie, carrot orange and white, plus an
// optional highlight (an item's rarity colour).

const BRAND = ["#ffb43a", "#ffc35f", "#ece5d8", "#ff8a2a", "#ffffff", "#ffd45e"];

interface Bit {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  /** Flutter phase (the card turning over: its height follows cos). */
  flip: number;
  vf: number;
  w: number;
  h: number;
  color: string;
  round: boolean;
  /** A feather / leaf (pointed ellipse) instead of a paper bit. */
  leaf: boolean;
  life: number;
  age: number;
}

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let bits: Bit[] = [];
let raf = 0;
let last = 0;

export interface BurstOpts {
  /** Screen point the burst comes from (px). */
  x: number;
  y: number;
  count?: number;
  /** Extra colour mixed in (rarity), about a third of the bits. */
  accent?: string;
  /** Spread of the launch cone (degrees, centred on `angle`). */
  spread?: number;
  /** Direction of the cone (degrees from straight up, + leans right). Default 0. */
  angle?: number;
  /** Launch speed scale. */
  power?: number;
  /** White feathers and a few leaves drifting down instead of paper (the secret's unlock, progression.ts WINGS). */
  feathers?: boolean;
}

const FEATHERS = ["#ffffff", "#f4f6f2", "#e6ece8", "#ffffff", "#a6e22e", "#5cbf3e"];

/** Fires a burst. Cheap: plain 2D canvas, at most ~200 bits, gone in ~2 s. */
export function burst(o: BurstOpts): void {
  if (typeof window === "undefined" || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  // Potato (low-end PCs): no confetti at all.
  if (document.body.classList.contains("potato")) return;
  ensureCanvas();
  const n = Math.min(200 - bits.length, o.count ?? 70);
  const spread = ((o.spread ?? 70) * Math.PI) / 180;
  const power = o.power ?? 1;
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + ((o.angle ?? 0) * Math.PI) / 180 + (Math.random() - 0.5) * spread;
    const speed = (380 + Math.random() * 520) * power; // px/s
    const big = Math.random() < 0.25;
    bits.push({
      x: o.x + (Math.random() - 0.5) * 24,
      y: o.y + (Math.random() - 0.5) * 10,
      vx: Math.cos(a) * speed,
      vy: Math.sin(a) * speed,
      rot: Math.random() * Math.PI * 2,
      vr: (Math.random() - 0.5) * 12,
      flip: Math.random() * Math.PI * 2,
      vf: 6 + Math.random() * 10,
      w: o.feathers ? 11 + Math.random() * 6 : big ? 9 : 6 + Math.random() * 3,
      h: o.feathers ? 3.5 + Math.random() * 2 : big ? 5 : 3 + Math.random() * 3,
      color: o.feathers ? FEATHERS[(Math.random() * FEATHERS.length) | 0] : o.accent && Math.random() < 0.35 ? o.accent : BRAND[(Math.random() * BRAND.length) | 0],
      round: !o.feathers && Math.random() < 0.22,
      leaf: !!o.feathers,
      life: (o.feathers ? 2.2 : 1.5) + Math.random() * 0.9,
      age: 0,
    });
  }
  if (!raf) {
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }
}

/** Drops every particle at once (a run started). */
export function stopConfetti(): void {
  bits = [];
  teardown();
}

function ensureCanvas(): void {
  if (canvas?.isConnected) return;
  canvas = document.createElement("canvas");
  canvas.id = "nt-confetti";
  canvas.setAttribute("aria-hidden", "true");
  document.body.append(canvas);
  ctx = canvas.getContext("2d");
  resize();
}

function resize(): void {
  if (!canvas) return;
  const dpr = Math.min(2, devicePixelRatio || 1);
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
}

const GRAVITY = 1150; // px/s²
const DRAG = 1.9; // 1/s (air drag on the launch speed)

function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const c = ctx;
  if (!c || !canvas) return teardown();
  if (canvas.width !== Math.round(innerWidth * Math.min(2, devicePixelRatio || 1))) resize();
  c.clearRect(0, 0, innerWidth, innerHeight);
  const keep: Bit[] = [];
  const drag = Math.exp(-DRAG * dt);
  const dpr = Math.min(2, devicePixelRatio || 1);
  for (const b of bits) {
    b.age += dt;
    if (b.age >= b.life || b.y > innerHeight + 40) continue;
    b.vx *= drag;
    b.vy = b.vy * drag + GRAVITY * dt * (b.vy > 0 ? (b.leaf ? 0.22 : 0.45) : 1); // falling bits catch the air: a slow flutter down (feathers slower)
    b.x += b.vx * dt + Math.sin(b.flip) * (b.leaf ? 40 : 18) * dt;
    b.y += b.vy * dt;
    b.rot += b.vr * dt;
    b.flip += b.vf * dt;
    const fade = Math.min(1, (b.life - b.age) / (b.life * 0.25));
    c.globalAlpha = fade;
    c.fillStyle = b.color;
    // (Reset to the base transform: the previous bit's rotate is still in getTransform(), so reading it back shrank
    // every bit after the first to nothing.)
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.translate(b.x, b.y);
    c.rotate(b.rot);
    const sy = Math.cos(b.flip);
    if (b.leaf) {
      // A feather / leaf: a pointed blade that tilts as it turns over.
      const hh = (b.h / 2) * Math.abs(sy) + 0.4;
      c.beginPath();
      c.moveTo(-b.w / 2, 0);
      c.quadraticCurveTo(0, -hh * 2, b.w / 2, 0);
      c.quadraticCurveTo(0, hh * 2, -b.w / 2, 0);
      c.fill();
    } else if (b.round) {
      c.beginPath();
      c.ellipse(0, 0, b.h * 0.7, b.h * 0.7 * Math.abs(sy) + 0.4, 0, 0, Math.PI * 2);
      c.fill();
    } else c.fillRect(-b.w / 2, (-b.h / 2) * sy, b.w, b.h * sy || 0.5);
    keep.push(b);
  }
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.globalAlpha = 1;
  bits = keep;
  if (bits.length) raf = requestAnimationFrame(frame);
  else teardown();
}

function teardown(): void {
  cancelAnimationFrame(raf);
  raf = 0;
  canvas?.remove();
  canvas = null;
  ctx = null;
}
