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
        if (zone.kind > 3 || recorded.at("kind") != kinds[zone.kind] || recorded.value("track", 0u) != zone.track
            || recorded.value("index", 0u) != zone.index) {
            return false;
        }
        for (size_t axis = 0; axis < 3; ++axis) {
            if (recorded.at("mins").at(axis).get<float>() != zone.mins[axis]
                || recorded.at("maxs").at(axis).get<float>() != zone.maxs[axis]) {
                return false;
            }
        }
    }
    return true;
}

inline nlohmann::json practice_from_replay_reply(bool ok, const std::string &reason = {}) {
    return {{"type", "practiceFromReplayResult"},
            {"ok", ok},
            {"reason", ok ? nlohmann::json(nullptr) : nlohmann::json(reason)}};
}

inline std::string replay_style_label(const std::string &style) {
    constexpr std::pair<std::string_view, std::string_view> labels[] = {
            {"autohop", "Normal"},
            {"legit", "EZ Scroll"},
            {"scroll", "Legit Scroll"},
            {"wonly", "W-Only"},
            {"sideways", "Sideways"},
            {"hsw", "Half-Sideways"},
            {"lowgrav", "Low Gravity"},
            {"segmented", "Segmented"},
            {"autostrafe", "Auto Strafe"},
    };
    for (const auto &[id, label] : labels) {
        if (id == style) {
            return std::string(label);
        }
    }
    return style;
}

inline std::string
replay_practice_problem(const nlohmann::json &info, const std::string &map, const std::string &selected_style) {
    if (!map.empty() && info.at("map") != map) {
        return "That replay is " + info.at("map").get<std::string>() + ". Switch to it first.";
    }
    const auto style = info.at("style").get<std::string>();
    const auto expected = info.value("track", 0u) ? "autohop" : selected_style;
    if (style != expected) {
        return "That replay is " + replay_style_label(style) + ". Switch to it first.";
    }
    BhSettings settings{};
    const auto &saved = info.at("settings");
    if (!bh_style_settings(style.c_str(), &settings)) {
        return "Unknown replay style.";
    }
    const std::pair<const char *, float> numbers[] = {
            {"tickInterval", settings.tick_interval},
            {"airAccelerate", settings.air_accelerate},
            {"accelerate", settings.accelerate},
            {"friction", settings.friction},
            {"stopSpeed", settings.stop_speed},
            {"gravity", settings.gravity},
            {"maxSpeed", settings.max_speed},
    };
    bool same = info.value("timerRules", 1u) == 2 && saved.at("physics") == settings.physics
                && saved.at("autohop") == bool(settings.autohop)
                && saved.value("stamina", false) == bool(settings.stamina);
    for (const auto &[name, value] : numbers) {
        same = same && saved.at(name).get<float>() == value;
    }
    return same ? "" : "That replay is from an older version of the game, so it can only be watched.";
}

struct ReplayTakeover {
    BhSnapshot snapshot{};
    BhCmd view{};
    uint32_t track = 0;
    std::string style;

    static ReplayTakeover
    take(BhContext *core,
         const nlohmann::json &info,
         std::span<const BhZone> zones,
         const std::string &selected_style,
         bool gauntlet,
         bool multiplayer,
         std::optional<uint32_t> tick = std::nullopt,
         const std::string &map = {}) {
        if (gauntlet) {
            throw std::runtime_error("No practice during a gauntlet.");
        }
        if (multiplayer) {
            throw std::runtime_error("Practice is for solo play, not servers.");
        }
        const auto problem = replay_practice_problem(info, map, selected_style);
        if (!problem.empty()) {
            throw std::runtime_error(problem);
        }
        ReplayTakeover result;
        result.track = info.value("track", 0u);
        result.style = result.track ? "autohop" : selected_style;
        if (!replay_zones_match(info, zones)) {
            throw std::runtime_error("The map zones changed since that replay. It can only be watched.");
        }
        if (!bh_snapshot(core, &result.snapshot)) {
            throw std::runtime_error(bh_last_error(core));
        }
        const uint32_t target = tick.value_or(result.snapshot.player.tick);
        if (target > info.at("totalTicks").get<uint32_t>()) {
            throw std::runtime_error("Replay tick outside recording.");
        }
        if (!bh_replay_seek(core, target, &result.snapshot) || !bh_last_command(core, &result.view)
            || !bh_practice_from_replay(core, selected_style.c_str())) {
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
