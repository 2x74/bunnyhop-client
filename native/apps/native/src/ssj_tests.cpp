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
    {   // Strafe trainer, per tick by default: the first air tick after one with a yaw reads.
        using T = native::StrafeTrainer;
        const std::uint32_t right = T::right_bit, left = T::left_bit;
        const float speed = 600, ideal = T::ideal_degrees(speed);
        assert(std::fabs(ideal - 2.8624f) < 1e-3f);
        T trainer;
        assert(!trainer.tick(false, speed, 179.0f, right));  // nothing to compare the yaw with yet
        auto r = trainer.tick(false, speed, 179.0f + ideal - 360.0f, right);  // across the 180/-180 wrap
        assert(r && std::fabs(r->percent - 100.0f) < 0.1f && !r->hint);
        r = trainer.tick(false, speed, 179.0f + 1.5f * ideal - 360.0f, right);  // half a tick's worth
        assert(r && std::fabs(r->percent - 50.0f) < 0.1f);  // per tick: no averaging by default
        assert(native::strafe_band(100) == 0 && native::strafe_band(80) == 1 && native::strafe_band(150) == 2);

        // Smoothing is a rolling mean of the last N air ticks, still one reading per tick.
        T smooth;
        smooth.set_smoothing(2);
        float yaw = 0;
        smooth.tick(false, speed, yaw, right);
        r = smooth.tick(false, speed, yaw += ideal, right);
        assert(r && std::fabs(r->percent - 100.0f) < 0.1f);
        r = smooth.tick(false, speed, yaw += ideal * 0.5f, right);
        assert(r && std::fabs(r->percent - 75.0f) < 0.1f);
        smooth.set_smoothing(0);
        assert(smooth.smoothing() == 1);

        // Hints wait for a full window, then say what's wrong over it.
        auto run = [&](float rate, std::uint32_t keys) {
            T t;
            float y = 0;
            std::optional<native::StrafeReading> last;
            t.tick(false, speed, y, keys);
            for (unsigned i = 0; i < T::hint_window; ++i) {
                last = t.tick(false, speed, y += ideal * rate, keys);
                if (i + 1 < T::hint_window) assert(last && !last->hint);
            }
            return last->hint;
        };
        assert(!run(1.0f, right));
        assert(run(0.5f, right) == native::StrafeHint::strafe_more);
        assert(run(1.6f, right) == native::StrafeHint::strafe_less);
        assert(run(1.0f, 0) == native::StrafeHint::less_deadtime);           // no key
        assert(run(1.0f, left | right) == native::StrafeHint::less_deadtime);  // both cancel
        assert(std::string(native::strafe_hint_text(native::StrafeHint::strafe_more)) == "Strafe more!");

        // Too slow to have an ideal angle: no reading. A long stand starts over.
        T slow;
        for (unsigned t = 0; t < 40; ++t) assert(!slow.tick(false, 10, float(t), right));
        T chain;
        yaw = 0;
        chain.tick(false, speed, yaw, 0);
        for (unsigned i = 0; i < T::hint_window; ++i) chain.tick(false, speed, yaw += ideal, 0);
        for (unsigned i = 0; i <= T::ground_reset; ++i) assert(!chain.tick(true, speed, yaw, 0));
        r = chain.tick(false, speed, yaw += ideal, right);
        assert(r && !r->hint);  // the dead air from before the stand is gone
    }
    {
        using T=native::StrafeTrainer;
        const float speed=300,ideal=T::ideal_degrees(speed);
        T wonly;float yaw=90;
        wonly.tick(false,speed,yaw,450.f,0.f);
        std::optional<native::StrafeReading> reading;
        for(unsigned i=0;i<T::hint_window;++i)reading=wonly.tick(false,speed,yaw+=ideal,450.f,0.f);
        assert(reading&&std::fabs(reading->percent-100)<.1f&&!reading->hint);
        // Filtered D in W-only has no effective movement, regardless of the original physical keys.
        T filtered;filtered.tick(false,speed,90,0.f,0.f);yaw=90;
        for(unsigned i=0;i<T::hint_window;++i)reading=filtered.tick(false,speed,yaw+=ideal,0.f,0.f);
        assert(reading&&reading->hint==native::StrafeHint::less_deadtime);

        // The reported W-only gain must use zeroed D, not the unfiltered side wish.
        float pos[3]={0,0,100},vel[3]={300,0,0};
        native::SsjState pre{pos,vel,true,false};
        native::SsjTracker live(native::SsjMode::every),replay(native::SsjMode::every),raw(native::SsjMode::every);
        const native::SsjCmd start{450,0,90,native::ssj_in_forward|native::ssj_in_jump};
        const native::SsjCmd effective{0,0,90,0},unfiltered{0,450,90,native::ssj_in_moveright};
        native::SsjTick info;info.jumped=true;
        live.tick(pre,start,info);replay.tick(pre,start,info);raw.tick(pre,start,info);
        pre.grounded=false;info.jumped=false;
        for(int i=0;i<30;++i){live.tick(pre,effective,info);replay.tick(pre,effective,info);raw.tick(pre,unfiltered,info);}
        pre.grounded=true;info.jumped=true;
        const auto a=live.tick(pre,start,info),b=replay.tick(pre,start,info),c=raw.tick(pre,start,info);
        assert(a&&b&&c&&a->gain==b->gain&&a->sync==b->sync&&a->strafes==b->strafes);
        assert(a->gain!=c->gain||a->sync!=c->sync||a->strafes!=c->strafes);
    }
    {
        native::MovementFeedback f;
        f.ssj.jump=6;f.ssj_line="stale";f.ssj_good=true;f.ssj_was_in_start=true;f.ssj_was_noclip=true;
        f.strafe_ground_ticks=99;f.strafe_reading=native::StrafeReading{100,native::StrafeHint::less_deadtime};
        f.strafe_trainer.tick(false,300,90,450.f,0.f);
        f.reset(false,false,true);
        assert(f.ssj.jump==0&&f.ssj_line.empty()&&!f.ssj_good&&!f.strafe_reading);
        assert(f.strafe_ground_ticks==0&&!f.ssj_was_in_start&&!f.ssj_was_noclip);
        assert(!f.strafe_trainer.tick(false,300,200,450.f,0.f)); // no stale yaw
        for(int i=0;i<100;++i)assert(!f.history_ready(false,false,false));
        for(unsigned i=0;i<native::bhop_frames+1;++i)assert(!f.history_ready(true,false,false));
        assert(f.history_ready(true,false,false));
        f.reset(false,false,true);assert(!f.history_ready(false,true,false));assert(f.history_ready(true,true,false));
        f.reset(false,false,true);assert(!f.history_ready(true,true,true)); // noclip isn't a chain
        f.reset(true,false);assert(f.ssj_was_in_start&&f.history_ready(false,false,false));
    }
    std::cout << "Jump stats interval and strafe trainer checks passed\n";
    return 0;
}
