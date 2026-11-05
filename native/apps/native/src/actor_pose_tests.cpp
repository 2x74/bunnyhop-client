// The third-person bunny against the website's own model (actor-pose-oracle.ts): the CS:S animation, the bank into
// turns, the leg layer (planting, steps, jump phases, landings, idle shift, climb and swim) and the ears, frame by
// frame through a scripted run at mixed frame rates.
#include "actor_anim.hpp"
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>

namespace {

using native_actor_anim::LegMode;
using J = nlohmann::json;

constexpr int missing_assets_exit = 77;
// What a player sees of each bone: its rotation (matrix entries) and where its joint is (units). The CS:S pose alone is
// within ~2e-5 of the website's. Translation columns aren't compared directly: the ears turn about pivots ~60 units up,
// so a rounding-sized difference in their swing reads as thousandths of a unit there while the ear moves far less.
constexpr double rotation_tolerance = .002, joint_tolerance_units = .01;
constexpr double feet_tolerance_units = .01, pelvis_tolerance_units = 1e-4, bank_tolerance_degrees = 1e-6;
constexpr double feet_yaw_tolerance_degrees = 1e-4, seed_tolerance = 1e-12;
constexpr double probe_depth_units = 48;

void check(bool ok, const std::string &what) {
    if (!ok) throw std::runtime_error("third-person pose: " + what);
}

const char *mode_name(LegMode mode) {
    switch (mode) {
        case LegMode::ground:
            return "ground";
        case LegMode::air:
            return "air";
        case LegMode::floating:
            return "float";
        case LegMode::climb:
            return "climb";
        case LegMode::swim:
            return "swim";
    }
    return "";
}

// The oracle's floor: a gentle wave the probe finds within reach below the point it's given.
native_actor_anim::GroundProbe wave_probe(const J &floor) {
    const double wave_x = floor.at("waveX"), wave_y = floor.at("waveY");
    const double period_x = floor.at("periodX"), period_y = floor.at("periodY");
    return [=](double x, double y, double z) -> std::optional<double> {
        const double ground = wave_x * std::sin(x / period_x) + wave_y * std::cos(y / period_y);
        if (ground <= z && ground >= z - probe_depth_units) return ground;
        return std::nullopt;
    };
}

native_actor_anim::Input input_of(const J &pose) {
    native_actor_anim::Input input;
    input.position = pose.at("position").get<std::array<float, 3>>();
    input.velocity = pose.at("velocity").get<std::array<float, 3>>();
    input.yaw = pose.at("yaw");
    input.pitch = pose.at("pitch");
    input.ducking = pose.at("crouched");
    input.grounded = pose.at("grounded");
    input.sidemove = pose.at("sidemove");
    input.ladder = pose.at("ladder");
    input.water = pose.at("water");
    return input;
}

struct Worst {
    double rotation = 0, joint = 0, feet = 0;
};

// A bone's joint: its bind origin through its skinning matrix.
std::array<double, 3> joint(const float *matrix, const native_actor_anim::V &bind, size_t bone) {
    const double x = bind[bone * 12 + 3], y = bind[bone * 12 + 7], z = bind[bone * 12 + 11];
    std::array<double, 3> out{};
    for (size_t r = 0; r < 3; r++)
        out[r] = matrix[r * 4] * x + matrix[r * 4 + 1] * y + matrix[r * 4 + 2] * z + matrix[r * 4 + 3];
    return out;
}

void compare_bones(
        const native_actor_anim::V &expected,
        const native_actor_anim::V &skin,
        const native_actor_anim::V &bind,
        Worst &worst
) {
    for (size_t bone = 0; bone < skin.size() / 12; bone++) {
        const float *want = expected.data() + bone * 12, *got = skin.data() + bone * 12;
        for (size_t r = 0; r < 3; r++)
            for (size_t c = 0; c < 3; c++)
                worst.rotation = std::max(worst.rotation, std::abs(double(want[r * 4 + c]) - got[r * 4 + c]));
        const auto a = joint(want, bind, bone), b = joint(got, bind, bone);
        worst.joint = std::max(worst.joint, std::hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
    }
}

void compare_frame(
        const J &frame,
        const native_actor_anim::State &state,
        const native_actor_anim::V &skin,
        const native_actor_anim::V &bind,
        Worst &worst
) {
    const std::string at = frame.at("segment").get<std::string>() + " at " + frame.at("time").dump();
    const auto &legs = state.legs;
    check(mode_name(legs.mode) == frame.at("mode").get<std::string>(),
          at + ": the legs move in another mode than the website's");
    check(legs.steps == frame.at("steps").get<int>(), at + ": the feet step differently from the website's");
    check(std::abs(state.feetYaw - frame.at("feetYaw").get<double>()) <= feet_yaw_tolerance_degrees,
          at + ": the feet face another way");
    check(std::abs(state.bank - frame.at("bank").get<double>()) <= bank_tolerance_degrees,
          at + ": the body banks differently");
    check(std::abs(legs.pelvis_drop - frame.at("pelvisDrop").get<double>()) <= pelvis_tolerance_units,
          at + ": the pelvis sinks differently");
    const auto feet = frame.at("feet");
    for (size_t k = 0; k < legs.feet_world.size(); k++)
        worst.feet = std::max(worst.feet, std::abs(legs.feet_world[k] - feet[k].get<double>()));
    check(worst.feet <= feet_tolerance_units, at + ": the feet are somewhere else");
    if (frame.at("skin").is_null()) return;
    const auto expected = frame.at("skin").get<native_actor_anim::V>();
    check(expected.size() == skin.size() && bind.size() == skin.size(), at + ": the rigs differ");
    compare_bones(expected, skin, bind, worst);
    check(worst.rotation <= rotation_tolerance, at + ": bones turn differently by " + std::to_string(worst.rotation));
    check(worst.joint <= joint_tolerance_units, at + ": joints are " + std::to_string(worst.joint) + " units off");
}

}  // namespace

int main(int argc, char **argv) {
    try {
        check(argc == 3, "usage: actor_pose_tests ASSETS ORACLE");
        J oracle;
        std::ifstream(argv[2]) >> oracle;
        if (oracle.is_null() || !std::filesystem::exists(std::filesystem::path(argv[1]) / "actor-animations.json")) {
            std::cout << "Hosted actor assets absent; run bun run models first\n";
            return missing_assets_exit;
        }
        const auto data = std::make_unique<native_actor_anim::Data>(argv[1]);
        auto state = std::make_unique<native_actor_anim::State>(*data);
        const double seed = native_actor_anim::model_seed(oracle.at("outfit").get<std::string>(), "solid", "", "");
        check(std::abs(seed - oracle.at("seed").get<double>()) <= seed_tolerance,
              "the model's seed isn't the website's");
        state->set_seed(seed);
        state->legs.set_ground_probe(wave_probe(oracle.at("floor")));
        native_actor_anim::V skin;
        Worst worst;
        for (const auto &frame : oracle.at("frames")) {
            const auto &pose = frame.at("pose");
            state->pose(input_of(pose), frame.at("time"), frame.at("snap"), pose.at("attack").get<int>() != 0, skin);
            compare_frame(frame, *state, skin, data->bind, worst);
        }
        std::cout << oracle.at("frames").size() << " frames like the website's: rotations within " << worst.rotation
                  << ", joints within " << worst.joint << " units, feet within " << worst.feet << " units\n";
        return 0;
    } catch (const std::exception &error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
