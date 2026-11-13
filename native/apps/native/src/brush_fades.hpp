#pragma once
// Brush models that aren't simply drawn with the map's materials, as in CS:S (the website's brush-fades.ts):
//
// func_areaportalwindow (SDK 2013 c_func_areaportalwindow.cpp): the window entity draws its target's brush model
//   itself, blended by the eye's distance to the brush's box: TranslucencyLimit up to FadeStartDist (0: the brush
//   isn't there and you see the room behind it), opaque from FadeDist on. Without this the brush is a wall at every
//   distance (bhop_angst's doorway at 40 s).
// Materials whose proxies drive $alpha (the bridge's material_alpha.rs), run for each brush entity wearing one. The
//   world's own faces only run chains that need no entity (a Sine pulse).
// The entity's render keys (brush_render.hpp): not drawn at all (rendermode 10, a blend of 0), blended by renderamt or
//   a renderfx, tinted by rendercolor. A window brush is drawn by the window entity, so its own keys don't count.
//
// A surface below full strength draws blended without writing depth; at full strength it draws as the map's plain
// material, tinted if its brush is. Render only.
#include "native_math.hpp"
#include "render_math.hpp"
#include "brush_render.hpp"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace native_render {

struct FadeWindow {
    double start = 0, end = 0, limit = 0;
};

// How opaque a window brush is from `distance` units away (c_func_areaportalwindow.cpp GetDistanceBlend).
inline double window_blend(double distance, double start, double end, double limit) {
    if (start == end) return distance >= end ? 1 : limit;
    const double t = std::clamp((distance - start) / (end - start), 0., 1.);
    return limit + (1 - limit) * t;
}

namespace fade_detail {
inline std::string lower(std::string text) {
    for (auto &c : text)
        c = char(std::tolower(static_cast<unsigned char>(c)));
    return text;
}

// An entity key, case-insensitively; empty when absent.
inline std::string key(const nlohmann::json &entity, std::string_view name) {
    if (!entity.is_object()) return {};
    for (const auto &[k, v] : entity.items())
        if (lower(k) == name && v.is_string()) return v.get<std::string>();
    return {};
}

// A key as a number, 0 when it isn't one (JavaScript's Number, as the website reads them).
inline double number(const std::string &text) {
    if (text.empty()) return 0;
    char *end = nullptr;
    const double value = std::strtod(text.c_str(), &end);
    while (end && *end == ' ')
        ++end;
    return end && *end == 0 && std::isfinite(value) ? value : 0;
}
}  // namespace fade_detail

// func_areaportalwindow windows by the brush model they draw: the first entity named by `target`, as the engine picks.
inline std::unordered_map<uint32_t, FadeWindow> areaportal_windows(const nlohmann::json &entities) {
    using namespace fade_detail;
    std::unordered_map<uint32_t, FadeWindow> out;
    if (!entities.is_array()) return out;
    for (const auto &window : entities) {
        if (lower(key(window, "classname")) != "func_areaportalwindow") continue;
        const auto name = lower(key(window, "target"));
        if (name.empty()) continue;
        const auto target = std::find_if(entities.begin(), entities.end(), [&](const auto &e) {
            return lower(key(e, "targetname")) == name;
        });
        if (target == entities.end()) continue;
        const auto model = key(*target, "model");
        if (model.size() < 2 || model[0] != '*' || model[1] == '0'
            || !std::all_of(model.begin() + 1, model.end(), [](char c) { return c >= '0' && c <= '9'; }))
            continue;
        const auto index = uint32_t(std::stoul(model.substr(1)));
        if (out.contains(index)) continue;
        out.emplace(
                index,
                FadeWindow{
                        number(key(window, "fadestartdist")),
                        number(key(window, "fadedist")),
                        std::clamp(number(key(window, "translucencylimit")), 0., 1.)
                }
        );
    }
    return out;
}

// The first entity of each brush model whose keys change how it draws (render.ts): not one the map changes while it
// runs (`changing`, entity indices), a window's brush (the window entity draws it), a func_breakable_surf, or a
// FadeSlow / FadeFast. `index` is the entity's place in the list.
struct BrushRender {
    RenderKeys keys;
    double index = 0;
};

inline std::unordered_map<uint32_t, BrushRender> brush_renders(
        const nlohmann::json &entities,
        const std::unordered_set<uint32_t> &changing,
        const std::unordered_map<uint32_t, FadeWindow> &windows
) {
    std::unordered_map<uint32_t, BrushRender> out;
    std::unordered_set<uint32_t> seen;
    if (!entities.is_array()) return out;
    for (size_t index = 0; index < entities.size(); index++) {
        const auto &e = entities[index];
        if (!e.is_object()) continue;
        const auto model_key = e.value("model", "");
        if (model_key.size() < 2 || model_key[0] != '*' || model_key[1] == '0'
            || !std::all_of(model_key.begin() + 1, model_key.end(), [](char c) { return c >= '0' && c <= '9'; }))
            continue;
        const auto model = uint32_t(std::stoul(model_key.substr(1)));
        if (!seen.insert(model).second) continue;
        if (changing.contains(uint32_t(index)) || windows.contains(model)
            || fade_detail::lower(e.value("classname", "")) == "func_breakable_surf")
            continue;
        const auto keys = render_keys(e);
        if (fx_is_frame_fade(keys)) continue;
        if (keys.mode == render_none || keys.color || fx_is_timed(keys) || (keys.mode != 0 && keys.amount < 255))
            out.emplace(model, BrushRender{keys, double(index)});
    }
    return out;
}

