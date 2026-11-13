#pragma once
// Brush models whose opacity changes while you play, as in CS:S (the website's brush-fades.ts):
//
// func_areaportalwindow (SDK 2013 c_func_areaportalwindow.cpp): the window entity draws its target's brush model
//   itself, blended by the eye's distance to the brush's box: TranslucencyLimit up to FadeStartDist (0: the brush
//   isn't there and you see the room behind it), opaque from FadeDist on. Without this the brush is a wall at every
//   distance (bhop_angst's doorway at 40 s).
// Materials whose proxies drive $alpha (the bridge's material_alpha.rs), run for each brush entity wearing one. The
//   world's own faces only run chains that need no entity (a Sine pulse).
//
// A surface below full strength draws blended without writing depth; at full strength it draws as the map's plain
// material. A brush entity whose every surface is at zero isn't drawn. Render only.
//
// Each surface's alpha and each brush's hidden flag are this frame's result. A brush's own render keys (rendermode,
// renderamt, rendercolor) can multiply into the same state in update().
#include "native_math.hpp"
#include "render_math.hpp"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <unordered_map>
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

// One surface's state this frame: below full strength it draws blended at `alpha`; `plain` draws as the map does.
struct SurfaceFade {
    float alpha = 1;
    bool plain = true;
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
        SurfaceFade fade;
    };

    // `surfaces`: the materials of `model` that fade (by `window`, their own chain or both). `whole`: they are every
    // material the model draws, so at zero the model isn't drawn at all.
    void
    add(uint32_t model,
        const Bounds &box,
        std::optional<FadeWindow> window,
        std::vector<Surface> surfaces,
        bool whole) {
        if (surfaces.empty()) return;
        for (size_t i = 0; i < surfaces.size(); i++)
            lookup_.emplace(key(model, surfaces[i].material), Where{brushes_.size(), i});
        if (model) models_.emplace(model, brushes_.size());
        brushes_.push_back({model, box, window, std::move(surfaces), whole && model != 0, false});
    }

    size_t size() const { return brushes_.size(); }

    // Sets every fade for a view from `eye` at map time `time`. In Potato a brush is simply there or not.
    void update(const Vec3 &eye, double time, bool potato, const ModelMatrix &matrix_of, const Chain &run) {
        for (auto &brush : brushes_)
            update_brush(brush, eye, time, potato, matrix_of, run);
    }

    // This frame's state of `material` on `model`, if it fades.
    const SurfaceFade *surface(uint32_t model, uint32_t material) const {
        const auto at = lookup_.find(key(model, material));
        return at == lookup_.end() ? nullptr : &brushes_[at->second.brush].surfaces[at->second.surface].fade;
    }

    // Whether `model` has faded out entirely this frame.
    bool hidden(uint32_t model) const {
        const auto at = models_.find(model);
        return at != models_.end() && brushes_[at->second].hidden;
    }

private:
    // Height of the eye above the middle of a standing player (64 - 62 / 2): PlayerProximity measures from the middle.
    static constexpr float eye_above_centre = 33;

    struct Brush {
        uint32_t model = 0;
        Bounds box;
        std::optional<FadeWindow> window;
        std::vector<Surface> surfaces;
        bool whole = false, hidden = false;
    };

    struct Where {
        size_t brush, surface;
    };

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

    void update_brush(
            Brush &brush, const Vec3 &eye, double time, bool potato, const ModelMatrix &matrix_of, const Chain &run
    ) {
        const auto matrix = brush.model ? matrix_of(brush.model) : native::Matrix{};
        double blend = 1, distance = 0;
        if (brush.window) {
            const auto &w = *brush.window;
            blend = window_blend(box_distance(brush.box, to_local(matrix, eye)), w.start, w.end, w.limit);
        }
        if (brush.model) {
            Vec3 centre{};
            for (int k = 0; k < 3; k++)
                centre[k] = (brush.box.lo[k] + brush.box.hi[k]) * .5f;
            const auto world = transform_point(matrix, centre);
            distance = std::hypot(world[0] - eye[0], world[1] - eye[1], world[2] - (eye[2] - eye_above_centre));
        }
        uint32_t noise = 0;
        double most = 0;
        for (auto &s : brush.surfaces) {
            const double own = s.chain ? run(s.material, s.vars, distance, time, brush.model, noise) : s.base;
            const double alpha = own * blend;
            most = std::max(most, alpha);
            s.fade = {float(alpha), blend >= 1 && (!s.chain || (alpha >= 1 && s.base >= 1))};
        }
        brush.hidden = brush.whole && (potato ? most < .5 : most <= 0);
    }

    std::vector<Brush> brushes_;
    std::unordered_map<uint64_t, Where> lookup_;
    std::unordered_map<uint32_t, size_t> models_;
};

}  // namespace native_render
