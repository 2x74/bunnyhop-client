// Fixed-arity Math.hypot for code that runs every frame (model poses, the viewmodel). V8's Math.hypot allocates an
// array of its arguments on every call; at a few hundred calls a frame it was one of the game's biggest sources of
// garbage (and so of minor GC pauses). These compile to plain arithmetic. No overflow guard: game-scale values only.
// Visual code only: physics and anything that must match the verifier stay in the core.
export const hypot2 = (x: number, y: number): number => Math.sqrt(x * x + y * y);
export const hypot3 = (x: number, y: number, z: number): number => Math.sqrt(x * x + y * y + z * z);
export const hypot4 = (x: number, y: number, z: number, w: number): number => Math.sqrt(x * x + y * y + z * z + w * w);
