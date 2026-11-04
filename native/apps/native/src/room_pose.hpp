#pragma once
#include "bunnyhop_native.h"
#include "hud_text.hpp"
#include <algorithm>
#include <array>
#include <charconv>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <span>
#include <string>
#include <string_view>

namespace native {

// Sample flags the room relays (protocol.ts SF_*). Jump, teleport and attack bits come from RoomBridge::room_events.
constexpr unsigned room_flag_grounded = 1;
constexpr unsigned room_flag_crouched = 2;

struct RoomPoseSample {
    uint32_t tick = 0;
    std::array<float, 3> position{};
    std::array<float, 3> velocity{};
    float yaw = 0;
    float pitch = 0;
    unsigned flags = 0;
};

// Paces what the room hears about your movement by simulated ticks, as the website does (net/mp.ts afterTick): one
// sample every sample_ticks and one batch every send_ticks. A timer in the hidden menu page can't do this, because the
// browser engine throttles hidden pages to about one timer a second.
class RoomPoseBatcher {
public:
    static constexpr uint32_t sample_ticks = 4;  // protocol.ts SAMPLE_TICKS
    static constexpr uint32_t send_ticks = 20;   // protocol.ts SEND_TICKS
    static constexpr size_t max_samples = 8;     // protocol.ts MAX_SAMPLES

    // Counts one simulated tick and says whether it takes a sample. The count never resets: sample ticks stay
    // monotonic across restarts, map changes and spectating, and stop while the game isn't stepping, like web's.
    bool advance(bool sending) {
        ++net_tick_;
        if (!sending) count_ = 0;
        return sending && net_tick_ % sample_ticks == 0;
    }

    void add(RoomPoseSample sample) {
        sample.tick = net_tick_;
        if (count_ == max_samples) {
            std::shift_left(samples_.begin(), samples_.end(), 1);
            --count_;
        }
        samples_[count_++] = sample;
    }

    bool batch_due() const { return count_ > 0 && net_tick_ % send_ticks == 0; }

    std::span<const RoomPoseSample> samples() const { return {samples_.data(), count_}; }

    void clear() { count_ = 0; }

private:
    uint32_t net_tick_ = 0;
    std::array<RoomPoseSample, max_samples> samples_{};
    size_t count_ = 0;
};

// The run as the room shows it to others (protocol.ts NetMeta without the ping).
struct RoomPoseMeta {
    std::string_view style;
    unsigned track = 0;
    unsigned timer = 0;
    uint32_t timer_ticks = 0;
    unsigned weapon = 0;
    bool silenced = false;
};

// protocol.ts TIMER_IDLE / TIMER_START / TIMER_RUNNING / TIMER_FINISHED from the core's run state.
inline RoomPoseMeta room_pose_meta(const BhRunState &run, uint32_t current_tick, std::string_view style) {
    constexpr uint32_t running = 1, finished = 2;
    constexpr unsigned timer_idle = 0, timer_start = 1, timer_running = 2, timer_finished = 3;
    RoomPoseMeta meta;
    meta.style = style;
    meta.track = run.track;
    meta.timer = run.status == finished  ? timer_finished
                 : run.status == running ? timer_running
                 : run.in_start          ? timer_start
                                         : timer_idle;
    if (run.status == running || run.status == finished)
        meta.timer_ticks = (run.status == finished ? run.end_tick : current_tick) - run.start_tick;
    return meta;
}

// Batches due during one frame's ticks, kept until the frame is done simulating. A hitch that catches up more
// than max_batches batches in one frame drops the oldest: the room only shows the newest pose anyway.
class RoomPoseOutbox {
public:
    static constexpr size_t max_batches = 8;

    struct Batch {
        uint64_t generation = 0;
        std::array<RoomPoseSample, RoomPoseBatcher::max_samples> samples{};
        size_t count = 0;
        RoomPoseMeta meta;
        HudLabel<48> style;

        std::span<const RoomPoseSample> taken() const { return {samples.data(), count}; }
    };

