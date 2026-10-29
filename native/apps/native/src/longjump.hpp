#pragma once
#include "bunnyhop_native.h"
#include "hud_geometry.hpp"
#include "hud_text.hpp"
#include "semantic_palette.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <optional>
#include <string>
#include <vector>

namespace native {
struct LjStrafe {
    int side = 0, ticks = 0, synced = 0;
    double gain = 0, loss = 0;
};

struct LjPoint {
    double d = 0, z = 0, v = 0;
};

struct LjReport {
    bool standing = false, failed = false, crouched = false;
    double distance = 0, displacement = 0, pre = 0, max = 0, sync = 0, airtime = 0;
    HudSamples<LjStrafe, 256> strafes;
    HudSamples<LjPoint, 512> path;
};

inline unsigned lj_tier(const LjReport &report) {
    if (!report.standing || report.failed) return 0;
    constexpr std::array<double, 4> distances = {250, 260, 268, 275};
    return unsigned(std::count_if(distances.begin(), distances.end(), [&](double distance) {
        return report.distance >= distance;
    }));
}

inline SemanticColor lj_color(const LjReport &report, std::string_view mode) {
    std::array<uint32_t, 5> colors = {0xffffff, 0x5eb6ff, 0x4dff88, 0xff5d5d, 0xffc53d};
    if (mode == "redGreen") colors = {0xffffff, 0x5eb6ff, 0x8040ff, 0xff5d5d, 0xf0e442};
    if (mode == "blueYellow") colors = {0xffffff, 0x3d8bff, 0x4dff88, 0xff5d5d, 0xe69f00};
    return semantic_rgb(colors[lj_tier(report)]);
}

inline HudLabel<> lj_head(const LjReport &report) {
    HudLabel<> result;
    double distance = report.distance;
    // A binary float lands exactly halfway between hundredths only at an odd eighth.
    // JavaScript toFixed chooses the larger distance there; printf uses ties-to-even.
    constexpr double eighths_per_unit = 8;
    const double eighths = distance * eighths_per_unit;
    if (eighths == std::floor(eighths) && std::fmod(eighths, 2) == 1) distance = std::nextafter(distance, INFINITY);
    result.format("%s %.2f%s", report.standing ? "LJ" : "BH", distance, report.failed ? " fail" : "");
    return result;
}

inline HudLabel<> lj_details(const LjReport &report) {
    HudLabel<> result;
    result.format(
            "%.0f pre | %.0f max | %zu str | %.0f%% sync",
            std::floor(report.pre + .5),
            std::floor(report.max + .5),
            report.strafes.size(),
            std::floor(report.sync + .5)
    );
    return result;
}

// Display-only port of web/movement-stats/stats.ts LjTracker. The core's exact
// clean-tick observation is required throughout; no value feeds the simulation.
class LjTracker {
    struct Flight {
        std::array<double, 3> start{};
        uint32_t tick = 0;
        bool standing = false, valid = false;
        double pre = 0, max = 0, duck = 0;
        int side = 0, samples = 0, synced = 0;
        HudSamples<LjStrafe, 256> list;
        HudSamples<LjPoint, 512> path;
        std::optional<std::pair<double, uint32_t>> cross;
    };

    unsigned ground = 0;
    std::optional<Flight> flight;

    static double speed(const BhState &p) { return std::hypot(double(p.velocity[0]), double(p.velocity[1])); }

    static double displacement(const BhState &p, const Flight &f) {
        return std::hypot(p.position[0] - f.start[0], p.position[1] - f.start[1]);
    }

    static double round1(double v) { return std::floor(v * 10 + .5) / 10; }

    static std::optional<LjReport> report(Flight &f, double d, uint32_t ticks, double dt, bool crouched, bool failed) {
        const double airtime = ticks * dt;
        if (!f.samples || airtime < .2 || airtime > 1.2 || d < 32) return {};
        return LjReport{
                f.standing,
                failed,
                crouched,
                d + 32,
                d,
                f.pre,
                f.max,
                100. * f.synced / f.samples,
                airtime,
                std::move(f.list),
                std::move(f.path)
        };
    }

public:
    void reset() {
        ground = 0;
        flight.reset();
    }

    std::optional<LjReport>
    feed(const BhState &pre, const BhState &post, const BhCmd &cmd, bool valid, double dt, const std::string &style) {
        bool finite = true;
        for (int i = 0; i < 3; ++i)
            finite &= std::isfinite(pre.position[i]) && std::isfinite(post.position[i])
                      && std::isfinite(pre.velocity[i]) && std::isfinite(post.velocity[i]);
        const bool manual = style == "autohop" || style == "legit" || style == "scroll" || style == "hsw";
        if ((post.events & (1 | 8)) || pre.on_ladder || post.on_ladder || !manual || !std::isfinite(dt) || dt <= 0
            || uint64_t(post.tick) != uint64_t(pre.tick) + 1 || !finite) {
            reset();
            return {};
        }
        if (pre.grounded) ++ground;
        std::optional<LjReport> result;
        if (flight) {
            auto &f = *flight;
            f.valid &= valid;
            const double v = speed(post), before = speed(pre), d = displacement(post, f),
                         z = post.position[2] - f.start[2];
            if (!pre.grounded) {
                ++f.samples;
                const bool synced = (cmd.forward || cmd.side) && v > before + .0001;
                if (synced) ++f.synced;
                const int side = (cmd.side > 0) - (cmd.side < 0);
                if (side && side != f.side) {
                    f.list.push_back(LjStrafe{side});
                    f.side = side;
                }
                if (!f.list.empty()) {
                    auto &s = f.list.back();
                    ++s.ticks;
                    if (v > before)
                        s.gain += v - before;
                    else
                        s.loss += before - v;
                    if (synced) ++s.synced;
                }
            }
            f.max = std::max(f.max, v);
            if (!post.grounded && bool(post.crouched) != bool(pre.crouched))
                f.duck += double(post.position[2]) - pre.position[2]
                          - (double(pre.velocity[2]) + post.velocity[2]) * .5 * dt;
            f.path.push_back({round1(d), round1(post.grounded ? z : z - f.duck), round1(v)});
            if (!f.cross && z < 0) {
                const double zp = pre.position[2] - f.start[2], dp = displacement(pre, f),
                             t = zp > z ? zp / (zp - z) : 1;
                f.cross = {{dp + (d - dp) * std::clamp(t, 0., 1.), post.tick}};
            }
            if (z < -2 && f.cross) {
                if (f.valid) result = report(f, f.cross->first, f.cross->second - f.tick, dt, post.crouched, true);
                flight.reset();
            } else if ((post.events & 4) || post.grounded) {
                if (f.valid && std::abs(z) <= 2) result = report(f, d, post.tick - f.tick, dt, post.crouched, false);
                flight.reset();
            } else if ((post.tick - f.tick) * dt > 1.2)
                flight.reset();
        }
        if ((post.events & 2) && pre.grounded && !pre.crouched) {
            Flight f;
            for (int i = 0; i < 3; ++i)
                f.start[i] = pre.position[i];
            f.tick = pre.tick;
            f.pre = speed(pre);
            f.standing = ground >= 10 && f.pre <= 300;
            f.max = speed(post);
            f.valid = valid;
            f.path.push_back({0, 0, round1(f.pre)});
            flight = std::move(f);
        }
        if (!pre.grounded) ground = 0;
        return result;
    }
};
}  // namespace native