// One surface's state this frame: below full strength it draws blended at `alpha` (`plain` draws as the map does),
// tinted by `tint` when its brush has a rendercolor. `mask`: its texture's alpha is a mask, no part of the blend.
struct SurfaceFade {
    float alpha = 1;
    bool plain = true, mask = false;
    std::optional<std::array<float, 3>> tint;
};

// What a brush model has beyond its materials: a window, and its entity's render keys when they change how it draws.
struct BrushSpec {
    std::optional<FadeWindow> window;
    std::optional<RenderKeys> render;
    // De-syncs the timed effects between entities (the entity's place in the map's entity list).
    double index = 0;
};

class BrushFades {
public:
    // Runs material `material`'s $alpha chain once for brush `seed` (bh_material_alpha_run).
    using Chain = std::function<double(
            uint32_t material, std::vector<double> &vars, double distance, double time, uint32_t seed, uint32_t &noise
    )>;
    using ModelMatrix = std::function<native::Matrix(uint32_t model)>;

    struct Surface {
        uint32_t material = 0;
        // The material's own alpha (its VMT's $alpha).
        float base = 1;
        bool chain = false;
        std::vector<double> vars;
        // The entity's render keys apply (no $alpha chain, a VMT $color and $alpha of 1).
        bool keyed = false;
        // The texture's alpha is a mask (the bridge's base_alpha_mask), so it doesn't blend.
        bool mask = false;
        // Set by add(): it can draw below full strength.
        bool fades = false;
        SurfaceFade fade;
    };

    // Model `model` (box in its own space) as `spec` says. `candidates`: its materials that can take an opacity;
    // `used_count`: every material it draws, so a brush whose every surface fades isn't drawn at zero.
    void
    add(uint32_t model, const Bounds &box, const BrushSpec &spec, std::vector<Surface> candidates, size_t used_count) {
        Brush brush;
        brush.model = model;
        brush.box = box;
        brush.window = spec.window;
        brush.index = spec.index;
        if (spec.render) brush.timed = fx_is_timed(*spec.render);
        if (spec.render && brush.timed) brush.render = spec.render;
        if (spec.render && !brush.timed) brush.blend = fx_blend(*spec.render, {}) / 255.;
        if (spec.render && (spec.render->mode == render_none || (!brush.timed && brush.blend <= 0))) {
            // Never drawn, whatever it is made of.
            brush.undrawn = brush.hidden = true;
            push(std::move(brush));
            return;
        }
        for (auto &s : candidates) {
            const auto tint = s.keyed ? spec.render->color : std::nullopt;
            s.fades = spec.window || s.chain || (s.keyed && (brush.timed || brush.blend < 1));
            if (!s.fades && !tint) continue;
            s.fade = {1, true, s.mask, tint};
            brush.surfaces.push_back(std::move(s));
        }
        if (brush.surfaces.empty()) return;
        brush.whole = model != 0 && brush.surfaces.size() == used_count;
        push(std::move(brush));
    }

    // A brush CS:S never draws (brush_render.hpp undrawn_class_models).
    void hide(uint32_t model) {
        Brush brush;
        brush.model = model;
        brush.undrawn = brush.hidden = true;
        push(std::move(brush));
    }

    size_t size() const { return brushes_.size(); }

    // Sets every fade for a view from `eye` looking along `forward` at map time `time`. In Potato a distance fade
    // switches at half strength.
    void
    update(const Vec3 &eye,
           const Vec3 &forward,
           double time,
           bool potato,
           const ModelMatrix &matrix_of,
           const Chain &run) {
        for (auto &brush : brushes_)
            if (!brush.undrawn) update_brush(brush, eye, forward, time, potato, matrix_of, run);
    }

    // This frame's state of `material` on `model`, if it fades or is tinted.
    const SurfaceFade *surface(uint32_t model, uint32_t material) const {
        const auto at = lookup_.find(key(model, material));
        return at == lookup_.end() ? nullptr : &brushes_[at->second.brush].surfaces[at->second.surface].fade;
    }

    // Whether `model` isn't drawn this frame.
    bool hidden(uint32_t model) const {
        const auto at = models_.find(model);
        return at != models_.end() && brushes_[at->second].hidden;
    }

private:
    // Height of the eye above the middle of a standing player (64 - 62 / 2): PlayerProximity measures from the middle.
    static constexpr float eye_above_centre = 33;
    // Noise changes this often (GaussianNoise and the renderfx flicker draw a new number every frame).
    static constexpr double noise_hz = 100;

