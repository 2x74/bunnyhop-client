#include "movement_audio.hpp"
#include <nlohmann/json.hpp>
#include <cassert>
#include <fstream>
#include <iostream>
using json = nlohmann::json;

static BhState state(const json &s) {
    BhState p{};
    for (int i = 0; i < 3; ++i) {
        p.position[i] = s.at("position")[i];
        p.velocity[i] = s.at("velocity")[i];
    }
    p.tick = s.at("tick");
    p.grounded = s.at("grounded").get<bool>();
    p.crouched = s.at("crouched").get<bool>();
    p.on_ladder = s.at("onLadder").get<bool>();
    return p;
}

static void expect_close(double a, double b) {
    if (std::abs(a - b) > 1e-8) {
        std::cerr << a << " != " << b << '\n';
        std::abort();
    }
}

int main(int argc, char **argv) {
    assert(argc == 2);
    json cases;
    std::ifstream(argv[1]) >> cases;
    unsigned count = 0, reports = 0, announcements = 0;
    for (const auto &c : cases) {
        native::LjTracker tracker;
        native::LongjumpAnnouncements automatic;
        unsigned reported = 0;
        bool called = false;
        for (const auto &t : c.at("ticks")) {
            auto pre = state(t.at("pre")), post = state(t.at("post"));
            post.events = t.at("events");
            const auto &j = t.at("cmd");
            BhCmd cmd{j.at("forward"), j.at("side"), j.at("yaw"), j.at("pitch"), j.at("buttons")};
            const bool valid = t.at("post").value("jumpStatsValid", false);
            const double dt = t.at("dt");
            const std::string style = t.at("style");
            const auto r = tracker.feed(pre, post, cmd, valid, dt, style);
            const auto &expected = t.at("report");
            if (bool(r) != !expected.is_null()) {
                std::cerr << c.at("name") << " tick " << post.tick << " report mismatch\n";
                return 1;
            }
            bool should_call = false;
            if (r) {
                ++reported;
                expect_close(r->distance, expected.at("distance"));
                expect_close(r->displacement, expected.at("displacement"));
                expect_close(r->pre, expected.at("pre"));
                expect_close(r->max, expected.at("max"));
                expect_close(r->sync, expected.at("sync"));
                expect_close(r->airtime, expected.at("airtime"));
                assert(r->standing == (expected.at("kind") == "LJ"));
                assert(r->failed == expected.value("failed", false));
                assert(r->crouched == expected.at("crouched"));
                assert(r->strafes.size() == expected.at("strafes"));
                assert(r->path.size() == expected.at("path").size());
                for (size_t i = 0; i < r->path.size(); ++i) {
                    expect_close(r->path[i].d, expected["path"][i]["d"]);
                    expect_close(r->path[i].z, expected["path"][i]["z"]);
                    expect_close(r->path[i].v, expected["path"][i]["v"]);
                }
                for (size_t i = 0; i < r->strafes.size(); ++i) {
                    const auto &s = r->strafes[i];
                    const auto &e = expected["strafeStats"][i];
                    assert(s.side == e["side"] && s.ticks == e["ticks"]);
                    expect_close(s.gain, e["gain"]);
                    expect_close(s.loss, e["loss"]);
                    expect_close(100. * s.synced / s.ticks, e["sync"]);
                }
                should_call = r->standing && !r->failed && r->distance >= 250;
            }
            BhJumpObservation observation{pre, post, cmd, uint32_t(valid), 0};
            BhSnapshot snapshot{};
            snapshot.player = post;
            const bool call = automatic.tick(snapshot, &observation, dt, style, 250);
            assert(call == should_call);
            called |= call;
            ++count;
        }
        assert(reported == c.at("reports"));
        reports += reported;
        announcements += called;
    }
    for (int fault = 0; fault < 7; ++fault) {
        native::LongjumpAnnouncements a;
        const auto &ticks = cases[0]["ticks"];
        bool called = false;
        for (size_t i = 0; i < ticks.size(); ++i) {
            const auto &t = ticks[i];
            auto pre = state(t["pre"]), post = state(t["post"]);
            post.events = t["events"];
            BhSnapshot snapshot{};
            snapshot.player = post;
            BhCmd cmd{};
            cmd.side = -450;
            BhJumpObservation o{pre, post, cmd, 1, uint32_t(fault == 0 && i >= 35)};
            if (i == 35) {
                if (fault == 1) o.valid = 0;
                if (fault == 2) continue;
                if (fault == 3) snapshot.movement_mode = 1;
                if (fault == 4) o.pre.position[0] += 1;
                if (fault == 5) o.post.position[0] += 1;
            }
            called |= a.tick(snapshot, fault == 6 && i == 35 ? nullptr : &o, .01, "autohop", 250);
        }
        assert(!called);
    }
    native::LjTracker finite;
    BhState pre{}, post{};
    pre.grounded = 1;
    post.tick = 1;
    post.events = 2;
    post.position[0] = NAN;
    assert(!finite.feed(pre, post, BhCmd{}, true, .01, "autohop"));
    assert(announcements > 0);
    std::cout << "LJ web oracle: " << cases.size() << " cases / " << count << " ticks / " << reports
              << " reports; discontinuities fail closed\n";
}
