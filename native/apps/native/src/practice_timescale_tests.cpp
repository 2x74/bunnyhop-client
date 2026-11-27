// Practice timescale (web test/practice-timescale.test.ts): only solo practice mode slows the game, a run never
// keeps a scale, a slowed attempt is never submitted, and the scheduler runs half the ticks at 0.5x with timed-input
// boundaries on the real clock, exactly as before at 1x.
#undef NDEBUG
#include "input_scheduler.hpp"
#include "practice.hpp"
#include <cassert>
#include <cstdio>
#include <vector>

namespace {
constexpr uint64_t tick_ns = 10'000'000;
constexpr uint64_t frame_ns = 16'666'667;

native::TimescaleContext practice_mode() {
    native::TimescaleContext context;
    context.practice_mode = true;
    return context;
}

void test_only_solo_practice_mode_and_never_kept() {
    native::PracticeTimescale timescale;
    native::TimescaleContext outside;
    assert(timescale.set(.5, outside) == "Timescale only works in practice mode. Type !practice first.");
    assert(timescale.frame(outside) == 1);
    assert(timescale.set(.5, practice_mode()) == "Timescale 0.5x. It goes back to 1x when you leave practice.");
    assert(timescale.frame(practice_mode()) == .5);
    // Practice mode off mid-session: 1x at once, and the choice is forgotten.
    assert(timescale.frame(outside) == 1);
    assert(timescale.frame(practice_mode()) == 1);
    for (auto blocked :
         {&native::TimescaleContext::in_room,
          &native::TimescaleContext::tutorial,
          &native::TimescaleContext::gauntlet,
          &native::TimescaleContext::segmented}) {
        auto context = practice_mode();
        context.*blocked = true;
        assert(timescale.set(.25, practice_mode()).starts_with("Timescale 0.25x"));
        assert(timescale.frame(context) == 1 && timescale.value() == 1);
    }
    assert(timescale.set(1.5, practice_mode()) == "Use !timescale 0.1 to 1, like !timescale 0.5");
    assert(timescale.set(.05, practice_mode()).starts_with("Use"));
    assert(timescale.set(.333, practice_mode()) == "Timescale 0.33x. It goes back to 1x when you leave practice.");
    assert(timescale.set(1, practice_mode()) == "Timescale back to normal.");
}

void test_a_slowed_attempt_never_counts() {
    native::Practice practice;
    assert(practice.counts());
    practice.slowed = true;
    assert(!practice.counts());
    practice.restart();
    assert(practice.counts());
    practice.mode = true;
    practice.restart();
    assert(!practice.counts());
}

// 120 frames at 60 Hz (2 s): the ticks run and each tick's end on the real clock.
std::vector<uint64_t> run(double speed, uint64_t start = 1'000'000'000) {
    native::InputScheduler scheduler;
    scheduler.reset(start);
    std::vector<uint64_t> ends;
    for (uint64_t frame = 1; frame <= 120; ++frame) {
        const uint64_t now = start + frame * frame_ns;
        scheduler.frame(now, true, tick_ns, speed);
        const uint64_t from = now - frame_ns;
        while (scheduler.due(tick_ns)) {
            scheduler.place_tick(tick_ns);
            scheduler.sim_ns += scheduler.real_tick_ns(tick_ns);
            assert(scheduler.sim_ns >= from && scheduler.sim_ns <= now);
            ends.push_back(scheduler.sim_ns);
            scheduler.consume(tick_ns);
        }
    }
    return ends;
}

void test_ticks_and_boundaries_follow_the_scale() {
    const auto full = run(1), half = run(.5), quarter = run(.25);
    assert(full.size() >= 199 && full.size() <= 200);
    assert(half.size() >= 99 && half.size() <= 100);
    assert(quarter.size() >= 49 && quarter.size() <= 50);
    for (const auto *ends : {&full, &half, &quarter})
        for (size_t index = 1; index < ends->size(); ++index)
            assert((*ends)[index] >= (*ends)[index - 1]);
    // At 0.5x a tick spans 20 ms of real time (to the nanosecond rounding).
    assert(half[51] - half[50] >= 2 * tick_ns - 2 && half[51] - half[50] <= 2 * tick_ns + 2);
    // At 1x the boundaries are the scheduler's own, tick after tick from the frame's start (as before).
    native::InputScheduler scheduler;
    scheduler.reset(0);
    scheduler.frame(frame_ns * 3, true, tick_ns);
    const uint64_t start = scheduler.sim_ns;
    scheduler.place_tick(tick_ns);
    assert(scheduler.sim_ns == start && scheduler.real_tick_ns(tick_ns) == tick_ns);
}
}  // namespace

// Delete / Clear all (web 0.0.44 Checkpoints.remove): the one after the deleted checkpoint becomes current, or the one
// before when it was the last; clearing keeps practice mode and noclip as they are.
void test_delete_and_clear_checkpoints() {
    native::Practice practice;
    assert(!practice.remove(nullptr) && practice.clear_checkpoints(nullptr) == 0);
    for (uint32_t handle = 1; handle <= 4; ++handle)
        practice.retain({handle, "autohop", "autohop", 0});
    practice.step(-2);
    assert(practice.number() == 2);
    assert(practice.remove(nullptr) && practice.checkpoints.size() == 3);
    assert(practice.number() == 2 && practice.checkpoints[practice.current].handle == 3);
    practice.step(5);
    assert(practice.remove(nullptr) && practice.number() == 2 && practice.checkpoints[practice.current].handle == 3);
    practice.mode = practice.active = practice.noclip = true;
    assert(practice.clear_checkpoints(nullptr) == 2);
    assert(practice.checkpoints.empty() && practice.number() == 0 && practice.current == 0);
    assert(practice.mode && practice.active && practice.noclip);
    assert(!practice.remove(nullptr));
}

int main() {
    test_delete_and_clear_checkpoints();
    test_only_solo_practice_mode_and_never_kept();
    test_a_slowed_attempt_never_counts();
    test_ticks_and_boundaries_follow_the_scale();
    std::puts("practice timescale passed");
}
