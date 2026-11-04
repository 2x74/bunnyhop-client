#pragma once
#include "freecam.hpp"
#include "spectate.hpp"
#include <optional>
#include <string>
#include <string_view>

namespace native {

// The menu script that asks the room to watch |target|, or to stop watching.
inline std::string spectate_script(std::optional<unsigned> target) {
    const std::string value = target ? std::to_string(*target) : std::string("null");
    return "window.bunnyhopNativeMenu?.onRoomCommand?.({t:'spec',target:" + value + "})";
}

// Freecam, room spectating's camera and the spectate menu, owned by the client loop.
struct FreeCameras {
    Freecam freecam;
    SpectatorView spectator;
    SpectatePicker picker;

    // !freecam or its bind: free look while watching, else your own freecam. Returns why it can't turn on, if so.
    std::string_view toggle(bool spectating, const FreecamPlace &place, const FreeLookInput &controls) {
        if (spectating) {
            spectator.toggle_free(controls);
            return {};
        }
        if (freecam.active()) {
            freecam.end(controls);
            return {};
        }
        const auto refusal = freecam_unavailable(place);
        if (refusal.empty()) freecam.begin(controls);
        return refusal;
    }

    // Once a frame, with whom you watched last frame and whom you watch now. Starting to watch ends freecam and starts
    // in-eye; switching players keeps the camera. A camera never outlives its reason, even when the change went unseen
    // (leaving the map forgets the watched player before this runs), so its hold on the mouse and keys goes with it.
    void
    follow(std::optional<unsigned> watched_before,
           std::optional<unsigned> watched_now,
           const FreecamPlace &place,
           const FreeLookInput &controls) {
        if (watched_now && !watched_before) freecam.end(controls);
        if (watched_now)
            spectator.watch(!watched_before, controls);
        else
            spectator.stop(controls);
        if (freecam.active() && !freecam_unavailable(place).empty()) freecam.end(controls);
    }

    // Leaving the map or restarting: back in your eyes, keys released.
    void stop(const FreeLookInput &controls) {
        freecam.end(controls);
        spectator.stop(controls);
    }

    // Whether a camera flies now (the mouse and keys are its).
    bool flying(bool spectating) const { return spectating ? spectator.free() : freecam.active(); }

    // Wheel notches step a flying camera's speed instead of reaching a bind; returns false when none flies.
    bool wheel(double notches, bool spectating) {
        if (!flying(spectating)) return false;
        (spectating ? spectator.free_look() : freecam.view()).wheel(notches);
        return true;
    }

    // This frame's freecam line (in |extras|) and spectator bar. |name| is the watched player's; |shown| is whether
    // they are on screen yet.
    template <class Extras>
    SpectatorBar hud(Extras &extras, bool spectating, bool shown, std::string_view name, const BindTable &binds) {
        const auto first = [&](std::string_view action) {
            const auto &codes = binds.codes(action);
            return codes.empty() ? std::string_view() : std::string_view(codes.front());
        };
        extras.freecam_line.assign(freecam.active() ? freecam.hud_line(first("freecam")) : std::string_view());
        if (!spectating) return {};
        return {true, !shown, name, spectator.hint(first("restart"), binds)};
    }

    // After the frame placed its own view in |eye| and |view|: a flying camera takes over (returns true). The spectator
    // view remembers its In-eye or Chase view, where free look starts.
    bool
    place(bool spectating, float eye[3], Input &view, const FreeLookKeys &keys, const Input &player, double seconds) {
        if (spectating && spectator.free()) {
            spectator.free_look().match_mouse(player);
            spectator.place_free(eye, view, keys, seconds);
            return true;
        }
        if (spectating) {
            spectator.remember(eye, view);
            return false;
        }
        if (!freecam.active()) return false;
        freecam.view().match_mouse(player);
        freecam.view().place(eye, view, keys, seconds);
        return true;
    }
};

}  // namespace native
