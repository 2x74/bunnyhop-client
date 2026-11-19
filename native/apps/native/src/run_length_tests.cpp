#include "run_length.hpp"
#include "run_vault.hpp"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>

namespace {

BhRunState recording(uint64_t commands, uint32_t status = 1) {
    BhRunState run{};
    run.status = status;
    run.recording = 1;
    run.recording_valid = 1;
    run.total_commands = commands;
    return run;
}

void ranked_length_notice_shows_once_per_recording() {
    native::RunLength length(100);
    assert(!length.observe(recording(100)).passed_ranked);
    assert(!length.too_long(recording(100)));
    assert(length.observe(recording(101)).passed_ranked);
    assert(length.too_long(recording(101)));
    assert(!length.observe(recording(102)).passed_ranked);
    // A restart begins a new recording: past the limit again, it says so again.
    assert(!length.observe(recording(5)).passed_ranked);
    assert(length.observe(recording(150)).passed_ranked);
}

void recording_that_ends_unfinished_is_noticed() {
    native::RunLength length(100);
    length.observe(recording(40));
    auto stopped = recording(50);
    stopped.recording = stopped.recording_valid = 0;
    assert(length.observe(stopped).ended_unfinished);
    assert(!length.observe(stopped).ended_unfinished);
    length.observe(recording(1));
    assert(!length.observe(recording(80, 2)).ended_unfinished);
    auto finished = recording(80, 2);
    finished.recording = 0;
    assert(!length.observe(finished).ended_unfinished);
}

void stop_reasons() {
    std::string reason;
    using Stop = native::RunLength::Stop;
    assert(native::RunLength::stop_reason({{"reason", "command_limit"}}, reason) == Stop::capped);
    assert(native::RunLength::stop_reason({{"reason", "write_error"}}, reason) == Stop::failed);
    assert(native::RunLength::failure_notice(reason).find("couldn't be written") != std::string::npos);
    assert(native::RunLength::stop_reason({{"reason", "simulation_error"}}, reason) == Stop::failed);
    for (const char *ordinary : {"reset", "practice_restore", "replay_loaded", "identity_changed"})
        assert(native::RunLength::stop_reason({{"reason", ordinary}}, reason) == Stop::none);
    assert(native::RunLength::stop_reason(nullptr, reason) == Stop::none);
}

// The vault keeps the flags, still reads a summary without them as before, and a capped run is never a local PB.
void vault_summaries_mark_long_and_unfinished_runs() {
    const nlohmann::json base = {
            {"map", "bhop_long"},
            {"style", "autohop"},
            {"track", 0},
            {"time", 30000.5},
            {"jumps", 12},
            {"strafes", 30},
            {"sync", 80.5},
            {"finishedAt", 1.7e12},
            {"eligible", true}
    };
    const auto plain = native::RunVault::sanitize(base);
    assert(!plain.contains("rankedTooLong") && !plain.contains("unfinished") && plain["eligible"] == true);
    auto too_long = base;
    too_long["eligible"] = false;
    too_long["rankedTooLong"] = true;
    assert(native::RunVault::sanitize(too_long)["rankedTooLong"] == true);
    auto run = recording(8'640'000);
    run.seconds = 86'000;
    const auto capped = native::RunVault::sanitize(native::RunLength::capped_summary(base, run, .01));
    assert(capped["unfinished"] == true && capped["eligible"] == false && capped["time"] == 86'000);
    // Past a day of play the summary still reads.
    auto day_and_more = base;
    day_and_more["time"] = 120'000;
    assert(native::RunVault::sanitize(day_and_more).is_object());
}

}  // namespace

int main() {
    ranked_length_notice_shows_once_per_recording();
    recording_that_ends_unfinished_is_noticed();
    stop_reasons();
    vault_summaries_mark_long_and_unfinished_runs();
}
