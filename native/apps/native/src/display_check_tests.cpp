#include "display_check.hpp"
#include "window_mode_driver.hpp"
#include <cassert>
#include <functional>
#include <filesystem>
#include <set>
#include <string>

// The display check and the guard around WindowModeDriver: what the player sees when a borderless or fullscreen
// switch fails, stalls or never comes back.

namespace {

namespace fs = std::filesystem;
using native::DisplayCheck;
using native::DisplayOutcome;
using native::WindowJson;

constexpr uint64_t frame_ns = 4'000'000;
constexpr uint64_t second_ns = 1'000'000'000;

// A window whose system refuses some modes, as WindowController reports them.
struct FakeWindow {
    std::string shown = "windowed";
    std::set<std::string> refused;
    std::vector<std::string> applied;
    bool minimized = false;

    bool is_minimized() const { return minimized; }

    bool apply(const WindowJson &settings, bool = false, const std::optional<native::WindowBounds> & = std::nullopt) {
        const auto mode = settings.at("windowMode").get<std::string>();
        applied.push_back(mode);
        if (refused.contains(mode)) return false;
        shown = mode;
        return true;
    }

    std::string mode() const { return shown; }

    std::string error() const { return "refused"; }

    void refit() {}
};

using Driver = native::BasicWindowModeDriver<FakeWindow>;
using Guard = native::DisplayGuard<Driver>;

struct Clock {
    uint64_t now = 1'000 * second_ns;

