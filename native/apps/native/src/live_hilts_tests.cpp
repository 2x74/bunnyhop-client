#include "live_hilts.hpp"
#include "nlohmann/json.hpp"
#include <cassert>
#include <fstream>
#include <iostream>

// Replays the website's living hilts over the oracle's stretch of play (live-hilts-oracle.ts): every design on three
// knives must write the same pieces, morphs, light channels and design values.
namespace {

using json = nlohmann::json;

native_hilt::V3 v3(const json &value) {
    return {value[0].get<double>(), value[1].get<double>(), value[2].get<double>()};
}

native_hilt::Pivots pivots_of(const json &p) {
    native_hilt::Pivots out;
    const auto point = [&](const char *key, native_hilt::V3 &into) {
        if (p.contains(key)) into = v3(p[key]);
    };
    point("eye", out.eye);
    point("balance", out.balance);
    point("escape", out.escape);
    point("gear", out.gear);
    point("lure", out.lure);
    point("tipRight", out.tip_right);
    point("tipLeft", out.tip_left);
    point("edgeRight", out.edge_right);
    point("edgeLeft", out.edge_left);
    out.flower_z = p.value("flower", 0.);
    out.grip_center = p.value("gripCenter", 0.);
    out.grip_half = p.value("gripHalf", 0.);
    return out;
}

native_hilt::PlayInput input_of(const json &frame) {
    native_hilt::PlayInput in;
    in.velocity = v3(frame["velocity"]);
    in.grounded = frame["grounded"];
    in.landed = frame["landed"];
    in.yaw_degrees = frame["yaw"];
    return in;
}

native_hilt::CameraInKnife camera_of(const json &frame) {
    const auto &camera = frame["camera"];
    return {v3(camera["pos"]), v3(camera["right"]), v3(camera["up"])};
}

std::vector<float> flatten(const native_hilt::Uniforms &u) {
    std::vector<float> out;
    for (const auto &m : u.piece)
        out.insert(out.end(), m.begin(), m.end());
    out.insert(out.end(), u.morph.begin(), u.morph.end());
    for (const auto &c : u.chan)
        out.insert(out.end(), c.begin(), c.end());
    for (const auto &l : u.live)
        out.insert(out.end(), l.begin(), l.end());
    return out;
}

double check_run(const json &oracle, const json &run, std::array<float, 12> knife_bind) {
    const auto design = native_hilt::design_named(run["design"].get<std::string>());
    assert(design);
    const auto pivots = pivots_of(run["pivots"]);
    native_hilt::Pieces pieces(knife_bind);
    native_hilt::PlaySignals signals;
    native_hilt::Memory memory;
    const size_t every = oracle["recordEvery"];
    double now = 0, worst = 0;
    size_t record = 0;
    const auto &frames = oracle["frames"];
    for (size_t i = 0; i < frames.size(); ++i) {
        const auto &frame = frames[i];
        if (frame["reset"].get<bool>()) {
            signals.reset();
            memory = {};
        }
        const double dt = frame["dt"];
        now += dt;
        signals.still = frame["still"];
        signals.update(dt, now, input_of(frame), frame["inspecting"]);
        native_hilt::animate(*design, signals, pieces, memory, pivots, dt);
        if (*design == native_hilt::Design::watcher)
            native_hilt::designs::watcher_look(camera_of(frame), pivots, pieces, memory);
        if (i % every) continue;
        const auto got = flatten(pieces.u);
        const auto &want = run["records"][record++];
        assert(want.size() == got.size());
        for (size_t k = 0; k < got.size(); ++k) {
            const double expected = want[k].get<double>();
            worst = std::max(worst, std::abs(got[k] - expected) / std::max(1., std::abs(expected)));
        }
    }
    return worst;
}

void check_schedule() {
    // The same event for every time inside it, whatever the frame rate.
    const auto a = native_hilt::schedule(10.0, 2, 5, 3), b = native_hilt::schedule(10.0001, 2, 5, 3);
    assert(a.index == b.index && a.at <= 10 && a.next > a.at);
    assert(native_hilt::hash1(0) >= 0 && native_hilt::hash1(-7) < 1);
    assert(!native_hilt::design_named("hilt-oak"));
    assert(native_hilt::design_named("hilt-ember") == native_hilt::Design::forge);
}

}  // namespace

int main(int argc, char **argv) {
    assert(argc == 2);
    std::ifstream file(argv[1]);
    const auto oracle = json::parse(file);
    std::array<float, 12> knife_bind{};
    for (size_t k = 0; k < 12; ++k)
        knife_bind[k] = oracle["knifeBind"][k];
    constexpr double tolerance = 2e-4;
    double worst = 0;
    for (const auto &run : oracle["runs"]) {
        const double run_worst = check_run(oracle, run, knife_bind);
        if (run_worst >= tolerance)
            std::cout << run["design"].get<std::string>() << " on " << run["knife"].get<std::string>() << ": "
                      << run_worst << "\n";
        worst = std::max(worst, run_worst);
    }
    std::cout << "worst " << worst << " over " << oracle["runs"].size() << " runs\n";
    assert(worst < tolerance);
    check_schedule();
    std::cout << "Living hilts match the website\n";
}
