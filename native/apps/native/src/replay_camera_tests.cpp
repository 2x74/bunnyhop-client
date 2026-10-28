#include "replay_camera.hpp"
#include <nlohmann/json.hpp>
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <fstream>
#include <iostream>
static unsigned traces = 0;

extern "C" int bh_trace_camera(BhContext *, const float[3], const float[3], float, float *fraction) {
    ++traces;
    *fraction = 1;
    return 1;
}

int main(int argc, char **argv) {
    assert(argc == 2);
    std::ifstream in(argv[1]);
    nlohmann::json oracle;
    in >> oracle;
    native::ReplayCamera chase, flyby;
    chase.set_mode("chase");
    flyby.set_mode("flyby");
    native::Input view;
    float eye[3]{};
    double seconds = 0;
    for (const auto &frame : oracle.at("frames")) {
        const auto &s = frame.at("state");
        BhState target{};
        for (int k = 0; k < 3; k++) {
            target.position[k] = s["pos"][k];
            target.velocity[k] = s["vel"][k];
        }
        target.view_offset_z = s["viewZ"];
        target.crouched = s["crouched"].get<bool>();
        target.grounded = s["grounded"].get<bool>();
        seconds += .01;
        chase.sample(nullptr, target, s["yaw"], s["pitch"], seconds, eye, view, .01);
        for (int k = 0; k < 3; k++)
            assert(std::abs(eye[k] - frame["chase"][k].get<double>()) < .001);
        flyby.sample(nullptr, target, s["yaw"], s["pitch"], seconds, eye, view, .01);
        for (int k = 0; k < 3; k++)
            assert(std::abs(eye[k] - frame["flyby"][k].get<double>()) < .001);
    }
    const unsigned n = oracle.at("n");
    std::vector<BhGhostFrame> path(n + 1);
    for (unsigned i = 0; i <= n; i++) {
        path[i].position[0] = float(i * 2);
        path[i].position[1] = float(std::sin(i * .01) * 200);
        path[i].position[2] = i % 100 < 50 ? 20 : 0;
    }
    std::vector<uint8_t> teleports(n + 1);
    teleports[750] = 1;
    chase.direct(path, 100, 0, n, nullptr, n, &teleports);
    const auto &shots = chase.shot_list();
    assert(shots.size() == oracle["shots"].size());
    for (size_t i = 0; i < shots.size(); i++) {
        const auto &expected = oracle["shots"][i];
        assert(std::abs(shots[i].from * 100 - expected["from"].get<double>()) < 1e-6
               && std::abs(shots[i].to * 100 - expected["to"].get<double>()) < 1e-6
               && shots[i].kind == expected["kind"].get<std::string>());
        if (shots[i].kind == "tripod")
            for (int k = 0; k < 3; k++)
                assert(std::abs(shots[i].at[k] - expected["at"][k].get<double>()) < .001);
    }
    native::ReplayCamera incremental;
    incremental.begin_direct(path, 100, 0, n, reinterpret_cast<BhContext *>(1), n, teleports);
    unsigned turns = 0;
    while (incremental.direct_pending()) {
        const auto before = traces;
        incremental.step_direct(1, -1);
        assert(traces - before <= 1);
        assert(++turns < 100000);
    }
    assert(turns > 100);
    assert(incremental.shot_list().size() == shots.size());
    for (size_t i = 0; i < shots.size(); i++) {
        const auto &actual = incremental.shot_list()[i];
        assert(actual.from == shots[i].from && actual.to == shots[i].to && actual.kind == shots[i].kind
               && actual.at == shots[i].at);
    }
    incremental.begin_direct(path, 100, 0, n, nullptr, n, teleports);
    incremental.step_direct(1, -1);
    incremental.cancel_direct();
    assert(!incremental.direct_pending());
    assert(incremental.shot_list().size() == shots.size());
    incremental.begin_direct({}, 100, 0, 0);
    assert(incremental.step_direct());
    assert(incremental.shot_list().empty());
    native::ReplayCamera free_path;
    assert(free_path.set_mode("path") && free_path.mode == "flyby");
    assert(free_path.set_mode("freePath") && free_path.third_person());
    assert(!free_path.set_mode("unsupported"));
    std::cout << "Web chase/flyby/eye smoothing and deterministic auto director oracle matched\n";
}
