#pragma once
// Long runs. The server ranks a recording of up to bh_record_ranked_commands() commands (8 hours at 100 tick). Past
// that the run carries on and is saved to the replays, but isn't uploaded. At the core's 24-hour cap the recording
// stops; what was recorded is saved and the player is told. A recording that stops early for a failure is said when
// it happens, not only at the finish.
#include "bunnyhop_native.h"
#include <nlohmann/json.hpp>
#include <cstdint>
#include <stdexcept>
#include <string>

namespace native {

inline constexpr const char *past_ranked_length_notice =
        "Past 8 hours: this run will be saved to your replays but can't go on the leaderboard.";
inline constexpr const char *capped_recording_notice =
        "Recording stopped at 24 hours. What was recorded is saved to your replays.";
inline constexpr unsigned run_length_notice_ms = 8000;

class RunLength {
public:
    enum class Stop { none, capped, failed };

    struct Observation {
        // The recording just passed the ranked length: show past_ranked_length_notice.
        bool passed_ranked = false;
        // The recording ended before the run finished, and whether that matters to the player.
        bool ended_unfinished = false;
    };

    explicit RunLength(uint64_t ranked_commands) : ranked_commands_(ranked_commands) {}

    // Once a frame with the run state of a real attempt (not the replay viewer).
    Observation observe(const BhRunState &run) {
        Observation observed;
        // A new recording counts from zero again.
        if (run.total_commands < last_total_) notified_ = false;
        last_total_ = run.total_commands;
        const bool recording = run.recording != 0;
        if (recording && run.recording_valid && too_long(run) && !notified_) {
            notified_ = true;
            observed.passed_ranked = true;
        }
        observed.ended_unfinished = was_recording_ && !recording && run.status != 2;
        was_recording_ = recording;
        return observed;
    }

    bool too_long(const BhRunState &run) const { return run.total_commands > ranked_commands_; }

    // Why a recording ended unfinished, from its summary (bh_record_summary_json). Ordinary endings (a restart, a
    // practice tool, a map change) are Stop::none.
    static Stop stop_reason(const nlohmann::json &summary, std::string &reason) {
        reason = summary.is_object() ? summary.value("reason", std::string()) : std::string();
        if (reason == "command_limit") return Stop::capped;
        if (reason == "write_error" || reason == "simulation_error") return Stop::failed;
        return Stop::none;
    }

    static std::string failure_notice(const std::string &reason) {
        const char *cause = reason == "write_error" ? "the replay file couldn't be written" : "the simulation failed";
        return std::string("Recording stopped: ") + cause + ". This run can't be submitted.";
    }

    // The vault summary of a recording stopped at the cap: what was played, never a ranked run or a finish time.
    static nlohmann::json capped_summary(nlohmann::json summary, const BhRunState &run, double tick_seconds) {
        const double played_seconds = double(run.total_commands) * tick_seconds;
        summary["time"] = run.status == 1 && run.seconds > 0 ? run.seconds : played_seconds;
        summary["jumps"] = run.jumps;
        summary["strafes"] = run.strafes;
        summary["sync"] = run.sync_percent;
        summary["eligible"] = false;
        summary["unfinished"] = true;
        return summary;
    }

    // The core's summary of the recording that ended last.
    static nlohmann::json last_summary(BhContext *core) {
        size_t bytes = 0;
        const auto *raw = bh_record_summary_json(core, &bytes);
        if (!raw || !bytes) return nullptr;
        return nlohmann::json::parse(raw, raw + bytes, nullptr, false);
    }

    // Writes the recording stopped at the cap to `path`. Throws with the core's error.
    static void write_capped(BhContext *core, const std::string &path) {
        if (!bh_record_write_capped_bhr(core, path.c_str())) {
            const char *error = bh_last_error(core);
            throw std::runtime_error(std::string("Saving the recording: ") + (error && *error ? error : "failed"));
        }
    }

private:
    uint64_t ranked_commands_;
    uint64_t last_total_ = 0;
    bool notified_ = false;
    bool was_recording_ = false;
};

}  // namespace native
