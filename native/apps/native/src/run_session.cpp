#include "run_session.hpp"
#include "base64.hpp"
#include "data_location.hpp"
#include "run_timing.hpp"
#include <cstdio>
#include <stdexcept>

namespace native {
namespace {

void require(bool ok, BhContext *core, const char *operation) {
    if (!ok) {
        const char *error = bh_last_error(core);
        throw std::runtime_error(std::string(operation) + ": " + (error && *error ? error : "native core failed"));
    }
}

}  // namespace

nlohmann::json RunHeartbeat::invalidate(Reset reset) {
    ++generation;
    if (reset != Reset::generation) start = 0;
    if (reset == Reset::range) upto = 0;
    return {{"type", "reset"}};
}

void RunHeartbeat::restart() {
    hash = initial_hash;
    paused = false;
}

void RunHeartbeat::begin(uint32_t tick) {
    start = upto = tick;
    restart();
}

nlohmann::json RunHeartbeat::fold(BhContext *core, const BhRunState &run) {
    const auto length = uint32_t(run.total_commands);
    require(bh_record_fold(core, hash, upto, length, &hash), core, "Hashing native heartbeat");
    upto = length;
    char hex[9];
    std::snprintf(hex, sizeof(hex), "%08x", hash);
    return {{"type", "beat"}, {"track", run.track}, {"tick", length - start}, {"hash", hex}, {"paused", paused}};
}

void RunHeartbeat::sent(std::chrono::steady_clock::time_point now) {
    time = now;
    paused = false;
}

void RunRecorder::clear(bool recording_ended) {
    ended = recording_ended;
    path.clear();
    pending_capture.reset();
}

void RunRecorder::begin(
        BhContext *core,
        const std::filesystem::path &cache,
        const std::string &map,
        const std::string &build,
        const std::string &style,
        const std::string &player,
        TurnSettings turns,
        const std::string &loadout
) {
    const auto stamp =
            std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::system_clock::now().time_since_epoch())
                    .count();
    path = data_location::utf8(cache / "replays" / (map + "-" + std::to_string(stamp) + ".bhr"));
    require(bh_record_identity(core, build.c_str()), core, "Setting native release identity");
    require(bh_record_begin(core, "", style.c_str(), player.c_str(), 100), core, "Starting native recording");
    require(input.begin(core, turns), core, "Setting v29 recording input");
    bh_record_loadout(core, loadout.c_str());
}

void RunRecorder::write(BhContext *core) {
    require(bh_record_end(core), core, "Finishing native recording");
    require(bh_record_write_bhr(core, path.c_str()), core, "Writing native replay");
}

nlohmann::json RunRecorder::finish_event(uint32_t track, double seconds, const std::string &bytes) const {
    return {{"type", "finish"},
            {"track", track},
            {"timeMs", score_ms(seconds)},
            {"timingPolicy", timing_policy},
            {"replayBase64", base64(bytes)}};
}

}  // namespace native
