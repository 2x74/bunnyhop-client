// Timestamped input (timed_input.hpp, input_timeline.hpp) through the client's frame-loop input path.
#include "timed_input_harness.hpp"
#include "replay_controls.hpp"
#include "turn_settings.hpp"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <cmath>
#include <cstdio>
#include <functional>
#include <string>
#include <vector>
#include <cstdlib>
#include <new>

static bool count_allocations = false;
static size_t allocation_count = 0;

void *operator new(std::size_t size) {
    if (count_allocations) {
        ++allocation_count;
    }
    if (void *memory = std::malloc(size ? size : 1)) {
        return memory;
    }
    throw std::bad_alloc();
}

void operator delete(void *memory) noexcept {
    std::free(memory);
}

void operator delete(void *memory, std::size_t) noexcept {
    std::free(memory);
}

using native::test::LoopHarness;
using native::test::ms;
using native::test::TickRow;

namespace {

constexpr int64_t start = 1000 * ms;

bool close(double a, double b, double tolerance = 1e-9) {
    return std::abs(a - b) <= tolerance;
}

int64_t frame_period(int fps) {
    return int64_t(std::llround(1e9 / fps));
}

double counts_between(int64_t after, int64_t until, const std::vector<std::pair<int64_t, double>> &reports) {
    double sum = 0;
    for (const auto &[t, x] : reports) {
        if (t > after && t <= until) {
            sum += x;
        }
    }
    return sum;
}

void test_each_tick_takes_exactly_its_reports() {
    for (const int fps : {60, 100, 144, 240, 360}) {
        for (const int hz : {1000, 2000, 8000}) {
            LoopHarness loop;
            loop.start_at(start);
            std::vector<std::pair<int64_t, double>> reports;
            const int64_t period = 1'000'000'000 / hz;
            for (int64_t t = start + period, i = 0; t <= start + 1000 * ms; t += period, ++i) {
                const double x = (i / 37) % 2 ? -1 : 2;
                loop.motion(t, x);
                reports.push_back({t, x});
            }
            loop.run(start + 1000 * ms, frame_period(fps));
            assert(loop.rows.size() >= 98);
            int64_t previous = loop.rows.front().boundary - 10 * ms;
            for (const TickRow &row : loop.rows) {
                assert(std::abs(row.boundary - previous - 10 * ms) <= 1000);
                assert(row.counts == counts_between(previous, row.boundary, reports));
                previous = row.boundary;
            }
        }
    }
}

void test_fractional_reports_stay_exact() {
    LoopHarness loop;
    loop.start_at(start);
    double total = 0;
    for (int i = 1; i <= 400; ++i) {
        const double x = i % 4 == 0 ? -.125 : .375;
        loop.motion(start + i * 250'000, x);
        total += x;
    }
    loop.run(start + 120 * ms, frame_period(144));
    assert(loop.input.yaw_counts == total);
    for (const TickRow &row : loop.rows) {
        // Every share is a whole number of 1/8 counts: nothing was rounded or split.
        assert(row.counts * 8 == std::floor(row.counts * 8));
    }
}

void test_pitch_clamps_in_report_order() {
    LoopHarness loop;
    loop.start_at(start);
    loop.motion(start + 1 * ms, 0, 10000);
    loop.motion(start + 2 * ms, 0, -100);
    loop.run(start + 20 * ms, frame_period(60));
    // The first report pins the view at 89; the second then looks up 100 * 2 * 0.022 degrees.
    assert(close(loop.input.pitch, 89 - 4.4, 1e-9));
}

void test_pitch_uses_the_settings_each_report_was_made_with() {
    LoopHarness loop;
    loop.start_at(start);
    loop.input.invert_y = true;
    loop.motion(start + 1 * ms, 0, 10);
    loop.pump(start + 2 * ms);
    loop.input.invert_y = false;
    loop.input.separate_vertical = true;
    loop.input.vertical_sensitivity = 5;
    loop.motion(start + 3 * ms, 0, 10);
    loop.run(start + 20 * ms, frame_period(60));
    assert(close(loop.input.pitch, -10 * 2 * .022 + 10 * 5 * .022));
}

void test_late_reports_count_in_the_next_tick() {
    LoopHarness loop;
    loop.start_at(start);
    loop.motion(start + 4 * ms, 3);
    // Stamped before the first boundary, but read from the queue after that tick ran.
    loop.motion(start + 9 * ms, 5, 0, start + 12 * ms);
    loop.frame(start + 10 * ms);
    assert(loop.rows.size() == 1);
    assert(loop.rows[0].counts == 3);
    loop.frame(start + 20 * ms);
    assert(loop.rows.size() == 2);
    assert(loop.rows[0].counts == 3);
    assert(loop.rows[1].counts == 5);
    assert(loop.timeline.queue().late == 1);
}

void test_holdback_adapts_like_the_web() {
    native::TimedInput queue;
    assert(queue.holdback_ms == 1);
    queue.take(100 * ms, [](double, double) {});
    for (int i = 0; i < 400; ++i) {
        queue.add_motion(97 * ms, 1, 0);
    }
    assert(queue.holdback_ms == 1.5);
    double got = 0;
    queue.take(110 * ms, [&](double x, double) { got += x; });
    assert(got == 400);
    for (int window = 0; window < 8; ++window) {
        const int64_t base = 1000 * ms + window * 100 * ms;
        for (int i = 0; i < 400; ++i) {
            queue.add_motion(base + i * 10'000, 1, 0);
        }
        queue.take(base + 20 * ms, [](double, double) {});
    }
    assert(queue.holdback_ms == 1);
}

void test_reports_late_at_the_largest_holdback_give_up_timestamps() {
    native::TimedInput queue;
    int64_t now = 1000 * ms;
    for (int window = 0; window < 40 && !queue.unreliable; ++window) {
        queue.take(now, [](double, double) {});
        for (int i = 0; i < 400; ++i) {
            queue.add_motion(now - 30 * ms, 1, 0);
        }
        now += 100 * ms;
    }
    assert(queue.holdback_ms == native::TimedInput::holdback_limit_ms);
    assert(queue.unreliable);
    assert(queue.stamp(now - 2 * ms, now, 0) == now);
}

void test_stamps() {
    native::TimedInput queue;
    const int64_t now = 5000 * ms;
    assert(queue.stamp(now - 1500'000, now, 0) == now - 1500'000);
    assert(queue.stamp(0, now, 0) == now);
    assert(queue.stamp(now + 5 * ms, now, 0) == now);
    assert(queue.stamp(now + 500'000, now, 0) == now);
    // A hitch's backlog lands at the start of the retained 0.25 s window.
    assert(queue.stamp(now - 900 * ms, now, 0) == now - 250 * ms);
    // Older than the newest queued: received now, so the queue stays in order.
    assert(queue.stamp(now - 3 * ms, now, now - 2 * ms) == now);
}

void test_keys_apply_at_their_own_tick() {
    LoopHarness loop;
    loop.start_at(start);
    loop.key(start + 5 * ms, "KeyA", true);
    loop.key(start + 12 * ms, "KeyD", true);
    loop.key(start + 14 * ms, "KeyA", false);
    // A complete tap inside one tick moves nothing (the boundary state, as the web).
    loop.key(start + 21 * ms, "KeyW", true);
    loop.key(start + 24 * ms, "KeyW", false);
    // A press exactly on a boundary belongs to that tick.
    loop.key(start + 40 * ms, "Space", true);
    loop.run(start + 50 * ms, 10 * ms);
    assert(loop.rows.size() == 5);
    assert(loop.rows[0].held == native::left);
    assert(loop.rows[1].held == native::right);
    assert(loop.rows[2].held == native::right);
    assert(loop.rows[3].held == (native::right | native::jump));
    assert(loop.rows[4].held == (native::right | native::jump));
}

void test_a_whole_frame_of_key_switches_splits_by_tick() {
    // 30 fps: three ticks per frame. The old path gave all three the frame's last key state.
    LoopHarness loop;
    loop.start_at(start);
    loop.key(start + 1 * ms, "KeyA", true);
    loop.key(start + 15 * ms, "KeyA", false);
    loop.key(start + 15 * ms, "KeyD", true);
    loop.key(start + 25 * ms, "KeyD", false);
    loop.key(start + 25 * ms, "KeyA", true);
    loop.frame(start + 33 * ms);
    assert(loop.rows.size() == 3);
    assert(loop.rows[0].held == native::left);
    assert(loop.rows[1].held == native::right);
    assert(loop.rows[2].held == native::left);
}

void test_sensitivity_change_commits_pending_motion_first() {
    LoopHarness loop;
    loop.start_at(start);
    loop.input.set_angles(0, 90);
    loop.motion(start + 4 * ms, 5);
    loop.pump(start + 6 * ms);
    loop.timeline.set_sensitivity(loop.input, 3);
    loop.motion(start + 7 * ms, 1);
    loop.frame(start + 10 * ms);
    assert(close(loop.input.yaw(), native::Input::normalize(90 - 5 * .044 - 1 * .066), 1e-9));
}

void test_teleport_keeps_pending_motion_and_held_keys() {
    LoopHarness loop;
    loop.start_at(start);
    loop.key(start + 1 * ms, "KeyD", true);
    loop.motion(start + 8 * ms, 4);
    loop.motion(start + 12 * ms, 6);
    loop.after_tick = [](native::Input &input, size_t tick) {
        if (tick == 0) {
            BhState state{};
            state.events = native::teleported;
            state.teleport_angles[0] = 357;
            state.teleport_angles[1] = 90;
            input.events(state);
        }
    };
    loop.frame(start + 13 * ms);
    // The report after the boundary is still pending when the teleport sets the view.
    assert(loop.rows[0].counts == 4);
    assert(close(loop.input.pitch, -3));
    loop.frame(start + 21 * ms);
    assert(loop.rows[1].counts == 6);
    assert(loop.rows[1].held == native::right);
    assert(close(loop.rows[1].yaw, native::Input::normalize(90 - 6 * .044)));
}

void test_map_pitch_is_signed_before_clamping() {
    assert(close(native::Input::view_pitch(357), -3));
    assert(close(native::Input::view_pitch(358), -2));
    assert(close(native::Input::view_pitch(90), 89));
    assert(close(native::Input::view_pitch(-90), -89));
    assert(close(native::Input::view_pitch(270), -89));
    assert(close(native::Input::view_pitch(-270), 89));
    assert(close(native::Input::view_pitch(45), 45));
}

void test_camera_preview_does_not_drain_the_queue() {
    LoopHarness loop;
    loop.start_at(start);
    loop.motion(start + 4 * ms, 3);
    loop.motion(start + 13 * ms, 7);
    loop.frame(start + 14 * ms);
    const native::Input camera = loop.timeline.preview(loop.input);
    assert(camera.yaw_counts == 10);
    assert(loop.input.yaw_counts == 3);
    assert(loop.timeline.queue().pending() == 1);
    loop.frame(start + 24 * ms);
    assert(loop.rows[1].counts == 7);
}

// A 1 s main-loop stall: the frame keeps the newest 0.25 s (25 ticks); the stall's older motion collapses into the
// first retained tick and its key edges fold into held state. Nothing is invented or lost.
void test_capped_hitch_folds_dropped_time(bool teleport_after) {
    for (const int fps : {60, 144, 240}) {
        LoopHarness loop;
        loop.start_at(start);
        double total = 0;
        for (int64_t t = start + 1 * ms; t <= start + 2000 * ms; t += 1 * ms) {
            // Reports made during the stall are read when it ends.
            const int64_t arrival = t > start + 500 * ms && t < start + 1500 * ms ? start + 1500 * ms : t;
            loop.motion(t, 1, 0, arrival);
            total += 1;
        }
        loop.key(start + 100 * ms, "KeyD", true);
        loop.key(start + 700 * ms, "KeyD", false, start + 1500 * ms);
        loop.key(start + 700 * ms, "KeyA", true, start + 1500 * ms);
        loop.key(start + 800 * ms, "KeyW", true, start + 1500 * ms);
        loop.key(start + 810 * ms, "KeyW", false, start + 1500 * ms);
        size_t teleport_tick = 0;
        loop.after_tick = [&](native::Input &input, size_t tick) {
            if (teleport_after && teleport_tick && tick == teleport_tick) {
                BhState state{};
                state.events = native::teleported;
                state.teleport_angles[1] = 180;
                input.events(state);
            }
        };
        const int64_t period = frame_period(fps);
        loop.run(start + 500 * ms, period);
        const size_t before = loop.rows.size();
        teleport_tick = before;
        loop.frame(start + 1500 * ms);
        const size_t retained = loop.rows.size() - before;
        assert(retained == 25 || retained == 26);
        const TickRow &first = loop.rows[before];
        // The first retained tick takes everything from the last tick before the stall up to its own boundary.
        const int64_t previous = loop.rows[before - 1].boundary;
        assert(first.counts == double(first.boundary / ms - previous / ms));
        assert(first.held == native::left);
        for (size_t i = before; i < loop.rows.size(); ++i) {
            assert(!(loop.rows[i].held & native::forward));
            assert(loop.rows[i].held == native::left);
        }
        loop.run(start + 2200 * ms, period);
        double taken = 0;
        for (const TickRow &row : loop.rows) {
            taken += row.counts;
        }
        assert(taken == total);
        for (size_t i = 1; i < loop.rows.size(); ++i) {
            if (i != before) {
                assert(std::abs(loop.rows[i].boundary - loop.rows[i - 1].boundary - 10 * ms) <= 1000);
            }
        }
    }
}

// Standing on a rotating platform: every tick reports an angle change. Ticks keep their 100 Hz cadence, keys stay
// held and no motion is lost (PR #55 regression F1).
void test_rotating_platform_keeps_cadence() {
    for (const int fps : {60, 144, 240}) {
        LoopHarness loop;
        loop.start_at(start);
        loop.key(start + 1 * ms, "KeyD", true);
        double total = 0;
        for (int64_t t = start + 500'000; t <= start + 2000 * ms; t += 500'000) {
            loop.motion(t, 1);
            total += 1;
        }
        loop.after_tick = [](native::Input &input, size_t) {
            BhState state{};
            state.events = native::angles_changed;
            state.angle_change[1] = 1;
            input.events(state);
        };
        loop.run(start + 2000 * ms, frame_period(fps));
        // 100 ticks per second of frames, give or take the last partial tick.
        const int64_t expected = (loop.last_frame() - start) / (10 * ms);
        assert(std::abs(int64_t(loop.rows.size()) - expected) <= 1);
        assert(loop.rows.size() >= 195);
        double taken = 0;
        for (size_t i = 0; i < loop.rows.size(); ++i) {
            taken += loop.rows[i].counts;
            if (i) {
                assert(std::abs(loop.rows[i].boundary - loop.rows[i - 1].boundary - 10 * ms) <= 1000);
                assert(loop.rows[i].held == native::right);
                assert(loop.rows[i].counts >= 19 && loop.rows[i].counts <= 21);
            }
        }
        // Every report delivered by the last frame is in a tick or still pending.
        const double delivered = double((loop.last_frame() - start) / 500'000);
        assert(total >= delivered);
        assert(taken + loop.timeline.queue().pending_x == delivered);
    }
}

// ---- input barriers: every client transition (client.cpp) -------------------------------------------------------
//
// Hold D, cross the transition, then the key-up arrives (or, after a release barrier, arrives while not captured,
// where the client never calls handle_code). No transition may leave D held afterwards.

enum class Barrier { release, restart, settings, none };

struct Transition {
    const char *name;
    Barrier barrier;
};

void check_transition(const Transition &transition) {
    LoopHarness loop;
    loop.start_at(start);
    loop.key(start + 2 * ms, "KeyD", true);
    loop.motion(start + 4 * ms, 3);
    loop.frame(start + 10 * ms);
    assert(loop.rows.back().held == native::right);
    loop.motion(start + 15 * ms, 2);
    loop.pump(start + 16 * ms);
    switch (transition.barrier) {
        case Barrier::release:
            loop.timeline.release(loop.input, loop.held_codes);
            break;
        case Barrier::restart:
            loop.timeline.restart(loop.input, loop.held_codes);
            break;
        case Barrier::settings:
            loop.timeline.settings_changed(loop.input, loop.held_codes);
            break;
        case Barrier::none:
            break;
    }
    const bool captured_after = transition.barrier != Barrier::release;
    if (transition.barrier == Barrier::release || transition.barrier == Barrier::settings) {
        assert(loop.held_codes.empty());
        assert(loop.timeline.queue().keys.empty());
        assert(loop.timeline.queue().pending_edges() == 0);
    }
    if (transition.barrier == Barrier::release) {
        assert(loop.timeline.queue().pending() == 0);
    }
    loop.frame(start + 20 * ms);
    const uint32_t held_after = loop.rows.back().held;
    if (transition.barrier == Barrier::restart || transition.barrier == Barrier::none) {
        assert(held_after == native::right);
    } else {
        assert(held_after == 0);
    }
    if (transition.barrier == Barrier::settings || transition.barrier == Barrier::none) {
        // The view's pending motion survives a settings change.
        assert(loop.rows.back().counts == 2);
    }
    if (captured_after) {
        loop.key(start + 25 * ms, "KeyD", false);
    }
    loop.frame(start + 30 * ms);
    loop.frame(start + 40 * ms);
    assert(loop.rows.back().held == 0);
    assert(loop.held_codes.empty());
    assert(loop.timeline.queue().keys.empty());
    // A fresh press after the transition works normally.
    loop.key(start + 45 * ms, "KeyA", true);
    loop.frame(start + 50 * ms);
    assert(loop.rows.back().held == native::left);
    std::printf("  transition %-28s ok\n", transition.name);
}

void test_transitions() {
    const Transition transitions[] = {
            {"capture off (Esc menu)", Barrier::release},
            {"capture on (resume)", Barrier::release},
            {"menu open (F10, Esc)", Barrier::release},
            {"focus lost", Barrier::release},
            {"focus gained", Barrier::release},
            {"replay controls (Tab)", Barrier::release},
            {"chat open", Barrier::release},
            {"chat close", Barrier::release},
            {"settings patch", Barrier::settings},
            {"restart / seek", Barrier::restart},
            {"window mode (Alt+Enter)", Barrier::none},
    };
    for (const Transition &transition : transitions) {
        check_transition(transition);
    }
}

void test_input_mode_switch_carries_holds() {
    LoopHarness loop;
    loop.start_at(start);
    loop.key(start + 2 * ms, "KeyW", true);
    loop.motion(start + 15 * ms, 4);
    loop.frame(start + 10 * ms);
    loop.pump(start + 16 * ms);
    loop.timeline.set_timed(false, loop.input, loop.held_codes);
    assert(!loop.timeline.timed());
    assert(loop.input.yaw_counts == 4);
    loop.frame(start + 20 * ms);
    assert(loop.rows.back().held == native::forward);
    loop.timeline.set_timed(true, loop.input, loop.held_codes);
    loop.frame(start + 30 * ms);
    assert(loop.rows.back().held == native::forward);
}

void test_bind_table_matches_binds() {
    native::BindTable binds;
    auto settings = native::default_settings();
    settings["binds"]["forward"] = {"KeyW", "ArrowUp"};
    settings["binds"]["jump"] = {"Space", "MouseWheel"};
    binds.rebuild(settings.at("binds"));
    assert(binds.of("KeyW") == native::forward);
    assert(binds.of("ArrowUp") == (native::forward | native::turn_fast));
    assert(binds.of("Space") == native::jump);
    assert(binds.of("MouseWheel") == 0);
    assert(binds.of("Mouse1") == native::attack);
    assert(binds.of("KeyR") == 0);
    const std::set<std::string> codes = {"KeyW", "KeyA", "Mouse2"};
    assert(binds.held(codes) == (native::forward | native::left | native::attack2));
}

// A key-up lost while the menu had focus leaves SDL's key state down, so SDL labels the next real press a repeat.
void test_first_press_after_a_barrier_counts() {
    native::KeyPresses presses;
    const size_t w = 26;
    assert(!presses.repeat(w, true, false));
    assert(presses.repeat(w, true, true));
    // Menu opens: the key-up never reaches SDL. The barrier clears what the game has seen.
    presses.clear();
    assert(!presses.repeat(w, true, true));
    assert(presses.repeat(w, true, true));
    assert(!presses.repeat(w, false, false));
    assert(!presses.repeat(w, true, false));

    // Losing keyboard ownership resets stale SDL state; capture alone preserves action holds.
    LoopHarness loop;
    assert(!loop.timeline.key_repeat(w, true, false));
    assert(loop.timeline.key_repeat(w, true, true));
    loop.timeline.release(loop.input, loop.held_codes);
    assert(loop.timeline.key_repeat(w, true, true));
    loop.timeline.keyboard_focus_lost();
    assert(!loop.timeline.key_repeat(w, true, true));
}

void test_embedded_menu_owns_the_keyboard() {
    assert(native::game_owns_keyboard(false, true));
    assert(!native::game_owns_keyboard(true, true));
    assert(native::game_owns_keyboard(true, false));
    assert(native::game_owns_keyboard(false, false));
}

void test_held_tab_through_replay_routing() {
    LoopHarness loop;
    native::ReplayControls controls;
    constexpr size_t tab_scancode = 43;
    int transitions = 0;
    for (int event = 0; event < 100; ++event) {
        const bool repeat = loop.timeline.key_repeat(tab_scancode, true, event != 0);
        if (controls.toggle_from_key(true, repeat)) {
            ++transitions;
            loop.timeline.release(loop.input, loop.held_codes);
            loop.timeline.restart(loop.input, loop.held_codes);
        }
    }
    assert(transitions == 1);
    assert(!controls.visible);
    loop.timeline.key_repeat(tab_scancode, false, false);
    const bool repeat = loop.timeline.key_repeat(tab_scancode, true, false);
    assert(controls.toggle_from_key(true, repeat));
    assert(controls.visible);
}

void test_capped_gap_with_remainder_and_holdback() {
    LoopHarness loop;
    loop.start_at(start);
    loop.timeline.queue().holdback_ms = 4;
    loop.frame(start + 7 * ms);
    loop.motion(start + 10 * ms, 3, 10000, start + 1000 * ms);
    loop.motion(start + 11 * ms, 5, -100, start + 1000 * ms);
    loop.key(start + 10 * ms, "KeyA", true, start + 1000 * ms);
    loop.frame(start + 1000 * ms);
    assert(loop.rows.size() == 25);
    assert(loop.rows.front().boundary == start + 753 * ms);
    assert(loop.rows.front().counts == 8);
    assert(loop.rows.front().reports == 2);
    assert(loop.rows.front().held == native::left);
    assert(close(loop.rows.front().pitch, 89 - 4.4, 1e-5));
}

void test_long_stall_preserves_event_clock() {
    native::EventStamps stamps;
    stamps.begin_pump(uint64_t(start));
    const uint64_t resumed = uint64_t(start + 60'000 * ms);
    stamps.begin_pump(resumed);
    assert(stamps.time(native::EventStamps::kMotion, uint64_t(start - ms), resumed) == uint64_t(start - ms));
    for (uint64_t i = 1; i <= 1000; ++i) {
        const uint64_t stamp = uint64_t(start) + i * ms;
        assert(stamps.time(native::EventStamps::kMotion, stamp, resumed) == stamp);
    }
    assert(stamps.source(native::EventStamps::kMotion).trusted);
    assert(stamps.source(native::EventStamps::kMotion).off_clock == 0);
    stamps.begin_pump(resumed + ms);
    for (uint32_t i = 0; i < native::EventStamps::kOffClockLimit; ++i) {
        stamps.time(native::EventStamps::kMotion, 3 * ms, resumed + ms);
    }
    assert(!stamps.source(native::EventStamps::kMotion).trusted);
}

void test_backlog_storage_is_bounded() {
    native::Input input;
    native::InputTimeline timeline;
    native::InputScheduler scheduler;
    scheduler.reset(uint64_t(start));
    const uint64_t resumed = uint64_t(start + 60'000 * ms);
    scheduler.frame(resumed, true, uint64_t(native::test::tick_ns));
    timeline.begin_pump(input, resumed, scheduler, uint64_t(native::test::tick_ns));
    auto &queue = timeline.queue();
    double pitch = 0;
    constexpr int reports = 480'000;
    const std::string code = "KeyA";
    for (int i = 1; i <= reports; ++i) {
        const uint64_t stamp = uint64_t(start) + uint64_t(i) * 125'000;
        const double y = i % 2 ? 10000 : -100;
        pitch = std::clamp(pitch + input.pitch_degrees(y), -89.0, 89.0);
        timeline.motion(input, stamp, resumed, .125, y);
        const int64_t edge_time = queue.stamp(int64_t(stamp), int64_t(resumed), queue.edge_tail());
        queue.add_edge(edge_time, code, i % 2 != 0);
        assert(queue.motion_storage() <= native::TimedInput::storage_limit);
        assert(queue.edge_storage() <= native::TimedInput::storage_limit);
    }
    while (scheduler.due(uint64_t(native::test::tick_ns))) {
        timeline.take_tick(input, scheduler.sim_ns, uint64_t(native::test::tick_ns), false);
        scheduler.consume(uint64_t(native::test::tick_ns));
    }
    uint64_t sim_ns = resumed;
    timeline.take_tick(input, sim_ns, uint64_t(native::test::tick_ns), false);
    assert(input.yaw_counts == reports * .125);
    assert(input.motion_events == reports);
    assert(input.pitch == pitch);
    assert(queue.keys.empty());
    assert(queue.pending() == 0 && queue.pending_edges() == 0);
}

void test_8khz_input_does_not_allocate() {
    native::Input input;
    native::InputTimeline timeline;
    native::InputScheduler scheduler;
    scheduler.reset(uint64_t(start));
    const std::string code = "KeyA";
    allocation_count = 0;
    count_allocations = true;
    for (uint64_t frame = 1; frame <= 1000; ++frame) {
        const uint64_t now = uint64_t(start) + frame * 16 * ms;
        scheduler.frame(now, true, uint64_t(native::test::tick_ns));
        timeline.begin_pump(input, now, scheduler, uint64_t(native::test::tick_ns));
        for (uint64_t report = 0; report < 128; ++report) {
            const uint64_t stamp = now - (127 - report) * 125'000;
            timeline.motion(input, stamp, now, .125, .25);
            timeline.queue().add_edge(int64_t(stamp), code, report % 2 == 0);
        }
        while (scheduler.due(uint64_t(native::test::tick_ns))) {
            timeline.take_tick(input, scheduler.sim_ns, uint64_t(native::test::tick_ns), false);
            scheduler.consume(uint64_t(native::test::tick_ns));
        }
    }
    count_allocations = false;
    assert(allocation_count == 0);
}

void test_turn_keys_use_each_command_cutoff() {
    native::Input input;
    input.set_angles(0, 0);
    native::InputTimeline timeline;
    timeline.queue().holdback_ms = 0;
    timeline.rebuild_binds(native::default_settings().at("binds"));
    std::set<std::string> held;
    timeline.key(held, "ArrowLeft", true, false, uint64_t(start + ms), uint64_t(start + 20 * ms));
    timeline.key(held, "ArrowUp", true, false, uint64_t(start + 12 * ms), uint64_t(start + 20 * ms));
    uint64_t sim_ns = uint64_t(start);
    const native::TurnSettings turns{300, 2.5};
    for (int tick = 1; tick <= 2; ++tick) {
        timeline.take_tick(input, sim_ns, uint64_t(native::test::tick_ns), false);
        turns.apply(input, timeline.held(held), .01, true);
        const auto command = input.command();
        input.look_sample();
        if (tick == 1) {
            assert(command.yaw == 3 && command.buttons == native::turn_left);
        } else {
            assert(command.yaw == 10.5 && command.buttons == (native::turn_left | native::turn_fast));
        }
    }
    timeline.key(held, "ArrowRight", true, false, uint64_t(start + 21 * ms), uint64_t(start + 30 * ms));
    timeline.take_tick(input, sim_ns, uint64_t(native::test::tick_ns), false);
    turns.apply(input, timeline.held(held), .01, true);
    const auto command = input.command();
    assert(command.yaw == 10.5 && command.buttons == 0);
}

void test_event_stamps_per_backend() {
    const uint64_t now = 20'000 * ms;
    native::EventStamps windows;
    windows.configure("windows");
    assert(windows.time(native::EventStamps::kMotion, now - 2 * ms, now) == now - 2 * ms);
    // A hitch's backlog is still on the clock.
    assert(windows.time(native::EventStamps::kMotion, now - 900 * ms, now) == now - 900 * ms);
    assert(windows.source(native::EventStamps::kMotion).trusted);

    native::EventStamps x11;
    x11.configure("x11");
    assert(x11.time(native::EventStamps::kMotion, now - 2 * ms, now) == now);
    assert(!x11.source(native::EventStamps::kMotion).trusted);
    assert(!x11.source(native::EventStamps::kMotion).reason.empty());
    assert(x11.time(native::EventStamps::kKeys, now - 2 * ms, now) == now - 2 * ms);

    // Stamps on another clock: arrival time for each, then for the session.
    native::EventStamps foreign;
    for (uint32_t i = 0; i < native::EventStamps::kOffClockLimit; ++i) {
        assert(foreign.time(native::EventStamps::kKeys, 3 * ms, now) == now);
    }
    assert(!foreign.source(native::EventStamps::kKeys).trusted);
    assert(foreign.time(native::EventStamps::kKeys, now - 1 * ms, now) == now);
    assert(foreign.source(native::EventStamps::kMotion).trusted);
}

// X11: motion stamped in X server milliseconds would look 20 s old. Arrival time keeps each report in its frame.
void test_x11_motion_uses_arrival_time() {
    LoopHarness loop;
    loop.timeline.configure_stamps("x11");
    loop.start_at(start);
    loop.motion(start + 4 * ms, 3);
    loop.pump(start + 4 * ms);
    loop.frame(start + 10 * ms);
    loop.motion(5, 4, 0, start + 15 * ms);
    loop.run(start + 40 * ms, 10 * ms);
    assert(loop.rows[0].counts == 3);
    assert(loop.rows[1].counts == 4);
    assert(loop.timeline.queue().late == 0);
}
}  // namespace

int main() {
    test_capped_gap_with_remainder_and_holdback();
    test_long_stall_preserves_event_clock();
    test_backlog_storage_is_bounded();
    test_8khz_input_does_not_allocate();
    test_turn_keys_use_each_command_cutoff();
    test_held_tab_through_replay_routing();
    test_each_tick_takes_exactly_its_reports();
    test_fractional_reports_stay_exact();
    test_pitch_clamps_in_report_order();
    test_pitch_uses_the_settings_each_report_was_made_with();
    test_late_reports_count_in_the_next_tick();
    test_holdback_adapts_like_the_web();
    test_reports_late_at_the_largest_holdback_give_up_timestamps();
    test_stamps();
    test_keys_apply_at_their_own_tick();
    test_a_whole_frame_of_key_switches_splits_by_tick();
    test_sensitivity_change_commits_pending_motion_first();
    test_teleport_keeps_pending_motion_and_held_keys();
    test_map_pitch_is_signed_before_clamping();
    test_camera_preview_does_not_drain_the_queue();
    test_capped_hitch_folds_dropped_time(false);
    test_capped_hitch_folds_dropped_time(true);
    test_rotating_platform_keeps_cadence();
    test_transitions();
    test_input_mode_switch_carries_holds();
    test_bind_table_matches_binds();
    test_first_press_after_a_barrier_counts();
    test_embedded_menu_owns_the_keyboard();
    test_event_stamps_per_backend();
    test_x11_motion_uses_arrival_time();
    std::puts("timed input: all tests passed");
    return 0;
}
