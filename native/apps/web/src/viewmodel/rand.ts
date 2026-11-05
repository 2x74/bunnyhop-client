// Seeded randomness for the first-person presentation (recoil variation, muzzle flash, shells, impact sparks, idle
// detail): a replay export or a re-watch shows exactly the same thing every time. Each owner keeps its own stream and
// reseeds it on a reset (GunPresenter.reset: a restart, a replay seek, an export's start), so two viewers on screen
// never disturb each other. mulberry32: tiny, fast, good enough for looks. No allocation per call.

export class VmRandom {
  private s: number;

  constructor(private readonly base = 0x9e3779b9) {
    this.s = base >>> 0;
  }

  /** Back to the start of the stream (`salt` picks another one: a gun id, a knife). */
  seed(salt = 0): void {
    this.s = (this.base ^ Math.imul(salt | 0, 0x85ebca6b)) >>> 0;
  }

  /** 0 <= x < 1. */
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** -1 <= x < 1. */
  signed(): number {
    return this.next() * 2 - 1;
  }
}

/** A stable small number for a string (salts: gun / knife ids). */
export function saltOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}
