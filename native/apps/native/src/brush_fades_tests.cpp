// Window brushes and $alpha chains as the website's test/brush-fades.test.ts and material-alpha.test.ts check them:
// which brush a func_areaportalwindow draws, its blend by the eye's distance to the brush's box, a material's chain
// measured from the middle of the player to the middle of the brush, Potato's there-or-not, and the world's faces.
#include "brush_fades.hpp"
#include <cassert>
#include <cstdio>
#include <unordered_set>

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

// A spec with only a window.
native_render::BrushSpec window(FadeWindow w) {
    native_render::BrushSpec spec;
    spec.window = w;
    return spec;
}

const native_render::Vec3 ahead = {1, 0, 0};

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
    fades.add(183, door_box, window({1200, 2000, 0}), {surface(1)}, 1);
    const auto matrix = [](uint32_t) {
        return at(10560, 936, 1472);
    };
    fades.update({10682.9f, -79.4f, 1266.5f}, ahead, 0, false, matrix, no_chain);
    assert(fades.hidden(183));
    fades.update({10560, 920 - 1600, 1472}, ahead, 0, false, matrix, no_chain);
    assert(!fades.hidden(183));
    const auto *door = fades.surface(183, 1);
    assert(door && !door->plain && close(door->alpha, .5));
    assert(!fades.surface(183, 0));
    fades.update({10560, 920 - 2400, 1472}, ahead, 0, false, matrix, no_chain);
    assert(fades.surface(183, 1)->plain && fades.surface(183, 1)->alpha == 1);
}

void test_potato_is_there_or_not_and_translucent_materials_multiply() {
    BrushFades fades;
    fades.add(5, door_box, window({100, 300, 0}), {surface(0), surface(1, .35f)}, 2);
    const auto origin = [](uint32_t) {
        return at(0, 0, 0);
    };
    fades.update({0, -16 - 180, 0}, ahead, 0, true, origin, no_chain);
    assert(fades.hidden(5));
    fades.update({0, -16 - 220, 0}, ahead, 0, true, origin, no_chain);
    assert(!fades.hidden(5));
    fades.update({0, -16 - 200, 0}, ahead, 0, false, origin, no_chain);
    assert(close(fades.surface(5, 1)->alpha, .175));
    fades.update({0, -16 - 50, 0}, ahead, 0, false, origin, no_chain);
    assert(fades.hidden(5));
}

// A chain clear inside 1,200 units and opaque from 3,300 (bhop_angst's floor), fed the distance between the middles.
void test_runs_a_chain_from_the_middle_of_the_player_to_the_middle_of_the_brush() {
    const BrushFades::Chain floor_chain =
            [](uint32_t, std::vector<double> &, double distance, double, uint32_t, uint32_t &) {
                return std::clamp((distance - 1200) / 2100, 0., 1.);
            };
    BrushFades fades;
    fades.add(181, {{-960, -960, 30}, {960, 960, 34}}, {}, {surface(1, 1, true)}, 1);
    const auto matrix = [](uint32_t) {
        return at(1024, 13824, -3104);
    };
    // The eye 33 units above the player's middle; the brush's middle 32 above its origin.
    fades.update({1024, 13824, -3072 + 2250 + 33}, ahead, 0, false, matrix, floor_chain);
    const auto *s = fades.surface(181, 1);
    assert(!s->plain && close(s->alpha, .5) && !fades.hidden(181));
    // GothQueen at tick 5149, 855 units above it: clear, so not drawn.
    fades.update({1251.1f, 13851.8f, -2215.6f}, ahead, 0, false, matrix, floor_chain);
    assert(fades.hidden(181));
    fades.update({1024, 13824, -3072 + 4000}, ahead, 0, false, matrix, floor_chain);
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
    fades.add(0, {}, {}, {surface(4, 1, true)}, 1);
    fades.update({100, 100, 100}, ahead, 0, false, [](uint32_t) { return native::Matrix{}; }, pulse);
    assert(seen_seed == 0 && seen_distance == 0 && close(fades.surface(0, 4)->alpha, .75));
    fades.update({100, 100, 100}, ahead, 2, false, [](uint32_t) { return native::Matrix{}; }, pulse);
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
    fades.add(7, door_box, {}, {surface(1, 1, true), surface(2, 1, true)}, 2);
    const auto origin = [](uint32_t) {
        return at(0, 0, 0);
    };
    fades.update({0, 0, 0}, ahead, 0, false, origin, noisy);
    fades.update({0, 0, 0}, ahead, .01, false, origin, noisy);
    assert((starts == std::vector<uint32_t>{0, 2, 0, 2}));
}

