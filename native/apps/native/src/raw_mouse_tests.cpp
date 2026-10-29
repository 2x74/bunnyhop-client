#include "input_backend.hpp"
#include "input_timeline.hpp"
#include "settings.hpp"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <cstdio>
#include <thread>

namespace {
constexpr uint64_t origin_ns = 1'000'000'000;
constexpr uint64_t millisecond_ns = 1'000'000;
constexpr uint64_t tick_ns = 10 * millisecond_ns;
constexpr size_t stress_reports = 1'000'000;

void clock_mapping() {
    const native::InputClockBridge clock{9'000'000'000'000, origin_ns};
    assert(clock.map(clock.source) == origin_ns);
    assert(clock.map(clock.source + 125'000) == origin_ns + 125'000);
    assert(clock.map(clock.source - 250'000) == origin_ns - 250'000);
    assert(clock.map(0) == 0);
    assert((native::InputClockBridge{0, UINT64_MAX}).map(1) == UINT64_MAX);
    native::InputClockSample sample;
    sample.consider(origin_ns, origin_ns, origin_ns + tick_ns);
    assert(!sample.valid());
    sample.consider(origin_ns, origin_ns, origin_ns + 100);
    assert(sample.valid() && sample.span == 100);
    assert(sample.bridge.source == origin_ns + 50 && sample.bridge.target == origin_ns);
    sample.consider(origin_ns, 0, origin_ns + 200);
    assert(sample.span == 100 && sample.bridge.target == origin_ns);
}

void capture_and_overflow() {
    auto pipe = std::make_unique<native::RawMousePipe>();
    pipe->capture(true, origin_ns);
    const uint64_t epoch = pipe->capture_epoch();
    assert(pipe->publish(origin_ns - 1, 1, 0, epoch));
    native::RawMouseReport report;
    assert(!pipe->pop(report));
    assert(pipe->publish(origin_ns, 1, 0, epoch));
    pipe->capture(false);
    pipe->capture(true, origin_ns + 1);
    assert(pipe->pop(report) && report.epoch != pipe->capture_epoch());
    assert(pipe->publish(origin_ns + 2, 1, 0, epoch));
    assert(!pipe->pop(report));
    for (size_t index = 0; index < native::RawMousePipe::capacity; ++index) {
        assert(pipe->publish(origin_ns + index + 1, 1, -1, pipe->capture_epoch()));
    }
    assert(!pipe->publish(origin_ns + tick_ns, 1, 0, pipe->capture_epoch()));
    assert(pipe->dropped.load() == 1 && pipe->status.load() == native::RawMouseStatus::overflow);
    for (size_t index = 0; index < native::RawMousePipe::capacity; ++index) {
        assert(pipe->pop(report));
        assert(report.timestamp == origin_ns + index + 1 && report.x == 1 && report.y == -1);
    }
    assert(!pipe->pop(report));
    pipe->select(true);
    const uint64_t selection = pipe->selection.load();
    pipe->select(false);
    pipe->select(true);
    assert(!pipe->selected(selection));
}

void axis_grouping_preserves_pitch_reversals() {
    auto pipe = std::make_unique<native::RawMousePipe>();
    pipe->capture(true);
    native::RawMouseAccumulator motion;
    motion.value(*pipe, origin_ns, 4, 0);
    motion.value(*pipe, origin_ns, 0, 20);
    motion.value(*pipe, origin_ns + 125'000, 0, -20);
    motion.flush(*pipe);
    native::RawMouseReport report;
    assert(pipe->pop(report) && report.x == 4 && report.y == 20);
    assert(pipe->pop(report) && report.x == 0 && report.y == -20);
    assert(!pipe->pop(report));
}

void backend_barriers_and_exact_ticks() {
    auto pipe = std::make_unique<native::RawMousePipe>();
    native::InputBackend backend("x11", *pipe);
    pipe->status.store(native::RawMouseStatus::ready);
    assert(backend.begin(native::InputBackendChoice::raw, true));
    native::Input input;
    native::InputTimeline timeline;
    timeline.configure_stamps("x11");
    timeline.queue().holdback_ms = 0;
    const uint64_t epoch = pipe->capture_epoch();
    assert(pipe->publish(origin_ns + 11 * millisecond_ns, -3, -2, epoch));
    assert(pipe->publish(origin_ns + 9 * millisecond_ns, 2, 1, epoch));
    SDL_Event duplicate{};
    duplicate.type = SDL_EVENT_MOUSE_MOTION;
    duplicate.motion.xrel = 999;
    assert(SDL_PushEvent(&duplicate));
    SDL_Event event{};
    unsigned reports = 0;
    while (backend.poll(event)) {
        assert(backend.native_event());
        timeline.motion(
                input,
                event.motion.timestamp,
                origin_ns + 20 * millisecond_ns,
                event.motion.xrel,
                event.motion.yrel,
                backend.native_event()
        );
        ++reports;
    }
    assert(reports == 2);
    uint64_t boundary = origin_ns;
    timeline.take_tick(input, boundary, tick_ns, false);
    auto command = input.command();
    assert(command.yaw == float(360 - 2 * 2 * .022) && command.pitch == float(2 * .022));
    assert(command.buttons == 0 && command.side == 0 && command.forward == 0);
    timeline.take_tick(input, boundary, tick_ns, false);
    command = input.command();
    assert(command.yaw == float(2 * .022) && command.pitch == float(-2 * .022));
    assert(command.buttons == 0 && command.side == 0 && command.forward == 0);
    assert(pipe->publish(origin_ns + 21 * millisecond_ns, 123, 456, epoch));
    backend.capture(false);
    backend.barrier();
    backend.begin(native::InputBackendChoice::raw, true);
    assert(!backend.poll(event));
    assert(pipe->publish(origin_ns + 22 * millisecond_ns, 123, 456, epoch));
    assert(!backend.poll(event));
    pipe->status.store(native::RawMouseStatus::overflow);
    assert(backend.begin(native::InputBackendChoice::raw, true));
    assert(!backend.native_active());
    assert(SDL_PushEvent(&duplicate));
    assert(backend.poll(event) && !backend.native_event() && event.motion.xrel == 999);
}

void bounded_pump_snapshot() {
    auto pipe = std::make_unique<native::RawMousePipe>();
    native::InputBackend backend("cocoa", *pipe);
    pipe->status.store(native::RawMouseStatus::ready);
    backend.begin(native::InputBackendChoice::raw, true);
    const uint64_t epoch = pipe->capture_epoch();
    assert(pipe->publish(origin_ns, 1, 0, epoch));
    assert(pipe->publish(origin_ns, 0, 1, epoch));
    SDL_Event event{};
    assert(backend.poll(event) && event.motion.xrel == 1);
    assert(pipe->publish(origin_ns + 1, 2, 0, epoch));
    assert(backend.poll(event) && event.motion.yrel == 1);
    assert(!backend.poll(event));
    backend.begin(native::InputBackendChoice::raw, true);
    assert(backend.poll(event) && event.motion.xrel == 2);
    assert(!backend.poll(event));
    const std::string_view backend_name = backend.name();
    const std::string_view timestamp_kind = backend.timestamp_kind();
    backend.begin(native::InputBackendChoice::raw, false);
    assert(!backend.native_active());
    assert(backend_name == backend.name() && timestamp_kind == backend.timestamp_kind());
}

void produce_reports(native::RawMousePipe &pipe) {
    for (size_t index = 0; index < stress_reports; ++index) {
        // Bound the producer to the consumer without turning a throughput test into an intentional overrun.
        while (!pipe.requested.exchange(false, std::memory_order_acq_rel))
            std::this_thread::yield();
        assert(pipe.publish(origin_ns + index, double(index + 1), -double(index + 1), pipe.capture_epoch()));
    }
}

void threaded_handoff() {
    auto pipe = std::make_unique<native::RawMousePipe>();
    pipe->capture(true);
    std::jthread producer(produce_reports, std::ref(*pipe));
    for (size_t index = 0; index < stress_reports; ++index) {
        pipe->requested.store(true, std::memory_order_release);
        native::RawMouseReport report;
        while (!pipe->pop(report))
            std::this_thread::yield();
        assert(report.timestamp == origin_ns + index && report.x == double(index + 1)
               && report.y == -double(index + 1));
    }
    producer.join();
    assert(pipe->dropped.load() == 0);
}
}  // namespace

int main() {
    assert(SDL_Init(SDL_INIT_EVENTS));
    clock_mapping();
    capture_and_overflow();
    axis_grouping_preserves_pitch_reversals();
    backend_barriers_and_exact_ticks();
    bounded_pump_snapshot();
    threaded_handoff();
    SDL_Quit();
    std::puts("raw mouse: clock, capture, overflow, exact tick commands and 1000000 threaded reports passed");
}
