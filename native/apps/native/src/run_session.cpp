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
    diagnostics.reset();
    ended = recording_ended;
    path.clear();
    pending_capture.reset();
}

std::string RunRecorder::next_path() const {
    const auto stamp =
            std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::system_clock::now().time_since_epoch())
                    .count();
    return data_location::utf8(replays / (replay_map + "-" + std::to_string(stamp) + ".bhr"));
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
    replays = cache / "replays";
    replay_map = map;
    path = next_path();
    require(bh_record_identity(core, build.c_str()), core, "Setting native release identity");
    require(bh_record_begin(core, "", style.c_str(), player.c_str(), 100), core, "Starting native recording");
    require(input.begin(core, turns), core, "Setting v29 recording input");
    bh_record_loadout(core, loadout.c_str());
}

void RunRecorder::resume_segment(BhContext *core) {
    require(input.restore(core), core, "Restoring recording input");
    // A load can follow a finish whose replay is already written; the rewound run gets a file of its own.
    path = next_path();
    BhRunState run{};
    require(bh_run_state(core, &run), core, "Reading restored timer");
    ended = run.status == 2;
    pending_capture.reset();
    diagnostics.reset();
}

void RunRecorder::write(BhContext *core) {
    require(bh_record_end(core), core, "Finishing native recording");
    require(bh_record_write_bhr(core, path.c_str()), core, "Writing native replay");
}

nlohmann::json RunRecorder::finish_event(
        uint32_t track,
        double seconds,
        const std::string &bytes,
        const nlohmann::json &play,
        const nlohmann::json &mouse
) const {
    return {{"type", "finish"},
            {"track", track},
            {"timeMs", score_ms(seconds)},
            {"timingPolicy", timing_policy},
            {"diagnostics", diagnostics.serialize(play)},
            {"mouse", mouse},
            {"replayBase64", base64(bytes)}};
}

}  // namespace native