// brush-render.test.ts: the keys as the engine reads them, and ComputeFxBlend.
native_render::RenderKeys keys_of(const char *json) {
    return native_render::render_keys(nlohmann::json::parse(json));
}

native_render::RenderKeys keys(int mode, int amount, int fx = 0) {
    native_render::RenderKeys k;
    k.mode = mode;
    k.amount = amount;
    k.fx = fx;
    return k;
}

int blend(const native_render::RenderKeys &k, double time = 0, double depth = 0, int jitter = 0, double index = 0) {
    native_render::FxInputs in;
    in.time = time;
    in.depth = depth;
    in.jitter = jitter;
    in.index = index;
    return native_render::fx_blend(k, in);
}

void test_reads_render_keys_as_the_engine_does() {
    const auto plain = keys_of(R"({"classname": "func_brush"})");
    assert(plain.mode == 0 && plain.amount == 255 && !plain.color && plain.fx == 0);
    const auto all =
            keys_of(R"({"RenderMode": "10", "RENDERAMT": "100", "RenderColor": "255 128 0", "renderFX": "16"})");
    assert(all.mode == native_render::render_none && all.amount == 100 && all.fx == 16);
    assert(all.color && (*all.color)[0] == 1 && close((*all.color)[1], 128 / 255.) && (*all.color)[2] == 0);
    assert(!keys_of(R"({"rendercolor": "255 255 255"})").color);
    const auto four = *keys_of(R"({"rendercolor": "128 255 255 7"})").color;
    assert(close(four[0], 128 / 255.) && four[1] == 1 && four[2] == 1);
    const auto short_color = *keys_of(R"({"rendercolor": "200"})").color;
    assert(close(short_color[0], 200 / 255.) && short_color[1] == 0 && short_color[2] == 0);
    const auto empty = *keys_of(R"({"rendercolor": ""})").color;
    assert(empty[0] == 0 && empty[1] == 0 && empty[2] == 0);
    const auto loose = keys_of(R"({"renderamt": "50.9", "rendermode": " 2x"})");
    assert(loose.amount == 50 && loose.mode == 2);
    assert(keys_of(R"({"renderamt": "abc"})").amount == 0);
}

void test_compute_fx_blend() {
    constexpr double pi = 3.14159265358979323846, quarter = pi / 4;
    assert(blend(keys(0, 0)) == 255 && blend(keys(0, 100)) == 255);
    for (int mode : {1, 2, 3, 4, 5, 9})
        assert(blend(keys(mode, 100)) == 100);
    assert(blend(keys(2, 0)) == 0);
    assert(blend(keys(1, 220, 14)) == 220 && blend(keys(5, 196, 26)) == 196);
    // Pulses, in rendermode 0 too.
    assert(blend(keys(0, 200, 1), quarter) == 216 && blend(keys(0, 200, 1), 3 * quarter) == 184);
    assert(blend(keys(0, 255, 1), quarter) == 255 && blend(keys(0, 100, 3), quarter) == 164);
    assert(blend(keys(0, 100, 2), pi / 16) == 116 && blend(keys(0, 100, 4), pi / 16) == 164);
    assert(blend(keys(0, 7, 24), pi / 24) == 255 && blend(keys(0, 7, 24), 0) == 0);
    // Strobes and flickers (bhop_vacban's walls); the entity index shifts the phase by index * 363 radians.
    assert(blend(keys(0, 255, 9), pi / 8) == 255 && blend(keys(0, 255, 9), 3 * pi / 8) == 0);
    assert(blend(keys(0, 255, 9), pi / 8, 0, 0, 1) == (std::sin(pi / 2 + 363) < 0 ? 0 : 255));
    assert(blend(keys(2, 90, 10), pi / 32) == 90 && blend(keys(2, 90, 11), 3 * pi / 72) == 0);
    assert(blend(keys(0, 255, 12), .1) == 255 && blend(keys(0, 255, 13), .25) == 0);
    // Hologram: fades between 100 and 500 units ahead, nothing behind the eye; Distort without the distance.
    const auto hologram = keys(0, 255, 16);
    assert(blend(hologram, 0, -1) == 0 && blend(hologram, 0, 0) == 0 && blend(hologram, 0, 60) == 180);
    assert(blend(hologram, 0, 300) == 90 && blend(hologram, 0, 500) == 0 && blend(hologram, 0, 900) == 0);
    assert(blend(hologram, 0, 60, -32) == 148 && blend(hologram, 0, 60, 31) == 211);
    assert(blend(keys(0, 255, 15), 0, -500, 5) == 185);
    std::vector<int> timed, frame_fades;
    for (int fx : {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 19, 24, 26})
        if (native_render::fx_is_timed(keys(0, 255, fx))) timed.push_back(fx);
    for (int fx : {4, 5, 6, 7})
        if (native_render::fx_is_frame_fade(keys(0, 255, fx))) frame_fades.push_back(fx);
    assert((timed == std::vector<int>{1, 2, 3, 4, 9, 10, 11, 12, 13, 15, 16, 24}));
    assert((frame_fades == std::vector<int>{5, 6}));
    // The same hash as the website and the bridge.
    assert(native_render::hash01(183, 7) == 0.3391792436596006);
    assert(native_render::hash01(5, (int64_t(1) << 31) + 9) == 0.8221343879122287);
}

