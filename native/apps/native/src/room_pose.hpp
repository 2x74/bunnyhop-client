#pragma once
#include "bunnyhop_native.h"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <array>
#include <cstdint>
#include <span>
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

// The message ui/room-service.ts pose() accepts: one batch, sent to the room as it arrives.
inline nlohmann::json room_pose_message(
        uint64_t generation,
        std::string_view room_id,
        std::string_view map,
        std::span<const RoomPoseSample> samples,
        const RoomPoseMeta &meta
) {
    auto list = nlohmann::json::array();
    for (const auto &sample : samples) {
        list.push_back(
                {{"tick", sample.tick},
                 {"x", sample.position[0]},
                 {"y", sample.position[1]},
                 {"z", sample.position[2]},
                 {"vx", sample.velocity[0]},
                 {"vy", sample.velocity[1]},
                 {"vz", sample.velocity[2]},
                 {"yaw", sample.yaw},
                 {"pitch", sample.pitch},
                 {"flags", sample.flags}}
        );
    }
    return {{"generation", generation},
            {"id", room_id},
            {"map", map},
            {"samples", std::move(list)},
            {"meta",
             {{"style", meta.style}, {"track", meta.track}, {"timer", meta.timer}, {"timerTicks", meta.timer_ticks}}},
            {"weapon", meta.weapon},
            {"silenced", meta.silenced}};
}

}  // namespace native
