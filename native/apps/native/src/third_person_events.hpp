#pragma once
// The gestures the third-person model plays for your own player and for a replay's runner: the pulses a room's players
// get from the wire (room_state.hpp), taken here from the simulation and the replay's trailer. Mirrors the website's
// viewer/thirdperson.ts and viewer/viewer.ts.
#include "bunnyhop_native.h"
#include "ghost_playback.hpp"
#include "render_shaders.hpp"
#include <algorithm>
#include <cstdint>
#include <optional>

namespace native_render {

inline constexpr uint32_t knife_weapon = 1, first_gun_weapon = 2;
inline constexpr unsigned gun_shot_pulse = 1, gun_reload_pulse = 2;
// core.ts WEAPON_EVENT_RELOAD_STARTED.
inline constexpr uint32_t weapon_reload_started_flag = 4;
inline constexpr double min_own_reload_seconds = .2;
// viewer.ts `contiguous`: frames this far apart aren't playback, so nothing between them is shown.
inline constexpr double replay_live_event_ticks = 30;

// What one pose of an actor plays. An actor is posed up to three times a frame (the sun's shadow, the water's mirror,
// the view) and its pulses play on the first, or a gun's kick would add up.
struct ActorPulses {
    bool snapped = false, swing = false, shot = false, reload = false;
    std::optional<GunReload> own_reload;
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
    pulses.own_reload = actor.gunReload;
    return pulses;
}

// The model a third-person camera follows, yours or a replay's runner, where the player stands and looks.
inline Actor own_actor(const BhSnapshot &state, float pitch, float yaw, uint32_t weapon) {
    constexpr uint32_t crouched_flag = 1, grounded_flag = 2;
    Actor actor;
    actor.id = own_actor_id;
    actor.opacity = 1;
    std::copy_n(state.player.position, 3, actor.frame.position);
    std::copy_n(state.player.velocity, 3, actor.frame.velocity);
    actor.frame.tick = state.player.tick;
    actor.frame.flags = (state.player.crouched ? crouched_flag : 0) | (state.player.grounded ? grounded_flag : 0);
    actor.frame.view_offset_z = state.player.view_offset_z;
    actor.frame.pitch = pitch;
    actor.frame.yaw = yaw;
    actor.frame.weapon = weapon;
    return actor;
}

class ThirdPersonEvents {
public:
    // One simulation tick of your own weapons (ThirdPerson.attack and weaponTick).
    void tick(const BhWeaponReport &weapon, const BhAttackReport *attack, double tick_seconds) {
        if (attack && attack->weapon == knife_weapon) pending_.swing = attack->mode;
        if (attack && attack->weapon >= first_gun_weapon && attack->weapon == weapon.active) pending_.shot = true;
        if (weapon.active >= first_gun_weapon && weapon.active == last_weapon_) {
            const double seconds = std::max(min_own_reload_seconds, weapon.reload_ticks * tick_seconds);
            if (weapon.flags & weapon_reload_started_flag)
                pending_.reload = GunReload{seconds, false, weapon.clip == 0};
            else if (weapon.clip > last_clip_)
                pending_.reload = GunReload{seconds, true, false};
        }
        last_weapon_ = weapon.active;
        last_clip_ = weapon.clip;
    }

    // A teleport: the model starts over from where you are.
    void snap() { pending_.snapped = true; }

    // Once per drawn frame in live play.
    void own_frame() {
        replay_ticks_.reset();
        begin_frame(pending_);
        pending_ = {};
    }

    // Once per drawn frame of a replay at `tick`: the swings and inspects its trailer has since the last frame.
    void replay_frame(BhContext *core, uint32_t tick) {
        Gestures gestures;
        BhReplayEvents events{};
        const auto range = replay_ticks_.advance(tick, true, gestures.snapped);
        if (range && bh_replay_events(core, range->first, range->second, &events)) {
            gestures.swing = events.cosmetic;
            gestures.inspect = events.inspect_signal;
            gestures.inspect_held = events.inspect_held != 0;
        }
        begin_frame(gestures);
    }

    // Puts this frame's gestures on the model, when a third-person camera shows it. An empty hand doesn't swing or
    // inspect (viewer.ts), and a swing in a trailer with a gun in hand is a shot the model doesn't replay.
    void apply(Actor &model) {
        const bool knife = model.frame.weapon == knife_weapon && !model.emptyHand;
        const bool gun = model.frame.weapon >= first_gun_weapon;
        model.attack = knife ? frame_.swing : gun && frame_.shot ? gun_shot_pulse : 0;
        model.gunReload = gun ? frame_.reload : std::nullopt;
        model.inspect = knife ? frame_.inspect : 0;
        model.inspectHeld = knife && frame_.inspect_held;
        model.snapped = frame_.snapped;
        drawn_ = true;
    }

private:
    struct Gestures {
        unsigned swing = 0, inspect = 0;
        bool shot = false, inspect_held = false, snapped = false;
        std::optional<GunReload> reload;
    };

    // Back in view after frames without a pose, the model starts from here and not from where it was hidden. What
    // happened while it was hidden isn't played late.
    void begin_frame(const Gestures &gestures) {
        frame_ = gestures;
        frame_.snapped |= !drawn_;
        drawn_ = false;
    }

    Gestures pending_, frame_;
    GhostEventCursor replay_ticks_{-1, replay_live_event_ticks};
    uint32_t last_weapon_ = 0, last_clip_ = 0;
    bool drawn_ = false;
};

}  // namespace native_render
