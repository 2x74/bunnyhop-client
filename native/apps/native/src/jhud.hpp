#pragma once
// JHUD, the per-jump readout near the crosshair that bhop servers show with !jhud: "6: 612 (98%)" over "84.21 90.00%",
// the whole of it coloured for how the jump went. Display only, like !ssj (ssj.hpp). A port of
// apps/web/src/ssj/jhud.ts, checked against it by jhud_tests.cpp.
//
// The numbers are !ssj's for "every jump" (its SsjTracker in that mode, run separately, so the !ssj mode doesn't
// matter), with its 32-bit float steps, and this file adds:
//   JSS: how fast you turned, against the turn that gains the most at your speed. Per air tick, |yaw change| / atan(30
//   /
//     horizontal speed) (ticks without a turn count as 0), averaged over the jump's air ticks. 100% is the ideal turn;
//     over is too fast.
//   colours: the speed table for the first jumps (it asks "is this speed on pace for jump N?"), gain after that.
// One thing differs from "every jump" in !ssj: a map's teleport doesn't start the count over, as neither plugin's does.
// On a map that teleports between levels you'd lose a jump's gain each time, and jump 1 at 800 u/s means nothing.
#include "hud_text.hpp"
#include "semantic_palette.hpp"
#include "ssj.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <limits>
#include <optional>

namespace native {

/** What one jump shows. Jump 1 is only the speed, like both plugins. */
struct JhudReport {
    unsigned jump = 0;
    /** Horizontal speed at take-off, rounded down. */
    int speed = 0;
    std::optional<float> gain, sync;
    /** JSS as a ratio (1 = 100%). */
    std::optional<double> jss;
};

/** The five colours, worst to best (JumpStats' names for them). */
enum class JhudBand { really_bad, bad, meh, good, really_good };
inline constexpr size_t jhud_band_count = 5;

struct JhudPrefs {
    /** Sync after the gain (JumpStats' default; blankbhop/jhud has no sync). */
    bool sync = true;
    /** JSS in brackets after the speed. */
    bool jss = false;
    /** An arrow by the gain: down turning too fast, up too slow (blankbhop/jhud's Strafe Analyzer). */
    bool analyzer = false;
    /** Jumps up to this one take their colour from the speed table (at most 16); later ones from gain. */
    unsigned speed_colors = 6;
    /** Nothing shows after this jump; 0: no limit (JumpStats' cutoff). */
    unsigned cutoff = 0;
    /** JumpStats' defaults, in band order. The colours are the plugins' own. */
    std::array<SemanticColor, jhud_band_count> colors = {
            semantic_rgb(0xff0000),
            semantic_rgb(0xffa500),
            semantic_rgb(0x00ff00),
            semantic_rgb(0x00ffff),
            semantic_rgb(0xffffff)
    };

    bool operator==(const JhudPrefs &) const = default;
};

/** How long a jump stays up with no newer one (s): the plugins' hud text hold. */
inline constexpr double jhud_hold_seconds = 1;

/** Runs SsjTracker in "every jump" mode and adds JSS over the same ticks. */
class JhudTracker {
public:
    void reset() {
        ssj_.reset();
        yaw_ = std::numeric_limits<double>::quiet_NaN();
        jss_sum_ = 0;
        jss_ticks_ = 0;
    }

    /** One tick, as SsjTracker::tick (a teleport doesn't count: above). Returns the jump this tick took off for, if
     * any. */
    std::optional<JhudReport> tick(const SsjState &pre, const SsjCmd &cmd, SsjTick info) {
        info.teleported = false;
        const auto report = ssj_.tick(pre, cmd, info);
        double turn = double(cmd.yaw) - yaw_;
        yaw_ = cmd.yaw;
        if (turn > half_turn_degrees)
            turn -= full_turn_degrees;
        else if (turn < -half_turn_degrees)
            turn += full_turn_degrees;
        if (ssj_.sampled) {
            ++jss_ticks_;
            add_turn(turn, pre);
        }
        if (!report) {
            if (ssj_.jump == 0) clear_jss();
            return std::nullopt;
        }
        JhudReport result;
        result.jump = report->jump;
        result.speed = report->speed;
        result.gain = report->gain;
        result.sync = report->sync;
        if (report->jump > 1 && jss_ticks_) result.jss = jss_sum_ / double(jss_ticks_);
        clear_jss();
        return result;
    }

private:
    static constexpr double half_turn_degrees = 180;
    static constexpr double full_turn_degrees = 360;
    static constexpr double degrees_per_radian = 180 / ssj_detail::pi;

