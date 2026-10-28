// The game's one WebGL renderer, for small things that draw 3D outside the game view (notify/item3d.ts: the unlock card's
// model). main.ts registers it as soon as it exists. Borrowers render into their own render target between frames and
// restore what they change, so the game's frame never sees them; nobody else creates a context for a few pixels.

import type * as THREE from "three";

let shared: THREE.WebGLRenderer | null = null;

export function setSharedRenderer(r: THREE.WebGLRenderer | null): void {
  shared = r;
}

/** The game's renderer, or null (no game on this page, or its context is lost). */
export function sharedRenderer(): THREE.WebGLRenderer | null {
  if (!shared) return null;
  try {
    return shared.getContext().isContextLost() ? null : shared;
  } catch {
    return null;
  }
}
