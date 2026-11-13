// Source material proxies that drive `$alpha`: surfaces that fade with the player's distance (PlayerProximity: bhop_angst's
// floors that open up as you fall towards them, the neon blocks of the badges maps that only show up close, HL2's
// combine shield) or pulse over time (Sine). The core resolves materials without proxies, so the client reads the chain
// from the VMT and runs it for each brush entity that wears the material. Render only: nothing here touches physics.
//
// SDK 2013 game/client/functionproxy.cpp, mathproxy.cpp, proxyplayer.cpp, proxyentity.cpp:
//   a material's proxies run in file order every time it is bound, each writing one material variable. Variables keep
//   their values between binds, so a proxy that reads a variable written further down the list sees the last bind's
//   value (bhop_tesquo_v2 reads the distance one frame late). Here every entity keeps its own variables.
//   The world's own faces are bound without an entity. PlayerProximity and EntityRandom then return before writing, as
//   I read the SDK, which would leave such a face at whatever the VMT's starting values work out to (0.7 for the neon
//   blocks). That isn't confirmed against the game, so chains that need an entity (`perEntity`) are not run on the
//   world's faces: they keep their VMT alpha, as before.
//   Math on a variable the VMT declared as an integer ("0") truncates on the first bind only: it then stores a float,
//   so every later bind is float math. Floats throughout here.

import type { Vmt } from "./vmt";

/** What a run of the chain reads from the game. */
export interface AlphaInputs {
  /** Units between the entity's centre and the player's (PlayerProximity). */
  distance: number;
  /** Map time in seconds (Sine). */
  time: number;
  /** The entity's random number in 0..1 (EntityRandom). */
  random: number;
  /** A fresh normally distributed number, mean 0 and deviation 1 (GaussianNoise). */
  gaussian(): number;
}

/** A material's `$alpha` chain. `run` returns the alpha (0..1) and keeps `vars` for the next run. */
export interface AlphaProgram {
  /** Fresh variables, as the VMT sets them. */
  vars(): Float64Array;
  run(vars: Float64Array, inputs: AlphaInputs): number;
  /** Reads the player's distance or the entity's random number: differs per entity, and needs one. */
  perEntity: boolean;
}

type Operand = { slot: number } | { value: number };
type Op = (v: Float64Array, i: AlphaInputs) => void;

const SUPPORTED = new Set(["add", "subtract", "multiply", "divide", "equals", "clamp", "sine", "gaussiannoise", "playerproximity", "entityrandom"]);
/** Variables shaders define without the VMT naming them. */
const BUILT_IN: Record<string, number> = { $alpha: 1 };

const varName = (raw: string | undefined): string | null => {
  const m = /^\s*(\$[^\s[\]]+)\s*(?:\[\s*(\d+)\s*\])?\s*$/.exec(raw ?? "");
  return m ? m[1].toLowerCase() + (m[2] === undefined ? "" : `[${Number(m[2])}]`) : null;
};

