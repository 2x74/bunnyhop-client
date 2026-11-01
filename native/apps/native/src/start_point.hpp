#pragma once
#include "bunnyhop_native.h"
#include "settings.hpp"
#include <array>
#include <optional>
#include <vector>

namespace native {
struct StartPoint {
    std::array<float, 3> position{};
    float yaw = 0, pitch = 0;
    bool practice = false;
};

inline bool start_zone_holds(const BhZone &z, const float p[3], uint32_t track) {
    return z.kind == 0 && z.track == track && p[0] - 16 >= z.mins[0] && p[0] + 16 <= z.maxs[0] && p[1] - 16 >= z.mins[1]
           && p[1] + 16 <= z.maxs[1] && p[2] <= z.maxs[2] && p[2] + 62 >= z.mins[2];
}

// A start point can be saved anywhere the player stands still on the ground, in
// main or practice runs. Only one inside the start zone can begin a timed, recorded
// run if reached without practice tools. The verifier requires the replay's spawn
// there. A point elsewhere or reached with tools restarts as practice.
// Noclip is refused: the flight state is not the player's resting state.
inline std::string start_point_problem(const BhState &s, bool noclip) {
    if (noclip) return "Turn off noclip first";
    if (!s.grounded || s.on_ladder) return "Stand on the ground";
    if (s.crouched) return "Stand up";
    if (std::hypot(std::hypot(s.velocity[0], s.velocity[1]), s.velocity[2]) > 1) return "Stand still";
    return {};
}

// Restart: the core settles the saved point onto the floor below it and respawns
// the player there. A fresh respawn is not grounded until its first tick and has
// no velocity, so the resting checks above cannot apply; the point holds when the
// core put the player at it (same x/y, same floor within 4 units).
inline bool start_point_landed(const BhState &s, const StartPoint &p) {
    return s.position[0] == p.position[0] && s.position[1] == p.position[1]
           && std::abs(s.position[2] - p.position[2]) <= 4;
}

inline bool start_point_in_zone(const BhState &s, const std::vector<BhZone> &zones, uint32_t track) {
    for (const auto &z : zones)
        if (start_zone_holds(z, s.position, track)) return true;
    return false;
}

// How far inside the edge a moved point lands: f32 rounding can't put the footprint back over it.
constexpr float start_point_snap_inset = 1;
constexpr float start_point_hull_half_width = 16;
constexpr float start_point_hull_height = 62;
constexpr const char *practice_spawn_notice = "This start point doesn't count. !clearstart to go back to the real one.";

inline bool start_zone_touched(const BhZone &z, const float p[3], uint32_t track) {
    return z.kind == 0 && z.track == track && p[0] + start_point_hull_half_width >= z.mins[0]
           && p[0] - start_point_hull_half_width <= z.maxs[0] && p[1] + start_point_hull_half_width >= z.mins[1]
           && p[1] - start_point_hull_half_width <= z.maxs[1] && p[2] <= z.maxs[2]
           && p[2] + start_point_hull_height >= z.mins[2];
}

inline float snapped_axis(float position, float zone_min, float zone_max) {
    const float reach = start_point_hull_half_width + start_point_snap_inset;
    if (position - start_point_hull_half_width >= zone_min && position + start_point_hull_half_width <= zone_max)
        return position;
    return std::min(zone_max - reach, std::max(zone_min + reach, position));
}

// A standing footprint that sticks out of a start zone's edge means the zone: the point moves in as little as possible
// (website start-point.ts snapIntoStartZone). At most 33 units per axis, less than the hull is wide, so nothing solid
// can lie between the two spots, and a restart that can't stand there falls back to the map's spawn.
inline std::optional<std::array<float, 3>>
snap_into_start_zone(const float position[3], const std::vector<BhZone> &zones, uint32_t track) {
    const float reach = start_point_hull_half_width + start_point_snap_inset;
    std::optional<std::array<float, 3>> best;
    double best_moved = 0;
    for (const auto &z : zones) {
        if (!start_zone_touched(z, position, track)) continue;
        if (z.maxs[0] - z.mins[0] < 2 * reach || z.maxs[1] - z.mins[1] < 2 * reach) continue;
        const std::array<float, 3> moved_to = {
                snapped_axis(position[0], z.mins[0], z.maxs[0]),
                snapped_axis(position[1], z.mins[1], z.maxs[1]),
                position[2]
        };
        if (!start_zone_holds(z, moved_to.data(), track)) continue;
        const double moved =
                std::hypot(double(moved_to[0]) - double(position[0]), double(moved_to[1]) - double(position[1]));
        if (best && moved >= best_moved) continue;
        best = moved_to;
        best_moved = moved;
    }
    return best;
}

// What "set start" does here: the spot to save, whether restarts from it are practice, and what to tell the player.
struct StartPointSave {
    BhState state{};
    bool practice = false;
    std::string message;
};

inline StartPointSave
plan_start_point(const BhState &current, const std::vector<BhZone> &zones, uint32_t track, bool used_practice_tools) {
    StartPointSave save;
    save.state = current;
    if (used_practice_tools) {
        save.practice = true;
        save.message = "Spawn saved. This run used noclip, a checkpoint or a practice spawn, so restarts from it are "
                       "practice and won't count. !clearstart undoes it.";
        return save;
    }
    if (start_point_in_zone(current, zones, track)) {
        save.message = "Start point saved";
        return save;
    }
    if (const auto snapped = snap_into_start_zone(current.position, zones, track)) {
        std::copy(snapped->begin(), snapped->end(), save.state.position);
        save.message = "Start point saved, just inside the zone";
        return save;
    }
    save.practice = true;
    save.message = "Spawn saved. It's outside the start zone, so restarts from it are practice and won't count. "
                   "!clearstart undoes it.";
    return save;
}

inline bool
start_point_practice(const StartPoint &point, const BhState &state, const std::vector<BhZone> &zones, uint32_t track) {
    return point.practice || !start_point_in_zone(state, zones, track);
}

struct StartPoints {
    Json points = Json::object();

