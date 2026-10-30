#include "data_location.hpp"
#pragma once
#include "bunnyhop_native.h"
#include "replay_range.hpp"
#include "run_timing.hpp"
#include <filesystem>

namespace native {

struct ReplayPose {
    BhSnapshot snapshot{};
    BhCmd view{};
};

struct ReplaySession {
    nlohmann::json info;
    ReplayRange range;
    std::string style;
    BhSettings settings{};
    ReplayPose initial;

    static ReplaySession open(BhContext *core, const std::filesystem::path &path, bool full_recording = false) {
        if (!bh_replay_load(core, native::data_location::utf8(path).c_str())) {
            throw std::runtime_error(bh_last_error(core));
        }
        size_t bytes = 0;
        const char *raw = bh_replay_info(core, &bytes);
        if (!raw) {
            throw std::runtime_error(bh_last_error(core));
        }
        ReplaySession session;
        session.info = nlohmann::json::parse(raw, raw + bytes);
        session.range = ReplayRange::make(session.info, full_recording);
        session.style = session.info.at("style");
        const auto &settings = session.info.at("settings");
        session.settings.max_speed = settings.at("maxSpeed");
        session.settings.air_accelerate = settings.at("airAccelerate");
        session.initial = session.seek(core, session.range.from);
        return session;
    }

    ReplayPose seek(BhContext *core, uint32_t tick) const {
        ReplayPose pose;
        if (!bh_replay_seek(core, range.clamp(tick), &pose.snapshot) || !bh_last_command(core, &pose.view)) {
            throw std::runtime_error(bh_last_error(core));
        }
        return pose;
    }

    void set_full_recording(bool full) { range = ReplayRange::make(info, full); }

    nlohmann::json
    state(bool active,
          const std::string &id,
          uint32_t tick,
          bool paused,
          double speed,
          const std::string &camera,
          double run_seconds,
          double fallback_interval) const {
        return {
                {"tickInterval", active ? range.tick_interval : fallback_interval},
                {"active", active},
                {"id", id},
                {"tick", tick},
                {"totalTicks", active ? range.total : 0u},
                {"paused", paused},
                {"speed", speed},
                {"camera", camera},
                {"seconds", run_seconds},
                {"timeMs", score_ms(run_seconds)},
                {"rangeStartTick", active ? range.from : 0u},
                {"rangeEndTick", active ? range.to : 0u},
                {"rangeTick", active ? range.relative(tick) : 0u},
                {"rangeTotalTicks", active ? range.ticks() : 0u},
                {"elapsedSeconds", active ? range.relative(tick) * range.tick_interval : 0},
                {"fullRecording", range.full_recording},
        };
    }
};

}  // namespace native
