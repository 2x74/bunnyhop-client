#include "ponytail_motion.hpp"
#include "nlohmann/json.hpp"
#include <cassert>
#include <fstream>
#include <iostream>

// Replays the website's ponytail over the oracle's movement stream (ponytail-oracle.ts).
int main(int argc, char **argv) {
    assert(argc == 2);
    std::ifstream file(argv[1]);
    const auto oracle = nlohmann::json::parse(file);
    native_render::PonytailMotion motion;
    const auto &steps = oracle.at("steps");
    const auto &angles = oracle.at("angles");
    constexpr double tolerance_radians = 1e-5;
    double worst = 0;
    for (size_t i = 0; i < steps.size(); ++i) {
        const auto &step = steps[i];
        const float velocity[3] = {step["velocity"][0], step["velocity"][1], step["velocity"][2]};
        native_render::advance_ponytail(
                motion, velocity, step["yaw"].get<float>(), step["dt"], step["snap"], step["length"]
        );
        worst = std::max(worst, std::abs(motion.pitch - angles[i][0].get<double>()));
        worst = std::max(worst, std::abs(motion.side - angles[i][1].get<double>()));
    }
    assert(worst < tolerance_radians);
    std::cout << "Ponytail pendulum matches the website over " << steps.size() << " steps (worst " << worst << ")\n";
}
