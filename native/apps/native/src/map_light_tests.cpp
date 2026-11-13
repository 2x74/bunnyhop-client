// The map's light and fog against values from the website's own functions (model-light.ts modelLightOf,
// render.ts ldrLightmapLook, depth-fog.ts depthFogColor).
#include "map_light.hpp"
#include "model_light.hpp"
#include <cassert>
#include <cmath>
#include <cstdio>

namespace {
constexpr float tolerance = 1e-5f;

bool close_to(float a, float b) {
    return std::abs(a - b) < tolerance;
}

void expect_light(const std::array<float, 18> &cube, native_render::ModelLightMode mode, std::array<float, 3> web) {
    const auto light = native_render::model_light_of(cube, mode, 1);
    for (int k = 0; k < 3; k++) {
        if (close_to(light[k], web[k])) continue;
        std::fprintf(stderr, "model light %d: %f, web %f\n", k, light[k], web[k]);
        assert(false);
    }
}

void test_model_light() {
    using Mode = native_render::ModelLightMode;
    std::array<float, 18> dim{}, red{}, dark{};
    for (int i = 0; i < 18; i++) {
        dim[i] = .02f + float(i % 3) * .01f + float(i / 3) * .003f;
        red[i] = i % 3 == 0 ? .9f : .1f;
    }
    expect_light(dim, Mode::subtle, {-.47144282f, -.38833112f, -.30521941f});
    expect_light(dim, Mode::full, {-.75592486f, -.66717026f, -.58352083f});
    expect_light(red, Mode::subtle, {.30932779f, -.3099537f, -.3099537f});
    expect_light(red, Mode::full, {.50569766f, -.36297407f, -.36297407f});
    expect_light(dark, Mode::subtle, {-.4f, -.4f, -.4f});
    expect_light(dark, Mode::full, {-.68f, -.68f, -.68f});
}

void test_ldr_look() {
    const float light[5] = {0, .05f, .3f, 1, 5}, web[5] = {0, .06870452f, .31261293f, .98347483f, 3.98212567f};
    for (int i = 0; i < 5; i++)
        assert(std::abs(native_render::ldr_lightmap_look(light[i]) - web[i]) < 1e-4f);
}

void test_fog_color() {
    const float color[3] = {200, 100, 50}, color2[3] = {0, 50, 100}, dir[3] = {0, 0, 2}, forward[3] = {.6f, 0, .8f};
    const auto fog = native_render::fog_view_color(color, color2, dir, true, forward);
    assert(close_to(fog[0], .70588235f) && close_to(fog[1], .37254902f) && close_to(fog[2], .21568627f));
    const auto plain = native_render::fog_view_color(color, color2, dir, false, forward);
    assert(close_to(plain[0], 200.f / 255) && close_to(plain[2], 50.f / 255));
}
}  // namespace

int main() {
    test_model_light();
    test_ldr_look();
    test_fog_color();
    std::puts("map light: model light, LDR lift and fog colour match the website");
    return 0;
}
