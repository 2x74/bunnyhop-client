#pragma once
#include "bunnyhop_native.h"
#include "render_math.hpp"
#include "native_cosmetics.hpp"
#include "graphics_settings.hpp"
#include <array>
#include <span>
#include <vector>

namespace native_render {
inline constexpr double ghost_trail_seconds = 2.5;
inline constexpr unsigned ghost_trail_step = 2;
inline constexpr size_t ghost_trail_capacity = 399;
inline bool valid_ghost_position(const BhGhostFrame &frame) {
    return std::all_of(std::begin(frame.position), std::end(frame.position),
                       [](float value) { return std::isfinite(value); });
}
inline Vec3 ghost_feet(const BhGhostFrame &frame, float height = 6) {
    return {frame.position[0], frame.position[1], frame.position[2] + height};
}
inline bool positional_teleport(const BhGhostFrame &a, const BhGhostFrame &b) {
    // Positional-import fallback from ghost-route-data.ts. The ABI has no simulation teleport event bit.
    float distance = 0;
    for (int axis = 0; axis < 3; ++axis) {
        distance += std::abs(b.position[axis] - a.position[axis]);
    }
    return distance > 200;
}
struct GhostOptions {
    bool pb = true, wr = true, custom = true, trail = true, route = false, show = true;
    GhostSource route_source = GhostSource::none;
    bool route_path = false;
    void read(const nlohmann::json &settings) {
        show = settings.value("showGhost", true);
        pb = settings.value("ghostPb", true);
        wr = settings.value("ghostWr", true);
        custom = settings.value("ghostCustom", true);
        trail = settings.value("ghostTrail", true);
        route = settings.value("ghostRoute", false);
        const auto source = settings.value("ghostRouteSource", std::string("auto"));
        route_source = source == "auto" ? GhostSource::none : ghost_source(source);
        route_path = settings.value("ghostRouteMode", std::string("jumps")) == "path";
    }
    bool visible(GhostSource source) const {
        return show && (source == GhostSource::pb ? pb : source == GhostSource::wr ? wr : custom);
    }
};
struct GhostPath {
    struct Segment {
        Vec3 from, to;
    };
    std::vector<BhGhostFrame> frames;
    std::vector<uint8_t> teleports;
    std::vector<Segment> jump_links;
    std::vector<Vec3> jumps;
    uint32_t start = 0, end = 0, track = 0;
    std::string style = "autohop", name = "Ghost", loadout;
    double interval = 1. / 64;
    GhostSource source = GhostSource::custom;
    bool enabled = false;

