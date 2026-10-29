#pragma once
#include "timed_input.hpp"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <string>

namespace native {

class RunDiagnostics {
    static constexpr uint64_t second_ns = 1'000'000'000;
    static constexpr double millisecond_ns = 1'000'000;
    static constexpr size_t sample_capacity = 8192;
    static constexpr uint64_t poll_window_ns = second_ns / 2;
    static constexpr uint64_t maximum_report_gap_ns = 20'000'000;
    static constexpr uint64_t minimum_report_span_ns = 50'000'000;
    static constexpr std::array<unsigned, 7> poll_rates = {125, 250, 500, 1000, 2000, 4000, 8000};
    static constexpr double poll_tolerance = .15;
    static constexpr double input_number_limit = 1'000'000;
    static constexpr double fps_limit = 1000;

    struct Samples {
        std::array<float, sample_capacity> values{};
        size_t count = 0;
        double maximum = 0;

        void add(double value) {
            values[count++ % sample_capacity] = float(value);
            maximum = std::max(maximum, value);
        }

        double percentile(double fraction) const {
            auto sorted = values;
            const size_t length = std::min(count, sample_capacity);
            if (!length) return 0;
            const size_t index = std::min(length - 1, size_t(fraction * double(length)));
            std::nth_element(sorted.begin(), sorted.begin() + index, sorted.begin() + length);
            return sorted[index];
        }
    };

    bool running_ = false;
    uint64_t started_ = 0, last_frame_ = 0, stopped_ = 0;
    uint64_t frames_ = 0, events_ = 0, over25_ = 0, over50_ = 0;
    uint64_t previous_report_ = 0, poll_at_ = 0, poll_span_ = 0, poll_reports_ = 0;
    uint64_t reports_start_ = 0, late_start_ = 0, reports_ = 0, late_ = 0;
    std::array<unsigned, poll_rates.size()> poll_bins_{};
    unsigned poll_samples_ = 0;
    double max_delta_ = 0, holdback_ms_ = 0;
    bool timed_ = false, timed_off_ = false;
    std::string client_version_;
    Samples frame_ms_, age_ms_;

    static double number(double value) {
        if (!std::isfinite(value)) return 0;
        return std::round(std::clamp(value, -input_number_limit, input_number_limit) * 100) / 100;
    }

    void sample_poll(uint64_t now) {
        if (now < poll_at_ || now - poll_at_ < poll_window_ns) return;
        if (poll_span_ >= minimum_report_span_ns) {
            const double hz = double(poll_reports_) * second_ns / double(poll_span_);
            for (size_t index = 0; index < poll_rates.size(); ++index) {
                if (std::abs(hz - poll_rates[index]) <= poll_rates[index] * poll_tolerance) {
                    ++poll_bins_[index];
                    ++poll_samples_;
                    break;
                }
            }
        }
        poll_at_ = now;
        poll_span_ = poll_reports_ = 0;
    }

    unsigned poll_rate() const {
        constexpr unsigned minimum_samples = 3;
        constexpr double minimum_share = .1;
        for (size_t index = poll_rates.size(); index-- > 0;) {
            if (poll_bins_[index] >= minimum_samples && poll_bins_[index] >= poll_samples_ * minimum_share)
                return poll_rates[index];
        }
        return 0;
    }

public:
    // The release's version ("0.6.2"), shown on leaderboard hover cards. Development builds send none.
    void set_client_version(std::string version) {
        client_version_ = version == "local" ? std::string() : std::move(version);
    }

    void reset() { running_ = false; }

    void start(uint64_t now, const TimedInput &queue, bool timed) {
        auto version = std::move(client_version_);
        *this = RunDiagnostics{};
        client_version_ = std::move(version);
        running_ = true;
        started_ = last_frame_ = poll_at_ = now;
        reports_start_ = queue.reports;
        late_start_ = queue.late;
        timed_ = timed;
    }

    void motion(uint64_t timestamp, uint64_t received, double x, double y) {
        if (!running_) return;
        ++events_;
        max_delta_ = std::max(max_delta_, std::hypot(x, y));
        if (timestamp && received >= timestamp) age_ms_.add(double(received - timestamp) / millisecond_ns);
        if (timestamp > previous_report_ && previous_report_) {
            const uint64_t span = timestamp - previous_report_;
            if (span <= maximum_report_gap_ns) {
                poll_span_ += span;
                ++poll_reports_;
            }
        }
        if (timestamp) previous_report_ = timestamp;
    }

    void frame(uint64_t now, const TimedInput &queue) {
        if (!running_ || now < last_frame_) return;
        constexpr double slow_frame_ms = 25, stalled_frame_ms = 50;
        const double milliseconds = double(now - last_frame_) / millisecond_ns;
        frame_ms_.add(milliseconds);
        over25_ += milliseconds > slow_frame_ms;
        over50_ += milliseconds > stalled_frame_ms;
        ++frames_;
        last_frame_ = now;
        reports_ = queue.reports >= reports_start_ ? queue.reports - reports_start_ : 0;
        late_ = queue.late >= late_start_ ? queue.late - late_start_ : 0;
        holdback_ms_ = queue.holdback_ms;
        timed_off_ = queue.unreliable;
        sample_poll(now);
    }

    void stop(uint64_t now, const TimedInput &queue) {
        if (!running_) return;
        frame(now, queue);
        stopped_ = now;
        running_ = false;
    }

    nlohmann::json client_json() const {
        nlohmann::json client = {{"kind", "native"}};
        if (!client_version_.empty()) client["version"] = client_version_;
        return client;
    }

    nlohmann::json serialize(const nlohmann::json &play) const {
        const double seconds = stopped_ > started_ ? double(stopped_ - started_) / second_ns : 0;
        const double fps = seconds > 0 ? double(frames_) / seconds : 0;
        const double event_hz = seconds > 0 ? double(events_) / seconds : 0;
        nlohmann::json input = {
                {"source", "SDL"},
                {"filter", false},
                {"timed", timed_},
                {"timedOff", timed_off_},
                {"holdbackMs", number(holdback_ms_)},
                {"lateShare", number(reports_ ? double(late_) / double(reports_) : 0)},
                {"events", number(double(events_))},
                {"reports", number(double(events_))},
                {"eventHz", number(event_hz)},
                {"reportHz", number(event_hz)},
                {"fps", number(fps)},
                {"maxDelta", number(max_delta_)},
                {"frameP50", number(frame_ms_.percentile(.5))},
                {"frameP99", number(frame_ms_.percentile(.99))},
                {"frameMax", number(frame_ms_.maximum)},
                {"worstFrame", number(frame_ms_.maximum)},
                {"over25", number(double(over25_))},
                {"over50", number(double(over50_))},
                {"ageP50", number(age_ms_.percentile(.5))},
                {"ageMax", number(age_ms_.maximum)}
        };
        auto result = nlohmann::json{
                {"selfCheck", "error"},
                {"problems", {"Native client self-check is unavailable"}},
                {"client", client_json()},
                {"fps", number(std::min(fps, fps_limit))},
                {"input", std::move(input)},
                {"play", play}
        };
        if (const auto hz = poll_rate()) {
            result["play"]["pollHz"] = hz;
            result["input"]["pollHz"] = hz;
        }
        return result;
    }
};

}  // namespace native
