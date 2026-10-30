// The HUD's comparison with the race ghosts, by the rules of the website's GhostManager.frame: which ghost it uses, how
// often it reads, and that the signs say what the player sees (negative time is ahead, positive speed is faster).
#include "ghost_compare.hpp"
#include "hud_readouts.hpp"
#include <cassert>
#include <cmath>
#include <iostream>

namespace {

using native::GhostCompare;
using native::GhostCompareFrame;
using native_render::GhostPath;
using native_render::GhostSource;

constexpr double tick_interval = .01;
constexpr float units_per_tick = 6;
constexpr double route_speed = units_per_tick / tick_interval;

GhostPath straight_path(GhostSource source, float units = units_per_tick, int ticks = 3000) {
    GhostPath path;
    path.source = source;
    path.frames.resize(size_t(ticks) + 1);
    path.teleports.assign(size_t(ticks) + 1, 0);
    for (int t = 0; t <= ticks; ++t)
        path.frames[size_t(t)].position[0] = float(t) * units;
    path.start = 0;
    path.end = uint32_t(ticks);
    path.interval = tick_interval;
    path.revision = native_render::next_ghost_path_revision();
    return path;
}

GhostCompareFrame running_at(float x, int elapsed, std::optional<double> player_speed) {
    GhostCompareFrame frame;
    frame.status = native::ghost_run_running;
    frame.elapsed_ticks = elapsed;
    frame.tick_interval = tick_interval;
    frame.position = {x, 0, 0};
    frame.player_speed = player_speed;
    return frame;
}

GhostCompare::Racing only(const GhostPath &path, unsigned slot = 0) {
    GhostCompare::Racing racing{};
    racing[slot] = &path;
    return racing;
}

void check_identical_run_reads_zero() {
    const auto ghost = straight_path(GhostSource::pb);
    GhostCompare compare;
    for (int t = 0; t <= 2000; ++t) {
        compare.frame(only(ghost), GhostSource::none, running_at(float(t) * units_per_tick, t, route_speed));
        if (t < 4) continue;
        assert(compare.split() && std::abs(*compare.split()) < 1e-9);
        assert(compare.speed_delta() && std::abs(*compare.speed_delta()) < 1e-3);
        assert(native::speed_diff_text(*compare.speed_delta()).view() == "+0");
    }
}

void check_signs() {
    const auto ghost = straight_path(GhostSource::pb);
    GhostCompare ahead;
    // Twice as far as the ghost got in the same time: a second ahead at elapsed 1 s; 100 u/s faster than it.
    constexpr int elapsed = 100;
    ahead.frame(only(ghost), GhostSource::none, running_at(1200, elapsed, route_speed + 100));
    assert(ahead.split() && std::abs(*ahead.split() + 1) < 1e-9);
    assert(ahead.speed_delta() && std::abs(*ahead.speed_delta() - 100) < 1e-3);
    GhostCompare behind;
    behind.frame(only(ghost), GhostSource::none, running_at(300, elapsed, route_speed - 250));
    assert(behind.split() && std::abs(*behind.split() - .5) < 1e-9);
    assert(behind.speed_delta() && std::abs(*behind.speed_delta() + 250) < 1e-3);
}

void check_which_ghost() {
    const auto pb = straight_path(GhostSource::pb, 6), wr = straight_path(GhostSource::wr, 12);
    const auto custom = straight_path(GhostSource::custom, 3);
    const GhostCompare::Racing all = {&custom, &wr, &pb, nullptr};
    const auto read = [&](const GhostCompare::Racing &racing, GhostSource choice) {
        GhostCompare compare;
        compare.frame(racing, choice, running_at(600, 100, 0.));
        return compare.split();
    };
    // 600 units in: tick 100 on the PB's route, 50 on the WR's, 200 on the custom ghost's.
    assert(std::abs(*read(all, GhostSource::none)) < 1e-9);
    assert(std::abs(*read(all, GhostSource::pb)) < 1e-9);
    assert(std::abs(*read(all, GhostSource::wr) - .5) < 1e-9);
    assert(std::abs(*read(all, GhostSource::custom) + 1) < 1e-9);
    // Auto without a PB takes the WR, and without either the custom ghost.
    assert(std::abs(*read({&custom, &wr, nullptr, nullptr}, GhostSource::none) - .5) < 1e-9);
    assert(std::abs(*read({&custom, nullptr, nullptr, nullptr}, GhostSource::none) + 1) < 1e-9);
    // A choice that isn't racing compares with nothing, and no ghost at all reads nothing.
    assert(!read({&custom, nullptr, nullptr, nullptr}, GhostSource::wr));
    assert(!read({}, GhostSource::none));
    // Each slot keeps its own delta, for its own name tag.
    GhostCompare compare;
    compare.frame(all, GhostSource::none, running_at(600, 100, 0.));
    assert(std::abs(*compare.delta(0) + 1) < 1e-9);
    assert(std::abs(*compare.delta(1) - .5) < 1e-9);
}

void check_cadence() {
    const auto ghost = straight_path(GhostSource::pb);
    GhostCompare compare;
    compare.frame(only(ghost), GhostSource::none, running_at(0, 0, 0.));
    const auto first = compare.speed_delta();
    assert(first);
    // The time difference reads every 4 ticks, and the speed difference at most every .1 s: every 12 ticks here.
    constexpr double player_speed = 900;
    for (int t = 1; t < 12; ++t) {
        compare.frame(only(ghost), GhostSource::none, running_at(float(t) * units_per_tick, t, player_speed));
        assert(compare.speed_delta() == first);
    }
    compare.frame(only(ghost), GhostSource::none, running_at(12 * units_per_tick, 12, player_speed));
    assert(compare.speed_delta() && std::abs(*compare.speed_delta() - (player_speed - route_speed)) < 1e-3);
    // No move to read (a teleport, or no new tick) keeps the last reading.
    const auto held = compare.speed_delta();
    compare.frame(only(ghost), GhostSource::none, running_at(24 * units_per_tick, 24, std::nullopt));
    assert(compare.speed_delta() == held);
}

void check_run_states() {
    const auto ghost = straight_path(GhostSource::pb);
    GhostCompare compare;
    compare.frame(only(ghost), GhostSource::none, running_at(600, 100, 600.));
    assert(compare.split() && compare.speed_delta());
    // Finished: the whole runs against each other, and no speed difference.
    auto finished = running_at(600, 3100, 0.);
    finished.status = native::ghost_run_finished;
    compare.frame(only(ghost), GhostSource::none, finished);
    assert(std::abs(*compare.split() - 1) < 1e-9);
    assert(!compare.speed_delta());
    // Idle: nothing at all.
    auto idle = running_at(0, 0, std::nullopt);
    idle.status = native::ghost_run_idle;
    compare.frame(only(ghost), GhostSource::none, idle);
    assert(!compare.split() && !compare.speed_delta() && !compare.delta(0));
    // A restart goes back to the start of the route, wherever the search was.
    compare.frame(only(ghost), GhostSource::none, running_at(12000, 2000, 600.));
    assert(compare.split());
    compare.restart();
    assert(!compare.split() && !compare.speed_delta());
    compare.frame(only(ghost), GhostSource::none, running_at(60, 10, 600.));
    assert(std::abs(*compare.split()) < 1e-9);
}

void check_lost_and_new_ghost() {
    const auto ghost = straight_path(GhostSource::pb);
    GhostCompare compare;
    compare.frame(only(ghost), GhostSource::none, running_at(600, 100, 600.));
    // Far off the route: the speed difference has nothing to read; the time difference keeps its last value.
    auto lost = running_at(600, 112, 600.);
    lost.position[1] = 5000;
    compare.frame(only(ghost), GhostSource::none, lost);
    assert(!compare.speed_delta());
    assert(compare.split());
    // A new ghost in the slot gets a new search, even on the same memory.
    auto next = straight_path(GhostSource::pb, 12);
    compare.frame(only(next), GhostSource::none, running_at(600, 124, 0.));
    assert(std::abs(*compare.split() - .74) < 1e-9);
}

void check_player_speed_from_states() {
    BhRunState run{};
    run.status = native::ghost_run_running;
    run.start_tick = 10;
    run.last_tick = 110;
    BhState previous{}, current{};
    previous.tick = 109;
    current.tick = 110;
    previous.position[0] = 100;
    current.position[0] = 103;
    current.position[1] = 4;
    auto frame = native::ghost_compare_frame(run, previous, current, tick_interval);
    assert(frame.elapsed_ticks == 100);
    assert(frame.player_speed && std::abs(*frame.player_speed - 500) < 1e-6);
    current.events = native::teleported;
    assert(!native::ghost_compare_frame(run, previous, current, tick_interval).player_speed);
    current.events = 0;
    previous.tick = current.tick;
    assert(!native::ghost_compare_frame(run, previous, current, tick_interval).player_speed);
    run.status = native::ghost_run_finished;
    run.end_tick = 90;
    assert(native::ghost_compare_frame(run, previous, current, tick_interval).elapsed_ticks == 80);
    run.status = native::ghost_run_idle;
    assert(native::ghost_compare_frame(run, previous, current, tick_interval).elapsed_ticks == 0);
}

void check_speed_readout_text() {
    native::GhostSpeedReadout readout;
    assert(!readout.shown());
    readout.show(42.4);
    assert(readout.shown() && readout.text() == "+42" && readout.value() == 42);
    readout.show(-17.6);
    assert(readout.text() == "-18" && readout.value() == -18);
    readout.show(-.4);
    assert(readout.text() == "+0" && readout.value() == 0);
    readout.show(std::nullopt);
    assert(!readout.shown());
}

}  // namespace

int main() {
    check_identical_run_reads_zero();
    check_signs();
    check_which_ghost();
    check_cadence();
    check_run_states();
    check_lost_and_new_ghost();
    check_player_speed_from_states();
    check_speed_readout_text();
    std::cout << "Ghost comparison checks passed\n";
    return 0;
}
