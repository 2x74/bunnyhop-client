#include "actor_anim.hpp"
#include <iostream>
#include <filesystem>

int main(int argc, char **argv) {
    if (argc < 2 || argc > 3) {
        std::cerr << "actor animation asset directory required\n";
        return 1;
    }
    using namespace native_actor_anim;
    constexpr double frame_seconds = 1. / 60, airborne_jump_speed = 301.993, gravity = 800, airborne_limit_seconds = 2;
    if (!std::filesystem::exists(std::string(argv[1]) + "/actor-animations.json")
        || !std::filesystem::exists(std::string(argv[1]) + "/actor-animations.bin")) {
        std::cout << "Hosted actor assets absent; run bun run models first\n";
        return 77;
    }
    Data d(argv[1]);
    State s(d);
    std::ifstream f(argc == 3 ? argv[2] : std::string(argv[1]) + "/oracle.json");
    J frames;
    f >> frames;
    double maxError = 0;
    for (const auto &frame : frames) {
        const auto &j = frame["input"];
        Input i;
        i.velocity = j["vel"].get<std::array<float, 3>>();
        i.yaw = j["eyeYaw"];
        i.pitch = j["eyePitch"];
        i.ducking = j["ducking"];
        i.grounded = j["onGround"];
        i.jumped = j["jumped"];
        i.climbing = j.value("climbing", false);
        i.swimming = j.value("swimming", false);
        // The anim state alone, stepped as the oracle steps the website's (pose() adds the leg layer's verdict).
        const double time = frame["time"];
        const bool snap = frame["snap"];
        if (snap) {
            s.reset(time);
            const double elapsed = (airborne_jump_speed - i.velocity[2]) / gravity;
            if (!i.grounded && elapsed >= 0 && elapsed < airborne_limit_seconds) s.airborne(elapsed);
        }
        if (frame["shot"]) s.fire();
        s.update(snap ? 0 : frame_seconds, i, snap, time);
        s.apply();
        s.bs.build();
        if (!frame["world"].is_null()) {
            auto expected = frame["world"].get<V>();
            for (size_t k = 0; k < expected.size(); k++)
                maxError = std::max(maxError, std::abs(double(expected[k] - s.bs.world[k])));
        }
        if (std::abs(s.feetYaw - frame["feetYaw"].get<double>()) > .0001
            || std::abs(s.cycle - frame["cycle"].get<double>()) > .0001) {
            std::cerr << "state mismatch at " << frame["time"] << " cycle " << s.cycle << " expected " << frame["cycle"]
                      << "\n";
            return 1;
        }
    }
    std::cout << frames.size() << " exact web frames; max matrix error=" << maxError << "\n";
    return maxError > .002;
}