    struct Brush {
        uint32_t model = 0;
        Bounds box;
        std::optional<FadeWindow> window;
        // The keys of a brush whose blend a renderfx moves; a fixed blend is `blend`.
        std::optional<RenderKeys> render;
        double index = 0, blend = 1;
        std::vector<Surface> surfaces;
        bool timed = false, whole = false, hidden = false, undrawn = false;
    };

    struct Where {
        size_t brush, surface;
    };

    void push(Brush brush) {
        for (size_t i = 0; i < brush.surfaces.size(); i++)
            lookup_.emplace(key(brush.model, brush.surfaces[i].material), Where{brushes_.size(), i});
        if (brush.model) models_.emplace(brush.model, brushes_.size());
        brushes_.push_back(std::move(brush));
    }

    static uint64_t key(uint32_t model, uint32_t material) { return (uint64_t(model) << 32) | material; }

    // Distance from `p` (in the model's own space) to its box.
    static double box_distance(const Bounds &box, const Vec3 &p) {
        double sum = 0;
        for (int k = 0; k < 3; k++) {
            const double out = std::max({double(box.lo[k]) - p[k], 0., double(p[k]) - box.hi[k]});
            sum += out * out;
        }
        return std::sqrt(sum);
    }

    // `eye` in the model's own space (its transform is a rotation and a move).
    static Vec3 to_local(const native::Matrix &m, const Vec3 &eye) {
        const Vec3 d = {eye[0] - m[12], eye[1] - m[13], eye[2] - m[14]};
        Vec3 out{};
        for (int i = 0; i < 3; i++)
            out[i] = m[i * 4] * d[0] + m[i * 4 + 1] * d[1] + m[i * 4 + 2] * d[2];
        return out;
    }

    // A timed renderfx's blend this frame. Distort and Hologram draw from the brush's noise.
    static double timed_blend(
            const Brush &brush,
            const native::Matrix &m,
            const Vec3 &eye,
            const Vec3 &forward,
            double time,
            uint32_t &noise
    ) {
        const auto &keys = *brush.render;
        FxInputs in;
        in.time = time;
        in.index = brush.index;
        in.depth = (m[12] - eye[0]) * forward[0] + (m[13] - eye[1]) * forward[1] + (m[14] - eye[2]) * forward[2];
        if (keys.fx == 15 || keys.fx == 16) {
            const auto tick = int64_t(std::floor(time * noise_hz));
            in.jitter = int(std::floor(hash01(brush.model, tick * 64 + noise++) * 64)) - 32;
        }
        return fx_blend(keys, in) / 255.;
    }

    void update_brush(
            Brush &brush,
            const Vec3 &eye,
            const Vec3 &forward,
            double time,
            bool potato,
            const ModelMatrix &matrix_of,
            const Chain &run
    ) {
        const auto matrix = brush.model ? matrix_of(brush.model) : native::Matrix{};
        uint32_t noise = 0;
        const double blend = brush.render ? timed_blend(brush, matrix, eye, forward, time, noise) : brush.blend;
        double window = 1, distance = 0;
        if (brush.window) {
            const auto &w = *brush.window;
            window = window_blend(box_distance(brush.box, to_local(matrix, eye)), w.start, w.end, w.limit);
        }
        if (brush.model) {
            Vec3 centre{};
            for (int k = 0; k < 3; k++)
                centre[k] = (brush.box.lo[k] + brush.box.hi[k]) * .5f;
            const auto world = transform_point(matrix, centre);
            distance = std::hypot(world[0] - eye[0], world[1] - eye[1], world[2] - (eye[2] - eye_above_centre));
        }
        double most = 0, most_faded = 0;
        for (auto &s : brush.surfaces) {
            const double faded =
                    (s.chain ? run(s.material, s.vars, distance, time, brush.model, noise) : s.base) * window;
            const double alpha = faded * (s.keyed ? blend : 1);
            most = std::max(most, alpha);
            most_faded = std::max(most_faded, faded);
            s.fade.alpha = float(alpha);
            s.fade.plain =
                    !s.fades || (window >= 1 && (!s.keyed || blend >= 1) && (!s.chain || (alpha >= 1 && s.base >= 1)));
        }
        // The window entity, and an entity with a blend of its own, draw the whole brush or none of it. In Potato a
        // distance fade switches at half strength; a brush the map made see-through stays, drawn flat.
        brush.hidden = blend <= 0
                       || (potato ? window < .5 || (brush.whole && most_faded < .5)
                                  : window <= 0 || (brush.whole && most <= 0));
    }

    std::vector<Brush> brushes_;
    std::unordered_map<uint64_t, Where> lookup_;
    std::unordered_map<uint32_t, size_t> models_;
};

}  // namespace native_render
