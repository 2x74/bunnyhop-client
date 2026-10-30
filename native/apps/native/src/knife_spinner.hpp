#pragma once
#include "nlohmann/json.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <span>
#include <string>
#include <vector>

namespace native_render {

// The Whirligig's spinner (viewmodel/knives/whirligig.ts). The baked clips carry its kicks on the draw, the swings and
// the inspects; the thumb's idle flicks run on the wall clock, as on the website, so they turn the bone at draw time.
struct KnifeSpinner {
    size_t bone = 0;
    std::array<float, 3> axis{1, 0, 0}, pivot{};
    std::vector<std::string> knives;
    double period_seconds = 6.5, tau_seconds = .85;
    int thirds = 15;

    bool spins(const std::string &knife) const {
        return std::find(knives.begin(), knives.end(), knife) != knives.end();
    }
};

inline KnifeSpinner parse_knife_spinner(const nlohmann::json &metadata) {
    KnifeSpinner spinner;
    if (!metadata.contains("spinner")) return spinner;
    const auto &raw = metadata.at("spinner");
    spinner.bone = raw.at("bone").get<size_t>();
    spinner.axis = raw.at("axis").get<std::array<float, 3>>();
    spinner.pivot = raw.at("pivot").get<std::array<float, 3>>();
    spinner.knives = raw.at("knives").get<std::vector<std::string>>();
    spinner.period_seconds = raw.at("period").get<double>();
    spinner.tau_seconds = raw.at("tau").get<double>();
    spinner.thirds = raw.at("thirds").get<int>();
    return spinner;
}

// The idle spinner angle (degrees) at `seconds` (whirligig.ts whirlIdle): a flick every period that spins down. Each
// flick turns it a whole number of thirds and the spinner is three-fold symmetric, so the wrap at a period never shows.
inline double whirl_idle_degrees(const KnifeSpinner &spinner, double seconds) {
    constexpr double degrees_per_third = 120;
    if (!std::isfinite(seconds) || spinner.period_seconds <= 0) return 0;
    const double into = seconds - std::floor(seconds / spinner.period_seconds) * spinner.period_seconds;
    const double settled = 1 - std::exp(-spinner.period_seconds / spinner.tau_seconds);
    return spinner.thirds * degrees_per_third * ((1 - std::exp(-into / spinner.tau_seconds)) / settled);
}

// Turns the spinner's skinning matrix (row-major 3x4, bone-to-model times inverse bind) by `degrees` about its axle:
// skin * rotation about the bind-space axle, the website's rotation by -angle about the bone's local x.
inline void turn_spinner(std::span<float> pose, const KnifeSpinner &spinner, double degrees) {
    const size_t at = spinner.bone * 12;
    if (at + 12 > pose.size() || degrees == 0) return;
    const double angle = -degrees * 3.141592653589793 / 180;
    const double c = std::cos(angle), s = std::sin(angle), t = 1 - c;
    const double x = spinner.axis[0], y = spinner.axis[1], z = spinner.axis[2];
    const double r[3][3] = {
            {t * x * x + c, t * x * y - s * z, t * x * z + s * y},
            {t * x * y + s * z, t * y * y + c, t * y * z - s * x},
            {t * x * z - s * y, t * y * z + s * x, t * z * z + c}
    };
    double offset[3];
    for (int row = 0; row < 3; ++row)
        offset[row] = spinner.pivot[row]
                      - (r[row][0] * spinner.pivot[0] + r[row][1] * spinner.pivot[1] + r[row][2] * spinner.pivot[2]);
    std::array<float, 12> turned{};
    for (int row = 0; row < 3; ++row) {
        const float *skin = &pose[at + size_t(row) * 4];
        for (int column = 0; column < 3; ++column)
            turned[size_t(row) * 4 + column] =
                    float(skin[0] * r[0][column] + skin[1] * r[1][column] + skin[2] * r[2][column]);
        turned[size_t(row) * 4 + 3] = float(skin[0] * offset[0] + skin[1] * offset[1] + skin[2] * offset[2] + skin[3]);
    }
    std::copy(turned.begin(), turned.end(), pose.begin() + std::ptrdiff_t(at));
}

}  // namespace native_render
