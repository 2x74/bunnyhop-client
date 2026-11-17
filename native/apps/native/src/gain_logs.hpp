#pragma once
// Gain logs (the website's ssj/logs.ts GainLogTracker): every 6th jump, the gain, strafes and sync over the six jumps'
// air ticks, as CS:S strafers know them from their servers' logs. A jump with any air tick turned by a turn bind is
// left out of its window; a window needs LOG_MIN_JUMPS clean jumps and more than LOG_AIR_TICKS_PER_JUMP air ticks per
// counted jump. The game only counts; the menu (ui/gain-logs-native.ts) formats the line, shows it and sends it to a
// room, with the website's own code.
#include "ssj.hpp"
#include <nlohmann/json.hpp>
#include <array>
#include <cmath>
#include <optional>
#include <string>
#include <string_view>

namespace native {

// net/protocol.ts LOG_MIN_JUMPS / LOG_AIR_TICKS_PER_JUMP and ssj/logs.ts LOG_JUMPS.
inline constexpr unsigned gain_log_jumps = 6;
inline constexpr unsigned gain_log_min_jumps = 4;
inline constexpr unsigned gain_log_air_ticks_per_jump = 50;

// net/protocol.ts GainLogReport: gain and sync in percent, strafes and ticks summed over the counted jumps.
struct GainLogReport {
    unsigned jump = 0;
    unsigned jumps = 0;
    double gain = 0;
    double sync = 0;
    unsigned strafes = 0;
    unsigned ticks = 0;
};

class GainLogTracker {
public:
    void reset() {
        tracker_.reset();
        count_ = 0;
    }

    // Fed like the other SSJ trackers: the state before the tick and the command stepped.
    std::optional<GainLogReport> tick(const SsjState &pre, const SsjCmd &cmd, const SsjTick &t) {
        const unsigned before = tracker_.jump;
        tracker_.tick(pre, cmd, t);
        const unsigned jump = tracker_.jump;
        // Standing still started the count over.
        if (jump < before || jump == 0) count_ = 0;
        if (jump == before || !tracker_.last_window) return std::nullopt;
        if (count_ < windows_.size()) windows_[count_++] = *tracker_.last_window;
        if (jump % gain_log_jumps) return std::nullopt;
        const auto report = close(jump);
        count_ = 0;
        return report;
    }

private:
    // The window's report from its clean jumps (no turn-bind tick), summed in double as the website's reduce does.
    std::optional<GainLogReport> close(unsigned jump) const {
        unsigned clean = 0, ticks = 0, synced = 0, strafes = 0;
        double raw_gain = 0;
        for (size_t i = 0; i < count_; ++i) {
            const auto &window = windows_[i];
            if (window.binds) continue;
            ++clean;
            ticks += window.ticks;
            raw_gain += double(window.raw_gain);
            synced += window.synced;
            strafes += window.strafes;
        }
        if (clean < gain_log_min_jumps || ticks <= clean * gain_log_air_ticks_per_jump) return std::nullopt;
        constexpr double hundredths = 10000, percent = 100;
        GainLogReport report;
        report.jump = jump;
        report.jumps = clean;
        report.gain = std::floor(raw_gain / ticks * hundredths + .5) / percent;
        report.sync = percent * synced / ticks;
        report.strafes = strafes;
        report.ticks = ticks;
        return report;
    }

    SsjTracker tracker_{SsjMode::every};
    std::array<SsjWindow, gain_log_jumps> windows_{};
    size_t count_ = 0;
};

// The menu call for one window (window.bunnyhopNativeMenu.onGainLog): the report, the run's style and whether the
// attempt is practice, which decide whether the room gets it.
inline std::string gain_log_script(const GainLogReport &report, std::string_view style, bool practice) {
    const nlohmann::json value = {
            {"jump", report.jump},
            {"jumps", report.jumps},
            {"gain", report.gain},
            {"sync", report.sync},
            {"strafes", report.strafes},
            {"ticks", report.ticks},
            {"style", style},
            {"practice", practice},
    };
    return "window.bunnyhopNativeMenu?.onGainLog?.(" + value.dump() + ")";
}

}  // namespace native
