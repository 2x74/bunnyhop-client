#pragma once
#include <coroutine>
#include <exception>
#include <utility>
#include <chrono>
#include <string>

namespace native {

// Renderer preparation owns its suspended locals and releases them on cancellation.
class ResourceLoading {
public:
    struct promise_type {
        std::exception_ptr error;
        const char *label = "start";

        ResourceLoading get_return_object() {
            return ResourceLoading{std::coroutine_handle<promise_type>::from_promise(*this)};
        }

        std::suspend_always initial_suspend() noexcept { return {}; }

        std::suspend_always final_suspend() noexcept { return {}; }

        std::suspend_always yield_value(const char *value) noexcept {
            label = value;
            return {};
        }

        void return_void() noexcept {}

        void unhandled_exception() { error = std::current_exception(); }
    };

    ResourceLoading() = default;

    ResourceLoading(ResourceLoading &&other) noexcept : handle(std::exchange(other.handle, {})) {}

    ResourceLoading &operator=(ResourceLoading &&other) noexcept {
        if (this != &other) {
            if (handle) handle.destroy();
            handle = std::exchange(other.handle, {});
        }
        return *this;
    }

    ~ResourceLoading() {
        if (handle) handle.destroy();
    }

    double maximum_step_ms = 0;
    std::string slowest_step;

    bool step() {
        if (!handle) return true;
        if (!handle.done()) {
            const auto start = std::chrono::steady_clock::now();
            const auto label = handle.promise().label;
            handle.resume();
            const double elapsed =
                    std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
            if (elapsed > maximum_step_ms) {
                maximum_step_ms = elapsed;
                slowest_step = label;
            }
        }
        if (handle.promise().error) std::rethrow_exception(handle.promise().error);
        return handle.done();
    }

private:
    explicit ResourceLoading(std::coroutine_handle<promise_type> value) : handle(value) {}

    std::coroutine_handle<promise_type> handle{};
};

}  // namespace native
