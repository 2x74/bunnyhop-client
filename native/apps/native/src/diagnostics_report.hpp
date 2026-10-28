#pragma once
#include "event_stamps.hpp"
#include "frame_diagnostics.hpp"
#include <nlohmann/json.hpp>
#include <cstddef>
#include <cstdio>

namespace native {

// The overlay's second line: frame time spread, stalls and the input queue. Formats into |out| without allocating.
inline void format_frame_line(const FrameDiagnostics::Sample &sample, char *out, size_t size) {
    using Phase = FrameDiagnostics::Phase;
    const auto &phases = sample.phases;
    std::snprintf(
            out,
            size,
            "Frame p99 %.1f max %.1f ms | stalls>50ms %u (max %.0f) | sim %.1f render %.1f swap %.1f gpu %.1f "
            "menu %.1f | keys %.0f/s | queue %zu | late %.1f%% | holdback %.2f ms",
            sample.frame.p99_ms,
            sample.frame.max_ms,
            sample.stalls,
            sample.longest_stall_ms,
            phases[Phase::kSimulation].p99_ms,
            phases[Phase::kRender].p99_ms,
            phases[Phase::kSwap].p99_ms,
            phases[Phase::kGpuWait].p99_ms,
            phases[Phase::kMenu].p99_ms,
            sample.key_edges_per_second,
            sample.max_queue_depth,
            sample.late_share * 100,
            sample.holdback_ms
    );
}

inline nlohmann::json spread_json(const FrameDiagnostics::Spread &spread) {
    return {{"p50Ms", spread.p50_ms}, {"p99Ms", spread.p99_ms}, {"maxMs", spread.max_ms}};
}

inline nlohmann::json stamp_source_json(const EventStamps::Source &source) {
    return {{"source", source.trusted ? "event" : "arrival"},
            {"reason", std::string(source.reason)},
            {"offClock", source.off_clock}};
}

// Frame and input diagnostics for the menu's diagnostics panel and feedback "Attach game info".
inline nlohmann::json diagnostics_json(const FrameDiagnostics &frames, const EventStamps &stamps, bool timed_input) {
    const auto &sample = frames.last();
    nlohmann::json phases = nlohmann::json::object();
    for (size_t phase = 0; phase < FrameDiagnostics::kPhaseCount; ++phase) {
        phases[FrameDiagnostics::kPhaseNames[phase]] = spread_json(sample.phases[phase]);
    }
    nlohmann::json frame = {
            {"seconds", sample.seconds},
            {"frames", sample.frames},
            {"frame", spread_json(sample.frame)},
            {"phases", phases},
            {"longestStallMs", sample.longest_stall_ms},
            {"stallsOver50Ms", sample.stalls},
            {"focusLosses", frames.focus_losses},
            {"relativeModeFailures", frames.relative_mode_failures},
    };
    nlohmann::json input = {
            {"timed", timed_input},
            {"keyEdgesPerSecond", sample.key_edges_per_second},
            {"maxQueueDepth", sample.max_queue_depth},
            {"lateShare", sample.late_share},
            {"holdbackMs", sample.holdback_ms},
            {"timestampsGivenUp", sample.stamps_unreliable},
            {"motionStamps", stamp_source_json(stamps.source(EventStamps::kMotion))},
            {"keyStamps", stamp_source_json(stamps.source(EventStamps::kKeys))},
    };
    return {{"frame", frame}, {"input", input}};
}

}  // namespace native
