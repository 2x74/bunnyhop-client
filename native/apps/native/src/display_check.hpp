#pragma once
#include "atomic_replace.hpp"
#include "window_settings.hpp"
#include <cstdint>
#include <filesystem>
#include <set>
#include <string>
#include <system_error>
#include <utility>

namespace native {

// What the window shows when it isn't windowed, as one comparable key: the mode and, for exclusive fullscreen, the
// monitor, resolution, refresh rate and scaling it switches to. Windowed is the empty key.
inline std::string shown_display_key(const WindowJson &shown) {
    const auto mode = shown.value("windowMode", std::string("windowed"));
    if (mode == "windowed" || !valid_window_mode(mode)) return {};
    if (mode != "fullscreen") return mode;
    return "fullscreen " + fullscreen_mode_json(fullscreen_mode_setting(shown)).dump() + " "
           + fullscreen_scaling_setting(shown);
}

// Borderless and fullscreen are checked each time the game switches to one this session hasn't seen work: the switch
// has to come back and its first frames have to present. A swap that stalls or fails means the mode doesn't show,
// and the game goes back to windowed (client.cpp saves that). A switch the game never comes back from (frozen in the
// driver, a crash, closed from the task manager) leaves the marker file behind, and the next launch starts windowed.
class DisplayCheck {
public:
    // Frames, and time the window could show them, that a new mode must present to count as working.
    static constexpr int frames_needed = 30;
    static constexpr uint64_t time_needed_ns = 2'000'000'000;
    // Time spent inside the buffer swap since the switch, or in one swap, after which the mode isn't presenting.
    static constexpr uint64_t stalled_ns = 3'000'000'000;
    // A long frame for another reason (a map loading) counts at most this much toward time_needed_ns.
    static constexpr uint64_t frame_cap_ns = 250'000'000;

    enum class Verdict { none, pending, confirmed, failed };

    explicit DisplayCheck(std::filesystem::path marker) : marker_(std::move(marker)) {}

    // Launch: whether the last session switched to a mode it never saw present. Forgets it either way.
    bool unconfirmed_last_time() {
        std::error_code error;
        const bool found = std::filesystem::exists(marker_, error);
        if (found) std::filesystem::remove(marker_, error);
        return found;
    }

    // The window is about to show `key` (shown_display_key). The marker is on disk before the switch, so a switch
    // that never returns is known next launch. A key that already presented this session needs no new check.
    void before_switch(const std::string &key, uint64_t now_ns) {
        if (key.empty()) {
            windowed();
            return;
        }
        if (key == key_ || confirmed_.contains(key)) return;
        key_ = key;
        start(now_ns);
        try {
            atomic_write_file(marker_, "{\"shown\":" + WindowJson(key).dump() + "}\n");
        } catch (const std::exception &) {
            // Without a marker only the next-launch fallback is lost; the frame check still runs.
        }
    }

    // The switch didn't happen and the window kept what it showed, which was showing before.
    void cancel() {
        key_.clear();
        active_ = false;
        forget_marker();
    }

    // Windowed: nothing to check, and nothing to recover from next launch.
    void windowed() {
        key_.clear();
        active_ = false;
        forget_marker();
    }

    bool active() const { return active_; }

    const std::string &key() const { return key_; }

    // After each swap. `swap_ns`: time spent in it; `visible`: the window is focused and not minimized, so its frames
    // should reach the screen. `ok`: the swap reported success.
    Verdict frame(uint64_t now_ns, uint64_t swap_ns, bool visible, bool ok = true) {
        if (!active_) return Verdict::none;
        const uint64_t since = now_ns > last_ns_ ? now_ns - last_ns_ : 0;
        last_ns_ = now_ns;
        swap_ns_ += swap_ns;
        if (!ok || swap_ns >= stalled_ns || swap_ns_ >= stalled_ns) return fail();
        if (!visible) return Verdict::pending;
        ++frames_;
        shown_ns_ += since < frame_cap_ns ? since : frame_cap_ns;
        if (frames_ < frames_needed || shown_ns_ < time_needed_ns) return Verdict::pending;
        active_ = false;
        confirmed_.insert(key_);
        forget_marker();
        return Verdict::confirmed;
    }

private:
    std::filesystem::path marker_;
    std::set<std::string> confirmed_;
    std::string key_;
    bool active_ = false;
    int frames_ = 0;
    uint64_t last_ns_ = 0, shown_ns_ = 0, swap_ns_ = 0;

