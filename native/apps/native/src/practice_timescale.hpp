#pragma once
// Timescale (!timescale, !ts): slow motion for working out a route, only in solo practice mode (the website's
// practice-mode/timescale.ts). Only the frame loop's time accumulator is scaled (input_scheduler.hpp): the sim, the
// recording, the timer, SSJ and the HUD stay tick-based. 0.1 to 1. A run can't keep a scale: frame() answers 1 the
// moment practice mode is off or anything else blocks it, and forgets the choice; a tick at another scale also makes
// the attempt practice (Practice::slowed), so it is never submitted.
#include <cmath>
#include <cstdio>
#include <string>
#include <string_view>

namespace native {

inline constexpr double timescale_min = .1, timescale_max = 1;

struct TimescaleContext {
    bool practice_mode = false;
    bool in_room = false;
    bool tutorial = false;
    bool gauntlet = false;
    bool segmented = false;
};

// Why the timescale can't be used now, or empty (the website's wording).
inline std::string_view timescale_blocked(const TimescaleContext &context) {
    if (context.in_room) return "Timescale only works in solo practice.";
    if (context.tutorial) return "Timescale isn't available in the tutorial.";
    if (context.gauntlet) return "No timescale during a gauntlet.";
    if (context.segmented) return "Timescale isn't available in Segmented.";
    if (!context.practice_mode) return "Timescale only works in practice mode. Type !practice first.";
    return {};
}

// "0.5x", "0.25x", "1x".
inline std::string timescale_label(double scale) {
    constexpr double hundredths = 100;
    char text[16];
    std::snprintf(text, sizeof(text), "%gx", std::round(scale * hundredths) / hundredths);
    return text;
}

class PracticeTimescale {
public:
    // The scale chosen in practice (1 when none).
    double value() const { return chosen_; }

    // The scale this frame runs at: the chosen one while it's allowed; otherwise 1, and the choice is forgotten.
    double frame(const TimescaleContext &context) {
        if (!timescale_blocked(context).empty()) chosen_ = 1;
        return chosen_;
    }

    // Sets the scale (0.1 to 1, rounded to hundredths). The reply line, or the reason it can't.
    std::string set(double scale, const TimescaleContext &context) {
        constexpr double hundredths = 100, slack = 1e-9;
        if (const auto blocked = timescale_blocked(context); !blocked.empty()) return std::string(blocked);
        if (!std::isfinite(scale) || scale < timescale_min - slack || scale > timescale_max + slack)
            return "Use !timescale 0.1 to 1, like !timescale 0.5";
        chosen_ = std::round(scale * hundredths) / hundredths;
        if (chosen_ == 1) return "Timescale back to normal.";
        return "Timescale " + timescale_label(chosen_) + ". It goes back to 1x when you leave practice.";
    }

    // !timescale with nothing after it.
    std::string status(const TimescaleContext &context) const {
        if (const auto blocked = timescale_blocked(context); !blocked.empty()) return std::string(blocked);
        return "Timescale " + timescale_label(chosen_) + ". "
               + (chosen_ == 1 ? "Type !timescale 0.5 to slow down." : "Type !timescale 1 for normal speed.");
    }

private:
    double chosen_ = 1;
};

}  // namespace native
