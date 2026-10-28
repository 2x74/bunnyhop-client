#pragma once
#include "timed_input.hpp"
#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace native {

// Where each main-loop frame's time goes, for the mouse diagnostics overlay and feedback ("Attach game info").
// One thread runs the event pump, menu IPC, simulation, rendering and swap, so a stall in any of them holds input
// back; this names the phase. Storage is reserved once; recording a frame does not allocate.
class FrameDiagnostics {
public:
    enum Phase : size_t { kPump, kMenu, kSimulation, kRender, kSwap, kGpuWait, kSleep, kOther, kPhaseCount };

    static constexpr const char *kPhaseNames[kPhaseCount] = {
            "pump",
            "menu",
            "simulation",
            "render",
            "swap",
            "gpuWait",
            "sleep",
            "other",
    };
    static constexpr size_t kMaxFramesPerWindow = 8192;
    static constexpr uint64_t kWindowNs = 1'000'000'000;
    static constexpr double kStallMs = 50;

    struct Spread {
        double p50_ms = 0;
        double p99_ms = 0;
        double max_ms = 0;
    };

    struct Sample {
        double seconds = 0;
        uint64_t frames = 0;
        Spread frame;
        std::array<Spread, kPhaseCount> phases{};
        double longest_stall_ms = 0;
        uint32_t stalls = 0;
        double key_edges_per_second = 0;
        size_t max_queue_depth = 0;
        double late_share = 0;
        double holdback_ms = 0;
        bool stamps_unreliable = false;
    };

    // Counted whether or not the overlay is on: rare, and the likeliest causes of "the mouse stopped".
    uint32_t focus_losses = 0;
    uint32_t relative_mode_failures = 0;

    FrameDiagnostics() {
        for (auto &durations : phase_ms_) {
            durations.reserve(kMaxFramesPerWindow);
        }
        frame_ms_.reserve(kMaxFramesPerWindow);
        scratch_.reserve(kMaxFramesPerWindow);
    }

    const Sample &last() const { return last_; }

    bool active() const { return active_; }

    // At the top of each loop iteration: closes the previous frame and opens this one.
    void start_frame(uint64_t now, bool enabled) {
        if (active_ && frame_start_) {
            close_frame(now);
        }
        if (enabled && !active_) {
            clear_window(now);
            seed_counters_ = true;
        }
        active_ = enabled;
        frame_start_ = now;
        mark_ = now;
        current_.fill(0);
    }

    // The time since the previous mark went to |phase|.
    void mark(Phase phase, uint64_t now) {
        if (!active_ || now < mark_) {
            return;
        }
        current_[phase] += double(now - mark_) / 1e6;
        mark_ = now;
    }

    // Once per frame, after the ticks: the input queue as the ticks left it.
    void input(const TimedInput &queue) {
        if (!active_) {
            return;
        }
        if (seed_counters_) {
            reports_start_ = queue.reports;
            late_start_ = queue.late;
            edges_start_ = queue.edges_seen;
            seed_counters_ = false;
        }
        max_queue_depth_ = std::max(max_queue_depth_, queue.pending());
        reports_now_ = queue.reports;
        late_now_ = queue.late;
        edges_now_ = queue.edges_seen;
        holdback_ms_ = queue.holdback_ms;
        unreliable_ = queue.unreliable;
    }

private:
    bool active_ = false;
    uint64_t window_start_ = 0;
    uint64_t frame_start_ = 0;
    uint64_t mark_ = 0;
    std::array<double, kPhaseCount> current_{};
    std::array<std::vector<float>, kPhaseCount> phase_ms_;
    std::vector<float> frame_ms_;
    std::vector<float> scratch_;
    double longest_stall_ms_ = 0;
    uint32_t stalls_ = 0;
    size_t max_queue_depth_ = 0;
    bool seed_counters_ = false;
    uint64_t reports_start_ = 0;
    uint64_t reports_now_ = 0;
    uint64_t late_start_ = 0;
    uint64_t late_now_ = 0;
    uint64_t edges_start_ = 0;
    uint64_t edges_now_ = 0;
    double holdback_ms_ = 0;
    bool unreliable_ = false;
    Sample last_;

    void close_frame(uint64_t now) {
        mark(kOther, now);
        const double frame_ms = double(now - frame_start_) / 1e6;
        if (frame_ms > kStallMs) {
            ++stalls_;
        }
        longest_stall_ms_ = std::max(longest_stall_ms_, frame_ms);
        if (frame_ms_.size() < kMaxFramesPerWindow) {
            frame_ms_.push_back(float(frame_ms));
            for (size_t phase = 0; phase < kPhaseCount; ++phase) {
                phase_ms_[phase].push_back(float(current_[phase]));
            }
        }
        if (now - window_start_ >= kWindowNs) {
            publish(now);
            clear_window(now);
        }
    }

    Spread spread(const std::vector<float> &values) {
        Spread out;
        if (values.empty()) {
            return out;
        }
        scratch_.assign(values.begin(), values.end());
        const auto at = [this](double quantile) {
            const size_t index = std::min(scratch_.size() - 1, size_t(quantile * double(scratch_.size())));
            std::nth_element(scratch_.begin(), scratch_.begin() + std::ptrdiff_t(index), scratch_.end());
            return double(scratch_[index]);
        };
        out.p50_ms = at(.5);
        out.p99_ms = at(.99);
        out.max_ms = double(*std::max_element(scratch_.begin(), scratch_.end()));
        return out;
    }

    void publish(uint64_t now) {
        Sample sample;
        sample.seconds = double(now - window_start_) / 1e9;
        sample.frames = frame_ms_.size();
        sample.frame = spread(frame_ms_);
        for (size_t phase = 0; phase < kPhaseCount; ++phase) {
            sample.phases[phase] = spread(phase_ms_[phase]);
        }
        sample.longest_stall_ms = longest_stall_ms_;
        sample.stalls = stalls_;
        sample.key_edges_per_second = double(edges_now_ - edges_start_) / sample.seconds;
        sample.max_queue_depth = max_queue_depth_;
        const uint64_t reports = reports_now_ - reports_start_;
        sample.late_share = reports ? double(late_now_ - late_start_) / double(reports) : 0;
        sample.holdback_ms = holdback_ms_;
        sample.stamps_unreliable = unreliable_;
        last_ = sample;
    }

    void clear_window(uint64_t now) {
        window_start_ = now;
        frame_ms_.clear();
        for (auto &durations : phase_ms_) {
            durations.clear();
        }
        longest_stall_ms_ = 0;
        stalls_ = 0;
        max_queue_depth_ = 0;
        reports_start_ = reports_now_;
        late_start_ = late_now_;
        edges_start_ = edges_now_;
    }
};

}  // namespace native
