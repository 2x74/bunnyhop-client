#include "practice.hpp"
#include "practice_mode.hpp"
#include "resource_loading.hpp"
#include "hud_geometry.hpp"
#include "leave_hold.hpp"
#include "map_jobs.hpp"
#include "settings.hpp"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <thread>
#include <mutex>
#include <iostream>
using namespace std::chrono_literals;

void test_practice_mode() {
    native::Practice practice;
    native::StartPoints points;
    BhState player{};
    player.grounded = 1;
    points.save("map", 0, player, 0, 0, true);
    points.save("map", 1, player, 0, 0, false);
    points.save("map", 2, player, 0, 0, true);
    points.save("other", 0, player, 0, 0, true);
    practice.retain({1, "autohop", "autohop", 0});
    practice.active = practice.noclip = true;
    unsigned enters = 0, restarts = 0;
    auto enter = [&](const std::string &) {
        assert(practice.mode);
        practice.active = true;
        ++enters;
    };
    auto restart = [&]() {
        assert(!practice.noclip && !practice.mode);
        assert(!points.get("map", 0) && !points.get("map", 2));
        assert(points.get("map", 1) && points.get("other", 0));
        assert(practice.checkpoints.size() == 1);
        practice.restart();
        ++restarts;
    };
    using Mode = native::PracticeMode;
    assert(Mode::apply(practice, points, "map", false, enter, restart) == Mode::Change::cleared_spawns);
    assert(!practice.active && !practice.mode && !practice.noclip);
    assert(Mode::apply(practice, points, "map", false, enter, restart) == Mode::Change::off);
    practice.restart();
    assert(!practice.active && restarts == 2);
    assert(Mode::apply(practice, points, "map", true, enter, restart) == Mode::Change::on);
    assert(Mode::apply(practice, points, "map", true, enter, restart) == Mode::Change::unchanged);
    assert(enters == 1 && practice.active);
    assert(Mode::apply(practice, points, "map", std::nullopt, enter, restart) == Mode::Change::off);
    assert(Mode::apply(practice, points, "map", std::nullopt, enter, restart) == Mode::Change::on);
    assert(enters == 2 && practice.mode);
}

struct LoadingLifetime {
    int &alive;

    explicit LoadingLifetime(int &value) : alive(value) { ++alive; }

    ~LoadingLifetime() { --alive; }
};

native::ResourceLoading loading_fixture(int &alive, bool fail) {
    LoadingLifetime lifetime(alive);
    co_yield "loaded";
    if (fail) throw std::runtime_error("resource failure");
}

void test_resource_loading() {
    int alive = 0;
    {
        auto loading = loading_fixture(alive, false);
        assert(alive == 0 && !loading.step() && alive == 1);
    }
    assert(alive == 0);
    auto loading = loading_fixture(alive, true);
    assert(!loading.step() && alive == 1);
    bool failed = false;
    try {
        loading.step();
    } catch (const std::runtime_error &failure) {
        failed = std::string(failure.what()) == "resource failure";
    }
    assert(failed && alive == 0);
}

