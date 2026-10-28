#include "graphics_settings.hpp"
#include "render_capabilities.hpp"
#include "measure.hpp"
#include "replay_controls.hpp"
#include <cassert>
#include <iostream>
#include <fstream>
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
    rejects("graphicsResolutionScale", .1);
    rejects("graphicsGamma", 3);
    rejects("graphicsBrightness", std::numeric_limits<double>::infinity());
    rejects("graphicsAnisotropy", 12);
    rejects("graphicsMenuFps", 90);
    rejects("graphicsAspect", "3:2");
    rejects("graphicsFullbright", "yes");
    rejects("graphicsSkyExposure", -5);
    rejects("ghostRouteSource", "top");
    rejects("ghostRouteMode", "unknown");
    rejects("paint", {{"color", "#123456"}});
    rejects("paint", {{"size", "huge"}});
    rejects("paint", {{"color", "#ff4040"}, {"unsupported", true}});
    auto document = native::default_graphics_settings();
    assert(document.at("graphicsWaterReflections") == true && document.at("graphicsBloom") == true);
    assert(document.at("tagsPlayers") == true && document.at("tagsThroughWalls") == false);
    native::apply_graphics_quality(document, "lowest");
    const auto graphics = native::GraphicsSettings::read(document);
    assert(graphics.potato && graphics.samples == 0 && graphics.resolution_scale == .5f && graphics.anisotropy == 1);
    native::apply_graphics_quality(document, "high");
    assert(native::GraphicsSettings::read(document).samples == 4);
    assert(!native::patch_graphics_setting(document, "graphics", 42));
    assert(native::patch_graphics_setting(document, "graphicsSkyExposure", 4));
    assert(native::GraphicsSettings::read(document).sky_exposure == 4);
    native::GraphicsMenuPacer pacer;
    pacer.settings({{"graphicsMenuFps", 30}});
    uint64_t waited = 0;
    assert(pacer.pace(true, 0, [&](uint64_t nanoseconds) { waited = nanoseconds; }));
    assert(waited > 33000000 && waited < 34000000);
    assert(!pacer.pace(false, 0, [&](uint64_t) { assert(false); }));
    auto capabilities = Json::array({"scoreboard"});
    native::append_render_capabilities(capabilities);
    const auto count = capabilities.size();
    native::append_render_capabilities(capabilities);
    assert(capabilities.size() == count && capabilities.at(0) == "scoreboard");
    assert(std::find(capabilities.begin(), capabilities.end(), "paint") != capabilities.end());
    bool flashlight = false;
    native::toggle_graphics_flashlight(document, flashlight);
    assert(flashlight && document.at("graphicsFlashlight") == true);
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

int main(int argc, char **argv) {
    if (argc == 2) {
        std::ifstream input(argv[1]);
        Json fixture;
        input >> fixture;
        const auto defaults = native::default_graphics_settings();
        for (const auto &[key, value] : fixture.at("defaults").items()) {
            if (!defaults.contains(key) || defaults.at(key) != value)
                throw std::runtime_error("Web settings default mismatch: " + key);
        }
        for (const auto &test : fixture.at("cases")) {
            auto document = defaults;
            bool accepted = false;
            try {
                accepted = native::patch_graphics_setting(document, test.at("key"), test.at("value"));
            } catch (const std::runtime_error &) {
            }
            if (accepted != test.at("accepted").get<bool>())
                throw std::runtime_error("Web settings range mismatch: " + test.dump());
        }
        std::cout << "Web settings schema: " << fixture.at("defaults").size() << " defaults and "
                  << fixture.at("cases").size() << " validation cases matched\n";
    }
    settings_validation();
    graphics_views();
    surfaces_and_measurement();
    compare_alignment();
    std::cout << "Graphics validation, aspect/fit, surface picks, moving-owner coordinates and compare alignment "
                 "passed\n";
}
