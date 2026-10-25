#pragma once
// Presentation-only playback on the backdrop's private, map-loaded context.
// Native replay step/seek owns all simulation and historical replay math.
#include "bunnyhop_native.h"
#include "nlohmann/json.hpp"
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <stdexcept>
#include <string>

namespace native::backdrop {
class PbPlayback {
public:
    void load(BhContext *context, const std::string &path) {
        core = context;
        require(bh_replay_load(core, path.c_str()));
        size_t bytes = 0;
        const char *raw = bh_replay_info(core, &bytes);
        if (!raw || !bytes) throw std::runtime_error("Missing backdrop replay info");
        const auto info = nlohmann::json::parse(raw, raw + bytes);
        const auto ticks = info.at("totalTicks").get<uint64_t>();
        const auto start = info.at("startTick").get<uint64_t>(), end = info.at("endTick").get<uint64_t>();
        interval = info.at("settings").at("tickInterval").get<double>();
        if (!ticks || ticks > 2000000 || end <= start || end > ticks || !std::isfinite(interval) || interval <= 0 || interval > 1)
            throw std::runtime_error("Backdrop replay must be a bounded completed run");
        total = uint32_t(ticks);
        seek(0);
    }
    // Caller resets renderer presentation history after every successful seek,
    // including initialization and loops. No stale previous snapshot survives.
    void seek(uint32_t tick) {
        if (tick > total) throw std::runtime_error("Backdrop seek outside replay");
        BhSnapshot next{};
        require(bh_replay_seek(core, tick, &next));
        BhCmd command{};
        require(bh_last_command(core, &command));
        snapshot_ = next; command_ = command; accumulator = 0;
        seconds_ = double(tick) * interval;
        ++generation_;
    }
    void advance(double dt) {
        accumulator += std::isfinite(dt) ? std::clamp(dt, 0.0, .1) : 0;
        // Untrusted old recordings can specify very small tick intervals. Bound
        // work per rendered frame and drop excess wall time, never skip commands.
        unsigned steps = 0;
        while (accumulator >= interval && steps++ < 128) {
            if (snapshot_.player.tick >= total) {
                const double remaining = accumulator;
                seek(0);
                accumulator = remaining;
            }
            require(bh_replay_step(core, &snapshot_));
            require(bh_last_command(core, &command_));
            accumulator -= interval;
            seconds_ = double(snapshot_.player.tick) * interval;
        }
        if (accumulator >= interval) accumulator = std::fmod(accumulator, interval);
    }
    const BhSnapshot &snapshot() const { return snapshot_; }
    const BhCmd &command() const { return command_; }
    uint32_t total_ticks() const { return total; }
    uint64_t generation() const { return generation_; }
    double seconds() const { return seconds_; }

private:
    void require(int result) const {
        if (!result) throw std::runtime_error(std::string("Backdrop replay: ") + bh_last_error(core));
    }
    BhContext *core = nullptr;
    BhSnapshot snapshot_{};
    BhCmd command_{};
    uint32_t total = 0;
    uint64_t generation_ = 0;
    double interval = 0, accumulator = 0, seconds_ = 0;
};
}
