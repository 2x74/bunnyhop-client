#pragma once
#include "bunnyhop_native.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <vector>

namespace native_render {

// The map's own light and fog as the website draws them (render.ts, depth-fog.ts, map-props.ts).

inline constexpr float fog_color_scale = 1.f / 255;

// The fog colour for a view (web depth-fog.ts depthFogColor): `color`, or with `blend` mixed with `color2` by how far
// the view `forward` (unit, Source axes) faces `dir`.
inline std::array<float, 3>
fog_view_color(const float color[3], const float color2[3], const float dir[3], bool blend, const float forward[3]) {
    float t = 1;
    if (blend) {
        const float length = std::hypot(dir[0], dir[1], dir[2]);
        const float facing = forward[0] * dir[0] + forward[1] * dir[1] + forward[2] * dir[2];
        t = .5f * facing / (length > 0 ? length : 1.f) + .5f;
    }
    std::array<float, 3> out{};
    for (int k = 0; k < 3; k++)
        out[k] = (color[k] * t + color2[k] * (1 - t)) * fog_color_scale;
    return out;
}

// Linear light as an LDR map's lightmaps show it (web render.ts ldrLightmapLook): their texels are Source's
// 0.5 * L^(1/2.2) read back as sRGB, so props on those maps take the same curve and match the wall behind them.
inline float ldr_lightmap_look(float light) {
    constexpr float texel_half = .5f, gamma = 1 / 2.2f, max_overbright = 4, srgb_half = .21763764f;
    const float t = texel_half * std::pow(std::clamp(light, 0.f, max_overbright), gamma);
    const float linear = t <= .04045f ? t / 12.92f : std::pow((t + .055f) / 1.055f, 2.4f);
    return linear / srgb_half;
}

// The static props' light (bh_prop_light), with the lightmaps' LDR curve on LDR maps. Negative entries (no light)
// stay negative: the shader draws those with the stand-in shading.
inline std::vector<float> prop_light_colors(const float *values, size_t count, bool hdr) {
    std::vector<float> colors(values, values + count);
    if (!hdr)
        for (auto &value : colors)
            if (value >= 0) value = ldr_lightmap_look(value);
    return colors;
}

using LightCube = std::array<float, 18>;

// Animated props take the map's light cube at their place once (web map-props.ts: the first of 16, 0 and 48 units
// above the origin that has light), turned per vertex by the shader.
class PropCubes {
public:
    void reset(size_t instances) {
        cubes_.assign(instances, {});
        state_.assign(instances, unsampled);
    }

    const LightCube *at(const BhContext *core, size_t instance, const float origin[3], bool hdr) {
        if (instance >= state_.size()) return nullptr;
        if (state_[instance] == unsampled) state_[instance] = sample(core, cubes_[instance], origin, hdr);
        return state_[instance] == lit ? &cubes_[instance] : nullptr;
    }

private:
    static constexpr unsigned char unsampled = 0, lit = 1, unlit = 2;
    std::vector<LightCube> cubes_;
    std::vector<unsigned char> state_;

    static unsigned char sample(const BhContext *core, LightCube &cube, const float origin[3], bool hdr) {
        for (const float lift : {16.f, 0.f, 48.f}) {
            if (!bh_light_cube(core, origin[0], origin[1], origin[2] + lift, cube.data())) continue;
            if (!hdr)
                for (auto &value : cube)
                    value = ldr_lightmap_look(value);
            return lit;
        }
        return unlit;
    }
};

}  // namespace native_render