/** A VMT value as a number: a plain number, or component `i` of a `[a b c]` / `{a b c}` vector. NaN otherwise. */
function declared(vmt: Vmt, name: string): number {
  const m = /^(\$[^[]+)(?:\[(\d+)\])?$/.exec(name)!;
  const raw = vmt.params[m[1]];
  if (raw === undefined) return m[2] === undefined ? (BUILT_IN[m[1]] ?? NaN) : NaN;
  const parts = raw.replace(/[[\]{}]/g, " ").trim().split(/\s+/);
  if (m[2] === undefined) return parts.length === 1 ? Number(parts[0]) : NaN;
  return Number(parts[Number(m[2])] ?? NaN);
}

/**
 * The chain that ends in `$alpha`, or null when the VMT's proxies don't write `$alpha`, or do it from something not run
 * here (the view direction, the player's team, a texture's frame): the material then keeps its VMT alpha, as before.
 * Proxies that don't feed `$alpha` (TextureScroll, colour pulses) are left to their own code.
 */
export function alphaProgram(vmt: Vmt | null): AlphaProgram | null {
  if (!vmt) return null;
  const result = (p: Vmt["proxies"][number]) => varName(p.params.resultvar);
  if (!vmt.proxies.some((p) => result(p) === "$alpha")) return null;

  // Variables `$alpha` depends on, through any proxy in the list (order doesn't matter: values carry over between binds).
  const inputsOf = (p: Vmt["proxies"][number]): string[] =>
    ["srcvar1", "srcvar2", "min", "max", "sinemin", "sinemax", "sineperiod", "timeoffset", "mean", "halfwidth", "minval", "maxval", "scale"]
      .map((k) => p.params[k])
      .filter((v): v is string => v !== undefined && !Number.isFinite(Number(v.trim())))
      .map((v) => varName(v) ?? "?");
  const needed = new Set(["$alpha"]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of vmt.proxies) {
      const r = result(p);
      if (!r || !needed.has(r)) continue;
      for (const v of inputsOf(p)) if (!needed.has(v)) (needed.add(v), (grew = true));
    }
  }
  const chain = vmt.proxies.filter((p) => needed.has(result(p) ?? ""));
  if (needed.has("?") || chain.some((p) => !SUPPORTED.has(p.name))) return null;

  const names = [...needed];
  const initial = names.map((n) => declared(vmt, n));
  const written = new Set(chain.map((p) => result(p)!));
  // A variable nothing sets has no value in Source either (the proxy reading it fails to load).
  if (names.some((n, i) => Number.isNaN(initial[i]) && !written.has(n))) return null;
  const slot = (name: string) => names.indexOf(name);
  const operand = (raw: string | undefined, fallback: number): Operand => {
    if (raw === undefined) return { value: fallback };
    const n = Number(raw.trim());
    return Number.isFinite(n) ? { value: n } : { slot: slot(varName(raw)!) };
  };
  const read = (o: Operand, v: Float64Array) => ("slot" in o ? v[o.slot] : o.value);

  const ops: Op[] = [];
  for (const p of chain) {
    const out = slot(result(p)!);
    const a = operand(p.params.srcvar1, 0);
    const b = operand(p.params.srcvar2, 0);
    switch (p.name) {
      case "add": ops.push((v) => void (v[out] = read(a, v) + read(b, v))); break;
      case "subtract": ops.push((v) => void (v[out] = read(a, v) - read(b, v))); break;
      case "multiply": ops.push((v) => void (v[out] = read(a, v) * read(b, v))); break;
      // CDivideProxy: dividing by zero gives the first operand.
      case "divide": ops.push((v) => void (v[out] = read(b, v) !== 0 ? read(a, v) / read(b, v) : read(a, v))); break;
      case "equals": ops.push((v) => void (v[out] = read(a, v))); break;
      case "clamp": {
        const min = operand(p.params.min, 0);
        const max = operand(p.params.max, 1);
        ops.push((v) => {
          const lo = Math.min(read(min, v), read(max, v));
          const hi = Math.max(read(min, v), read(max, v));
          v[out] = Math.min(hi, Math.max(lo, read(a, v)));
        });
        break;
      }
      case "sine": {
        const period = operand(p.params.sineperiod, 1);
        const min = operand(p.params.sinemin, 0);
        const max = operand(p.params.sinemax, 1);
        const offset = operand(p.params.timeoffset, 0);
        ops.push((v, i) => {
          const s = Math.sin((2 * Math.PI * (i.time - read(offset, v))) / read(period, v)) * 0.5 + 0.5;
          v[out] = (read(max, v) - read(min, v)) * s + read(min, v);
        });
        break;
      }
      case "gaussiannoise": {
        const mean = operand(p.params.mean, 0);
        const dev = operand(p.params.halfwidth, 1);
        const min = operand(p.params.minval, -Infinity);
        const max = operand(p.params.maxval, Infinity);
        ops.push((v, i) => {
          const lo = Math.min(read(min, v), read(max, v));
          const hi = Math.max(read(min, v), read(max, v));
          v[out] = Math.min(hi, Math.max(lo, read(mean, v) + read(dev, v) * i.gaussian()));
        });
        break;
      }
      case "playerproximity": {
        const scale = operand(p.params.scale, 0.002);
        ops.push((v, i) => void (v[out] = i.distance * read(scale, v)));
        break;
      }
      case "entityrandom": {
        const scale = operand(p.params.scale, 1);
        ops.push((v, i) => void (v[out] = i.random * read(scale, v)));
        break;
      }
    }
  }
  const alpha = slot("$alpha");
  return {
    vars: () => Float64Array.from(initial, (n) => (Number.isNaN(n) ? 0 : n)),
    run(vars, inputs) {
      for (const op of ops) op(vars, inputs);
      const a = vars[alpha];
      return a >= 1 ? 1 : a > 0 ? a : 0;
    },
    perEntity: chain.some((p) => p.name === "playerproximity" || p.name === "entityrandom"),
  };
}

/** Uniform 0..1 from two integers (the per-entity random number, and the noise of a moment in time). */
export function hash01(a: number, b: number): number {
  let h = Math.imul(a ^ Math.imul(b + 1, 0x9e3779b9), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 16), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * func_areaportalwindow (SDK 2013 c_func_areaportalwindow.cpp GetDistanceBlend): how opaque the window brush is from
 * `distance` units away. `limit` up to `start`, 1 from `end` on (where the engine closes the portal behind it).
 */
export function windowBlend(distance: number, start: number, end: number, limit: number): number {
  if (start === end) return distance >= end ? 1 : limit;
  const t = Math.min(1, Math.max(0, (distance - start) / (end - start)));
  return limit + (1 - limit) * t;
}
