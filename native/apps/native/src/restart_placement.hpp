#pragma once
#include "restart_names.hpp"
#include "start_point.hpp"
#include <stdexcept>

namespace native {
inline constexpr float restart_hull_half_width = 16;
inline constexpr float restart_hull_height = 62;
inline constexpr float restart_floor_offset = 1;

struct RestartPlacement {
    BhState state{};
    std::optional<float> pitch;
    bool practice = false;

    static void check(BhContext *core, int result) {
        if (!result) {
            throw std::runtime_error(bh_last_error(core));
        }
    }

    static void apply_names(BhContext *core, const std::optional<RestartNames> &names) {
        check(core, bh_set_restart_names(core, names ? names->targetname : "", names ? names->classname : ""));
    }

    static RestartPlacement
    place(BhContext *core,
          const std::string &map,
          uint32_t track,
          const std::vector<BhZone> &zones,
          const StartPoints *points) {
        RestartPlacement result;
        check(core, bh_state(core, &result.state));
        const auto names = restart_names(map, track);
        const BhZone *start = nullptr;
        bool inside = false;
        for (const auto &zone : zones) {
            if (zone.kind != 0 || zone.track != track) continue;
            if (!start) start = &zone;
            const auto *p = result.state.position;
            inside =
                    inside
                    || (p[0] - restart_hull_half_width <= zone.maxs[0] && p[0] + restart_hull_half_width >= zone.mins[0]
                        && p[1] - restart_hull_half_width <= zone.maxs[1]
                        && p[1] + restart_hull_half_width >= zone.mins[1] && p[2] <= zone.maxs[2]
                        && p[2] + restart_hull_height >= zone.mins[2]);
        }
        if (start && (!inside || names)) {
            check(core,
                  bh_set_position(
                          core,
                          float((double(start->mins[0]) + start->maxs[0]) / 2),
                          float((double(start->mins[1]) + start->maxs[1]) / 2),
                          start->mins[2] + restart_floor_offset,
                          result.state.teleport_angles[1]
                  ));
            if (names) apply_names(core, names);
            check(core, bh_state(core, &result.state));
        }
        if (points) {
            if (const auto point = points->get(map, track)) {
                result.custom(core, map, *point, zones, track, names);
            }
        }
        return result;
    }

    void
    custom(BhContext *core,
           const std::string &map,
           const StartPoint &point,
           const std::vector<BhZone> &zones,
           uint32_t track,
           const std::optional<RestartNames> &names) {
        if (bh_set_position(core, point.position[0], point.position[1], point.position[2], point.yaw)
            && bh_state(core, &state) && start_point_landed(state, point)) {
            pitch = point.pitch;
            practice = start_point_practice(point, state, zones, track);
            apply_names(core, practice ? std::nullopt : names);
        } else {
            // A map spawn can overlap the start zone while its centre lies outside
            // it. Re-applying that spawn would record an invalid restart override.
            check(core, bh_reset(core));
            *this = place(core, map, track, zones, nullptr);
        }
    }
};
}  // namespace native
