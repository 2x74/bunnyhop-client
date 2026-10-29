#pragma once
#include <algorithm>
#include <cmath>
#include <cstdint>

namespace native {
// Motion reaching gameplay. SDL may estimate packet times or coalesce reports; even a device timestamp cannot
// reveal USB reports with no motion. Constant storage; no allocations, locking or logging in the event path.
struct MouseDiagnostics {
    static constexpr uint64_t second_ns = 1'000'000'000;
    static constexpr uint64_t maximum_interval_ns = 20'000'000;
    static constexpr double millisecond_ns = 1'000'000;
    static constexpr double minimum_sample_seconds = .25;

    struct Sample {
        double seconds = 0, events_per_second = 0, average_age_ms = 0, max_age_ms = 0, max_pump_ms = 0;
        uint64_t events = 0, peak_burst = 0;
        double motion_rate_hz = 0, timestamp_jitter_ms = 0;
        uint64_t repeated_stamps = 0, reversed_stamps = 0;
    };

    Sample last;
    const char *backend = "SDL";
    const char *timestamp_kind = "OS event";
    bool active = false;
    uint64_t since = 0, count = 0, aged = 0, burst = 0, peak = 0;
    double age_sum = 0, age_max = 0, pump_max = 0;
    uint64_t previous_stamp = 0, intervals = 0, interval_span = 0, repeated = 0, reversed = 0;
    double interval_mean = 0, interval_variance = 0;

    void publish(uint64_t now) {
        if (!since || now <= since) return;
        const double seconds = double(now - since) / second_ns;
        if (seconds < minimum_sample_seconds) return;
        last = {seconds, count / seconds, aged ? age_sum / aged : 0, age_max, pump_max, count, peak};
        last.motion_rate_hz = interval_span ? double(intervals) * second_ns / double(interval_span) : 0;
        last.timestamp_jitter_ms = intervals ? std::sqrt(interval_variance / double(intervals)) / millisecond_ns : 0;
        last.repeated_stamps = repeated;
        last.reversed_stamps = reversed;
    }

    void clear_window(uint64_t now) {
        since = now;
        count = aged = burst = peak = 0;
        age_sum = age_max = pump_max = 0;
        previous_stamp = intervals = interval_span = repeated = reversed = 0;
        interval_mean = interval_variance = 0;
    }

    void begin(uint64_t now, bool enabled) {
        if (active && !enabled) publish(now);
        if (enabled && !active) clear_window(now);
        active = enabled;
        burst = 0;
    }

    void source(uint64_t now, const char *name, const char *kind) {
        if (backend == name && timestamp_kind == kind) return;
        backend = name;
        timestamp_kind = kind;
        last = {};
        clear_window(now);
    }

    void interval(uint64_t timestamp) {
        const uint64_t previous = previous_stamp;
        previous_stamp = timestamp;
        if (!previous || !timestamp) return;
        if (timestamp == previous) {
            ++repeated;
            return;
        }
        if (timestamp < previous) {
            ++reversed;
            return;
        }
        const uint64_t span = timestamp - previous;
        if (span > maximum_interval_ns) return;
        ++intervals;
        interval_span += span;
        const double delta = double(span) - interval_mean;
        interval_mean += delta / double(intervals);
        interval_variance += delta * (double(span) - interval_mean);
    }

    void motion(uint64_t timestamp, uint64_t received) {
        if (!active) return;
        ++count;
        ++burst;
        interval(timestamp);
        if (timestamp && received >= timestamp) {
            const double age = double(received - timestamp) / millisecond_ns;
            age_sum += age;
            age_max = std::max(age_max, age);
            ++aged;
        }
    }

    void end(uint64_t now, uint64_t pump_start) {
        if (!active) return;
        peak = std::max(peak, burst);
        if (now >= pump_start) pump_max = std::max(pump_max, double(now - pump_start) / millisecond_ns);
        if (now >= since && now - since >= second_ns) {
            publish(now);
            clear_window(now);
        }
    }
};
}  // namespace native
