#include "display_mode_trial.hpp"
#include "display_modes.hpp"
#include "settings.hpp"
#include <cassert>
#include <vector>

// Exclusive fullscreen modes as the settings store them, and the ten-second trial of a new mode.

namespace {

using native::FullscreenMode;
using native::Json;

void shapes_have_their_names() {
    assert(native::aspect_name(1280, 960) == "4:3");
    assert(native::aspect_name(1024, 768) == "4:3");
    assert(native::aspect_name(1440, 1080) == "4:3");
    assert(native::aspect_name(1280, 1024) == "5:4");
    assert(native::aspect_name(1680, 1050) == "16:10");
    assert(native::aspect_name(1920, 1080) == "16:9");
    assert(native::aspect_name(1366, 768) == "16:9");
    assert(native::aspect_name(3440, 1440) == "21:9");
    assert(native::aspect_name(2560, 1080) == "21:9");
    assert(native::aspect_name(5120, 1440) == "32:9");
    assert(native::aspect_name(1000, 900).empty());
    assert(native::same_shape(1366, 768, 1920, 1080));
    assert(!native::same_shape(1280, 960, 1920, 1080));
}

void modes_match_by_size_then_rate() {
    const std::vector<native::DisplayModeOption> modes = {
            {1920, 1080, 240}, {1920, 1080, 144}, {1280, 960, 120}, {1280, 960, 59.94}, {1280, 960, 60}
    };
    assert(native::matching_mode(modes, {"", -1, 1920, 1080, 144}) == 1u);
    // No rate chosen, or one this size doesn't have: the highest of the size.
    assert(native::matching_mode(modes, {"", -1, 1920, 1080, 0}) == 0u);
    assert(native::matching_mode(modes, {"", -1, 1280, 960, 75}) == 2u);
    assert(native::matching_mode(modes, {"", -1, 1280, 960, 59.94}) == 3u);
    assert(!native::matching_mode(modes, {"", -1, 1024, 768, 0}));
}

void displays_match_by_name_and_place() {
    const std::vector<native::DisplayIdentity> displays = {{"DELL S2721DGF", 0}, {"DELL S2721DGF", 1}, {"LG", 2}};
    assert(native::matching_display(displays, {"DELL S2721DGF", 1, 0, 0, 0}) == 1u);
    // The second monitor was unplugged and the list shifted: the name still finds a monitor.
    assert(native::matching_display(displays, {"LG", 4, 0, 0, 0}) == 2u);
    assert(native::matching_display(displays, {"BenQ", 1, 0, 0, 0}) == 1u);
    assert(!native::matching_display(displays, {"", -1, 0, 0, 0}));
    assert(!native::matching_display(displays, {"BenQ", 9, 0, 0, 0}));
}

bool rejects(const Json &patch) {
    try {
        native::patch_settings(native::default_settings(), patch);
    } catch (const std::exception &) {
        return true;
    }
    return false;
}

void settings_validate_modes() {
    const auto defaults = native::default_settings();
    assert(native::fullscreen_mode_setting(defaults) == FullscreenMode{});
    assert(native::fullscreen_scaling_setting(defaults) == "stretch");
    const auto mode = native::fullscreen_mode_json({"DELL", 1, 1280, 960, 239.76});
    const auto changed = native::patch_settings(defaults, {{"fullscreenMode", mode}, {"fullscreenScaling", "bars"}});
    assert(native::fullscreen_mode_setting(changed) == (FullscreenMode{"DELL", 1, 1280, 960, 239.76}));
    assert(native::fullscreen_scaling_setting(changed) == "bars");
    // Partial objects fill in the desktop mode's defaults.
    assert(native::fullscreen_mode_setting(
                   native::patch_settings(defaults, {{"fullscreenMode", {{"width", 1024}, {"height", 768}}}})
           )
           == (FullscreenMode{"", -1, 1024, 768, 0}));
    assert(rejects({{"fullscreenMode", {{"width", 1280}, {"height", 0}}}}));
    assert(rejects({{"fullscreenMode", {{"width", 100}, {"height", 100}}}}));
    assert(rejects({{"fullscreenMode", {{"width", 1280.5}, {"height", 960}}}}));
    assert(rejects({{"fullscreenMode", {{"refreshHz", -1}}}}));
    assert(rejects({{"fullscreenMode", {{"refreshHz", 5000}}}}));
    assert(rejects({{"fullscreenMode", {{"display", std::string(200, 'x')}}}}));
    assert(rejects({{"fullscreenMode", {{"extra", 1}, {"a", 1}, {"b", 1}, {"c", 1}, {"d", 1}, {"e", 1}}}}));
    assert(rejects({{"fullscreenMode", "1280x960"}}));
    assert(rejects({{"fullscreenScaling", "center"}}));
}

void trial_reverts_after_ten_seconds() {
    using native::DisplayModeTrial;
    auto before = native::default_settings();
    before["windowMode"] = "borderless";
    auto after = before;
    after["windowMode"] = "fullscreen";
    after["fullscreenMode"] = native::fullscreen_mode_json({"", -1, 1280, 960, 0});
    assert(DisplayModeTrial::wanted(before, after));
    assert(!DisplayModeTrial::wanted(after, after));
    assert(!DisplayModeTrial::wanted(after, before));
    auto rescaled = after;
    rescaled["fullscreenScaling"] = "bars";
    assert(DisplayModeTrial::wanted(after, rescaled));

    DisplayModeTrial trial;
    constexpr uint64_t second = 1'000'000'000, start = 5 * second;
    trial.begin(before, start);
    assert(trial.active() && trial.seconds_left(start) == 10 && trial.seconds_left(start + second / 2) == 10);
    assert(trial.seconds_left(start + 9 * second + 1) == 1);
    assert(!trial.expired(start + 10 * second - 1) && trial.expired(start + 10 * second));
    auto shown = after;
    shown["fov"] = 100.0;
    const auto reverted = trial.revert(shown);
    assert(!trial.active());
    assert(reverted["windowMode"] == "borderless" && reverted["fullscreenMode"] == before["fullscreenMode"]);
    // Other settings changed meanwhile stay.
    assert(reverted["fov"] == 100.0);

    trial.begin(before, start);
    trial.keep();
    assert(!trial.active() && !trial.expired(start + 20 * second));
    assert(trial.revert(after) == after);
}

}  // namespace

int main() {
    shapes_have_their_names();
    modes_match_by_size_then_rate();
    displays_match_by_name_and_place();
    settings_validate_modes();
    trial_reverts_after_ten_seconds();
}
