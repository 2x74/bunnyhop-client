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
    // Where to restart: the player's spot, kept inside the start zone, facing the way they face. None: the track's own
    // restart point, as the bonus restart key picks it.
    std::optional<StartPoint> at;
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

    // The first start zone of `track` the player touches.
    static const BhZone *
    start_of(const std::vector<BhZone> &zones, uint32_t track, const float position[3], bool crouched) {
        for (const auto &zone : zones)
            if (zone.kind == 0 && zone.track == track && touches(zone, position, crouched)) return &zone;
        return nullptr;
    }

    static TrackStyleSwitch to_track(uint32_t track, std::string_view style) {
        TrackStyleSwitch change;
        change.track = track;
        change.toast = track ? "Bonus " + std::to_string(track) : "Main track";
        change.toast += ", ";
        change.toast += wire_style_name(style);
        return change;
    }

    // The restart at `position` in `zone`, kept inside it.
    static TrackStyleSwitch in_zone(const BhZone &zone, const float position[3], float yaw, std::string_view style) {
        auto change = to_track(zone.track, style);
        StartPoint at;
        at.position = {
                inside(position[0], zone.mins[0], zone.maxs[0]),
                inside(position[1], zone.mins[1], zone.maxs[1]),
                std::max(zone.mins[2] + zone_inset, position[2]),
        };
        at.yaw = yaw;
        change.at = at;
        return change;
    }

    // Before a live tick, from the last tick's timer and player.
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
        const auto *zone = start_of(zones, timer.track, player.position, player.crouched != 0);
        if (!zone) return std::nullopt;
        return in_zone(*zone, player.position, yaw, style);
    }

    // After an Infinite flight's landing tick (website flight-landing.ts landingBonusRestart). The landing can keep the
    // player in a bonus start, so the timer stays armed there, while the same tick's step carries them out of it and
    // starts the bonus run, still in Infinite: `due` never sees them standing in the start, and the verifier rejects
    // the finish (bonus runs are Normal). Decided from the timer's track after the tick, not from the zones the landing
    // spot touches, since where a main start overlaps the bonus start the timer keeps the bonus. When the timer is
    // armed in or has started a bonus that runs in another style, that bonus restarts at its own restart point, as the
    // bonus key does. Never at the landing spot: it can be in midair inside a tall start, which is no valid spawn.
    static std::optional<TrackStyleSwitch>
    landing_bonus(const BhRunState &timer, std::string_view selected_style, std::string_view active_style) {
        const bool started = timer.status == 1 || timer.pending_start != 0;
        if (timer.track == 0 || !(timer.in_start || started)) return std::nullopt;
        const auto style = style_for_track(selected_style, timer.track);
        if (style == active_style) return std::nullopt;
        return to_track(timer.track, style);
    }

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

    static std::optional<TrackStyleSwitch>
    landing_bonus(BhContext *core, std::string_view selected_style, std::string_view active_style) {
        BhRunState timer{};
        if (!core || !bh_run_state(core, &timer)) return std::nullopt;
        return landing_bonus(timer, selected_style, active_style);
    }
};

}  // namespace native
