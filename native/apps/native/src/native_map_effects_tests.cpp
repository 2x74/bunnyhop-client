#include "render_math.hpp"
#include <algorithm>
#include <deque>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>
#include <nlohmann/json.hpp>

// The effects only ask the core which emitters are switched on and where parents are; nothing here has either.
extern "C" const uint32_t *bh_effect_states(BhContext *, size_t *count) {
    *count = 0;
    return nullptr;
}

extern "C" int bh_model_transform(BhContext *, uint32_t, BhTransform *transform) {
    *transform = {};
    transform->visible = 1;
    return 1;
}

#include "native_map_effects.hpp"

namespace {
struct Particle {
    native_render::Vec3 position;
    float size;
    std::array<float, 4> color;
};

struct Recorder {
    std::vector<Particle> particles;

    void billboard(
            const native_render::Vec3 &p,
            float size,
            const std::array<float, 4> &color,
            const native_render::Vec3 &,
            const native_render::Vec3 &,
            int
    ) {
        particles.push_back({p, size, color});
    }

    void ribbon(
            const native_render::Vec3 &, const native_render::Vec3 &, float, const std::array<float, 4> &, const float *
    ) {}
};

void check(bool value, const std::string &label) {
    if (!value) throw std::runtime_error(label);
}

constexpr float aspect = 16.f / 9.f;
constexpr double world_seconds = 30;

nlohmann::json stack(float x, const std::string &rate = "20") {
    return {{"classname", "env_smokestack"},
            {"origin", std::to_string(x) + " 0 0"},
            {"InitialState", "1"},
            {"Rate", rate},
            {"JetLength", "100"},
            {"Speed", "50"},
            {"StartSize", "10"},
            {"EndSize", "30"},
            {"RenderColor", "255 51 0"}};
}

std::vector<Particle> draw(NativeMapEffects &effects, double yaw) {
    const float eye[3] = {-300, 0, 50};
    const auto view = native::camera_matrix(eye, yaw, 0, aspect);
    Recorder out;
    effects.draw(out, nullptr, view, eye, world_seconds, {0, -1, 0}, {0, 0, 1}, true);
    return out.particles;
}

void reads_keys_whatever_their_case() {
    NativeMapEffects effects;
    effects.load(nlohmann::json::array({stack(0)}), nlohmann::json::array());
    const auto particles = draw(effects, 0);
    // 20 a second for JetLength / Speed = 2 seconds.
    check(particles.size() == 40, "stack particle count " + std::to_string(particles.size()));
    for (const auto &p : particles) {
        check(p.color[0] == 1 && p.color[1] == .2f && p.color[2] == 0, "rendercolor");
        check(p.size >= 10 && p.size <= 30, "size between StartSize and EndSize");
        check(p.position[2] >= 0 && p.position[2] <= 100, "height within JetLength");
    }
}

void skips_stacks_out_of_view() {
    NativeMapEffects effects;
    effects.load(nlohmann::json::array({stack(0)}), nlohmann::json::array());
    check(draw(effects, 180).empty(), "a stack behind the camera still drew");
    check(draw(effects, 60).size() == 40, "a stack at the edge of the view must still draw");
}

void out_of_view_stacks_keep_their_budget() {
    // Eight full stacks use the whole 4,096 particle budget, so a ninth draws nothing, in view or not.
    auto entities = nlohmann::json::array();
    for (int i = 0; i < 8; i++)
        entities.push_back(stack(-2000.f - float(i) * 100, "512"));
    entities.push_back(stack(0, "512"));
    NativeMapEffects effects;
    effects.load(entities, nlohmann::json::array());
    check(draw(effects, 0).empty(), "the ninth stack drew past the budget");
}
}  // namespace

int main() {
    try {
        reads_keys_whatever_their_case();
        skips_stacks_out_of_view();
        out_of_view_stacks_keep_their_budget();
    } catch (const std::exception &error) {
        std::cerr << "map effects: " << error.what() << '\n';
        return 1;
    }
    return 0;
}
