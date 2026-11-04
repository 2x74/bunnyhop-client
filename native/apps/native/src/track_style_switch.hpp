#pragma once
#include "bunnyhop_native.h"
#include "room_styles.hpp"
#include "start_point.hpp"
#include <algorithm>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace native {

// The style a run on `track` uses: the selected style on the main track, Normal on every bonus (web styles.ts
// styleForTrack).
inline std::string_view style_for_track(std::string_view selected, uint32_t track) {
    return track ? std::string_view("autohop") : selected;
}

// Standing in a start zone of a track that runs in another style (a bonus while Infinite or W-Only is selected, or back
// on the main track after a bonus) restarts right there in that track's style, with a fresh recording (web session.ts
// command and switchTrackStyle). Not while flying: a flight through a bonus start waits for the landing, and a flight
// recording may never become a bonus run, which has to be Normal.
struct TrackStyleSwitch {
    uint32_t track = 0;
    // Where to restart: the player's spot, kept inside the start zone, facing the way they face.
    StartPoint at;
    std::string toast;

    static constexpr float zone_inset = 1;
    static constexpr float hull_half_width = 16;
    static constexpr float hull_height = 62;
    static constexpr float hull_height_ducked = 45;

    // web zones.ts playerInZone, in f64 like the timer (run.rs BhZone::contains).
    static bool touches(const BhZone &zone, const float position[3], bool crouched) {
        const double x = position[0], y = position[1], z = position[2];
        const double height = crouched ? hull_height_ducked : hull_height;
        return x - hull_half_width <= zone.maxs[0] && x + hull_half_width >= zone.mins[0]
               && y - hull_half_width <= zone.maxs[1] && y + hull_half_width >= zone.mins[1] && z <= zone.maxs[2]
               && z + height >= zone.mins[2];
    }

    static float inside(double value, float zone_min, float zone_max) {
        if (double(zone_max) - zone_min <= 2 * zone_inset) return float((double(zone_min) + zone_max) / 2);
        return float(std::min(double(zone_max) - zone_inset, std::max(double(zone_min) + zone_inset, value)));
    }

    static std::optional<TrackStyleSwitch>
    due(const BhRunState &timer,
        const BhState &player,
        const std::vector<BhZone> &zones,
        std::string_view selected_style,
        std::string_view active_style,
        bool flying,
        float yaw) {
        const auto style = style_for_track(selected_style, timer.track);
        if (!timer.in_start || flying || style == active_style) return std::nullopt;
        const auto zone = std::find_if(zones.begin(), zones.end(), [&](const BhZone &z) {
            return z.kind == 0 && z.track == timer.track && touches(z, player.position, player.crouched != 0);
        });
        if (zone == zones.end()) return std::nullopt;
        TrackStyleSwitch change;
        change.track = timer.track;
        change.at.position = {
                inside(player.position[0], zone->mins[0], zone->maxs[0]),
                inside(player.position[1], zone->mins[1], zone->maxs[1]),
                std::max(zone->mins[2] + zone_inset, player.position[2]),
        };
        change.at.yaw = yaw;
        change.toast = timer.track ? "Bonus " + std::to_string(timer.track) : "Main track";
        change.toast += ", ";
        change.toast += wire_style_name(style);
        return change;
    }

    // Before a live tick: the switch the last tick's timer and player call for, if any.
    static std::optional<TrackStyleSwitch>
    due(BhContext *core,
        const BhState &player,
        const std::vector<BhZone> &zones,
        std::string_view selected_style,
        std::string_view active_style,
        bool flying,
        float yaw) {
        BhRunState timer{};
        if (!core || zones.empty() || !bh_run_state(core, &timer)) return std::nullopt;
        return due(timer, player, zones, selected_style, active_style, flying, yaw);
    }
};

}  // namespace native
