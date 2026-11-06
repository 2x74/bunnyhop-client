// The knife viewmodel's hand-level pose work and inspect chain against the website (viewmodel-pose-oracle.ts): an
// attack cancelling a toss blends the fingers and the knife home at their own pace, a chain switch crossfades, the
// hand idle bends the wrist and eases two fingers, and the chain plays every press, hold and cancel as the website.
#include "viewmodel_inspect.hpp"
#include "viewmodel_pose.hpp"
#include <nlohmann/json.hpp>
#include <cassert>
#include <cstdio>
#include <fstream>

namespace {
using Json = nlohmann::json;

constexpr double pose_tolerance = 2e-4;
constexpr double time_tolerance = 1e-9;

std::vector<float> floats(const Json &values) {
    return values.get<std::vector<float>>();
}

void expect_pose(const std::vector<float> &got, const Json &want, const char *what) {
    assert(got.size() == want.size());
    for (size_t i = 0; i < got.size(); i++) {
        if (std::abs(got[i] - want[i].get<double>()) > pose_tolerance) {
            std::fprintf(
                    stderr,
                    "%s: bone %zu element %zu is %f, website %f\n",
                    what,
                    i / 12,
                    i % 12,
                    got[i],
                    want[i].get<double>()
            );
            assert(false);
        }
    }
}

void test_blends(const native_vm::KnifeRig &rig, const Json &oracle) {
    native_vm::PoseWork work;
    work.size_for(rig);
    const auto &poses = oracle.at("poses");
    auto cancelled = floats(poses.at("slash"));
    const auto toss = floats(poses.at("toss"));
    const auto &weights = oracle.at("cancel");
    const native_vm::CancelWeights groups{weights.at("fingers"), weights.at("knife"), weights.at("parts")};
    native_vm::blend_hierarchy(rig, cancelled, toss, weights.at("weight"), work, &groups);
    const auto joint_bones = oracle.at("jointBones").get<std::vector<int>>();
    const auto cancel_angles = oracle.at("cancelAngles").get<std::vector<double>>();
    const auto chain_angles = oracle.at("chainAngles").get<std::vector<double>>();
    native_vm::apply_part_angles(rig, cancelled, joint_bones, cancel_angles);
    expect_pose(cancelled, poses.at("cancel"), "cancel blend");
    auto chained = floats(poses.at("presented"));
    native_vm::blend_hierarchy(rig, chained, toss, .3, work);
    native_vm::apply_part_angles(rig, chained, joint_bones, chain_angles);
    expect_pose(chained, poses.at("chain"), "chain crossfade");
    // Through the skinning matrices the baked clips hold and back.
    std::vector<float> skin(chained.size()), world(chained.size());
    native_vm::to_skin(rig, chained, skin);
    native_vm::to_world(rig, skin, world);
    expect_pose(world, poses.at("chain"), "skin round trip");
}

void test_hand_idle(const native_vm::KnifeRig &rig, const Json &oracle) {
    auto hand = floats(oracle.at("poses").at("idle"));
    native_vm::apply_hand_idle(rig, hand, {1.3, -.7, 4, 3});
    expect_pose(hand, oracle.at("poses").at("idleHand"), "hand idle");
}

void expect_slot(const native_vm::ComboSlot &got, const Json &want, size_t frame, const char *what) {
    if (got.trick != want.at(0).get<int>() || std::abs(got.t - want.at(1).get<double>()) > time_tolerance) {
        std::fprintf(
                stderr,
                "%s frame %zu: trick %d at %f, website %d at %f\n",
                what,
                frame,
                got.trick,
                got.t,
                want.at(0).get<int>(),
                want.at(1).get<double>()
        );
        assert(false);
    }
}

const char *cue_name(native_render::InspectCue cue) {
    return cue == native_render::InspectCue::flip ? "flip" : cue == native_render::InspectCue::spin ? "spin" : "catch";
}

void test_chain(const Json &oracle) {
    std::vector<native_vm::TrickSpec> chain;
    for (const auto &spec : oracle.at("chain"))
        chain.push_back(native_vm::trick_from_json(spec));
    native_vm::InspectCombo combo;
    combo.set_chain(chain);
    native_render::InspectCueQueue cues;
    const auto &frames = oracle.at("frames");
    for (size_t f = 0; f < frames.size(); f++) {
        const auto &frame = frames[f];
        native_vm::ComboEvents events;
        events.cues = &cues;
        cues.clear();
        const auto action = frame.at("action").get<std::string>();
        if (action == "press") combo.press(events);
        if (action == "cancel") combo.cancel_attack(.12);
        if (action == "draw") combo.cancel_draw();
        combo.update(frame.at("dt").get<double>(), frame.at("held").get<bool>(), events);
        const auto pose = combo.pose();
        assert(pose.playing == !frame.at("current").is_null());
        if (pose.playing) expect_slot(pose.current, frame.at("current"), f, "trick");
        assert(pose.crossfading == !frame.at("previous").is_null());
        if (pose.crossfading) expect_slot(pose.previous, frame.at("previous"), f, "crossfading trick");
        assert(std::abs(pose.mix - frame.at("mix").get<double>()) < time_tolerance);
        assert(std::abs(pose.weight - frame.at("weight").get<double>()) < time_tolerance);
        const auto &started = frame.at("started");
        assert(events.started_count == started.size());
        for (size_t i = 0; i < events.started_count; i++)
            assert(events.started[i] == started[i].get<int>());
        const auto &heard = frame.at("cues");
        assert(cues.cues().size() == heard.size());
        for (size_t i = 0; i < heard.size(); i++)
            assert(heard[i] == cue_name(cues.cues()[i]));
    }
}

// A cancel with the knife in the fist is CS-snappy; one far out takes longer, like a catch.
void test_cancel_timing() {
    assert(native_vm::cancel_blend(0, 0) == native_vm::cancel_blend_seconds);
    assert(native_vm::cancel_blend(12, 0) == native_vm::cancel_blend_max_seconds);
    assert(native_vm::cancel_blend(0, 3.1) == native_vm::cancel_blend_max_seconds);
    const double halfway = native_vm::cancel_blend(3, 0);
    assert(halfway > native_vm::cancel_blend_seconds && halfway < native_vm::cancel_blend_max_seconds);
}
}  // namespace

int main(int argc, char **argv) {
    test_cancel_timing();
    if (argc < 2) {
        std::puts("viewmodel pose: no website oracle given, parity skipped");
        return 77;
    }
    std::ifstream file(argv[1]);
    const auto oracle = Json::parse(file);
    const auto rig = native_vm::KnifeRig::from_json(oracle.at("rig"));
    test_blends(rig, oracle);
    test_hand_idle(rig, oracle);
    test_chain(oracle);
    std::puts("viewmodel pose and inspect chain match the website");
    return 0;
}
