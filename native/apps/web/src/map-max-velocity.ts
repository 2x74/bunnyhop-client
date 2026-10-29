import { PHYSICS_VERSION } from "./core";

// Maps built for more than CS:S's default sv_maxvelocity 3500 (per axis), gated by each entry's minimum version.
// (crates/core/src/game/map_fixes.rs MAX_VELOCITY, matched on the BSP's entity lump); this copy is for code that only
// knows the map's name (the room's teleport check). crates/core/tests/physics_v14.rs checks the two lists agree.
// research/MAX-VELOCITY.md and research/MAX-VELOCITY-V19.md.

/** CS:S's default sv_maxvelocity. */
export const DEFAULT_MAX_VELOCITY = 3500;

export const MAP_MAX_VELOCITY: Readonly<Record<string, number>> = {
  bhop_sandtrap: 10000,
  bhop_sandtrap2: 10000,
  bhop_sandtrap3: 10000,
  bhop_icetrap: 10000,
  bhop_goldsrc: 10000,
  bhop_gigaheish_fix: 10000,
  bhop_accelerate: 10000,
  bhop_quack: 10000,
  bhop_rainbowroad_fix: 10000,
  kz_bhop_global: 20000,
};

/** First physics version using each per-map limit. */
export const MAP_MAX_VELOCITY_MIN_PHYSICS: Readonly<Record<string, number>> = {
  bhop_sandtrap: 14,
  bhop_sandtrap2: 14,
  bhop_sandtrap3: 14,
  bhop_icetrap: 14,
  bhop_goldsrc: 14,
  bhop_gigaheish_fix: 19,
  bhop_accelerate: 19,
  bhop_quack: 19,
  bhop_rainbowroad_fix: 19,
  kz_bhop_global: 19,
};

/** The per-axis velocity limit on `map` under the supplied physics version. */
export function mapMaxVelocity(map: string | null | undefined, physics: number = PHYSICS_VERSION): number {
  return map && Object.hasOwn(MAP_MAX_VELOCITY, map) && physics >= MAP_MAX_VELOCITY_MIN_PHYSICS[map]
    ? MAP_MAX_VELOCITY[map] : DEFAULT_MAX_VELOCITY;
}
