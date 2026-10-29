#pragma once
// The sun the Enhanced and Cinematic looks light with (web graphics/lighting-state.ts) and what one frame of their
// post-processing needs (enhanced_look.hpp LookFrame). The map's own sun comes from its light_environment; with Sky
// lighting on, a sky pack's declared sun and ambient replace it. Source coordinates (Z up) throughout, except where a
// pack's sky directions are three.js Y up (sky_image.hpp).
#include "look_settings.hpp"
#include "native_math.hpp"
#include "nlohmann/json.hpp"
#include "sky_image.hpp"
#include <array>
#include <cmath>
#include <optional>
#include <sstream>
#include <string>

namespace native {

struct MapSun {
    bool present = false;
    // Toward the sun.
    std::array<float, 3> direction{.35f, .45f, .82f};
    // Linear colours: the entity's colour, its irradiance (_light) and ambient (_ambient).
    std::array<float, 3> color{1, .905f, .716f}, irradiance{1, .905f, .716f}, ambient{.418f, .552f, .604f};
};

struct SceneSun {
    bool present = false, from_pack = false;
    std::array<float, 3> direction{0, 0, 1}, color{1, 1, 1}, ambient{0, 0, 0};
};

inline float srgb_channel_to_linear(float value) {
    return value <= .04045f ? value / 12.92f : std::pow((value + .055f) / 1.055f, 2.4f);
}

// web source-light-color.ts: an HDR colour unless it's the -1 sentinel, else the LDR one, else the fallback.
inline std::array<float, 3>
source_light_color(const nlohmann::json &entity, const char *hdr, const char *ldr, std::array<float, 3> fallback) {
    auto parse = [&](const char *key) -> std::optional<std::array<float, 3>> {
        if (!entity.contains(key) || !entity.at(key).is_string()) return std::nullopt;
        std::istringstream text(entity.at(key).get<std::string>());
        std::array<float, 3> rgb{};
        for (auto &channel : rgb)
            if (!(text >> channel) || !std::isfinite(channel) || channel < 0) return std::nullopt;
        for (auto &channel : rgb)
            channel = srgb_channel_to_linear(channel / 255);
        return rgb;
    };
    if (const auto high = parse(hdr)) return *high;
    if (const auto low = parse(ldr)) return *low;
    return fallback;
}

// The map's light_environment colours. The direction stays what the renderer already reads for material detail.
inline MapSun read_map_sun(const nlohmann::json &entities, const std::array<float, 3> &direction, bool present) {
    MapSun sun;
    sun.present = present;
    sun.direction = direction;
    for (const auto &entity : entities) {
        if (entity.value("classname", "") != "light_environment") continue;
        sun.color = source_light_color(entity, "rendercolor", "_light", sun.color);
        sun.irradiance = source_light_color(entity, "_lightHDR", "_light", sun.irradiance);
        sun.ambient = source_light_color(entity, "_ambientHDR", "_ambient", sun.ambient);
        break;
    }
    return sun;
}

// Source (x, y, z) is three.js (x, z, -y).
inline std::array<float, 3> three_from_source(const std::array<float, 3> &v) {
    return {v[0], v[2], -v[1]};
}

inline std::array<float, 3> source_from_three(const std::array<float, 3> &v) {
    return {v[0], -v[2], v[1]};
}

// Turns a three.js direction about the vertical by `yaw` radians (THREE.Vector3.applyAxisAngle about +Y).
inline std::array<float, 3> turn_three(const std::array<float, 3> &v, float yaw) {
    const float c = std::cos(yaw), s = std::sin(yaw);
    return {v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c};
}

// Which light the look uses (web lighting-state.ts effectiveLightingSource): the pack's when picked, or under the
// Ambience showcase, which is art-directed around its sky.
inline bool pack_lights_scene(const LookSettings &settings, const VisualProfile &profile, bool pack_sky) {
    return pack_sky && (settings.sky_lighting || profile.id == ambience_showcase_profile().id);
}

// The sky pack's turn (web composer-pipeline.ts): lit by the map, the pack's sun is turned to where the map's sun is
// so the baked shadows agree, then the player's own rotation is added.
inline float sky_yaw(const LookSettings &settings, bool lit_by_pack, const SkyPicture &sky, const MapSun &map) {
    constexpr float degrees = 3.14159265f / 180;
    const float user = std::clamp(settings.sky_rotation_degrees, -180.f, 180.f) * degrees;
    if (!lit_by_pack && sky.lighting.has_sun && map.present) {
        const auto mapSun = three_from_source(map.direction);
        const auto &packSun = sky.lighting.sun_direction;
        return std::atan2(mapSun[0], mapSun[2]) - std::atan2(packSun[0], packSun[2]) + user;
    }
    return sky.rotation + user;
}

// web lighting-state.ts resolveLighting: the pack's sun scaled by its brightness, radiance kept under 2048.
inline SceneSun
resolve_scene_sun(const MapSun &map, const SkyPicture *pack, bool lit_by_pack, float yaw, float exposure) {
    SceneSun sun;
    if (lit_by_pack && pack && pack->lighting.has_sun) {
        constexpr float radiance_limit = 2048;
        const auto &light = pack->lighting;
        auto bounded = [&](std::array<float, 3> color, float scale) {
            float peak = 0;
            for (auto &channel : color) {
                channel *= scale;
                peak = std::max(peak, channel);
            }
            if (peak > radiance_limit)
                for (auto &channel : color)
                    channel *= radiance_limit / peak;
            return color;
        };
        sun.present = sun.from_pack = true;
        sun.direction = source_from_three(turn_three(light.sun_direction, yaw));
        sun.color = bounded(light.sun_color, light.sun_intensity * exposure);
        if (light.has_ambient) sun.ambient = bounded(light.ambient_color, light.ambient_intensity * exposure);
        return sun;
    }
    sun.present = map.present;
    sun.direction = map.direction;
    sun.color = map.color;
    sun.ambient = map.ambient;
    return sun;
}

// web sun.ts projectSun: where the sun sits on screen (0-1), if it's ahead and near the screen.
inline std::optional<std::array<float, 2>>
project_sun(const Matrix &vp, const float eye[3], const float forward[3], const std::array<float, 3> &direction) {
    constexpr float max_distance = 40000, ahead = .05f, margin = .1f;
    const float length = std::hypot(std::hypot(direction[0], direction[1]), direction[2]);
    if (length <= 0) return std::nullopt;
    float toward[3];
    for (int k = 0; k < 3; k++)
        toward[k] = direction[size_t(k)] / length;
    if (forward[0] * toward[0] + forward[1] * toward[1] + forward[2] * toward[2] <= ahead) return std::nullopt;
    const float point[3] = {
            eye[0] + toward[0] * max_distance, eye[1] + toward[1] * max_distance, eye[2] + toward[2] * max_distance
    };
    float clip[4]{};
    for (int row = 0; row < 4; row++)
        clip[row] = vp[size_t(row)] * point[0] + vp[size_t(4 + row)] * point[1] + vp[size_t(8 + row)] * point[2]
                    + vp[size_t(12 + row)];
    if (clip[3] <= 0) return std::nullopt;
    const float x = clip[0] / clip[3] * .5f + .5f, y = clip[1] / clip[3] * .5f + .5f;
    if (x <= -margin || x >= 1 + margin || y <= -margin || y >= 1 + margin) return std::nullopt;
    return std::array<float, 2>{x, y};
}

}  // namespace native
