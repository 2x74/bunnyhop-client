// The gun recoil against the website's code (gun-recoil-oracle.ts writes the frames): the springs frame by frame
// through bursts, rapid fire, a dry fire, a draw and gun changes, and where they put the gun and the hand on it.
#include "gun_recoil.hpp"
#include <cassert>
#include <cstdio>
#include <fstream>

namespace {
using Json = nlohmann::json;

constexpr double spring_tolerance = 1e-6;
constexpr double placement_tolerance = 2e-4;

native_vm::RecoilSpec spec_of(const Json &recoil) {
    return {recoil.at("kick").get<double>(),
            recoil.at("back").get<double>(),
            recoil.at("roll").get<double>(),
            recoil.at("settle").get<double>()};
}

void apply(native_vm::GunRecoil &recoil, const std::string &event, const Json &specs) {
    if (event == "shot")
        recoil.shot();
    else if (event == "dry")
        recoil.dry_fire();
    else if (event == "draw")
        recoil.stop();
    else if (event.starts_with("gun:")) {
        const auto gun = event.substr(4);
        recoil.set_gun(gun, spec_of(specs.at(gun)));
    }
}

void expect_springs(const native_vm::GunRecoil &recoil, const Json &want, const std::string &what, size_t frame) {
    for (size_t i = 0; i < 5; i++) {
        const double website = want.at(i).get<double>();
        if (std::abs(recoil.value(i) - website) > spring_tolerance) {
            std::fprintf(
                    stderr,
                    "%s frame %zu spring %zu: %f, website %f\n",
                    what.c_str(),
                    frame,
                    i,
                    recoil.value(i),
                    website
            );
            assert(false);
        }
    }
}

// Each stream: the same events before the same frames give the same springs.
void test_streams(const Json &oracle) {
    for (const auto &stream : oracle.at("streams")) {
        const auto gun = stream.at("gun").get<std::string>();
        native_vm::GunRecoil recoil;
        recoil.set_gun(gun, spec_of(stream.at("recoil")));
        const auto &frames = stream.at("frames");
        for (size_t f = 0; f < frames.size(); f++) {
            const auto &frame = frames[f];
            for (const auto &event : frame.at("events"))
                apply(recoil, event.get<std::string>(), oracle.at("recoil"));
            recoil.advance(frame.at("dt").get<double>());
            expect_springs(recoil, frame.at("springs"), gun, f);
        }
    }
}

native_vm::Matrix34 matrix_of(const Json &values) {
    native_vm::Matrix34 out{};
    for (size_t i = 0; i < out.size(); i++)
        out[i] = values.at(i).get<float>();
    return out;
}

void expect_matrix(const native_vm::Matrix34 &got, const Json &want, const char *what, size_t frame) {
    for (size_t i = 0; i < got.size(); i++) {
        if (std::abs(got[i] - want.at(i).get<double>()) > placement_tolerance) {
            std::fprintf(
                    stderr, "%s frame %zu element %zu: %f, website %f\n", what, frame, i, got[i], want[i].get<double>()
            );
            assert(false);
        }
    }
}

// The recoil moved onto the still gun lands the gun bone and the right hand where the website's fired gun has them.
void test_placement(const Json &oracle) {
    const auto &placement = oracle.at("placement");
    const auto grip = placement.at("grip").get<std::array<float, 3>>();
    native_vm::GunRecoil recoil;
    recoil.set_gun("ak47", spec_of(oracle.at("recoil").at("ak47")));
    double largest = 0;
    for (size_t f = 0; f < placement.at("frames").size(); f++) {
        const auto &frame = placement.at("frames")[f];
        if (frame.at("shot").get<bool>()) recoil.shot();
        recoil.advance(frame.at("dt").get<double>());
        expect_springs(recoil, frame.at("springs"), "placement", f);
        const auto gun = matrix_of(frame.at("gun").at(0));
        const auto moved = recoil.matrix(gun.data(), grip);
        expect_matrix(native_vm::concat(moved, gun), frame.at("gun").at(1), "gun bone", f);
        expect_matrix(native_vm::concat(moved, matrix_of(frame.at("hand").at(0))), frame.at("hand").at(1), "hand", f);
        largest = std::max(largest, std::abs(recoil.value(0)));
    }
    // The stream really kicks the gun (a few degrees at the peak).
    assert(largest > 1);
}

// Shots in quick succession climb higher than one shot alone; a single shot settles back to rest.
void test_build_up() {
    const native_vm::RecoilSpec rifle{2.2, 1.1, 1.2, 160};
    native_vm::GunRecoil single, rapid;
    single.set_gun("ak47", rifle);
    rapid.set_gun("ak47", rifle);
    constexpr double frame_seconds = 1. / 120, cycle_seconds = .1;
    double single_peak = 0, rapid_peak = 0, since_shot = cycle_seconds;
    single.shot();
    for (int f = 0; f < 120; f++) {
        if (since_shot >= cycle_seconds - 1e-9) {
            rapid.shot();
            since_shot = 0;
        }
        single.advance(frame_seconds);
        rapid.advance(frame_seconds);
        since_shot += frame_seconds;
        single_peak = std::max(single_peak, single.value(0));
        rapid_peak = std::max(rapid_peak, rapid.value(0));
    }
    assert(rapid_peak > single_peak * 1.3);
    for (int f = 0; f < 600; f++)
        single.advance(frame_seconds);
    assert(std::abs(single.value(0)) < 1e-4);
    assert(single.matrix(native_vm::identity34.data(), {0, 0, 0}) == native_vm::identity34);
}

// salt_of and the random stream are the website's (viewmodel/rand.ts).
void test_random() {
    assert(native_vm::salt_of("") == 2166136261u);
    assert(native_vm::salt_of("a") == 0xe40c292cu);
    native_vm::PresentationRandom random(0x9e3779b9u);
    const double first = random.next();
    assert(first >= 0 && first < 1);
    native_vm::PresentationRandom again(0x9e3779b9u);
    assert(again.next() == first);
    again.seed(7);
    random.seed(7);
    assert(again.next() == random.next());
}
}  // namespace

int main(int argc, char **argv) {
    if (argc < 2) {
        std::fprintf(stderr, "usage: %s gun-recoil-oracle.json\n", argv[0]);
        return 2;
    }
    std::ifstream file(argv[1]);
    const auto oracle = Json::parse(file);
    test_streams(oracle);
    test_placement(oracle);
    test_build_up();
    test_random();
    std::puts("gun recoil: ok");
}
