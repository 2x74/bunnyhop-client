// Window brushes and $alpha chains as the website's test/brush-fades.test.ts and material-alpha.test.ts check them:
// which brush a func_areaportalwindow draws, its blend by the eye's distance to the brush's box, a material's chain
// measured from the middle of the player to the middle of the brush, Potato's there-or-not, and the world's faces.
#include "brush_fades.hpp"
#include <cassert>
#include <cstdio>

namespace {
using native_render::BrushFades;
using native_render::FadeWindow;

bool close(double a, double b) {
    return std::abs(a - b) < 1e-5;
}

native::Matrix at(float x, float y, float z) {
    BhTransform t{};
    t.origin[0] = x;
    t.origin[1] = y;
    t.origin[2] = z;
    return native::model_matrix(t);
}

BrushFades::Surface surface(uint32_t material, float base = 1, bool chain = false) {
    BrushFades::Surface out;
    out.material = material;
    out.base = base;
    out.chain = chain;
    return out;
}

const native_render::Bounds door_box = {{-320, -16, -384}, {320, 16, 384}};

void test_finds_the_brush_each_window_draws() {
    const auto windows = native_render::areaportal_windows(nlohmann::json::parse(R"([
        {"classname": "func_areaportalwindow", "portalnumber": "1", "TranslucencyLimit": "0", "target": "portal_cave1",
         "FadeStartDist": "1200", "FadeDist": "2000"},
        {"classname": "func_illusionary", "targetname": "Portal_Cave1", "model": "*183", "origin": "10560 936 1472"},
        {"classname": "func_illusionary", "targetname": "portal_cave1", "model": "*184"},
        {"classname": "func_areaportalwindow", "target": "wnd", "FadeStartDist": "64", "FadeDist": "256",
         "TranslucencyLimit": "0.2"},
        {"classname": "func_brush", "targetname": "wnd", "model": "*76"},
        {"classname": "func_areaportalwindow", "FadeStartDist": "128", "FadeDist": "512"},
        {"classname": "func_areaportalwindow", "target": "gone", "FadeStartDist": "128", "FadeDist": "512"},
        {"classname": "info_target", "targetname": "gone"}
    ])"));
    assert(windows.size() == 2);
    const auto &cave = windows.at(183);
    assert(cave.start == 1200 && cave.end == 2000 && cave.limit == 0);
    const auto &glass = windows.at(76);
    assert(glass.start == 64 && glass.end == 256 && close(glass.limit, .2));
}

void test_window_blend() {
    using native_render::window_blend;
    assert(window_blend(999, 1200, 2000, 0) == 0);
    assert(close(window_blend(1600, 1200, 2000, 0), .5));
    assert(window_blend(2000, 1200, 2000, 0) == 1);
    assert(window_blend(5000, 1200, 2000, 0) == 1);
    assert(close(window_blend(160, 64, 256, .2), .6));
    // bhop_dull: both distances 0, always opaque.
    assert(window_blend(0, 0, 0, 0) == 1);
    assert(close(window_blend(299, 300, 300, .1), .1));
}

const BrushFades::Chain no_chain = [](uint32_t, std::vector<double> &, double, double, uint32_t, uint32_t &) {
    return 1.;
};

// bhop_angst's doorway: gone at GothQueen's spot, half at 1,600 units from the near face, the plain brush from 2,000.
void test_fades_a_window_by_the_eyes_distance_to_its_box() {
    BrushFades fades;
    fades.add(183, door_box, FadeWindow{1200, 2000, 0}, {surface(1)}, true);
    const auto matrix = [](uint32_t) {
        return at(10560, 936, 1472);
    };
    fades.update({10682.9f, -79.4f, 1266.5f}, 0, false, matrix, no_chain);
    assert(fades.hidden(183));
    fades.update({10560, 920 - 1600, 1472}, 0, false, matrix, no_chain);
    assert(!fades.hidden(183));
    const auto *door = fades.surface(183, 1);
    assert(door && !door->plain && close(door->alpha, .5));
    assert(!fades.surface(183, 0));
    fades.update({10560, 920 - 2400, 1472}, 0, false, matrix, no_chain);
    assert(fades.surface(183, 1)->plain && fades.surface(183, 1)->alpha == 1);
}

void test_potato_is_there_or_not_and_translucent_materials_multiply() {
    BrushFades fades;
    fades.add(5, door_box, FadeWindow{100, 300, 0}, {surface(0), surface(1, .35f)}, true);
    const auto origin = [](uint32_t) {
        return at(0, 0, 0);
    };
    fades.update({0, -16 - 180, 0}, 0, true, origin, no_chain);
    assert(fades.hidden(5));
    fades.update({0, -16 - 220, 0}, 0, true, origin, no_chain);
    assert(!fades.hidden(5));
    fades.update({0, -16 - 200, 0}, 0, false, origin, no_chain);
    assert(close(fades.surface(5, 1)->alpha, .175));
    fades.update({0, -16 - 50, 0}, 0, false, origin, no_chain);
    assert(fades.hidden(5));
}

// A chain clear inside 1,200 units and opaque from 3,300 (bhop_angst's floor), fed the distance between the middles.
void test_runs_a_chain_from_the_middle_of_the_player_to_the_middle_of_the_brush() {
    const BrushFades::Chain floor_chain =
            [](uint32_t, std::vector<double> &, double distance, double, uint32_t, uint32_t &) {
                return std::clamp((distance - 1200) / 2100, 0., 1.);
            };
    BrushFades fades;
    fades.add(181, {{-960, -960, 30}, {960, 960, 34}}, std::nullopt, {surface(1, 1, true)}, true);
    const auto matrix = [](uint32_t) {
        return at(1024, 13824, -3104);
    };
    // The eye 33 units above the player's middle; the brush's middle 32 above its origin.
    fades.update({1024, 13824, -3072 + 2250 + 33}, 0, false, matrix, floor_chain);
    const auto *s = fades.surface(181, 1);
    assert(!s->plain && close(s->alpha, .5) && !fades.hidden(181));
    // GothQueen at tick 5149, 855 units above it: clear, so not drawn.
    fades.update({1251.1f, 13851.8f, -2215.6f}, 0, false, matrix, floor_chain);
    assert(fades.hidden(181));
    fades.update({1024, 13824, -3072 + 4000}, 0, false, matrix, floor_chain);
    assert(fades.surface(181, 1)->plain);
}

// The world's faces (model 0) only run chains that need no entity, with no distance, and are never hidden.
void test_world_faces_pulse_and_stay_drawn() {
    uint32_t seen_seed = 99;
    double seen_distance = -1;
    const BrushFades::Chain pulse =
            [&](uint32_t, std::vector<double> &, double distance, double time, uint32_t seed, uint32_t &) {
                seen_seed = seed;
                seen_distance = distance;
                return time > 1 ? 0. : .75;
            };
    BrushFades fades;
    fades.add(0, {}, std::nullopt, {surface(4, 1, true)}, true);
    fades.update({100, 100, 100}, 0, false, [](uint32_t) { return native::Matrix{}; }, pulse);
    assert(seen_seed == 0 && seen_distance == 0 && close(fades.surface(0, 4)->alpha, .75));
    fades.update({100, 100, 100}, 2, false, [](uint32_t) { return native::Matrix{}; }, pulse);
    assert(!fades.hidden(0));
}

// The noise counter starts at 0 each frame and is shared by a brush's materials, as the website's per-brush draws.
void test_noise_draws_are_counted_per_brush_per_frame() {
    std::vector<uint32_t> starts;
    const BrushFades::Chain noisy = [&](uint32_t, std::vector<double> &, double, double, uint32_t, uint32_t &noise) {
        starts.push_back(noise);
        noise += 2;
        return 1.;
    };
    BrushFades fades;
    fades.add(7, door_box, std::nullopt, {surface(1, 1, true), surface(2, 1, true)}, true);
    const auto origin = [](uint32_t) {
        return at(0, 0, 0);
    };
    fades.update({0, 0, 0}, 0, false, origin, noisy);
    fades.update({0, 0, 0}, .01, false, origin, noisy);
    assert((starts == std::vector<uint32_t>{0, 2, 0, 2}));
}
}  // namespace

int main() {
    test_finds_the_brush_each_window_draws();
    test_window_blend();
    test_fades_a_window_by_the_eyes_distance_to_its_box();
    test_potato_is_there_or_not_and_translucent_materials_multiply();
    test_runs_a_chain_from_the_middle_of_the_player_to_the_middle_of_the_brush();
    test_world_faces_pulse_and_stay_drawn();
    test_noise_draws_are_counted_per_brush_per_frame();
    std::puts("Brush fades: windows, chains, Potato and the world's faces passed");
}
