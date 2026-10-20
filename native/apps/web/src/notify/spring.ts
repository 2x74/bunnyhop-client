// Spring motion for notifications, as plain CSS easings: a damped spring is simulated once per preset and sampled into a
// CSS `linear()` easing (progress goes past 1 and settles back, so a transform overshoots and settles on the compositor
// with no per-frame JS). DOM-free: apps/api/test/notify.test.ts checks the numbers.
//
//   el.animate({ transform: ["translateY(12px) scale(0.9)", "none"] }, { ...spring(SPRINGS.pop), fill: "backwards" })
//
// Browsers without linear() get a fixed overshooting cubic-bezier of about the same feel (FALLBACK_EASING).

export interface SpringParams {
  /** N/m: how hard it pulls towards the target. */
  stiffness: number;
  /** N·s/m: how fast the wobble dies. */
  damping: number;
  /** kg (default 1). */
  mass?: number;
}

/** The springs every notification uses (research/NOTIFICATIONS.md, "Motion"). */
export const SPRINGS = {
  /** Toasts, nudges, things that land: quick, one small overshoot (~8%, the peak at ~175 ms), settled in ~500 ms. */
  pop: { stiffness: 520, damping: 28 },
  /** Banners and stamps: a little heavier, ~8% overshoot peaking at ~210 ms. */
  land: { stiffness: 420, damping: 26, mass: 1.1 },
  /** The reward inside a calm container (emblems, numbers, badges, the mascot's rise): ~25% overshoot. */
  bouncy: { stiffness: 600, damping: 18 },
  /** No overshoot (exits, things that slide back): critically damped. */
  calm: { stiffness: 400, damping: 40 },
} satisfies Record<string, SpringParams>;

export interface SpringCurve {
  /** Position (0 → 1) at each step of `dt` ms; the last sample is the settle point. */
  samples: number[];
  /** ms per sample. */
  dt: number;
  /** ms until it stays within `eps` of 1 and nearly still. */
  duration: number;
  /** Highest position reached minus 1 (0.12 = 12% overshoot). */
  overshoot: number;
}

/**
 * Simulates the spring from 0 (at rest) to 1. Semi-implicit Euler at 0.25 ms (stable and accurate enough for these
 * stiffnesses); stops once it has settled (|1 - x| < eps and |v| < eps per second), or at 3 s.
 */
export function simulateSpring(p: SpringParams, dt = 1000 / 120, eps = 0.001): SpringCurve {
  const m = p.mass ?? 1;
  const h = 0.00025;
  const per = Math.max(1, Math.round(dt / 1000 / h));
  let x = 0;
  let v = 0;
  let peak = 0;
  const samples = [0];
  for (let step = 1; step * dt <= 3000; step++) {
    for (let i = 0; i < per; i++) {
      const a = (-p.stiffness * (x - 1) - p.damping * v) / m;
      v += a * h;
      x += v * h;
    }
    peak = Math.max(peak, x);
    samples.push(x);
    if (Math.abs(1 - x) < eps && Math.abs(v) < eps * 10) break;
  }
  samples[samples.length - 1] = 1;
  return { samples, dt, duration: (samples.length - 1) * dt, overshoot: Math.max(0, peak - 1) };
}

/** A CSS `linear()` easing for the curve, about `points` stops (fewer where it's nearly straight is not worth it). */
export function linearEasing(c: SpringCurve, points = 40): string {
  const n = c.samples.length - 1;
  const stride = Math.max(1, Math.ceil(n / points));
  const out: string[] = [];
  for (let i = 0; i < n; i += stride) out.push(round(c.samples[i]));
  out.push("1");
  return `linear(${out.join(", ")})`;
}

const round = (x: number) => String(Math.round(x * 10000) / 10000);

/** Overshooting cubic-bezier for browsers without linear() (the "back out" family). */
export const FALLBACK_EASING = "cubic-bezier(0.34, 1.45, 0.64, 1)";

const cache = new Map<SpringParams, { duration: number; easing: string }>();
let linearOk: boolean | null = null;