void test_hides_the_classes_cs_s_never_draws() {
    const auto models = native_render::undrawn_class_models(nlohmann::json::parse(R"([
        {"classname": "func_dustmotes", "model": "*3"}, {"classname": "func_precipitation", "model": "*9"},
        {"classname": "func_clip_vphysics", "model": "*12"}, {"classname": "func_brush", "model": "*4"},
        {"classname": "func_dustcloud", "model": "*0"}
    ])"));
    assert((models == std::unordered_set<uint32_t>{3, 9, 12}));
}

native_render::BrushSpec keyed(const char *json, double index = 0) {
    native_render::BrushSpec spec;
    spec.render = keys_of(json);
    spec.index = index;
    return spec;
}

BrushFades::Surface keyed_surface(uint32_t material, float base = 1) {
    auto s = surface(material, base);
    s.keyed = true;
    return s;
}

// brush-fades.test.ts: rendermode 10 and a blend of 0 are never drawn; rendermode 0 ignores renderamt.
void test_never_draws_rendermode_10_or_a_blend_of_zero() {
    BrushFades fades;
    fades.add(151, door_box, keyed(R"({"rendermode": "10"})"), {keyed_surface(1)}, 2);
    fades.add(98, door_box, keyed(R"({"rendermode": "2", "renderamt": "0"})"), {keyed_surface(0)}, 1);
    fades.add(21, door_box, keyed(R"({"rendermode": "0", "renderamt": "0"})"), {keyed_surface(0)}, 1);
    assert(fades.size() == 2);
    const auto origin = [](uint32_t) {
        return at(0, 0, 0);
    };
    fades.update({0, 0, 0}, ahead, 0, false, origin, no_chain);
    assert(fades.hidden(151) && fades.hidden(98) && !fades.hidden(21));
    fades.update({0, 0, 0}, ahead, 1, true, origin, no_chain);
    assert(fades.hidden(151) && fades.hidden(98));
}

void test_blends_by_renderamt_and_tints_by_rendercolor() {
    BrushFades fades;
    const auto spec = keyed(R"({"rendermode": "1", "renderamt": "50", "rendercolor": "154 87 201"})");
    // Material 2 has an alpha of its own: the entity's keys don't apply to it.
    fades.add(1, door_box, spec, {keyed_surface(1), surface(2, .35f)}, 2);
    fades.add(19, door_box, keyed(R"({"rendercolor": "255 0 0"})"), {keyed_surface(0), keyed_surface(1)}, 2);
    const auto origin = [](uint32_t) {
        return at(0, 0, 0);
    };
    fades.update({0, 0, 0}, ahead, 0, false, origin, no_chain);
    const auto *own = fades.surface(1, 1);
    assert(own && !own->plain && close(own->alpha, 50 / 255.) && own->tint);
    assert(std::lround((*own->tint)[0] * 255) == 154 && std::lround((*own->tint)[2] * 255) == 201);
    assert(!fades.surface(1, 2) && !fades.hidden(1));
    // Tinted and nothing else: drawn as the map draws it, in its colour.
    const auto *red = fades.surface(19, 1);
    assert(red && red->plain && red->tint && (*red->tint)[0] == 1 && (*red->tint)[1] == 0);
    // In Potato a see-through brush stays, however faint.
    fades.update({0, 0, 0}, ahead, 0, true, origin, no_chain);
    assert(!fades.hidden(1));
}

