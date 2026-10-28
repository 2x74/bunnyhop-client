#pragma once
#include "bunnyhop_native.h"
#include "input_timeline.hpp"
#include "practice.hpp"
#include <nlohmann/json.hpp>
#include <optional>
#include <set>
#include <span>
#include <stdexcept>
#include <string>

namespace native {

inline bool replay_zones_match(const nlohmann::json &info, std::span<const BhZone> zones) {
    const auto &saved = info.at("zones");
    if (!saved.is_array() || saved.size() != zones.size() || zones.empty()) {
        return false;
    }
    constexpr const char *kinds[] = {"start", "end", "stage", "checkpoint"};
    for (size_t i = 0; i < zones.size(); ++i) {
        const auto &zone = zones[i];
        const auto &recorded = saved.at(i);
        if (zone.kind > 3 || recorded.at("kind") != kinds[zone.kind] ||
            recorded.value("track", 0u) != zone.track || recorded.value("index", 0u) != zone.index) {
            return false;
        }
        for (size_t axis = 0; axis < 3; ++axis) {
            if (recorded.at("mins").at(axis).get<float>() != zone.mins[axis] ||
                recorded.at("maxs").at(axis).get<float>() != zone.maxs[axis]) {
                return false;
            }
        }
    }
    return true;
}

struct ReplayTakeover {
    BhSnapshot snapshot{};
    BhCmd view{};
    uint32_t track = 0;
    std::string style;

    static ReplayTakeover take(BhContext *core, const nlohmann::json &info, std::span<const BhZone> zones,
                               const std::string &selected_style, bool gauntlet, bool multiplayer,
                               std::optional<uint32_t> tick = std::nullopt) {
        if (gauntlet) {
            throw std::runtime_error("No practice during a gauntlet.");
        }
        if (multiplayer) {
            throw std::runtime_error("Practice is for solo play, not servers.");
        }
        ReplayTakeover result;
        result.track = info.value("track", 0u);
        result.style = result.track ? "autohop" : selected_style;
        if (info.at("style") != result.style || !replay_zones_match(info, zones)) {
            throw std::runtime_error("Replay style or map zones do not match current practice.");
        }
        if (!bh_snapshot(core, &result.snapshot)) {
            throw std::runtime_error(bh_last_error(core));
        }
        const uint32_t target = tick.value_or(result.snapshot.player.tick);
        if (target > info.at("totalTicks").get<uint32_t>()) {
            throw std::runtime_error("Replay tick outside recording.");
        }
        if (!bh_replay_seek(core, target, &result.snapshot) || !bh_last_command(core, &result.view) ||
            !bh_practice_from_replay(core, selected_style.c_str())) {
            throw std::runtime_error(bh_last_error(core));
        }
        return result;
    }

    void resume(Practice &practice, InputTimeline &timeline, Input &input, std::set<std::string> &held) const {
        timeline.release(input, held);
        input.set_angles(view.pitch, view.yaw);
        practice.active = true;
        practice.noclip = false;
        practice.tool = "replay";
    }
};

}  // namespace native
