#include "gun_hold.hpp"
#include <cassert>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <vector>

// Replays the website's two-handed gun hold over the oracle's stream (gun-hold-oracle.ts): the arm bones, the gun's
// two bones and the muzzle must match frame by frame.
namespace {
using Json = nlohmann::json;

constexpr double tolerance_units = 2e-3;

double worst = 0;

void near(double a, double b, const char *what, size_t frame) {
    const double error = std::abs(a - b);
    worst = std::max(worst, error);
    if (error > tolerance_units) {
        std::fprintf(stderr, "%s differs at frame %zu: %.6f vs %.6f\n", what, frame, a, b);
        assert(false);
    }
}

void replay(const Json &run, const native_gun::Rig &rig, double jitter) {
    const auto data = native_gun::parse_hold(run.at("hold"));
    native_gun::GunHold hold(rig);
    hold.set_gun(&data, true);
    hold.silenced = run.at("silenced").get<bool>();
    const auto id = run.at("id").get<std::string>();
    const auto &frames = run.at("frames");
    std::vector<float> skinning(rig.names.size() * 12);
    for (size_t frame = 0; frame < frames.size(); ++frame) {
        const auto &expected = frames[frame];
        for (size_t bone = 0; bone < rig.names.size(); ++bone)
            for (size_t i = 0; i < 12; ++i)
                skinning[bone * 12 + i] = (i == 0 || i == 5 || i == 10) ? 1.f : 0.f;
        if (expected.at("shot").get<bool>()) hold.shot(jitter, jitter);
        if (expected.at("reload").get<bool>()) {
            const bool shell = data.shell_seconds.has_value();
            hold.reload(shell ? *data.shell_seconds : data.reload_seconds.value_or(2), shell, id == "ak47");
        }
        native_gun::HoldInput input;
        input.yaw = expected.at("yaw").get<double>();
        input.pitch = expected.at("pitch").get<double>();
        input.dt = expected.at("dt").get<double>();
        input.snap = expected.at("snap").get<bool>();
        hold.apply(skinning, input);
        const auto &want = expected.at("skinning");
        for (size_t i = 0; i < skinning.size(); ++i)
            near(skinning[i], want[i].get<double>(), "skinning", frame);
        for (size_t i = 0; i < hold.skin.size(); ++i)
            near(hold.skin[i], expected.at("skin")[i].get<double>(), "gun bone", frame);
        for (size_t i = 0; i < 3; ++i)
            near(hold.muzzle[i], expected.at("muzzle")[i].get<double>(), "muzzle", frame);
    }
}
}  // namespace

int main(int argc, char **argv) {
    if (argc < 2) {
        std::fprintf(stderr, "usage: gun_hold_tests ORACLE.json\n");
        return 2;
    }
    std::ifstream file(argv[1]);
    const auto oracle = Json::parse(file);
    const auto &rig_json = oracle.at("rig");
    const auto names = rig_json.at("names").get<std::vector<std::string>>();
    const auto parents = rig_json.at("parent").get<std::vector<int>>();
    const auto bind = rig_json.at("bind").get<std::vector<float>>();
    native_gun::Rig rig{
            names, parents, bind, rig_json.at("csBones").get<size_t>(), native_gun::parse_fists(oracle.at("fists"))
    };
    for (const auto &run : oracle.at("runs"))
        replay(run, rig, oracle.at("jitter").get<double>());
    std::printf("Gun hold: %zu guns match the website (worst %.2e units)\n", oracle.at("runs").size(), worst);
    return 0;
}
