// The replay viewer's own state: drawing between ticks, the A-B loop and the HUD's room under the viewer's bars.
#include "replay_player.hpp"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <cmath>

namespace {

struct Area {
    int x = 0, top = 0, width = 1, height = 1;
};

constexpr uint32_t range_from = 100, range_to = 1000;

native::ReplayPlayer player() {
    native::ReplayPlayer viewer;
    viewer.session.range.from = range_from;
    viewer.session.range.to = range_to;
    viewer.session.range.total = range_to;
    viewer.begin("fixture.bhr");
    return viewer;
}

BhState state(uint32_t tick, float x, float view_offset) {
    BhState result{};
    result.tick = tick;
    result.position[0] = x;
    result.view_offset_z = view_offset;
    return result;
}

void smooth_between_ticks() {
    auto viewer = player();
    BhCmd before{}, after{};
    before.yaw = 170;
    before.pitch = 10;
    after.yaw = -170;
    after.pitch = 20;
    viewer.record_view(before, 41);
    viewer.record_view(after, 42);
    const auto previous = state(41, 0, 64), current = state(42, 10, 46);
    auto shown = current;
    native::Input view;
    viewer.smooth(shown, previous, current, .25f, view);
    assert(std::abs(shown.position[0] - 2.5f) < 1e-5f && std::abs(shown.view_offset_z - 59.5f) < 1e-5f);
    // Across the ±180° seam the view turns the short way: 170° to -170° passes 175°, not 92.5°.
    assert(std::abs(std::remainder(view.yaw() - 175, 360.)) < 1e-4 && std::abs(view.pitch - 12.5) < 1e-4);
    // A seek is not drawn as motion: the tick before isn't the previous one.
    auto jumped = current;
    viewer.smooth(jumped, state(12, 0, 64), current, .25f, view);
    assert(jumped.position[0] == 10);
    auto teleported = current;
    teleported.events = 1;
    auto landed = teleported;
    viewer.smooth(landed, previous, teleported, .25f, view);
    assert(landed.position[0] == 10);
}

void loop_repeats() {
    auto viewer = player();
    viewer.set_loop({{"from", 200}, {"to", 300}});
    viewer.wrap_loop(250);
    assert(!viewer.controls.pending);
    viewer.paused = true;
    viewer.wrap_loop(300);
    assert(viewer.controls.pending == 200u && !viewer.paused);
    for (const nlohmann::json &bad : {nlohmann::json{{"from", 50}, {"to", 300}}, {{"from", 300}, {"to", 200}}}) {
        bool rejected = false;
        try {
            viewer.set_loop(bad);
        } catch (const std::exception &) {
            rejected = true;
        }
        assert(rejected);
    }
    viewer.set_loop(nullptr);
    assert(!viewer.loop);
}

void hud_under_viewer() {
    auto viewer = player();
    const Area window{0, 0, 1920, 1080};
    viewer.viewer_ui({{"open", true}, {"top", 60}, {"bottom", 190}});
    assert(viewer.hud_area(window, 1080, 1).height == 1080);
    viewer.ui_shown = true;
    const auto inside = viewer.hud_area(window, 1080, 2);
    assert(inside.top == 120 && inside.height == 1080 - 120 - 380);
    // Bars that would leave the HUD almost no room are ignored.
    viewer.viewer_ui({{"open", true}, {"top", 400}, {"bottom", 400}});
    assert(viewer.hud_area(window, 1080, 1).height == 1080);
}

}  // namespace

int main() {
    smooth_between_ticks();
    loop_repeats();
    hud_under_viewer();
}
