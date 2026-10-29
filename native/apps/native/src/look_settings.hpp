#pragma once
// The website's graphics looks (web graphics/presets.ts and profiles.ts): Source, Plain, Enhanced and Cinematic, the
// Enhanced / Cinematic effect switches, lighting profiles, sun shadows and the sky picker. Keys are the web pref paths
// in camelCase (settings-keys.ts), with the website's defaults, so the menu's own rows drive them.
#include "nlohmann/json.hpp"
#include <algorithm>
#include <cmath>
#include <regex>
#include <stdexcept>
#include <string>
#include <string_view>

namespace native {

inline nlohmann::json default_look_settings() {
    return {{"graphicsPreset", "source"},
            {"graphicsSpatialAA", true},
            {"graphicsContactShading", false},
            {"graphicsAtmosphere", false},
            {"graphicsSunShafts", false},
            {"graphicsMapProfiles", false},
            {"graphicsAmbienceShowcase", false},
            {"graphicsLightingProfile", "map"},
            {"graphicsDirectContribution", 1.},
            {"graphicsAmbientContribution", 1.},
            {"graphicsDynamicShadows", false},
            {"graphicsShadowQuality", "medium"},
            {"graphicsShadowDistance", 1024.},
            {"graphicsShadowStrength", .18},
            {"graphicsSkyMode", "map"},
            {"graphicsSkyPackId", nullptr},
            {"graphicsSkyRotation", 0.},
            {"graphicsLightingSource", "map"}};
}

// A sky pack id: the website's rule (sky-packs/manifest.ts validateSkyPack).
inline bool valid_sky_id(std::string_view id) {
    static const std::regex pattern("^[a-z0-9][a-z0-9_-]{0,63}$");
    return std::regex_match(id.begin(), id.end(), pattern);
}

inline void look_choice(const nlohmann::json &value, std::initializer_list<std::string_view> choices) {
    if (!value.is_string()) throw std::runtime_error("Graphics choice must be text");
    const auto &text = value.get_ref<const std::string &>();
    if (std::find(choices.begin(), choices.end(), text) == choices.end())
        throw std::runtime_error("Unsupported choice: " + text);
}

inline void look_number(const nlohmann::json &value, double low, double high) {
    if (!value.is_number()) throw std::runtime_error("Graphics value must be a number");
    const double number = value.get<double>();
    if (!std::isfinite(number) || number < low || number > high)
        throw std::runtime_error("Graphics value outside supported range");
}

// Validates and stores one look key. False for keys that aren't look keys.
inline bool patch_look_setting(nlohmann::json &out, const std::string &key, const nlohmann::json &value) {
    const auto defaults = default_look_settings();
    if (!defaults.contains(key)) return false;
    if (key == "graphicsPreset")
        look_choice(value, {"source", "classic", "enhanced", "cinematic"});
    else if (key == "graphicsLightingProfile")
        look_choice(value, {"map", "auto", "balanced", "daylight", "indoor", "ambience"});
    else if (key == "graphicsShadowQuality")
        look_choice(value, {"low", "medium", "high"});
    else if (key == "graphicsSkyMode")
        look_choice(value, {"map", "procedural", "pack"});
    else if (key == "graphicsLightingSource")
        look_choice(value, {"map", "pack"});
    else if (key == "graphicsSkyPackId") {
        if (!value.is_null() && !(value.is_string() && valid_sky_id(value.get_ref<const std::string &>())))
            throw std::runtime_error("Invalid sky id");
    } else if (key == "graphicsDirectContribution" || key == "graphicsAmbientContribution")
        look_number(value, 0, 2);
    else if (key == "graphicsShadowDistance")
        look_number(value, 256, 4096);
    else if (key == "graphicsShadowStrength")
        look_number(value, 0, .4);
    else if (key == "graphicsSkyRotation")
        look_number(value, -180, 180);
    else if (!value.is_boolean())
        throw std::runtime_error("Graphics toggle must be true or false");
    out[key] = value;
    return true;
}

enum class Look { source, classic, enhanced, cinematic };
enum class LightingProfileId { map, automatic, balanced, daylight, indoor, ambience };
enum class SkyMode { map, procedural, pack };

// Appearance numbers of a lighting profile (web profiles.ts VisualProfile). Unset optionals keep the look's own.
struct VisualProfile {
    std::string_view id = "source-default-v1";
    float bloom_scale = 1, haze_distance = 9000;
    float sun_direct = 0, sky_fill = 0, baked_scale = 1;
    float exposure = 1, highlight_shoulder = 0;
    float saturation = -1, contrast = -1, haze = -1;
};

// What Enhanced and Cinematic do without a profile (web presets.ts presetConfig).
struct LookConfig {
    float bloom = .08f, saturation = 1.015f, contrast = 1;
    float reflection_scale = .5f;
};

inline LookConfig look_config(Look look) {
    if (look == Look::cinematic) return {.16f, 1.035f, 1.01f, .75f};
    return {};
}

struct LookSettings {
    Look look = Look::source;
    bool spatial_aa = true, contact_shading = false, atmosphere = false, sun_shafts = false;
    bool map_profiles = false, ambience_showcase = false;
    LightingProfileId lighting_profile = LightingProfileId::map;
    float direct_contribution = 1, ambient_contribution = 1;
    bool dynamic_shadows = false;
    int shadow_size = 1024;
    float shadow_distance = 1024, shadow_strength = .18f;
    SkyMode sky_mode = SkyMode::map;
    std::string sky_pack_id;
    float sky_rotation_degrees = 0;
    bool sky_lighting = false;

