#include "latest_worker.hpp"
#include <cassert>
#include <chrono>
#include <future>

int main() {
    using namespace std::chrono_literals;
    auto entered = std::make_shared<std::promise<void>>();
    auto started = entered->get_future();
    auto release = std::make_shared<std::promise<void>>();
    auto gate = release->get_future().share();
    auto cancelled = std::make_shared<std::promise<bool>>();
    auto observed = cancelled->get_future();
    std::atomic_uint executions = 0;
    native::LatestWorker<int> worker;
    worker.submit([entered, gate, cancelled, &executions](const std::atomic_bool &cancel) {
        ++executions;
        entered->set_value();
        gate.wait();
        cancelled->set_value(cancel.load());
        return -1;
    });
    assert(started.wait_for(2s) == std::future_status::ready);
    auto last = std::make_shared<std::promise<void>>();
    auto finished = last->get_future();
    for (int i = 0; i < 1000; ++i) {
        worker.submit([i, last, &executions](const std::atomic_bool &) {
            ++executions;
            last->set_value();
            return i;
        });
    }
    assert(executions == 1);
    release->set_value();
    assert(observed.get());
    assert(finished.wait_for(2s) == std::future_status::ready);
    std::optional<int> value;
    const auto deadline = std::chrono::steady_clock::now() + 2s;
    while (!value && std::chrono::steady_clock::now() < deadline) {
        value = worker.take();
        std::this_thread::yield();
    }
    assert(value && *value == 999 && executions == 2);

    // Shutdown owns no future that joins a stale library call. Its captures
    // remain alive until that call returns, without touching the service.
    auto shutdown_entered = std::make_shared<std::promise<void>>();
    auto shutdown_started = shutdown_entered->get_future();
    auto shutdown_release = std::make_shared<std::promise<void>>();
    auto shutdown_gate = shutdown_release->get_future().share();
    auto shutdown_done = std::make_shared<std::promise<bool>>();
    auto shutdown_result = shutdown_done->get_future();
    auto service = std::make_unique<native::LatestWorker<int>>();
    service->submit([shutdown_entered, shutdown_gate, shutdown_done](const std::atomic_bool &cancel) {
        shutdown_entered->set_value();
        shutdown_gate.wait();
        shutdown_done->set_value(cancel.load());
        return 0;
    });
    assert(shutdown_started.wait_for(2s) == std::future_status::ready);
    const auto before = std::chrono::steady_clock::now();
    service.reset();
    assert(std::chrono::steady_clock::now() - before < 100ms);
    shutdown_release->set_value();
    assert(shutdown_result.wait_for(2s) == std::future_status::ready && shutdown_result.get());
}