    static std::string key(const std::string &map, uint32_t track) { return map + ":" + std::to_string(track); }

    bool load(const Json &value) {
        if (!value.is_object() || value.size() > 4096) return false;
        for (auto it = value.begin(); it != value.end(); ++it) {
            if (!decode(it.value())) return false;
        }
        points = value;
        return true;
    }

    static std::optional<StartPoint> decode(const Json &v) {
        try {
            if (!v.is_object() || !v.contains("position") || !v["position"].is_array() || v["position"].size() != 3)
                return {};
            StartPoint out;
            for (int i = 0; i < 3; ++i) {
                out.position[i] = v["position"][i].get<float>();
                if (!std::isfinite(out.position[i]) || std::abs(out.position[i]) > 32768) return {};
            }
            out.practice = v.value("practice", false);
            out.yaw = v.at("yaw").get<float>();
            out.pitch = v.at("pitch").get<float>();
            if (!std::isfinite(out.yaw) || !std::isfinite(out.pitch) || out.pitch < -89 || out.pitch > 89) return {};
            return out;
        } catch (...) {
            return {};
        }
    }

    void
    save(const std::string &map, uint32_t track, const BhState &s, double yaw, double pitch, bool practice = false) {
        points[key(map, track)] = {
                {"position", {s.position[0], s.position[1], s.position[2]}},
                {"yaw", yaw},
                {"pitch", pitch},
                {"practice", practice}
        };
    }

    bool clear(const std::string &map, uint32_t track) { return points.erase(key(map, track)) != 0; }

    bool clear_practice(const std::string &map) {
        const auto prefix = map + ":";
        bool cleared = false;
        for (auto it = points.begin(); it != points.end();) {
            if (it.key().starts_with(prefix) && it.value().value("practice", false)) {
                it = points.erase(it);
                cleared = true;
            } else {
                ++it;
            }
        }
        return cleared;
    }

    std::optional<StartPoint> get(const std::string &map, uint32_t track) const {
        const auto it = points.find(key(map, track));
        return it == points.end() ? std::nullopt : decode(*it);
    }
};

// Hold-to-restart ignores autorepeat, cancels on release/focus transitions and
// fires only once. Wheel bindings cannot be held and act immediately, as on web.
struct RestartGuard {
    double started = -1;
    std::string action;

    void cancel() {
        started = -1;
        action.clear();
    }

    bool press(const std::string &next, double now, bool enabled, bool /*timed*/, bool wheel) {
        if (!enabled || wheel) {
            cancel();
            return true;
        }
        if (started < 0 || action != next) {
            action = next;
            started = now;
        }
        return false;
    }

    float progress(double now) const { return started < 0 ? -1.f : float(std::clamp((now - started) / 500., 0., 1.)); }

    std::optional<std::string> frame(double now, bool held, bool suspended) {
        if (started < 0) return {};
        if (suspended) {
            cancel();
            return {};
        }
        if (now - started >= 500) {
            const auto result = action;
            cancel();
            return result;
        }
        if (!held) cancel();
        return {};
    }
};
}  // namespace native