    uint64_t operator()() const { return now; }
};

fs::path fresh_folder(const std::string &name) {
    const auto folder = fs::temp_directory_path() / ("bunnyhop-display-check-" + name);
    fs::remove_all(folder);
    fs::create_directories(folder);
    return folder;
}

WindowJson settings(const std::string &mode) {
    auto out = native::default_window_settings();
    out["windowMode"] = mode;
    return out;
}

// Presents `frames` frames from `clock`, each swap taking `swap_ns`.
DisplayOutcome present(Guard &guard, WindowJson &preferences, Clock &clock, int frames, uint64_t swap_ns = 0) {
    DisplayOutcome outcome = DisplayOutcome::none;
    for (int i = 0; i < frames && outcome == DisplayOutcome::none; i++) {
        clock.now += frame_ns + swap_ns;
        outcome = guard.after_swap(preferences, clock.now, swap_ns, true, true, false);
    }
    return outcome;
}

void keys() {
    assert(native::shown_display_key(settings("windowed")).empty());
    assert(native::shown_display_key(settings("borderless")) == "borderless");
    auto low = settings("fullscreen");
    low["fullscreenMode"] = native::fullscreen_mode_json({"", -1, 1280, 960, 0});
    // Another resolution or scaling is another switch to check.
    assert(native::shown_display_key(low) != native::shown_display_key(settings("fullscreen")));
    auto bars = low;
    bars["fullscreenScaling"] = "bars";
    assert(native::shown_display_key(bars) != native::shown_display_key(low));
}

void check_confirms_after_frames() {
    const auto folder = fresh_folder("confirm");
    DisplayCheck check(folder / "marker.json");
    uint64_t now = 0;
    check.before_switch("fullscreen", now);
    // On disk before the switch, so a switch that never returns is known next launch.
    assert(fs::exists(folder / "marker.json") && check.active());
    // Thirty frames aren't enough in less than two seconds of showing.
    for (int i = 0; i < DisplayCheck::frames_needed; i++)
        assert(check.frame(now += frame_ns, 0, true) == DisplayCheck::Verdict::pending);
    DisplayCheck::Verdict verdict = DisplayCheck::Verdict::pending;
    while (verdict == DisplayCheck::Verdict::pending)
        verdict = check.frame(now += 100'000'000, 0, true);
    assert(verdict == DisplayCheck::Verdict::confirmed);
    assert(!fs::exists(folder / "marker.json") && !check.active());
    // A mode that presented this session isn't checked again (no marker each time the menu opens).
    check.before_switch("borderless", now);
    check.windowed();
    check.before_switch("fullscreen", now);
    assert(!check.active() && !fs::exists(folder / "marker.json"));
}

void check_ignores_hidden_and_slow_frames() {
    const auto folder = fresh_folder("hidden");
    DisplayCheck check(folder / "marker.json");
    uint64_t now = 0;
    check.before_switch("fullscreen", now);
    // Alt+Tab: minimized frames don't count, however long it takes.
    for (int i = 0; i < 200; i++)
        assert(check.frame(now += second_ns / 10, 0, false) == DisplayCheck::Verdict::pending);
    // A map loading on the frame loop: a ten-second frame counts as a quarter second of showing.
    assert(check.frame(now += 10 * second_ns, 0, true) == DisplayCheck::Verdict::pending);
    assert(check.active() && fs::exists(folder / "marker.json"));
}

void check_fails_on_stall_or_error() {
    const auto folder = fresh_folder("stall");
    DisplayCheck check(folder / "marker.json");
    uint64_t now = 0;
    check.before_switch("fullscreen", now);
    assert(check.frame(now += second_ns, second_ns, true) == DisplayCheck::Verdict::pending);
    assert(check.frame(now += second_ns, second_ns, true) == DisplayCheck::Verdict::pending);
    // Three seconds inside the swap since the switch: the mode isn't presenting.
    assert(check.frame(now += second_ns, second_ns, true) == DisplayCheck::Verdict::failed);
    assert(!fs::exists(folder / "marker.json") && !check.active());
    check.before_switch("fullscreen", now);
    assert(check.frame(now += frame_ns, 0, true, false) == DisplayCheck::Verdict::failed);
    // Failed modes are checked again next time.
    check.before_switch("fullscreen", now);
    assert(check.active());
}

void launch_after_a_switch_that_never_returned() {
    const auto folder = fresh_folder("hang");
    Clock clock;
    {
        // The last session switched to fullscreen and froze in the driver, or was closed from the task manager.
        FakeWindow window;
        Driver modes(window, "fullscreen");
        Guard guard(folder);
        auto preferences = settings("fullscreen");
        assert(!guard.launch(preferences, false));
        guard.watch(modes, std::ref(clock));
        modes.launch(preferences, false, std::nullopt);
        assert(window.shown == "fullscreen");
        assert(fs::exists(folder / Guard::marker_name));
    }
    FakeWindow window;
    Guard guard(folder);
    auto preferences = settings("fullscreen");
    assert(guard.launch(preferences, false));
    assert(preferences["windowMode"] == "windowed");
    assert(guard.notice().find("didn't show last time") != std::string::npos);
    assert(!fs::exists(folder / Guard::marker_name));
    // Only once: the launch after that keeps what the player chooses next.
    auto chosen = settings("fullscreen");
    assert(!guard.launch(chosen, false) && chosen["windowMode"] == "fullscreen");
}

void windowed_flag() {
    const auto folder = fresh_folder("flag");
    Guard guard(folder);
    auto preferences = settings("fullscreen");
    assert(guard.launch(preferences, true));
    assert(preferences["windowMode"] == "windowed" && guard.notice().empty());
    auto windowed = settings("windowed");
    assert(!guard.launch(windowed, true));
}

void refused_at_launch() {
    const auto folder = fresh_folder("refused");
    Clock clock;
    FakeWindow window;
    window.refused = {"borderless"};
    Driver modes(window, "fullscreen");
    Guard guard(folder);
    auto preferences = settings("fullscreen");
    guard.watch(modes, std::ref(clock));
    // The home menu shows fullscreen as borderless, which this system refuses.
    modes.launch(preferences, true, std::nullopt);
    assert(window.shown == "windowed" && modes.policy().chosen == "windowed");
    assert(present(guard, preferences, clock, 1) == DisplayOutcome::windowed);
    assert(preferences["windowMode"] == "windowed");
    assert(guard.notice().find("refused") != std::string::npos);
    assert(present(guard, preferences, clock, 1) == DisplayOutcome::none);
}

void refused_when_the_menu_closes() {
    const auto folder = fresh_folder("menu-close");
    Clock clock;
    FakeWindow window;
    window.refused = {"fullscreen"};
    Driver modes(window, "fullscreen");
    Guard guard(folder);
    auto preferences = settings("fullscreen");
    guard.watch(modes, std::ref(clock));
    modes.launch(preferences, true, std::nullopt);
    assert(window.shown == "borderless");
    assert(present(guard, preferences, clock, 1) == DisplayOutcome::none);
    modes.set_menu(false, false, preferences);
    assert(window.shown == "windowed");
    assert(present(guard, preferences, clock, 1) == DisplayOutcome::windowed);
    assert(preferences["windowMode"] == "windowed");
    // The menu opening and closing again stays windowed.
    modes.set_menu(true, false, preferences);
    modes.set_menu(false, false, preferences);
    assert(window.shown == "windowed");
}

void stalled_mode_goes_windowed() {
    const auto folder = fresh_folder("frozen");
    Clock clock;
    FakeWindow window;
    Driver modes(window, "fullscreen");
    Guard guard(folder);
    auto preferences = settings("fullscreen");
    guard.watch(modes, std::ref(clock));
    modes.launch(preferences, false, std::nullopt);
    assert(guard.checking());
    assert(present(guard, preferences, clock, 10, second_ns) == DisplayOutcome::windowed);
    assert(window.shown == "windowed" && modes.policy().chosen == "windowed");
    assert(preferences["windowMode"] == "windowed");
    assert(guard.notice().find("didn't show") != std::string::npos);
    assert(!fs::exists(folder / Guard::marker_name));
}

void healthy_mode_is_kept() {
    const auto folder = fresh_folder("healthy");
    Clock clock;
    FakeWindow window;
    Driver modes(window, "fullscreen");
    Guard guard(folder);
    auto preferences = settings("fullscreen");
    guard.watch(modes, std::ref(clock));
    modes.launch(preferences, false, std::nullopt);
    assert(present(guard, preferences, clock, 1000) == DisplayOutcome::none);
    assert(window.shown == "fullscreen" && preferences["windowMode"] == "fullscreen");
    assert(!guard.checking() && !fs::exists(folder / Guard::marker_name));
}

void trial_reverts_itself() {
    const auto folder = fresh_folder("trial");
    Clock clock;
    FakeWindow window;
    Driver modes(window, "borderless");
    Guard guard(folder);
    auto preferences = settings("borderless");
    guard.watch(modes, std::ref(clock));
    modes.launch(preferences, true, std::nullopt);
    assert(present(guard, preferences, clock, 1000) == DisplayOutcome::none);
    // Settings tries exclusive fullscreen; its frames stall. The trial puts borderless back, not windowed.
    auto trying = settings("fullscreen");
    assert(modes.choose(trying));
    modes.set_menu(false, false, trying);
    assert(window.shown == "fullscreen" && guard.checking());
    clock.now += 4 * second_ns;
    assert(guard.after_swap(trying, clock.now, 4 * second_ns, true, true, true) == DisplayOutcome::revert_trial);
    assert(trying["windowMode"] == "fullscreen" && window.shown == "fullscreen");
}

void refused_choice_keeps_the_old_mode() {
    const auto folder = fresh_folder("choice");
    Clock clock;
    FakeWindow window;
    Driver modes(window, "windowed");
    Guard guard(folder);
    auto preferences = settings("windowed");
    guard.watch(modes, std::ref(clock));
    modes.launch(preferences, false, std::nullopt);
    window.refused = {"borderless"};
    // Settings reports the error; the window stays as it was and nothing is left to recover next launch.
    assert(!modes.choose(settings("borderless")));
    assert(window.shown == "windowed" && !guard.checking());
    assert(!fs::exists(folder / Guard::marker_name));
    assert(present(guard, preferences, clock, 1) == DisplayOutcome::none);
}

}  // namespace

int main() {
    keys();
    check_confirms_after_frames();
    check_ignores_hidden_and_slow_frames();
    check_fails_on_stall_or_error();
    launch_after_a_switch_that_never_returned();
    windowed_flag();
    refused_at_launch();
    refused_when_the_menu_closes();
    stalled_mode_goes_windowed();
    healthy_mode_is_kept();
    trial_reverts_itself();
    refused_choice_keeps_the_old_mode();
    return 0;
}
