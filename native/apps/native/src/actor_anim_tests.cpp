#include "actor_anim.hpp"
#include <iostream>
#include <filesystem>

int main(int argc, char **argv) {
    if (argc < 2 || argc > 3) {
        std::cerr << "actor animation asset directory required\n";
        return 1;
    }
    using namespace native_actor_anim;
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
        V out;
        s.pose(i, frame["time"], frame["snap"], frame["shot"], out);
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
