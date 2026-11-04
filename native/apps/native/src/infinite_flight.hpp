#pragma once
#include "bunnyhop_native.h"
#include <cstdint>
#include <optional>
#include <string_view>

namespace native {

// Core step event: the player flew this tick (crates/core game/flight.rs EVENT_FLIGHT).
constexpr uint32_t event_flight = 1u << 9;

// Infinite's noclip on physics v24+ (website session.ts flightOn): the bridge puts IN_FLIGHT in every command while the
// key's flag is on, the core flies it and the recording keeps it, so the run after a flight counts. Nothing here is
// practice. The bridge turns the flag off on every reset, restart, style or track switch, map load and checkpoint.
class InfiniteFlight {
public:
    static constexpr std::string_view hud_line = "Noclip";
    static constexpr std::string_view stuck_notice = "You're inside a wall. Fly out of it to land.";

    // The noclip key. False where the core can't fly (only Infinite on physics v24+ does), so the key stays practice
    // noclip.
    bool toggle(BhContext *core) {
        BhFlightState state{};
        if (!core || !bh_flight_state(core, &state) || !state.allowed) return false;
        if (!bh_flight_set(core, state.on ? 0 : 1)) return false;
        on_ = !state.on;
        return true;
    }

    // After every simulated tick. Returns the stuck-landing notice on the first tick it applies: the key is off but
    // the core is still flying, because the landing found no room.
    std::optional<std::string_view> observe(BhContext *core, const BhState &state) {
        BhFlightState flight{};
        on_ = core && bh_flight_state(core, &flight) && flight.on;
        flying_ = (state.events & event_flight) != 0;
        if (flying_) flew_ = true;
        if (!flying_ || on_) {
            stuck_said_ = false;
            return std::nullopt;
        }
        if (stuck_said_) return std::nullopt;
        stuck_said_ = true;
        return stuck_notice;
    }

    // The key's flag as of the last tick.
    bool on() const { return on_; }

    // The core flew the last tick: no jump stats, SSJ, sync or announcer for it.
    bool flying() const { return flying_; }

    // This attempt flew: a start point set now is a practice spawn (website PracticeAttempt.flew).
    bool flew() const { return flew_; }

    void restart() { *this = InfiniteFlight{}; }

private:
    bool on_ = false;
    bool flying_ = false;
    bool flew_ = false;
    bool stuck_said_ = false;
};

}  // namespace native
