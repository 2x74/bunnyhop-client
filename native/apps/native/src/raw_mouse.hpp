#pragma once
#include <array>
#include <algorithm>
#include <atomic>
#include <cstdint>
#include <cstddef>

namespace native {

enum class RawMouseStatus { idle, starting, ready, permission, unavailable, overflow };

struct RawMouseReport {
    uint64_t timestamp = 0;
    uint64_t epoch = 0;
    double x = 0;
    double y = 0;
};

// One producer (the platform worker), one consumer (the SDL event pump). Never overwrite unread motion: an
// overrun disables the backend until it is selected again, and the next pump returns to SDL.
class RawMousePipe {
public:
    static constexpr size_t capacity = 8192;
    std::atomic<bool> stop{false};
    std::atomic<bool> requested{false};
    std::atomic<uint64_t> selection{0};
    std::atomic<RawMouseStatus> status{RawMouseStatus::idle};
    std::atomic<uint64_t> dropped{0};

    void select(bool raw) {
        if (requested.exchange(raw, std::memory_order_acq_rel) != raw) {
            selection.fetch_add(1, std::memory_order_release);
        }
    }

    bool selected(uint64_t generation) const {
        return requested.load(std::memory_order_acquire) && selection.load(std::memory_order_acquire) == generation;
    }

    uint64_t capture_epoch() const { return epoch_.load(std::memory_order_acquire); }

    void capture(bool enabled, uint64_t since = 0) {
        const uint64_t previous = capture_epoch();
        if (bool(previous & 1) != enabled) {
            since_.store(since, std::memory_order_relaxed);
            epoch_.store(previous + 1, std::memory_order_release);
        }
    }

    bool publish(uint64_t timestamp, double x, double y, uint64_t epoch) {
        if (!(epoch & 1) || epoch != capture_epoch() || timestamp < since_.load(std::memory_order_relaxed)
            || (x == 0 && y == 0)) {
            return true;
        }
        const size_t written = written_.load(std::memory_order_relaxed);
        const size_t read = read_.load(std::memory_order_acquire);
        if (written - read == capacity) {
            dropped.fetch_add(1, std::memory_order_relaxed);
            status.store(RawMouseStatus::overflow, std::memory_order_release);
            return false;
        }
        reports_[written % capacity] = {timestamp, epoch, x, y};
        written_.store(written + 1, std::memory_order_release);
        return true;
    }

    bool pop(RawMouseReport &report) {
        const size_t read = read_.load(std::memory_order_relaxed);
        if (read == written_.load(std::memory_order_acquire)) {
            return false;
        }
        report = reports_[read % capacity];
        read_.store(read + 1, std::memory_order_release);
        return true;
    }

    size_t pending() const { return written_.load(std::memory_order_acquire) - read_.load(std::memory_order_relaxed); }

    void discard() { read_.store(written_.load(std::memory_order_acquire), std::memory_order_release); }

private:
    std::array<RawMouseReport, capacity> reports_{};
    std::atomic<size_t> written_{0};
    std::atomic<size_t> read_{0};
    std::atomic<uint64_t> epoch_{0};
    std::atomic<uint64_t> since_{0};
};

// Device readers can drain one mouse before another. Sort a bounded snapshot by event time, preserving the
// producer's order for ties. Reports arriving during a pump wait for the next one instead of extending the frame.
class RawMouseBatch {
public:
    void load(RawMousePipe &pipe) {
        count_ = 0;
        next_ = 0;
        const size_t available = std::min(pipe.pending(), RawMousePipe::capacity);
        for (size_t index = 0; index < available; ++index) {
            RawMouseReport report;
            if (!pipe.pop(report)) break;
            reports_[count_++] = {report, index};
        }
        std::sort(reports_.begin(), reports_.begin() + count_, before);
    }

    bool pop(RawMouseReport &report) {
        if (next_ == count_) return false;
        report = reports_[next_++].report;
        return true;
    }

    void clear() { count_ = next_ = 0; }

private:
    struct Ordered {
        RawMouseReport report;
        size_t order = 0;
    };

    std::array<Ordered, RawMousePipe::capacity> reports_{};
    size_t count_ = 0;
    size_t next_ = 0;

    static bool before(const Ordered &left, const Ordered &right) {
        if (left.report.timestamp != right.report.timestamp) return left.report.timestamp < right.report.timestamp;
        return left.order < right.order;
    }
};

// The two clocks are sampled together on the worker. Keep integer nanoseconds, including for clocks that began
// before SDL. No arrival-time calibration is applied to individual reports.
struct InputClockBridge {
    uint64_t source = 0;
    uint64_t target = 0;

    uint64_t map(uint64_t timestamp) const {
        if (timestamp >= source) {
            const uint64_t delta = timestamp - source;
            return delta > UINT64_MAX - target ? UINT64_MAX : target + delta;
        }
        const uint64_t delta = source - timestamp;
        return delta > target ? 0 : target - delta;
    }
};

struct InputClockSample {
    static constexpr unsigned attempts = 3;
    static constexpr uint64_t maximum_span_ns = 50'000;
    InputClockBridge bridge;
    uint64_t span = UINT64_MAX;

    void consider(uint64_t before, uint64_t target, uint64_t after) {
        if (after < before || after - before >= span) return;
        span = after - before;
        bridge = {before + span / 2, target};
    }

    bool valid() const { return span <= maximum_span_ns; }
};

// IOHID delivers axis values separately. Keep values with the same device timestamp together, including
// opposing Y counts in successive reports: combining those reports would change pitch at its clamp.
struct RawMouseAccumulator {
    RawMouseReport pending;

    void flush(RawMousePipe &pipe) {
        pipe.publish(pending.timestamp, pending.x, pending.y, pending.epoch);
        pending = {};
    }

    void value(RawMousePipe &pipe, uint64_t timestamp, double x, double y) {
        const uint64_t epoch = pipe.capture_epoch();
        if (pending.timestamp != timestamp || pending.epoch != epoch) {
            flush(pipe);
            pending.timestamp = timestamp;
            pending.epoch = epoch;
        }
        pending.x += x;
        pending.y += y;
    }
};

void run_raw_mouse(RawMousePipe &pipe) noexcept;

}  // namespace native
