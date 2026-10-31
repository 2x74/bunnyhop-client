#pragma once
// What a pose of a third-person model plays of its actor's pulses.
#include "bunnyhop_native.h"
#include "render_shaders.hpp"
#include <cstdint>

namespace native_render {

inline constexpr uint32_t knife_weapon = 1, first_gun_weapon = 2;
inline constexpr unsigned gun_shot_pulse = 1, gun_reload_pulse = 2;

// What one pose of an actor plays. An actor is posed up to three times a frame (the sun's shadow, the water's mirror,
// the view) and its pulses play on the first, or a gun's kick would add up.
struct ActorPulses {
    bool snapped = false, swing = false, shot = false, reload = false;
};

// An attack with a gun is a shot or a reload, not a knife swing (net/players.ts). The avatar poses swing whatever is
// in hand (`acting`).
inline ActorPulses actor_pulses(const Actor &actor, bool posed_this_frame, bool acting = false) {
    if (posed_this_frame) return {};
    const bool gun = actor.frame.weapon >= first_gun_weapon;
    ActorPulses pulses;
    pulses.snapped = actor.snapped;
    pulses.swing = actor.attack && (!gun || acting);
    pulses.shot = gun && actor.attack == gun_shot_pulse;
    pulses.reload = gun && actor.attack == gun_reload_pulse;
    return pulses;
}

}  // namespace native_render
