#pragma once
#include "window_settings.hpp"
#include <cstdint>
#include <optional>

namespace native {

// A new exclusive fullscreen mode is tried before it is kept: the game shows it with "Keep this display mode?"
// and goes back to the previous mode after ten seconds unless the player keeps it, so a mode the monitor can't
// show never strands them on a black screen. Only the window settings below take part.
class DisplayModeTrial {
public:
    static constexpr uint64_t trial_ns = 10'000'000'000;
    static constexpr const char *keys[] = {"windowMode", "fullscreenMode", "fullscreenScaling"};

    // True when going from `before` to `after` shows a different exclusive mode, which needs a trial.
    static bool wanted(const WindowJson &before, const WindowJson &after) {
        if (after.value("windowMode", std::string()) != "fullscreen") return false;
        if (before.value("windowMode", std::string()) != "fullscreen") return true;
        return fullscreen_mode_setting(before) != fullscreen_mode_setting(after)
               || fullscreen_scaling_setting(before) != fullscreen_scaling_setting(after);
    }

    // `previous` is the whole settings object before the change; the trial keeps only its display keys.
    void begin(const WindowJson &previous, uint64_t now_ns) {
        previous_ = WindowJson::object();
        for (const char *key : keys) {
            if (previous.contains(key)) (*previous_)[key] = previous.at(key);
        }
        deadline_ns_ = now_ns + trial_ns;
    }

    bool active() const { return previous_.has_value(); }

    bool expired(uint64_t now_ns) const { return active() && now_ns >= deadline_ns_; }

    // Whole seconds left, for the prompt (10 down to 1).
    int seconds_left(uint64_t now_ns) const {
        if (!active() || now_ns >= deadline_ns_) return 0;
        constexpr uint64_t second_ns = 1'000'000'000;
        return int((deadline_ns_ - now_ns + second_ns - 1) / second_ns);
    }

    void keep() { previous_.reset(); }

    // Ends the trial: `settings` with the display keys put back as they were before it.
    WindowJson revert(WindowJson settings) {
        if (previous_) {
            for (const auto &[key, value] : previous_->items())
                settings[key] = value;
        }
        previous_.reset();
        return settings;
    }

private:
    std::optional<WindowJson> previous_;
    uint64_t deadline_ns_ = 0;
};

}  // namespace native