    void start(uint64_t now_ns) {
        active_ = true;
        frames_ = 0;
        last_ns_ = now_ns;
        shown_ns_ = swap_ns_ = 0;
    }

    Verdict fail() {
        active_ = false;
        key_.clear();
        forget_marker();
        return Verdict::failed;
    }

    void forget_marker() {
        std::error_code error;
        std::filesystem::remove(marker_, error);
    }
};

// What the display check decided after a frame.
enum class DisplayOutcome { none, windowed, revert_trial };

// The display check wired to the window mode driver (window_mode_driver.hpp) for client.cpp: launch recovery, the
// check before every switch, and going back to windowed when a mode fails.
template <class Modes>
class DisplayGuard {
public:
    static constexpr const char *marker_name = "display-check.json";

    explicit DisplayGuard(const std::filesystem::path &data) : check_(data / marker_name) {}

    // Launch, before the window takes the saved mode. --windowed, or a switch the last session never saw present,
    // starts windowed. True when `preferences` changed and should be saved; notice() then says why, when the player
    // didn't ask.
    bool launch(WindowJson &preferences, bool windowed_flag) {
        const bool unconfirmed = check_.unconfirmed_last_time();
        if (preferences.value("windowMode", std::string("windowed")) == "windowed") return false;
        if (!windowed_flag && !unconfirmed) return false;
        preferences["windowMode"] = "windowed";
        if (!windowed_flag) notice_ = unconfirmed_notice;
        return true;
    }

    // From here on every borderless or fullscreen switch `modes` makes is checked. `now_ns` is the frame loop's clock.
    template <class Clock>
    void watch(Modes &modes, Clock now_ns) {
        modes_ = &modes;
        modes.listen(
                {[this, now_ns](const WindowJson &shown) { check_.before_switch(shown_display_key(shown), now_ns()); },
                 [this] { check_.cancel(); }}
        );
    }

    // Whether a swap failure now means the new mode isn't presenting, rather than a broken renderer.
    bool checking() const { return check_.active(); }

    // After each swap. `trial`: Settings is trying a new exclusive mode (display_mode_tryout.hpp), which goes back to
    // the previous mode by itself.
    DisplayOutcome
    after_swap(WindowJson &preferences, uint64_t now_ns, uint64_t swap_ns, bool visible, bool ok, bool trial) {
        if (!modes_) return DisplayOutcome::none;
        if (modes_->take_fallback()) return windowed(preferences, refused_notice);
        if (check_.frame(now_ns, swap_ns, visible, ok) != DisplayCheck::Verdict::failed) return DisplayOutcome::none;
        if (trial) return DisplayOutcome::revert_trial;
        modes_->fall_back(preferences);
        return windowed(preferences, frozen_notice);
    }

    // The latest reason the game went windowed by itself; empty once read.
    std::string notice() { return std::exchange(notice_, std::string()); }

private:
    static constexpr const char *unconfirmed_notice = "Fullscreen didn't show last time, so the game started windowed. "
                                                      "Settings → Display → Window mode switches back.";
    static constexpr const char *refused_notice =
            "Your system refused that display mode, so the game went back to windowed.";
    static constexpr const char *frozen_notice = "That display mode didn't show, so the game went back to windowed. "
                                                 "Settings → Display → Window mode switches back.";

    DisplayCheck check_;
    Modes *modes_ = nullptr;
    std::string notice_;

    DisplayOutcome windowed(WindowJson &preferences, const char *notice) {
        preferences["windowMode"] = "windowed";
        notice_ = notice;
        return DisplayOutcome::windowed;
    }
};

}  // namespace native
