#pragma once
#include "bunnyhop_native.h"
#include "recording_input.hpp"
#include "run_diagnostics.hpp"
#include <nlohmann/json.hpp>
#include <chrono>
#include <filesystem>
#include <optional>
#include <string>
#include <utility>

namespace native {

struct RunHeartbeat {
    static constexpr uint32_t initial_hash = 0x811c9dc5;
    enum class Reset { range, start, generation };

    uint64_t generation = 0;
    uint32_t start = 0, upto = 0, hash = initial_hash;
    bool paused = false;
    std::chrono::steady_clock::time_point time = std::chrono::steady_clock::now();

    nlohmann::json invalidate(Reset reset = Reset::range);
    void restart();
    void begin(uint32_t tick);
    nlohmann::json fold(BhContext *core, const BhRunState &run);
    void sent(std::chrono::steady_clock::time_point now);
};

struct RunRecorder {
    RecordingInput input;
    RunDiagnostics diagnostics;
    bool ended = false;
    std::string path;
    std::optional<std::pair<std::string, std::string>> pending_capture;

    void clear(bool recording_ended);
    void
    begin(BhContext *core,
          const std::filesystem::path &cache,
          const std::string &map,
          const std::string &build,
          const std::string &style,
          const std::string &player,
          TurnSettings turns,
          const std::string &loadout);
    void write(BhContext *core);
    nlohmann::json finish_event(
            uint32_t track,
            double seconds,
            const std::string &bytes,
            const nlohmann::json &play = nlohmann::json::object(),
            const nlohmann::json &mouse = nlohmann::json::object()
    ) const;
};

}  // namespace native