    void add_turn(double turn, const SsjState &pre) {
        if (turn == 0 || std::isnan(turn)) return;
        const double speed = std::hypot(double(pre.velocity[0]), double(pre.velocity[1]));
        const double ideal = std::atan(double(air_wish_cap) / speed) * degrees_per_radian;
        const double ratio = std::abs(turn) / ideal;
        if (!std::isnan(ratio)) jss_sum_ += ratio;
    }

    void clear_jss() {
        jss_sum_ = 0;
        jss_ticks_ = 0;
    }

    SsjTracker ssj_{SsjMode::every};
    double yaw_ = std::numeric_limits<double>::quiet_NaN();
    double jss_sum_ = 0;
    unsigned jss_ticks_ = 0;
};

/** Speeds for jumps 1-16: under the first is the worst colour, from the last up the best (JumpStats'
 * g_iJhudSpeedValues). */
inline constexpr std::array<std::array<int, 4>, 16> jhud_jump_speeds = {{
        {280, 282, 287, 289},
        {366, 370, 375, 380},
        {438, 442, 450, 455},
        {500, 505, 515, 525},
        {555, 560, 570, 580},
        {605, 610, 620, 633},
        {655, 665, 675, 680},
        {700, 710, 725, 730},
        {740, 750, 765, 770},
        {780, 790, 805, 810},
        {810, 820, 840, 850},
        {850, 860, 875, 885},
        {880, 900, 900, 920},
        {910, 920, 935, 955},
        {945, 955, 965, 990},
        {970, 980, 1000, 1020},
}};

/** Band for a jump's speed (jump 1-16). */
inline JhudBand jhud_speed_band(unsigned jump, int speed) {
    const auto &thresholds = jhud_jump_speeds[jump - 1];
    int band = 0;
    while (band < int(thresholds.size()) && speed >= thresholds[size_t(band)])
        ++band;
    return JhudBand(band);
}

/** Band for a gain: under 60, 60-70, 70-80, 80-90, 90 and up (over 100 can't happen: a tick's gain is at most 1). */
inline JhudBand jhud_gain_band(double gain) {
    constexpr double really_good = 90, good = 80, meh = 70, bad = 60;
    return gain >= really_good ? JhudBand::really_good
           : gain >= good      ? JhudBand::good
           : gain >= meh       ? JhudBand::meh
           : gain >= bad       ? JhudBand::bad
                               : JhudBand::really_bad;
}

/** Which colour a report shows in. */
inline JhudBand jhud_band(const JhudReport &report, unsigned speed_colors) {
    const unsigned table_jumps = unsigned(jhud_jump_speeds.size());
    if (report.jump == 1 || (report.jump <= table_jumps && report.jump <= speed_colors) || !report.gain)
        return jhud_speed_band(std::min(report.jump, table_jumps), report.speed);
    return jhud_gain_band(*report.gain);
}

enum class JhudArrow { none, too_fast, too_slow };

/** The readout's two lines. The analyzer's arrow is apart: the HUD's bitmap font has no triangle, so it's drawn. */
struct JhudLines {
    HudLabel<48> top;
    /** Empty on jump 1. */
    HudLabel<48> bottom;
    JhudArrow arrow = JhudArrow::none;
};

/**
 * SourceMod's %.2f cuts digits off rather than rounding, so 87.52 stored as 87.5199966 prints 87.51. The value is the
 * stored float widened, as in the website. A cut -0.00 becomes 0.00, as JavaScript's toFixed prints it.
 */
inline double jhud_cut_hundredths(float value) {
    const double cut = std::trunc(double(value) * 100) / 100;
    return cut == 0 ? 0 : cut;
}

/** The readout's lines, as the plugins print them. */
inline JhudLines jhud_lines(const JhudReport &report, const JhudPrefs &prefs) {
    JhudLines lines;
    if (prefs.jss && report.jss)
        lines.top.format("%u: %d (%.0f%%)", report.jump, report.speed, std::floor(*report.jss * 100));
    else
        lines.top.format("%u: %d", report.jump, report.speed);
    if (!report.gain) return lines;
    // With sync the gain is bare, as JumpStats prints it; alone it has its %, as blankbhop/jhud prints it.
    if (prefs.sync && report.sync)
        lines.bottom.format("%.2f %.2f%%", jhud_cut_hundredths(*report.gain), jhud_cut_hundredths(*report.sync));
    else
        lines.bottom.format("%.2f%%", jhud_cut_hundredths(*report.gain));
    if (prefs.analyzer && report.jss) lines.arrow = *report.jss > 1 ? JhudArrow::too_fast : JhudArrow::too_slow;
    return lines;
}

}  // namespace native
