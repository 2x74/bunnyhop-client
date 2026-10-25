// Maps built for more than CS:S's default sv_maxvelocity 3500 (per axis). The core applies these from physics v14
// (crates/core/src/game/map_fixes.rs MAX_VELOCITY, matched on the BSP's entity lump); this copy is for code that only
// knows the map's name (the room's teleport check). crates/core/tests/physics_v14.rs checks the two lists agree.
// research/MAX-VELOCITY.md.

/** CS:S's default sv_maxvelocity. */
export const DEFAULT_MAX_VELOCITY = 3500;

export const MAP_MAX_VELOCITY: Readonly<Record<string, number>> = {
  bhop_sandtrap: 10000,
  bhop_sandtrap2: 10000,
  bhop_sandtrap3: 10000,
  bhop_icetrap: 10000,
  bhop_goldsrc: 10000,
};

/** The per-axis velocity limit on `map`. */
export function mapMaxVelocity(map: string | null | undefined): number {
  return map && Object.hasOwn(MAP_MAX_VELOCITY, map) ? MAP_MAX_VELOCITY[map] : DEFAULT_MAX_VELOCITY;
}