void test_strobes_and_holograms() {
    BrushFades fades;
    fades.add(115, door_box, keyed(R"({"renderfx": "9"})"), {keyed_surface(0)}, 1);
    fades.add(18, door_box, keyed(R"({"renderfx": "16"})"), {keyed_surface(0)}, 1);
    const auto matrix = [](uint32_t model) {
        return model == 18 ? at(300, 40, 0) : at(0, 0, 0);
    };
    constexpr double pi = 3.14159265358979323846;
    fades.update({0, 0, 0}, ahead, pi / 8, false, matrix, no_chain);
    assert(!fades.hidden(115) && fades.surface(115, 0)->plain);
    // 300 units ahead: half of 180, give or take the flicker.
    const float hologram = fades.surface(18, 0)->alpha;
    assert(hologram >= (90 - 32) / 255.f && hologram <= (90 + 31) / 255.f);
    fades.update({0, 0, 0}, ahead, 3 * pi / 8, false, matrix, no_chain);
    assert(fades.hidden(115));
    // Looking away: behind the view plane.
    fades.update({0, 0, 0}, {-1, 0, 0}, 0, false, matrix, no_chain);
    assert(fades.hidden(18));
    fades.update({-400, 0, 0}, ahead, 0, false, matrix, no_chain);
    assert(fades.hidden(18));
}

// render.ts: the first entity per model, not the ones the map changes, a window's brush or a frame fade.
void test_picks_the_brushes_whose_keys_count() {
    const auto renders = native_render::brush_renders(
            nlohmann::json::parse(R"([
                {"classname": "worldspawn"},
                {"classname": "func_wall", "model": "*1", "rendermode": "10"},
                {"classname": "func_brush", "model": "*1", "rendercolor": "255 0 0"},
                {"classname": "func_brush", "model": "*2", "rendermode": "2", "renderamt": "100"},
                {"classname": "func_brush", "model": "*3", "rendermode": "2", "renderamt": "100"},
                {"classname": "func_illusionary", "model": "*4", "rendermode": "1", "renderamt": "100"},
                {"classname": "func_brush", "model": "*5", "renderfx": "5", "rendermode": "2", "renderamt": "9"},
                {"classname": "func_breakable_surf", "model": "*6", "rendermode": "10"},
                {"classname": "func_brush", "model": "*7", "rendermode": "5", "renderamt": "255"},
                {"classname": "func_brush", "model": "*8", "renderfx": "9"}
            ])"),
            {4},
            {{4, native_render::FadeWindow{64, 256, 0}}}
    );
    assert(renders.size() == 3);
    assert(renders.at(1).keys.mode == native_render::render_none && renders.at(1).index == 1);
    assert(renders.at(2).keys.amount == 100 && renders.at(8).index == 9);
}

void test_a_hidden_class_stays_hidden() {
    BrushFades fades;
    fades.hide(3);
    fades.update({0, 0, 0}, ahead, 0, false, [](uint32_t) { return at(0, 0, 0); }, no_chain);
    assert(fades.hidden(3) && !fades.hidden(4));
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
    test_reads_render_keys_as_the_engine_does();
    test_compute_fx_blend();
    test_hides_the_classes_cs_s_never_draws();
    test_never_draws_rendermode_10_or_a_blend_of_zero();
    test_blends_by_renderamt_and_tints_by_rendercolor();
    test_strobes_and_holograms();
    test_picks_the_brushes_whose_keys_count();
    test_a_hidden_class_stays_hidden();
    std::puts("Brush fades: windows, chains, render keys, Potato and the world's faces passed");
}
