// The first-person feel against the website's code (viewmodel-feel-oracle.ts writes the frames), then what a player
// would notice: the same pose at any frame rate, bhop landings that never move the camera, a speed FOV that doesn't
// pump hop to hop.
#include "viewmodel_feel.hpp"
#include "reduced_motion.hpp"
#include <nlohmann/json.hpp>
#include <cassert>
#include <cstdio>
#include <fstream>
#include <memory>

namespace {
using Json = nlohmann::json;
using native_vm::FeelInput;

constexpr double matrix_tolerance = 2e-4;
constexpr double value_tolerance = 1e-6;

FeelInput input_of(const Json &frame) {
    FeelInput input;
    for (int k = 0; k < 3; k++)
        input.velocity[k] = frame.at("velocity").at(k).get<double>();
    input.grounded = frame.at("grounded").get<bool>();
    input.view_offset_z = frame.at("viewOffsetZ").get<double>();
    input.sidemove = frame.at("sidemove").get<double>();
    input.yaw = frame.at("yaw").get<double>();
    input.pitch = frame.at("pitch").get<double>();
    input.landed = frame.at("landed").get<double>();
    return input;
}

void expect_matrix(const native_vm::Matrix34 &got, const Json &want, const char *what, size_t frame) {
    for (int i = 0; i < 12; i++) {
        if (std::abs(got[i] - want.at(i).get<double>()) > matrix_tolerance) {
            std::fprintf(
                    stderr,
                    "%s frame %zu element %d: %f, website %f\n",
                    what,
                    frame,
                    i,
                    got[i],
                    want.at(i).get<double>()
            );
            assert(false);
        }
    }
}

void expect_near(double got, double want, double tolerance, const char *what, size_t frame) {
    if (std::abs(got - want) > tolerance) {
        std::fprintf(stderr, "%s frame %zu: %f, website %f\n", what, frame, got, want);
        assert(false);
    }
}

// The knife feel, a rifle's and a pistol's own motion, and both in-eye cameras, frame by frame.
void test_frames(const Json &oracle) {
    const std::array<float, 3> pivot = {
            oracle.at("pivot").at(0).get<float>(),
            oracle.at("pivot").at(1).get<float>(),
            oracle.at("pivot").at(2).get<float>()
    };
    auto view = std::make_unique<native_vm::ViewFeel>();
    auto rifle = std::make_unique<native_vm::GunMotion>();
    auto pistol = std::make_unique<native_vm::GunMotion>();
    native_vm::EyeFeel eye, eye_off;
    rifle->bob = .5;
    pistol->bob = 1;
    pistol->sway = .6;
    double clock = 0;
    const auto &frames = oracle.at("frames");
    for (size_t f = 0; f < frames.size(); f++) {
        const auto &frame = frames[f];
        const double dt = frame.at("dt").get<double>();
        const auto input = input_of(frame);
        clock += dt;
        expect_matrix(view->update(dt, input, .5, 1, clock), frame.at("feel"), "knife feel", f);
        expect_matrix(rifle->update(dt, native_vm::GunClass::rifle, &input, pivot), frame.at("rifle"), "rifle", f);
        const bool pistol_input = frame.at("pistolInput").get<bool>();
        const auto &pistol_matrix =
                pistol->update(dt, native_vm::GunClass::pistol, pistol_input ? &input : nullptr, pivot);
        expect_matrix(pistol_matrix, frame.at("pistol"), "pistol", f);
        const double speed = std::hypot(input.velocity[0], input.velocity[1]);
        eye.update(dt, input.landed, speed + (f >= 300 && f < 420 ? 400 : 0), true, true);
        eye_off.update(dt, input.landed, speed, false, f >= 400);
        expect_near(eye.z, frame.at("eye").at(0).get<double>(), value_tolerance, "eye settle", f);
        expect_near(eye.fov, frame.at("eye").at(1).get<double>(), value_tolerance, "speed fov", f);
        expect_near(eye_off.z, frame.at("eyeOff").at(0).get<double>(), value_tolerance, "eye settle off", f);
        expect_near(eye_off.fov, frame.at("eyeOff").at(1).get<double>(), value_tolerance, "speed fov alone", f);
    }
}

// Under prefers-reduced-motion (reduced_motion.hpp): the rifle's own motion at 45%, the eye's settle at 45% and no
// speed FOV, as the website's GunMotion and EyeFeel do it.
void test_reduced_motion_frames(const Json &oracle) {
    const std::array<float, 3> pivot = {
            oracle.at("pivot").at(0).get<float>(),
            oracle.at("pivot").at(1).get<float>(),
            oracle.at("pivot").at(2).get<float>()
    };
    auto rifle = std::make_unique<native_vm::GunMotion>();
    native_vm::EyeFeel eye;
    rifle->bob = .5;
    rifle->motion = native::reduced_motion_scale;
    const auto &frames = oracle.at("frames");
    const auto &reduced = oracle.at("reduced");
    double lowest_settle = 0, widest_fov = 0;
    for (size_t f = 0; f < frames.size(); f++) {
        const auto &frame = frames[f];
        const double dt = frame.at("dt").get<double>();
        const auto input = input_of(frame);
        const auto &rifle_matrix = rifle->update(dt, native_vm::GunClass::rifle, &input, pivot);
        expect_matrix(rifle_matrix, reduced[f].at("rifle"), "reduced-motion rifle", f);
        const double speed = std::hypot(input.velocity[0], input.velocity[1]);
        eye.update(dt, input.landed, speed + (f >= 300 && f < 420 ? 400 : 0), true, true, native::reduced_motion_scale);
        expect_near(eye.z, reduced[f].at("eye").at(0).get<double>(), value_tolerance, "reduced-motion settle", f);
        expect_near(eye.fov, reduced[f].at("eye").at(1).get<double>(), value_tolerance, "reduced-motion fov", f);
        lowest_settle = std::min(lowest_settle, eye.z);
        widest_fov = std::max(widest_fov, eye.fov);
    }
    // The hard landings still settle the camera, a little; the speed FOV never shows.
    assert(lowest_settle < 0 && widest_fov == 0);
}

void test_hand_idle(const Json &oracle) {
    native_vm::HandIdle hand;
    const auto &frames = oracle.at("hand");
    for (size_t f = 0; f < frames.size(); f++) {
        const auto &frame = frames[f];
        hand.update(frame.at("dt").get<double>(), frame.at("idle").get<bool>());
        const auto pose = hand.pose(frame.at("clock").get<double>(), frame.at("amount").get<double>());
        expect_near(pose.flex, frame.at("flex").get<double>(), value_tolerance, "wrist flex", f);
        expect_near(pose.deviation, frame.at("deviation").get<double>(), value_tolerance, "wrist deviation", f);
        expect_near(pose.index, frame.at("index").get<double>(), value_tolerance, "index ease", f);
        expect_near(pose.pinky, frame.at("pinky").get<double>(), value_tolerance, "pinky ease", f);
    }
}

// The grip idle while the gun is idle: a shot and a click put it back at once, a reload's end settles the support hand.
// `motion`: the reduced-motion scale the website's animator was built under (gripReduced: 45%).
void test_grip_idle(const Json &oracle, const char *key, double motion) {
    native_vm::GripIdle grip;
    std::string clip = "idle";
    const auto &frames = oracle.at(key);
    for (size_t f = 0; f < frames.size(); f++) {
        const auto &frame = frames[f];
        const auto event = frame.at("event").get<std::string>();
        if (!event.empty()) grip.quiet_reset();
        grip.update(frame.at("dt").get<double>());
        const auto now = frame.at("clip").get<std::string>();
        if (clip == "reload" && now == "idle") grip.clip_ended(true);
        clip = now;
        if (now != "idle") continue;
        const auto pose = grip.pose(motion);
        expect_near(pose.index_off, frame.at("indexOff").get<double>(), value_tolerance, "trigger finger", f);
        expect_near(pose.left_open, frame.at("leftOpen").get<double>(), value_tolerance, "support fingers", f);
    }
}

// A run at 30 fps and at 240 fps through a hard landing ends on the same pose.
void test_frame_rate_parity() {
    auto at_rate = [](double fps) {
        auto view = std::make_unique<native_vm::ViewFeel>();
        native_vm::LandingWatch landing;
        const double dt = 1 / fps;
        double time = 0;
        while (time < 1.6 - 1e-9) {
            time += dt;
            const bool falling = time < 1;
            landing.tick(!falling, falling ? -1100 : 0);
            FeelInput input;
            input.velocity = {280, 60, falling ? -1100. : 0.};
            input.grounded = !falling;
            input.yaw = 40 * time;
            input.landed = landing.take();
            view->update(dt, input, .5, 1, time);
        }
        return view->value();
    };
    const auto slow = at_rate(30), fast = at_rate(240);
    for (int i = 0; i < 12; i++)
        assert(std::abs(slow[i] - fast[i]) < (i % 4 == 3 ? .1 : .007));
}

void test_eye_settle_and_speed_fov() {
    native_vm::EyeFeel eye;
    constexpr double frame = 1. / 120;
    eye.update(frame, -300, 0, true, true);
    for (int i = 0; i < 60; i++)
        eye.update(frame, 0, 0, true, true);
    assert(eye.z == 0);
    eye.update(frame, -1250, 0, true, true);
    double lowest = 0;
    for (int i = 0; i < 54; i++) {
        eye.update(frame, 0, 0, true, true);
        lowest = std::min(lowest, eye.z);
        assert(eye.z <= 0);
    }
    assert(lowest < -1.6 && lowest >= -native_vm::EyeFeel::settle_max_units);
    assert(eye.z > -.05);
    for (int i = 0; i < 360; i++)
        eye.update(frame, 0, 760, false, true);
    assert(std::abs(eye.fov - native_vm::EyeFeel::speed_fov_degrees) < .05);
    for (int i = 0; i < 60; i++)
        eye.update(frame, 0, i % 2 ? 600 : 760, false, true);
    assert(eye.fov > 2.9);
    for (int i = 0; i < 600; i++)
        eye.update(frame, 0, 540, false, true);
    assert(eye.fov == 0);
}

// Landings between frames: the hardest since the last frame, counted once.
void test_landing_watch() {
    native_vm::LandingWatch landing;
    landing.tick(false, -400);
    landing.tick(false, -900);
    landing.tick(true, 0);
    landing.tick(true, 0);
    assert(landing.take() == -900 && landing.take() == 0);
    landing.tick(false, 200);
    assert(landing.take() == 0);
}
}  // namespace

int main(int argc, char **argv) {
    test_frame_rate_parity();
    test_eye_settle_and_speed_fov();
    test_landing_watch();
    if (argc < 2) {
        std::puts("viewmodel feel: no website oracle given, parity skipped");
        return 77;
    }
    std::ifstream file(argv[1]);
    const auto oracle = Json::parse(file);
    test_frames(oracle);
    test_reduced_motion_frames(oracle);
    test_hand_idle(oracle);
    test_grip_idle(oracle, "grip", 1);
    test_grip_idle(oracle, "gripReduced", native::reduced_motion_scale);
    std::puts("viewmodel feel matches the website");
    return 0;
}
