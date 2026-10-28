#pragma once
#include <nlohmann/json.hpp>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <stdexcept>

namespace native {

struct ReplayRange {
    static constexpr double prelude_seconds = 1;
    static constexpr double outro_seconds = 1.5;
    uint32_t from = 0;
    uint32_t to = 0;
    uint32_t total = 0;
    double tick_interval = .01;
    bool full_recording = false;

    static ReplayRange make(const nlohmann::json &info, bool full = false) {
        ReplayRange range;
        range.total = info.at("totalTicks").get<uint32_t>();
        range.tick_interval = info.at("settings").at("tickInterval").get<double>();
        range.full_recording = full;
        if (!std::isfinite(range.tick_interval) || range.tick_interval <= 0) {
            throw std::runtime_error("Invalid replay tick interval.");
        }
        const uint32_t start = info.at("startTick").get<uint32_t>();
        const uint32_t end = info.at("endTick").get<uint32_t>();
        if (start > end || end > range.total) {
            throw std::runtime_error("Invalid replay timer bounds.");
        }
        range.to = range.total;
        if (!full) {
            const auto before = uint64_t(std::llround(prelude_seconds / range.tick_interval));
            const auto after = uint64_t(std::llround(outro_seconds / range.tick_interval));
            range.from = uint32_t(start - std::min(uint64_t(start), before));
            range.to = uint32_t(std::min(uint64_t(range.total), uint64_t(end) + after));
        }
        return range;
    }

    uint32_t clamp(uint32_t tick) const { return std::clamp(tick, from, to); }
    uint32_t relative(uint32_t tick) const { return clamp(tick) - from; }
    uint32_t ticks() const { return to - from; }

    template <class Options> void export_bounds(Options &options) const {
        const uint32_t first = options.full_recording ? 0 : from;
        const uint32_t last = options.full_recording ? total : to;
        if (options.to == 0 || (options.from == 0 && options.to == total)) {
            options.from = first;
            options.to = last;
        }
        if (options.from < first || options.from >= options.to || options.to > last) {
            throw std::runtime_error("Video clip is outside the selected replay range.");
        }
    }
};

}  // namespace native
