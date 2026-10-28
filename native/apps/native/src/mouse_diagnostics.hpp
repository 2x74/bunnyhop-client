#pragma once
#include <algorithm>
#include <cstdint>

namespace native {
// Delivered SDL motion events, not USB polling frequency or end-to-end latency.
// Constant storage; no allocations, locking or logging in the event path.
struct MouseDiagnostics {
    struct Sample {
        double seconds = 0, events_per_second = 0, average_age_ms = 0, max_age_ms = 0, max_pump_ms = 0;
        uint64_t events = 0, peak_burst = 0;
    };

    Sample last;
    bool active = false;
    uint64_t since = 0, count = 0, aged = 0, burst = 0, peak = 0;
    double age_sum = 0, age_max = 0, pump_max = 0;

    void publish(uint64_t now) {
        if (!since || now <= since) return;
        const double seconds = double(now - since) / 1e9;
        if (seconds < .25) return;
        last = {seconds, count / seconds, aged ? age_sum / aged : 0, age_max, pump_max, count, peak};
    }

    void clear_window(uint64_t now) {
        since = now;
        count = aged = burst = peak = 0;
        age_sum = age_max = pump_max = 0;
    }

    void begin(uint64_t now, bool enabled) {
        if (active && !enabled) publish(now);
        if (enabled && !active) clear_window(now);
        active = enabled;
        burst = 0;
    }

    void motion(uint64_t timestamp, uint64_t received) {
        if (!active) return;
        ++count;
        ++burst;
        if (timestamp && received >= timestamp) {
            const double age = double(received - timestamp) / 1e6;
            age_sum += age;
            age_max = std::max(age_max, age);
            ++aged;
        }
    }

    void end(uint64_t now, uint64_t pump_start) {
        if (!active) return;
        peak = std::max(peak, burst);
        if (now >= pump_start) pump_max = std::max(pump_max, double(now - pump_start) / 1e6);
        if (now >= since && now - since >= 1000000000ull) {
            publish(now);
            clear_window(now);
        }
    }
};
}  // namespace native