    void build_route() {
        jump_links.clear();
        jumps.clear();
        if (frames.empty() || start >= frames.size()) {
            return;
        }
        size_t anchor = start;
        const size_t last = std::min(size_t(end), frames.size() - 1);
        for (size_t tick = start + 1; tick <= last; ++tick) {
            const bool cut =
                teleports[tick] || !valid_ghost_position(frames[tick]) || !valid_ghost_position(frames[tick - 1]);
            const bool jumped = (frames[tick - 1].flags & 2) && !(frames[tick].flags & 2) &&
                                frames[tick].position[2] > frames[tick - 1].position[2];
            if (cut || jumped) {
                if (tick - 1 > anchor) {
                    jump_links.push_back({ghost_feet(frames[anchor], 2), ghost_feet(frames[tick - 1], 2)});
                }
                anchor = cut ? tick : tick - 1;
                if (!cut && jumped) {
                    jumps.push_back(ghost_feet(frames[tick - 1], 2));
                }
            }
        }
        if (last > anchor) {
            jump_links.push_back({ghost_feet(frames[anchor], 2), ghost_feet(frames[last], 2)});
        }
    }
    void load(BhContext *core, uint32_t handle, const nlohmann::json &info, GhostSource kind) {
        constexpr uint32_t maximum_ticks = 180000;
        const uint32_t total = info.value("totalTicks", 0u);
        if (!total || total > maximum_ticks) {
            throw std::runtime_error("Ghost path exceeds supported tick count");
        }
        source = kind == GhostSource::none ? GhostSource::custom : kind;
        track = info.value("track", 0u);
        if (info.contains("player") && info.at("player").is_string())
            name = info.at("player");
        if (info.contains("packedLoadout") && info.at("packedLoadout").is_string())
            loadout = info.at("packedLoadout");
        style = info.value("style", std::string("autohop"));
        start = std::min(info.value("startTick", 0u), total);
        end = std::min(info.value("endTick", total), total);
        interval = info.contains("settings") ? info.at("settings").value("tickInterval", 1. / 64)
                                             : info.value("tickInterval", 1. / 64);
        if (!std::isfinite(interval) || interval <= 0 || interval > 1) {
            throw std::runtime_error("Invalid ghost tick interval");
        }
        frames.resize(total + 1);
        teleports.assign(total + 1, 0);
        for (uint32_t tick = 0; tick <= total; ++tick) {
            if (!bh_ghost_frame(core, handle, tick, &frames[tick])) {
                throw std::runtime_error("Could not read recorded ghost path");
            }
            if (tick) {
                teleports[tick] = positional_teleport(frames[tick - 1], frames[tick]);
            }
        }
        enabled = true;
        build_route();
    }
};
class GhostTrails {
    std::array<Vec3, ghost_trail_capacity> points_{};
    size_t count_ = 0;

  public:
    // Recorded frames make pause, scrubbing and low presentation FPS produce the same ribbon.
    std::span<const Vec3> recorded(const GhostPath &path, double tick) {
        count_ = 0;
        if (path.frames.empty() || !std::isfinite(tick) || tick < path.start) {
            return {};
        }
        tick = std::min(tick, double(path.frames.size() - 1));
        const double from = std::max(double(path.start), tick - ghost_trail_seconds / path.interval);
        const auto first = uint32_t(std::ceil(from / ghost_trail_step)) * ghost_trail_step;
        uint32_t previous = first;
        for (uint32_t sample = first; sample < tick && count_ < ghost_trail_capacity - 1; sample += ghost_trail_step) {
            for (uint32_t crossed = previous + 1; crossed <= sample; ++crossed) {
                if (crossed < path.teleports.size() && path.teleports[crossed]) {
                    count_ = 0;
                }
            }
            if (valid_ghost_position(path.frames[sample])) {
                points_[count_++] = ghost_feet(path.frames[sample]);
            } else {
                count_ = 0;
            }
            previous = sample;
        }
        const auto head = uint32_t(tick);
        for (uint32_t crossed = previous + 1; crossed <= head; ++crossed) {
            if (path.teleports[crossed]) {
                count_ = 0;
            }
        }
        if (valid_ghost_position(path.frames[head])) {
            points_[count_++] = ghost_feet(path.frames[head]);
        }
        return {points_.data(), count_};
    }
    void clear() {
        count_ = 0;
    }
};
inline std::array<float, 4> trail_color(const std::array<std::array<float, 3>, 2> &colors, float progress,
                                        float opacity, float distance) {
    const float fraction = std::clamp((.92f - progress) * 2.4f, 0.f, 1.f);
    const float mix = fraction * fraction * (3 - 2 * fraction);
    const float near = std::clamp((distance - 40) / 160, 0.f, 1.f);
    std::array<float, 4> result{};
    for (int axis = 0; axis < 3; ++axis) {
        result[axis] = colors[0][axis] + (colors[1][axis] - colors[0][axis]) * mix;
    }
    result[3] = std::min(1.f, opacity * 1.2f) * progress * progress * near * near;
    return result;
}
inline int route_priority(GhostSource source) {
    return source == GhostSource::custom ? 0 : source == GhostSource::pb ? 1 : 2;
}
}