/** WAAPI / CSS timing for a spring: `{ duration, easing }` (cached per preset). `slow` scales the duration. */
export function spring(p: SpringParams, slow = 1): { duration: number; easing: string } {
  let t = cache.get(p);
  if (!t) {
    const c = simulateSpring(p);
    // (globalThis: this module is also type-checked without the DOM lib, by the API's tests.)
    const css = (globalThis as { CSS?: { supports?(prop: string, value: string): boolean } }).CSS;
    linearOk ??= !!css?.supports?.("animation-timing-function", "linear(0, 0.5 25%, 1)");
    t = { duration: Math.round(c.duration), easing: linearOk ? linearEasing(c) : FALLBACK_EASING };
    cache.set(p, t);
  }
  return slow === 1 ? t : { duration: Math.round(t.duration * slow), easing: t.easing };
}

/** Exit easing (accelerate away; exits are short and never overshoot). */
export const EASE_IN = "cubic-bezier(0.55, 0, 0.75, 0.3)";
/** Plain decelerate for opacity / colour (things that must not overshoot). */
export const EASE_OUT = "cubic-bezier(0.16, 1, 0.3, 1)";

/** A WAAPI keyframe these helpers build (a subset of the DOM's Keyframe, declared here: this module is also
 * type-checked without the DOM lib, by the API's tests). */
export type HopFrame = {
  transform?: string;
  opacity?: number;
  offset?: number;
  easing?: string;
};

/** The hop (AIRTIME): enter along a short arc and land with a squash. `from` is where it starts (px along y, + = below
 * its rest), `apex` how far above rest it rises. One WAAPI keyframe set; transform only. `squash` = false (Potato):
 * the arc without the landing squash. */
export function hopKeyframes(from: number, apex = 8, squash = true): HopFrame[] {
  return [
    { transform: `translateY(${from}px)`, opacity: 0, easing: "cubic-bezier(.33,1,.68,1)" },
    { transform: `translateY(${-apex}px)`, opacity: 1, offset: 0.55, easing: "cubic-bezier(.32,0,.67,0)" },
    { transform: squash ? "translateY(0) scale(1.05, 0.92)" : "none", offset: 0.82 },
    { transform: "none" },
  ];
}

/**
 * A hop sideways along a parabola: from (`x`, `y`) px off its rest, up over an apex `lift` px above the straight line,
 * landing at rest with a squash. For things that arrive from the side (the celebration's emblem, the bunny).
 */
export function arcKeyframes(x: number, y: number, lift: number, squash = true): HopFrame[] {
  const pts = [0, 0.25, 0.5, 0.75, 1].map((t) => {
    const px = x * (1 - t);
    const py = y * (1 - t) - 4 * lift * t * (1 - t);
    return `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px)`;
  });
  return [
    { transform: pts[0], opacity: 0, offset: 0 },
    { transform: pts[1], opacity: 1, offset: 0.18 },
    { transform: pts[2], offset: 0.38 },
    { transform: pts[3], offset: 0.58 },
    { transform: squash ? "translate(0, 0) scale(1.06, 0.9)" : pts[4], offset: 0.8 },
    { transform: "none", offset: 1 },
  ];
}

/** Points along the same parabola (for the dotted trail it leaves), `n` of them, start to just before the rest. */
export function arcPoints(x: number, y: number, lift: number, n = 6): { x: number; y: number }[] {
  return Array.from({ length: n }, (_, i) => {
    const t = (i + 0.5) / (n + 0.6);
    return { x: x * (1 - t), y: y * (1 - t) - 4 * lift * t * (1 - t) };
  });
}

/** Leaving with a small hop off: up a few px, then down and out. */
export function hopOffKeyframes(drop = 12): HopFrame[] {
  return [
    { transform: "none", opacity: 1, easing: "cubic-bezier(.33,1,.68,1)" },
    { transform: "translateY(-4px)", opacity: 1, offset: 0.35, easing: "cubic-bezier(.32,0,.67,0)" },
    { transform: `translateY(${drop}px)`, opacity: 0 },
  ];
}
