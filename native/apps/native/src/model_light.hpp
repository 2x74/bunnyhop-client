#pragma once
#include "bunnyhop_native.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <string>
#include <unordered_map>

namespace native_render {

// The map's light on the game's own models (web model-light.ts): hands, weapons and bunnies take the light where they
// are, from the map's light cube (bh_light_cube). The player programs multiply their studio light by 1 + uMapLight, so
// zero is the look without it. Readability comes first: the light only ever dims a model, never past the mode's floor,
// and Subtle takes half of the light's colour.

enum class ModelLightMode { off, subtle, full };

using ModelLightValue = std::array<float, 3>;

// A model's light from the cube at its place (six linear RGB colours), as the offset from the studio light.
// `exposure`: the HDR look's exposure for models drawn after it (the viewmodels).
inline ModelLightValue model_light_of(const std::array<float, 18> &cube, ModelLightMode mode, float exposure) {
    // Light at and above which a model keeps its full studio light, and the limits a tint pushes a channel to.
    constexpr float full_light = .4f, tint_min = .55f, tint_max = 1.3f, near_black = 1e-5f;
    constexpr float luma_weights[3] = {.2126f, .7152f, .0722f};
    const float floor = mode == ModelLightMode::full ? .32f : .6f;
    const float tint = mode == ModelLightMode::full ? 1.f : .5f;
    float average[3] = {};
    for (size_t i = 0; i < cube.size(); i++)
        average[i % 3] += cube[i] * exposure / 6;
    const float luma = average[0] * luma_weights[0] + average[1] * luma_weights[1] + average[2] * luma_weights[2];
    // Brightness follows the eye more than the light: the square root, capped at the studio light.
    const float level = std::min(1.f, std::max(floor, std::sqrt(std::max(0.f, luma) / full_light)));
    float colour[3] = {1, 1, 1};
    if (luma > near_black) {
        for (int k = 0; k < 3; k++)
            colour[k] = std::clamp(1 + (average[k] / luma - 1) * tint, tint_min, tint_max);
        // The tint moves the colour, not the brightness.
        const float tinted = colour[0] * luma_weights[0] + colour[1] * luma_weights[1] + colour[2] * luma_weights[2];
        for (auto &channel : colour)
            channel /= tinted;
    }
    return {colour[0] * level - 1, colour[1] * level - 1, colour[2] * level - 1};
}

// Each model's light, sampled every 50 ms of the world's clock and eased with a 0.18 s time constant, so crossing into
// another leaf or out of a lamp's reach never flickers, a paused view holds and an export repeats.
class ModelLight {
public:
    void set_mode(ModelLightMode mode) {
        if (mode == mode_) return;
        mode_ = mode;
        // The new mode's light at once, not eased from the old one.
        models_.clear();
    }

    ModelLightMode mode() const { return mode_; }

    // The light for the model `key` at the Source point `at` and world time `seconds`. A model unseen for a moment
    // (a cut to another camera, a seek) starts from its new light.
    ModelLightValue
    light(const BhContext *core, const std::string &key, const float at[3], double seconds, float exposure = 1) {
        if (mode_ == ModelLightMode::off || !core) return {};
        auto found = models_.find(key);
        if (found == models_.end()) found = models_.emplace(key, Lit{}).first;
        auto &model = found->second;
        const double dt = seconds - model.stepped;
        const bool cut = !model.seen || std::abs(dt) > cut_seconds;
        if (cut || seconds - model.sampled >= sample_seconds) {
            std::array<float, 18> cube{};
            if (bh_light_cube(core, at[0], at[1], at[2], cube.data()))
                model.target = model_light_of(cube, mode_, exposure);
            model.sampled = seconds;
        }
        const float ease = cut ? 1.f : float(1 - std::exp(-std::max(0.0, dt) / ease_seconds));
        for (int k = 0; k < 3; k++)
            model.value[k] += (model.target[k] - model.value[k]) * ease;
        model.stepped = seconds;
        model.seen = true;
        return model.value;
    }

    void forget(const std::string &key) { models_.erase(key); }

private:
    static constexpr double sample_seconds = .05, ease_seconds = .18, cut_seconds = .5;

    struct Lit {
        ModelLightValue value{}, target{};
        double sampled = 0, stepped = 0;
        bool seen = false;
    };

    ModelLightMode mode_ = ModelLightMode::off;
    std::unordered_map<std::string, Lit> models_;
};

}  // namespace native_render
