// Differential test: the same tick stream through the web SSJ reference and through the C++ port,
// report for report. src/ssj_oracle.ts produces the stream and the expected reports; this replays
// the stream and compares.
#include "ssj.hpp"
#include "strafe_trainer.hpp"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <nlohmann/json.hpp>
#include <cassert>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <iostream>
#include <string>

namespace {

native::SsjMode mode_from(const std::string &name) {
    if (name == "every") return native::SsjMode::every;
    if (name == "everySixth") return native::SsjMode::every_sixth;
    assert(name == "sixth");
    return native::SsjMode::sixth;
}

int failures = 0;
long compared = 0;

void fail(const std::string &where, const std::string &what) {
    if (++failures <= 20) std::cerr << "MISMATCH " << where << ": " << what << '\n';
}

template <typename T>
void same(const std::string &where, const char *field, const nlohmann::json &expected, const std::optional<T> &actual) {
    if (expected.is_null()) {
        if (actual) fail(where, std::string(field) + " should be absent, got " + std::to_string(*actual));
        return;
    }
    if (!actual) { fail(where, std::string(field) + " is absent, expected " + expected.dump()); return; }
    const auto want = expected.get<double>();
    if (double(*actual) != want)
        fail(where, std::string(field) + " is " + std::to_string(*actual) + ", expected " + expected.dump());
}

// Gain and efficiency are the only values that pass through cos and sin, whose last bit is not
// portable between implementations (see the note atop ssj.hpp). Both are rounded to two decimals
// before anyone sees them, so they are compared at that resolution rather than bit for bit.
void near(const std::string &where, const char *field, const nlohmann::json &expected, const std::optional<float> &actual) {
    if (expected.is_null()) {
        if (actual) fail(where, std::string(field) + " should be absent");
        return;
    }
    if (!actual) { fail(where, std::string(field) + " is absent, expected " + expected.dump()); return; }
    const double want = expected.get<double>();
    if (std::fabs(double(*actual) - want) > 0.0101)
        fail(where, std::string(field) + " is " + std::to_string(*actual) + ", expected " + expected.dump());
}

}  // namespace