    // Enhanced or Cinematic: the post-processing chain (enhanced_look.hpp) draws the frame.
    bool composer() const { return look == Look::enhanced || look == Look::cinematic; }

    static LookSettings read(const nlohmann::json &values, bool source_look) {
        LookSettings result;
        const auto &preset = values.at("graphicsPreset").get_ref<const std::string &>();
        result.look = !source_look || preset == "classic" ? Look::classic
                      : preset == "enhanced"              ? Look::enhanced
                      : preset == "cinematic"             ? Look::cinematic
                                                          : Look::source;
        result.spatial_aa = values.at("graphicsSpatialAA");
        result.contact_shading = values.at("graphicsContactShading");
        result.atmosphere = values.at("graphicsAtmosphere");
        result.sun_shafts = values.at("graphicsSunShafts");
        result.map_profiles = values.at("graphicsMapProfiles");
        result.ambience_showcase = values.at("graphicsAmbienceShowcase");
        result.lighting_profile = profile_id(values.at("graphicsLightingProfile").get<std::string>());
        result.direct_contribution = values.at("graphicsDirectContribution");
        result.ambient_contribution = values.at("graphicsAmbientContribution");
        result.dynamic_shadows = values.at("graphicsDynamicShadows");
        const auto &quality = values.at("graphicsShadowQuality").get_ref<const std::string &>();
        result.shadow_size = quality == "low" ? 512 : quality == "high" ? 2048 : 1024;
        result.shadow_distance = values.at("graphicsShadowDistance");
        result.shadow_strength = values.at("graphicsShadowStrength");
        const auto &sky = values.at("graphicsSkyMode").get_ref<const std::string &>();
        result.sky_mode = sky == "pack" ? SkyMode::pack : sky == "procedural" ? SkyMode::procedural : SkyMode::map;
        const auto &id = values.at("graphicsSkyPackId");
        result.sky_pack_id = id.is_string() ? id.get<std::string>() : std::string();
        if (result.sky_pack_id.empty() && result.sky_mode == SkyMode::pack) result.sky_mode = SkyMode::map;
        result.sky_rotation_degrees = values.at("graphicsSkyRotation");
        result.sky_lighting = values.at("graphicsLightingSource") == "pack";
        return result;
    }

    static LightingProfileId profile_id(std::string_view name) {
        if (name == "auto") return LightingProfileId::automatic;
        if (name == "balanced") return LightingProfileId::balanced;
        if (name == "daylight") return LightingProfileId::daylight;
        if (name == "indoor") return LightingProfileId::indoor;
        if (name == "ambience") return LightingProfileId::ambience;
        return LightingProfileId::map;
    }
};

// The sky pack the look draws, or "" when it draws the map's sky (Source, Plain and Potato never draw packs).
inline std::string picked_sky(const LookSettings &settings, bool potato) {
    return settings.composer() && !potato && settings.sky_mode == SkyMode::pack ? settings.sky_pack_id : "";
}

// The Ambience showcase is art-directed for one map build (web profiles.ts AMBIENCE_SHOWCASE).
inline constexpr std::string_view ambience_map_sha = "f21bafcf44f184067d6fb690d4fbba102e28dc87490bf2d363473c4cbbb96260";

inline VisualProfile ambience_showcase_profile() {
    return {"ambience-showcase-v1", 1.8f, 4800, 1.1f, .16f, .62f, 1, 1, 1.045f, 1.02f, .10f};
}

inline VisualProfile generic_profile(LightingProfileId id) {
    switch (id) {
        case LightingProfileId::balanced:
            return {"balanced-lighting-v2", 1, 7000, .35f, .07f, .88f, 1, .45f, 1.01f, 1, .045f};
        case LightingProfileId::daylight:
            return {"cinematic-daylight-v2", 1.4f, 6000, .7f, .12f, .75f, 1, 1, 1.025f, 1.01f, .065f};
        case LightingProfileId::indoor:
            return {"indoor-night-v2", .7f, 10000, 0, .035f, 1, 1, .2f, 1, 1, .02f};
        default:
            return {};
    }
}

inline bool is_ambience_map(std::string_view map, std::string_view sha) {
    if (sha == ambience_map_sha) return true;
    return sha.empty() && (map == "bhop_ambience" || map == "bhop_ambience.bsp");
}

// Per-map tuning behind Map visual profiles (web profiles.ts PROFILES).
inline VisualProfile map_profile(std::string_view map) {
    if (map == "bhop_arcane" || map == "bhop_arcane_v1") return {"arcane-v1", .85f, 12000};
    if (map == "bhop_arcane_v2") return {"arcane-v2", .85f, 12000};
    return {};
}

// web profiles.ts resolveVisualProfile: which profile the composer looks use on `map`.
inline VisualProfile
resolve_visual_profile(const LookSettings &settings, std::string_view map, std::string_view sha, bool has_sun) {
    auto selected = settings.lighting_profile;
    if (selected == LightingProfileId::map && settings.ambience_showcase) selected = LightingProfileId::ambience;
    if (selected == LightingProfileId::ambience)
        return is_ambience_map(map, sha) ? ambience_showcase_profile() : VisualProfile{};
    if (selected == LightingProfileId::automatic) {
        if (settings.ambience_showcase && is_ambience_map(map, sha)) return ambience_showcase_profile();
        selected = has_sun ? LightingProfileId::balanced : LightingProfileId::indoor;
    }
    if (selected != LightingProfileId::map) return generic_profile(selected);
    return settings.map_profiles ? map_profile(map) : VisualProfile{};
}

}  // namespace native