int main() {
    test_resource_loading();
    test_practice_mode();
    native::Practice p;
    assert(p.key_allowed("save", true));
    assert(!p.key_allowed("tele", true));
    assert(p.key_allowed("noclip", false));
    p.segment_status(2);
    assert(p.segment_label.view() == "Segmented · 2 loads");
    assert(p.key_allowed("tele", true));
    assert(p.key_allowed("next", true));
    assert(p.key_allowed("prev", true));
    assert(!p.key_allowed("noclip", true));
    p.segment_status(-1);
    p.menu_open = true;
    assert(p.key_allowed("tele", true));
    assert(p.key_allowed("noclip", true));
    p.menu_open = false;
    p.active = true;
    p.tool = "teleport";
    p.noclip = true;
    assert(p.key_allowed("next", true));
    assert(!native::practice_allows_event(p.active, "beat") && !native::practice_allows_event(p.active, "finish"));
    assert(native::practice_allows_event(p.active, "reset"));
    p.restart();
    assert(!p.active && !p.noclip && p.tool.empty());
    assert(native::practice_allows_event(p.active, "beat"));
    p.mode = p.active = true;
    p.restart();
    assert(p.active && !p.noclip);
    p.retain({1, "autohop", "autohop", 0});
    p.retain({2, "scroll", "scroll", 0});
    p.step(-1);
    assert(p.number() == 1);
    p.step(-1);
    assert(p.number() == 1);
    p.step(8);
    assert(p.number() == 2);
    assert(native::practice_unavailable(true, false, true, false, false) == "Practice is for solo play, not servers.");
    assert(native::practice_unavailable(true, false, false, false, true) == "No practice during a gauntlet.");
    p = native::Practice{};
    assert(!p.active && !p.mode && !p.menu_open && p.checkpoints.empty());  // new map/replay
    const auto prefs = native::default_settings();
    assert(prefs["hudScale"] == 100 && prefs["practiceKeepVelocity"] == true);
    assert(prefs["binds"]["cpPrev"].empty() && prefs["binds"]["cpNext"].empty() && prefs["binds"]["mainMenu"].empty());
    for (float percent : {50.f, 100.f, 175.f}) {
        const native::HudGeometry g(1280, 720, percent);
        // 720 px tall holds 800 HUD units at most, so past 112.5% the HUD stops growing instead of overlapping.
        const float expected = std::min(.8f * percent / 100, 720.f / native::hud_min_height_units);
        assert(std::abs(g.scale - expected) < 1e-6f);
        assert(g.height >= native::hud_min_height_units - .001f && g.width >= native::hud_min_width_units - .001f);
        // The centre remains fixed; default bottom spacing and glyph/key gaps all scale together.
        assert(std::abs(g.width * .5f * g.scale - 640) < .001f);
        assert(std::abs((g.height - 154) * g.scale - (720 - 154 * g.scale)) < .001f);
        auto patch = native::patch_settings(prefs, {{"hudScale", int(percent)}});
        assert(patch["hudScale"] == int(percent));
    }
    for (double percent : {49., 176., 100.5}) {
        bool threw = false;
        try {
            native::patch_settings(prefs, {{"hudScale", percent}});
        } catch (...) {
            threw = true;
        }
        assert(threw);
    }
    native::LeaveHold hold;
    using R = native::LeaveHold::Result;
    assert(hold.press(0, false, true) == R::leave);
    assert(hold.press(100, true, true) == R::none);
    assert(hold.frame(699, true, false) == R::none && hold.progress(699) > .99f);
    assert(hold.frame(700, true, false) == R::leave);
    hold.press(1000, true, true);
    assert(hold.frame(1100, false, false) == R::tap && hold.progress(1100) < 0);
    hold.press(2000, true, true);
    assert(hold.frame(2700, true, true) == R::none && hold.progress(2700) < 0);
    assert(hold.press(3000, true, false) == R::ask);
    assert(hold.press(5001, true, false) == R::ask);
    assert(hold.press(6000, true, false) == R::leave);
    // Timed practice uses the same hold/wheel guard as a timed ranked run.
    p.active = p.mode = true;
    assert(native::leave_requires_confirmation(1, false));
    assert(!native::leave_requires_confirmation(0, false) && !native::leave_requires_confirmation(2, false)
           && !native::leave_requires_confirmation(1, true));
    native::LeaveHold practice_hold;
    assert(practice_hold.press(10000, native::leave_requires_confirmation(1, false), true) == R::none);
    assert(practice_hold.frame(10599, true, false) == R::none && practice_hold.frame(10600, true, false) == R::leave);
    assert(practice_hold.press(11000, native::leave_requires_confirmation(1, false), false) == R::ask);
    assert(practice_hold.press(13000, native::leave_requires_confirmation(1, false), false) == R::leave);
    // Leave while one worker owns the shared cache; its stale progress must never overwrite the new request.
    std::atomic_bool entered = false, old_stopped = false;
    std::mutex cache, progress;
    std::string status;
    {
        native::MapJobs<int> jobs;
        jobs.start([&](const std::atomic_bool &cancel) {
            std::lock_guard lock(cache);
            entered = true;
            while (!cancel)
                std::this_thread::yield();
            {
                std::lock_guard p(progress);
                if (!cancel) status = "stale";
            }
            old_stopped = true;
            throw std::runtime_error("cancelled");
            return 0;
        });
        while (!entered)
            std::this_thread::yield();
        jobs.cancel();
        assert(!jobs.valid());
        jobs.start([&](const std::atomic_bool &cancel) {
            std::lock_guard lock(cache);
            assert(!cancel);
            {
                std::lock_guard p(progress);
                status = "new map";
            }
            return 42;
        });
        assert(jobs.get() == 42);
        assert(old_stopped && status == "new map");
        jobs.poll();
        entered = false;
        old_stopped = false;
        jobs.start([&](const std::atomic_bool &cancel) {
            entered = true;
            while (!cancel)
                std::this_thread::yield();
            old_stopped = true;
            return 0;
        });
        while (!entered)
            std::this_thread::yield();  // destructor must cancel before joining
    }
    assert(old_stopped);
    std::cout << "Native runtime practice, HUD geometry, leave hold and worker lifecycle passed\n";
}