    void add(uint64_t generation, std::span<const RoomPoseSample> samples, const RoomPoseMeta &meta) {
        if (count_ == max_batches) {
            std::shift_left(batches_.begin(), batches_.end(), 1);
            --count_;
        }
        auto &batch = batches_[count_++];
        batch.generation = generation;
        batch.count = std::min(samples.size(), batch.samples.size());
        std::copy_n(samples.begin(), batch.count, batch.samples.begin());
        batch.meta = meta;
        batch.style.assign(meta.style);
        batch.meta.style = {};
    }

    std::span<const Batch> batches() const { return {batches_.data(), count_}; }

    void clear() { count_ = 0; }

private:
    std::array<Batch, max_batches> batches_{};
    size_t count_ = 0;
};

// The script that hands one batch to ui/room-service.ts pose(). It is written into one buffer that is kept between
// batches, so sending a batch allocates nothing once the buffer has grown to fit.
class RoomPoseScript {
public:
    RoomPoseScript() { text_.reserve(reserved_bytes); }

    const std::string &
    write(uint64_t generation, std::string_view room_id, std::string_view map, const RoomPoseOutbox::Batch &batch) {
        text_.clear();
        text_ += "window.bunnyhopNativeMenu?.onRoomPose?.({\"generation\":";
        add_unsigned(generation);
        text_ += ",\"id\":";
        add_string(room_id);
        text_ += ",\"map\":";
        add_string(map);
        text_ += ",\"samples\":[";
        for (size_t i = 0; i < batch.count; ++i) {
            if (i) text_ += ',';
            add_sample(batch.samples[i]);
        }
        text_ += "],\"meta\":{\"style\":";
        add_string(batch.style.view());
        text_ += ",\"track\":";
        add_unsigned(batch.meta.track);
        text_ += ",\"timer\":";
        add_unsigned(batch.meta.timer);
        text_ += ",\"timerTicks\":";
        add_unsigned(batch.meta.timer_ticks);
        text_ += "},\"weapon\":";
        add_unsigned(batch.meta.weapon);
        text_ += ",\"silenced\":";
        text_ += batch.meta.silenced ? "true" : "false";
        text_ += "})";
        return text_;
    }

private:
    // Eight samples of ten fields at their longest, with room for the ids and the meta.
    static constexpr size_t reserved_bytes = 4096;
    std::string text_;

    void add_sample(const RoomPoseSample &sample) {
        text_ += "{\"tick\":";
        add_unsigned(sample.tick);
        constexpr std::array<const char *, 3> position_keys = {",\"x\":", ",\"y\":", ",\"z\":"};
        constexpr std::array<const char *, 3> velocity_keys = {",\"vx\":", ",\"vy\":", ",\"vz\":"};
        for (size_t axis = 0; axis < 3; ++axis) {
            text_ += position_keys[axis];
            add_number(sample.position[axis]);
        }
        for (size_t axis = 0; axis < 3; ++axis) {
            text_ += velocity_keys[axis];
            add_number(sample.velocity[axis]);
        }
        text_ += ",\"yaw\":";
        add_number(sample.yaw);
        text_ += ",\"pitch\":";
        add_number(sample.pitch);
        text_ += ",\"flags\":";
        add_unsigned(sample.flags);
        text_ += '}';
    }

    void add_unsigned(uint64_t value) {
        std::array<char, 24> digits{};
        const auto end = std::to_chars(digits.data(), digits.data() + digits.size(), value).ptr;
        text_.append(digits.data(), end);
    }

    // As JSON has it: the float's exact value (17 digits round-trip a double), and null for NaN or infinity.
    void add_number(float value) {
        if (!std::isfinite(value)) {
            text_ += "null";
            return;
        }
        std::array<char, 32> digits{};
        const int length = std::snprintf(digits.data(), digits.size(), "%.17g", double(value));
        text_.append(digits.data(), size_t(length));
    }

    void add_string(std::string_view value) {
        constexpr char hex[] = "0123456789abcdef";
        text_ += '"';
        for (const char character : value) {
            const auto byte = static_cast<unsigned char>(character);
            if (character == '"' || character == '\\') {
                text_ += '\\';
                text_ += character;
            } else if (byte < 0x20) {
                text_ += "\\u00";
                text_ += hex[byte >> 4];
                text_ += hex[byte & 15];
            } else {
                text_ += character;
            }
        }
        text_ += '"';
    }
};

}  // namespace native
