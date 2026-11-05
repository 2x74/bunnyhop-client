// Source's TextureScroll material proxy on `$basetexturetransform` (scrolling stars, conveyor arrows, waterfalls):
// the base texture's UVs slide by `rate` texture widths per second along `angle` degrees. CTextureScrollMaterialProxy:
// s = t * cos(angle) * rate, t = t * sin(angle) * rate, wrapped into 0..1, as the transform's translation. The core
// resolves materials without proxies, so the client reads the proxy from the VMT and moves the texture each frame.
// Render only: nothing here touches physics.
//
// Also Source's AnimatedTexture proxy on `$basetexture` (frame-animated VTFs: flipbook signs, fire, screens):
// CBaseAnimatedTextureProxy picks frame int(rate * time) % frames (or holds the last one with animationNoWrap), timed from
// 0 like the scrolls. The frames are decoded once at load; each frame then only swaps the material's map. Animated
// normal maps (`$normalmap` / `$bumpmap` on water and refract) aren't drawn from the VMT, so they don't apply.

import type * as THREE from "three";
import { loadVmt, vmtPath, type Vmt } from "./vmt";

export interface TextureScroll {
  /** Texture widths per second. */
  rate: number;
  /** Degrees; 0 = +s, 90 = +t. */
  angle: number;
}

const num = (v: string | undefined, fallback: number): number => {
  const n = v === undefined ? NaN : parseFloat(v.trim());
  return Number.isFinite(n) ? n : fallback;
};

/** The material's base-texture scroll, or null. Proxy defaults as in Source: rate 1, angle 0. */
export function textureScrollOf(vmt: Vmt | null): TextureScroll | null {
  if (!vmt) return null;
  for (const p of vmt.proxies) {
    if (p.name !== "texturescroll") continue;
    const target = (p.params.texturescrollvar ?? "").trim().toLowerCase();
    if (target !== "$basetexturetransform") continue;
    const rate = num(p.params.texturescrollrate, 1);
    const angle = num(p.params.texturescrollangle, 0);
    if (rate === 0) return null;
    return { rate, angle };
  }
  return null;
}

export interface TextureAnimation {
  /** Frames per second (`animatedTextureFrameRate`, default 15). */
  rate: number;
  /** `animationNoWrap`: stop on the last frame. */
  noWrap: boolean;
}

/** The material's base-texture flipbook (AnimatedTexture on `$basetexture`), or null. */
export function textureAnimationOf(vmt: Vmt | null): TextureAnimation | null {
  if (!vmt) return null;
  for (const p of vmt.proxies) {
    if (p.name !== "animatedtexture") continue;
    if ((p.params.animatedtexturevar ?? "").trim().toLowerCase() !== "$basetexture") continue;
    const rate = num(p.params.animatedtextureframerate, 15);
    if (!(rate > 0)) return null;
    return { rate, noWrap: num(p.params.animationnowrap, 0) !== 0 };
  }
  return null;
}

/** CBaseAnimatedTextureProxy::OnBind: the frame shown at `time` seconds. */
export function animationFrame(a: TextureAnimation, frames: number, time: number): number {
  if (frames <= 1) return 0;
  const f = Math.floor(a.rate * Math.max(0, time));
  return a.noWrap ? Math.min(f, frames - 1) : f % frames;
}

/** Decodes a VTF's animation frames (game path): the count, and frame `i` as a texture (null if it can't). */
export interface TextureFrameSource {
  count(path: string): number;
  frame(path: string, frame: number, needAlpha: boolean): THREE.Texture | null;
}

/** Most frames, and decoded bytes per map, the flipbooks may take (beyond that a material shows its first frame). */
const MAX_FRAMES = 256;
const MAX_FRAME_PIXELS = 48 * 1024 * 1024;

/** Scroll offset (s, t) at `time` seconds, wrapped into 0..1. */
export function scrollOffset(s: TextureScroll, time: number): [number, number] {
  const a = (s.angle * Math.PI) / 180;
  const wrap = (v: number) => v - Math.floor(v);
  return [wrap(time * Math.cos(a) * s.rate), wrap(time * Math.sin(a) * s.rate)];
}