int main(int argc, char **argv) {
    const std::string path = argc > 1 ? argv[1] : "ssj-oracle.json";
    std::ifstream file(path);
    if (!file) {
        std::cerr << "Cannot open the SSJ oracle at " << path
                  << "\nGenerate it with: bun apps/native/src/ssj_oracle.ts " << path << '\n';
        return 2;
    }
    nlohmann::json oracle;
    file >> oracle;

    for (const auto &item : oracle.at("cases")) {
        const auto mode_name = item.at("mode").get<std::string>();
        const auto seed = item.at("seed").get<long>();
        native::SsjTracker tracker(mode_from(mode_name));
        const auto &ticks = item.at("ticks");
        const auto &reports = item.at("reports");
        assert(ticks.size() == reports.size());
        for (std::size_t i = 0; i < ticks.size(); ++i) {
            const auto &t = ticks[i];
            const float position[3]{t.at("px").get<float>(), t.at("py").get<float>(), t.at("pz").get<float>()};
            const float velocity[3]{t.at("vx").get<float>(), t.at("vy").get<float>(), t.at("vz").get<float>()};
            native::SsjState pre;
            pre.position = position;
            pre.velocity = velocity;
            pre.grounded = t.at("grounded").get<bool>();
            pre.on_ladder = t.at("onLadder").get<bool>();
            native::SsjCmd cmd;
            cmd.forward = t.at("forward").get<float>();
            cmd.side = t.at("side").get<float>();
            cmd.yaw = t.at("yaw").get<float>();
            cmd.buttons = t.at("buttons").get<std::uint32_t>();
            native::SsjTick info;
            info.jumped = t.at("jumped").get<bool>();
            info.teleported = t.at("teleported").get<bool>();
            info.in_start = t.at("inStart").get<bool>();
            info.noclip = t.at("noclip").get<bool>();
            if (!t.at("time").is_null()) info.time = t.at("time").get<double>();

            const auto actual = tracker.tick(pre, cmd, info);
            const auto &expected = reports[i];
            const std::string where = mode_name + "/" + std::to_string(seed) + " tick " + std::to_string(i);
            if (expected.is_null()) {
                if (actual) fail(where, "produced a report where the reference produced none");
                continue;
            }
            if (!actual) { fail(where, "produced no report where the reference did"); continue; }
            ++compared;
            if (actual->jump != expected.at("jump").get<unsigned>())
                fail(where, "jump is " + std::to_string(actual->jump) + ", expected " + expected.at("jump").dump());
            if (actual->speed != expected.at("speed").get<int>())
                fail(where, "speed is " + std::to_string(actual->speed) + ", expected " + expected.at("speed").dump());
            same(where, "diff", expected.at("diff"), actual->diff);
            same(where, "height", expected.at("height"), actual->height);
            same(where, "strafes", expected.at("strafes"), actual->strafes);
            same(where, "sync", expected.at("sync"), actual->sync);
            near(where, "gain", expected.at("gain"), actual->gain);
            near(where, "eff", expected.at("eff"), actual->eff);
            same(where, "time", expected.at("time"), actual->time);
        }
    }

    // A stream that produced nothing would otherwise pass silently.
    if (compared < 100) {
        std::cerr << "Only " << compared << " reports were compared; the oracle looks wrong\n";
        return 1;
    }
    if (failures) {
        std::cerr << failures << " mismatches across " << compared << " reports\n";
        return 1;
    }
    std::cout << "SSJ port matches the web reference across " << compared << " reports\n";

    {   // The text line the HUD draws, independent of the oracle.
        native::SsjReport report;
        report.jump = 6;
        report.speed = 1013;
        report.diff = 87;
        report.gain = 87.56f;
        report.sync = 92.9f;
        report.strafes = 5u;
        const native::SsjFields fields;
        const auto line = native::ssj_text(report, fields);
        // Truncated, never rounded up: 87.56 shows as 87.5 and 92.9% sync as 92%.
        assert(line == "Jump 6 \xC2\xB7 1013 u/s (+87) \xC2\xB7 Gain 87.5% \xC2\xB7 Sync 92% \xC2\xB7 5 strafes");
        native::SsjReport single = report;
        single.strafes = 1u;
        assert(native::ssj_text(single, fields).find("1 strafe") != std::string::npos);
        assert(native::ssj_text(single, fields).find("1 strafes") == std::string::npos);
        native::SsjReport bare;
        bare.jump = 1;
        bare.speed = 300;
        assert(native::ssj_text(bare, fields) == "Jump 1 \xC2\xB7 300 u/s");
    }
    std::cout << "SSJ report text checks passed\n";

    {   // Every Nth jump: N, 2N, 3N ... and nothing else; 6 behaves as every 6th did.
        for (unsigned n = 1; n <= 30; ++n) {
            assert(native::ssj_shows(native::SsjMode::every_nth, n, 4) == (n % 4 == 0));
            assert(native::ssj_shows(native::SsjMode::every_nth, n) == native::ssj_shows(native::SsjMode::every_sixth, n, 6));
        }
        native::SsjTracker tracker(native::SsjMode::every_nth);
        tracker.set_interval(1);  // 1 would be "every jump"; held at 2
        assert(tracker.interval() == 2);
        tracker.jump = 3;
        tracker.set_interval(5);  // changing N starts the count over
        assert(tracker.interval() == 5 && tracker.jump == 0);
    }
    {   // Strafe trainer: turning exactly atan(30/speed) per air tick reads 100%.
        native::StrafeTrainer trainer;
        const float speed = 600, ideal = native::StrafeTrainer::ideal_degrees(speed);
        assert(std::fabs(ideal - 2.8624f) < 1e-3f);
        std::optional<float> reading;
        float yaw = 179.0f;  // crosses the 180/-180 wrap on the way
        for (unsigned t = 0; t <= native::StrafeTrainer::window; ++t) {
            if (const auto r = trainer.tick(false, speed, yaw)) reading = r;
            yaw += ideal;
            if (yaw > 180.0f) yaw -= 360.0f;
        }
        assert(reading && std::fabs(*reading - 100.0f) < 0.1f);
        assert(native::strafe_band(*reading) == 0 && native::strafe_band(80) == 1 && native::strafe_band(150) == 2);
        // Half the turn rate reads 50%; the ground starts a reading over.
        native::StrafeTrainer half;
        reading.reset();
        yaw = 0;
        half.tick(true, speed, yaw);
        for (unsigned t = 0; t < native::StrafeTrainer::window; ++t)
            if (const auto r = half.tick(false, speed, yaw += ideal / 2)) reading = r;
        assert(reading && std::fabs(*reading - 50.0f) < 0.1f);
        // Too slow to have an ideal angle: no reading.
        native::StrafeTrainer slow;
        for (unsigned t = 0; t < 40; ++t) assert(!slow.tick(false, 10, float(t)));
    }
    std::cout << "Jump stats interval and strafe trainer checks passed\n";
    return 0;
}
