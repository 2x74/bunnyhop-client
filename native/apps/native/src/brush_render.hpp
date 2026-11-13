#pragma once
// A brush entity's render keys (rendermode, renderamt, rendercolor, renderfx) as CS:S draws them: the website's
// brush-render.ts, from SDK 2013 c_baseentity.cpp. Render only: a brush that isn't drawn is as solid as before.
//
//   ShouldDraw: rendermode 10 is never drawn.
//   ComputeFxBlend: the blend, 0..255. Without a renderfx it is 255 in rendermode 0 (renderamt is ignored) and
//   renderamt
//     in every other mode. The pulse, strobe, flicker, distort and hologram effects compute it from the map time or the
//     view, in every mode. A blend of 0 is not drawn; under 255 it blends.
//   GetColorModulation: rendercolor, in every mode, opaque brushes included.
// FadeSlow / FadeFast (5, 6) lose alpha once per rendered frame, so they depend on the frame rate: left alone, as on
// the website, and so are brushes whose keys the map changes while it runs (bh_dynamic_render_entities).
#include <nlohmann/json.hpp>
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <optional>
#include <string>
#include <unordered_set>

namespace native_render {

inline constexpr int render_none = 10;

struct RenderKeys {
    int mode = 0;
    // renderamt, 0..255.
    int amount = 255;
    // rendercolor as 0..1; none for white (no modulation).
    std::optional<std::array<float, 3>> color;
    int fx = 0;
};

namespace render_detail {
enum Fx {
    pulse_slow = 1,
    pulse_fast = 2,
    pulse_slow_wide = 3,
    pulse_fast_wide = 4,
    fade_slow = 5,
    fade_fast = 6,
    strobe_slow = 9,
    strobe_fast = 10,
    strobe_faster = 11,
    flicker_slow = 12,
    flicker_fast = 13,
    distort = 15,
    hologram = 16,
    pulse_fast_wider = 24
};

inline std::string lower(std::string text) {
    for (auto &c : text)
        c = char(std::tolower(static_cast<unsigned char>(c)));
    return text;
}

// The first value of `name`, case-insensitively.
inline std::optional<std::string> key(const nlohmann::json &entity, std::string_view name) {
    if (!entity.is_object()) return std::nullopt;
    for (const auto &[k, v] : entity.items())
        if (lower(k) == name && v.is_string()) return v.get<std::string>();
    return std::nullopt;
}

// C atoi: leading whitespace, an optional sign, digits; 0 otherwise.
inline long long atoi_of(std::string_view text) {
    size_t at = 0;
    while (at < text.size() && std::isspace(static_cast<unsigned char>(text[at])))
        ++at;
    bool negative = false;
    if (at < text.size() && (text[at] == '+' || text[at] == '-')) negative = text[at++] == '-';
    long long value = 0;
    bool digits = false;
    while (at < text.size() && text[at] >= '0' && text[at] <= '9') {
        value = std::min(value * 10 + (text[at++] - '0'), 1LL << 40);
        digits = true;
    }
    return digits ? (negative ? -value : value) : 0;
}

inline int byte(long long n) {
    return int(std::clamp(n, 0LL, 255LL));
}
}  // namespace render_detail

// CBaseEntity::KeyValue: missing keys are rendermode 0, renderamt 255, white, no effect.
inline RenderKeys render_keys(const nlohmann::json &entity) {
    using namespace render_detail;
    RenderKeys out;
    out.mode = int(atoi_of(key(entity, "rendermode").value_or("")) & 0xff);
    if (const auto amount = key(entity, "renderamt")) out.amount = byte(atoi_of(*amount));
    out.fx = int(atoi_of(key(entity, "renderfx").value_or("")) & 0xff);
    // UTIL_StringToColor32 reads numbers into a colour that starts at 0 0 0; a key with no numbers is black.
    if (const auto color = key(entity, "rendercolor")) {
        std::array<int, 3> rgb{};
        size_t found = 0, at = 0;
        while (found < 3 && at < color->size()) {
            while (at < color->size() && std::isspace(static_cast<unsigned char>((*color)[at])))
                ++at;
            const size_t end = color->find_first_of(" \t\r\n\f\v", at);
            const auto token =
                    std::string_view(*color).substr(at, end == std::string::npos ? std::string::npos : end - at);
            if (token.empty()) break;
            rgb[found++] = byte(atoi_of(token));
            at = end == std::string::npos ? color->size() : end;
        }
        if (rgb != std::array<int, 3>{255, 255, 255})
            out.color = std::array<float, 3>{rgb[0] / 255.f, rgb[1] / 255.f, rgb[2] / 255.f};
    }
    return out;
}

// Whether the blend changes while the map runs (a renderfx computed from the time or the view).
inline bool fx_is_timed(const RenderKeys &k) {
    using namespace render_detail;
    switch (k.fx) {
        case pulse_slow:
        case pulse_fast:
        case pulse_slow_wide:
        case pulse_fast_wide:
        case strobe_slow:
        case strobe_fast:
        case strobe_faster:
        case flicker_slow:
        case flicker_fast:
        case distort:
        case hologram:
        case pulse_fast_wider:
            return true;
        default:
            return false;
    }
}

inline bool fx_is_frame_fade(const RenderKeys &k) {
    return k.fx == render_detail::fade_slow || k.fx == render_detail::fade_fast;
}

struct FxInputs {
    // Map time in seconds.
    double time = 0;
    // De-syncs the effects between entities (the entity's place in the entity list; the entity index in CS:S).
    double index = 0;
    // Units from the eye to the entity's origin along the view direction (Hologram).
    double depth = 0;
    // A fresh integer in -32..31 (Distort and Hologram flicker).
    int jitter = 0;
};

// C_BaseEntity::ComputeFxBlend: the blend, 0..255 (0: not drawn, 255: drawn as its materials are).
inline int fx_blend(const RenderKeys &k, const FxInputs &in) {
    using namespace render_detail;
    const double a = k.amount, offset = in.index * 363, t = in.time;
    const auto gate = [a](double wave) {
        return 20 * wave < 0 ? 0. : a;
    };
    double blend = 0;
    switch (k.fx) {
        case pulse_slow_wide:
            blend = a + 0x40 * std::sin(t * 2 + offset);
            break;
        case pulse_fast_wide:
            blend = a + 0x40 * std::sin(t * 8 + offset);
            break;
        case pulse_fast_wider:
            blend = 0xff * std::abs(std::sin(t * 12 + offset));
            break;
        case pulse_slow:
            blend = a + 0x10 * std::sin(t * 2 + offset);
            break;
        case pulse_fast:
            blend = a + 0x10 * std::sin(t * 8 + offset);
            break;
        case strobe_slow:
            blend = gate(std::sin(t * 4 + offset));
            break;
        case strobe_fast:
            blend = gate(std::sin(t * 16 + offset));
            break;
        case strobe_faster:
            blend = gate(std::sin(t * 36 + offset));
            break;
        case flicker_slow:
            blend = gate(std::sin(t * 2) + std::sin(t * 17 + offset));
            break;
        case flicker_fast:
            blend = gate(std::sin(t * 16) + std::sin(t * 23 + offset));
            break;
        case hologram:
        case distort: {
            // Distort turns the distance fade off; both set renderamt to 180.
            constexpr double near_units = 100, fade_units = 400, renderamt = 180;
            const double distance = k.fx == distort ? 1 : in.depth;
            if (distance <= 0)
                blend = 0;
            else
                blend = (distance <= near_units ? renderamt : (1 - (distance - near_units) / fade_units) * renderamt)
                        + in.jitter;
            break;
        }
        default:
            blend = k.mode == 0 ? 255 : a;
    }
    // The engine keeps it in an int (truncated towards zero), clamped.
    return byte((long long)std::trunc(blend));
}

// Uniform 0..1 from two integers (material-alpha.ts hash01, the bridge's material_alpha.rs hash01).
inline double hash01(int64_t a, int64_t b) {
    const uint32_t x = uint32_t(a), y = uint32_t(b + 1);
    uint32_t h = (x ^ (y * 0x9e3779b9u)) * 0x85ebca6bu;
    h = (h ^ (h >> 16)) * 0xc2b2ae35u;
    return double(h ^ (h >> 16)) / 4294967296.;
}

// Brush classes CS:S never draws as brushes (brush-visibility.ts): the dust volumes draw motes instead,
// func_precipitation spawns in the "environmental" mode, and the physics clips spawn with EF_NODRAW. None is solid to
// a player.
inline std::unordered_set<uint32_t> undrawn_class_models(const nlohmann::json &entities) {
    static const std::unordered_set<std::string> classes = {
            "func_dustmotes", "func_dustcloud", "func_precipitation", "func_clip_vphysics", "func_vehicleclip"
    };
    std::unordered_set<uint32_t> models;
    if (!entities.is_array()) return models;
    for (const auto &entity : entities) {
        if (!entity.is_object() || !classes.contains(render_detail::lower(entity.value("classname", "")))) continue;
        const auto model = entity.value("model", "");
        if (model.size() < 2 || model[0] != '*' || model[1] == '0'
            || !std::all_of(model.begin() + 1, model.end(), [](char c) { return c >= '0' && c <= '9'; }))
            continue;
        models.insert(uint32_t(std::stoul(model.substr(1))));
    }
    return models;
}

}  // namespace native_render