/**
 * Materials whose base texture scrolls. `attach` gives a material its own copy of its map (same image and GPU upload,
 * its own offset) when its VMT has a TextureScroll on `$basetexturetransform`; `update` moves them all.
 */
export class TextureScrolls {
  private readonly byName = new Map<string, { scroll: TextureScroll | null; anim: TextureAnimation | null }>();
  private readonly live = new Map<THREE.Material, { map: THREE.Texture; scroll: TextureScroll }>();
  /** Decoded flipbooks by VTF path (+ alpha): shared by the materials using them. */
  private readonly flipbooks = new Map<string, THREE.Texture[] | null>();
  private readonly animated: { material: THREE.MeshBasicMaterial; frames: THREE.Texture[]; anim: TextureAnimation; scroll: TextureScroll | null; shown: number }[] = [];
  private framePixels = 0;

  constructor(
    private readonly read: (path: string) => Uint8Array | null,
    private readonly frames: TextureFrameSource | null = null,
  ) {}

  /** Scrolling materials. */
  get size(): number {
    return this.live.size;
  }

  /** Flipbook materials. */
  get animatedCount(): number {
    return this.animated.length;
  }

  private proxies(name: string) {
    const key = name.toLowerCase();
    let p = this.byName.get(key);
    if (!p) {
      let vmt: Vmt | null = null;
      try {
        vmt = loadVmt(vmtPath(key), this.read);
      } catch {
        vmt = null;
      }
      this.byName.set(key, (p = { scroll: textureScrollOf(vmt), anim: textureAnimationOf(vmt) }));
    }
    return p;
  }

  private flipbook(path: string, needAlpha: boolean): THREE.Texture[] | null {
    const key = `${path.toLowerCase()}|${needAlpha ? 1 : 0}`;
    if (this.flipbooks.has(key)) return this.flipbooks.get(key)!;
    let out: THREE.Texture[] | null = null;
    const n = this.frames ? Math.min(this.frames.count(path), MAX_FRAMES) : 0;
    if (n > 1) {
      out = [];
      for (let i = 0; i < n; i++) {
        const t = this.frames!.frame(path, i, needAlpha);
        const img = t?.image as { width?: number; height?: number } | undefined;
        const px = (img?.width ?? 0) * (img?.height ?? 0);
        if (!t || this.framePixels + px > MAX_FRAME_PIXELS) {
          t?.dispose();
          for (const f of out) f.dispose();
          out = null;
          break;
        }
        this.framePixels += px;
        out.push(t);
      }
    }
    this.flipbooks.set(key, out);
    return out;
  }

  /**
   * Gives `material` its scroll and / or flipbook from its VMT. `base`: the resolved path of its base texture VTF, when
   * the map shows that file (not a texture pack's replacement), for the flipbook frames.
   */
  attach(material: THREE.Material, name: string | undefined, base?: { path: string; needAlpha: boolean }): void {
    const m = material as THREE.MeshBasicMaterial;
    if (!name || !m.map) return;
    const { scroll, anim } = this.proxies(name);
    if (anim && base) {
      const book = this.flipbook(base.path, base.needAlpha);
      if (book) {
        const template = m.map;
        // A scrolling flipbook gets its own copies (same uploads) for its own offset.
        const frames = book.map((f) => {
          const c = scroll ? f.clone() : f;
          c.wrapS = template.wrapS;
          c.wrapT = template.wrapT;
          c.repeat.copy(template.repeat);
          return c;
        });
        m.map = frames[0];
        this.animated.push({ material: m, frames, anim, scroll, shown: 0 });
        return;
      }
    }
    if (!scroll) return;
    const map = m.map.clone();
    m.map = map;
    this.live.set(material, { map, scroll });
  }

  update(time: number): void {
    for (const { map, scroll } of this.live.values()) {
      const [s, t] = scrollOffset(scroll, time);
      map.offset.set(s, t);
    }
    for (const a of this.animated) {
      const f = animationFrame(a.anim, a.frames.length, time);
      if (f !== a.shown) {
        a.shown = f;
        a.material.map = a.frames[f];
      }
      if (a.scroll) {
        const [s, t] = scrollOffset(a.scroll, time);
        a.frames[f].offset.set(s, t);
      }
    }
  }
}
