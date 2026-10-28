#pragma once
#include <nlohmann/json.hpp>
#include <cmath>
#include <cstdint>
#include <limits>

namespace native {
inline constexpr uint32_t timing_policy = 1;
inline constexpr double milliseconds_per_second = 1000.0;
inline constexpr double microseconds_per_second = 1000000.0;
inline constexpr double microseconds_per_millisecond = 1000.0;
inline constexpr double max_score_seconds = 86400.0;
inline constexpr int64_t max_score_ms = 86400000;
inline constexpr float legacy_tick_seconds = .01f;

inline int64_t score_ms(double seconds) {
    return int64_t(std::floor(seconds * milliseconds_per_second + 0.5));
}

// Old summaries store seconds. Convert at the boundary so equal milliseconds tie.
inline int64_t score_ms(const nlohmann::json &value, const char *seconds_field = "time") {
    const auto ms = value.find("timeMs");
    if (ms != value.end() && ms->is_number_integer()) {
        const auto score = ms->get<int64_t>();
        if (score >= 0 && score <= max_score_ms) return score;
    }
    const auto seconds = value.find(seconds_field);
    if (seconds != value.end() && seconds->is_number()) {
        const double time = seconds->get<double>();
        if (std::isfinite(time) && time >= 0 && time <= max_score_seconds) return score_ms(time);
    }
    return std::numeric_limits<int64_t>::max();
}

inline double score_seconds(int64_t time_ms) {
    return double(time_ms) / milliseconds_per_second;
}

inline int64_t legacy_replay_ms(const nlohmann::json &info) {
    const auto ticks = info.at("endTick").get<int64_t>() - info.at("startTick").get<int64_t>();
    const auto interval = info.at("settings").value("tickInterval", legacy_tick_seconds);
    const auto tick_us = std::floor(double(float(interval)) * microseconds_per_second + 0.5);
    return int64_t(std::floor(double(ticks) * tick_us / microseconds_per_millisecond + 0.5));
}
} // namespace native
