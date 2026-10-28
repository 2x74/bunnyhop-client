#include "graphics_settings.hpp"
#include "measure.hpp"
#include "replay_controls.hpp"
#include <cassert>
#include <iostream>
#include <limits>

using Json = nlohmann::json;
static void rejects(const std::string &key, const Json &patch) {
    auto document = native::default_graphics_settings();
    const auto before = document;
    bool rejected = false;
    try {
        native::patch_graphics_setting(document, key, patch);
    } catch (const std::runtime_error &) {
        rejected = true;
    }
    assert(rejected);
    assert(document == before);
}
static void settings_validation() {
    rejects("graphics", {{"resolutionScale", .1}});
    rejects("graphics", {{"gamma", 3}});
    rejects("graphics", {{"brightness", std::numeric_limits<double>::infinity()}});
    rejects("graphics", {{"msaa", 3}});
    rejects("graphics", {{"anisotropy", 12}});
    rejects("graphics", {{"aspect", "3:2"}});
    rejects("graphics", {{"waterReflections", true}});
    rejects("graphics", {{"fullbright", "yes"}});
    rejects("graphics", {{"preset", "cinematic"}});
    rejects("ghost", {{"routeSource", "top"}});
    rejects("ghost", {{"routeMode", "unknown"}});
    rejects("paint", {{"color", "#123456"}});
    rejects("paint", {{"size", "huge"}});
    rejects("graphics", {{"gamma", 2}, {"unsupported", true}});
    auto document = native::default_graphics_settings();
    assert(native::patch_graphics_setting(document, "graphics", {{"quality", "lowest"}}));
    const auto graphics = native::GraphicsSettings::read(document);
    assert(graphics.potato && graphics.samples == 0 && graphics.resolution_scale == .5f);
    assert(graphics.anisotropy == 1);
    assert(native::patch_graphics_setting(document, "graphics", {{"quality", "high"}, {"msaa", 8}}));
    assert(native::GraphicsSettings::read(document).samples == 8);
    assert(!native::patch_graphics_setting(document, "unrelated", 42));
    Json retired = {{"playerModel", "runner"}, {"ghostModel", "runner"}};
    native::migrate_retired_models(retired);
    assert(retired.at("playerModel") == "bunny" && retired.at("ghostModel") == "bunny");
    const auto binds = native::default_graphics_binds();
    assert(binds.size() == 5 && binds.at("paint").empty());
    native_render::SurfaceToolBindings tools;
    tools.read({{"binds", {{"paint", {"Mouse4"}}, {"measurePoint", {"KeyP"}}}}});
    assert(tools.match("Mouse4") == 0 && tools.match("KeyP") == 3 && tools.match("KeyX") == -1);
}
static void graphics_views() {
    native::GraphicsSettings settings;
    settings.aspect = 4.f / 3;
    auto view = native::graphics_view(settings, 1920, 1080);
    assert(view.width == 1440 && view.height == 1080);
    assert(view.output_width == 1920 && view.x == 0);
    settings.bars = true;
    view = native::graphics_view(settings, 1920, 1080);
    assert(view.width == 1440 && view.output_width == 1440 && view.x == 240);
    settings.resolution_scale = .5f;
    view = native::graphics_view(settings, 1920, 1080);
    assert(view.width == 720 && view.height == 540 && view.output_height == 1080);
    settings.aspect = 16.f / 9;
    settings.resolution_scale = 2;
    view = native::graphics_view(settings, 800, 1000);
    assert(view.output_width == 800 && view.output_height == 450 && view.y == 275);
    assert(view.width == 1600 && view.height == 900);
}
static void surfaces_and_measurement() {
    using namespace native_render;
    const auto result = measure_distance({0, 0, 0}, {3, 4, -12});
    assert(result.distance == 13 && result.horizontal == 5 && result.height == -12);
    const std::array<Vec3, 3> triangle = {{{0, 0, 0}, {10, 0, 0}, {0, 10, 0}}};
    assert(ray_triangle({1, 1, 20}, {0, 0, -1}, triangle) == 20);
    assert(!ray_triangle({15, 15, 20}, {0, 0, -1}, triangle));
    assert(!ray_triangle({1, 1, 2050}, {0, 0, -1}, triangle));
    assert(!ray_triangle({1, 1, -10}, {0, 0, 1}, triangle));
    BhTransform transform{};
    transform.origin[0] = 40;
    transform.angles[1] = 90;
    const auto matrix = native::model_matrix(transform);
    const Vec3 local{2, 3, 4};
    const auto roundtrip = surface_local(matrix, transform_point(matrix, local));
    for (int axis = 0; axis < 3; ++axis) {
        assert(std::abs(roundtrip[axis] - local[axis]) < .001f);
    }
}
static void compare_alignment() {
    using native::compare_tick;
    assert(compare_tick(150, 100, .01, 40, 1000, .005) == 140);
    assert(compare_tick(50, 100, .01, 40, 1000, .005) == 0);
    assert(compare_tick(2000, 100, .01, 40, 1000, .005) == 1000);
    assert(compare_tick(150, 100, .01, 40, 1000, 0) == 40);
}
int main() {
    settings_validation();
    graphics_views();
    surfaces_and_measurement();
    compare_alignment();
    std::cout
        << "Graphics validation, aspect/fit, surface picks, moving-owner coordinates and compare alignment passed\n";
}
