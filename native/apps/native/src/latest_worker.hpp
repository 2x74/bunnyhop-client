#pragma once
#include <atomic>
#include <condition_variable>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <thread>

namespace native {
// One running job and one replaceable pending job. The shared state outlives the
// service on shutdown so an uninterruptible library call never holds the UI up.
template <class Result> class LatestWorker {
    using Work = std::function<Result(const std::atomic_bool &)>;
    struct Request {
        Work work;
        std::shared_ptr<std::atomic_bool> cancelled;
    };
    struct State {
        std::mutex mutex;
        std::condition_variable changed;
        bool stop = false;
        std::optional<Request> pending;
        std::shared_ptr<std::atomic_bool> active;
        std::optional<Result> ready;
    };
    std::shared_ptr<State> state_ = std::make_shared<State>();
    std::thread worker_;
    static void run(const std::shared_ptr<State> &state) {
        std::unique_lock lock(state->mutex);
        for (;;) {
            state->changed.wait(lock, [&] { return state->stop || state->pending.has_value(); });
            if (state->stop)
                return;
            auto request = std::move(*state->pending);
            state->pending.reset();
            state->active = request.cancelled;
            lock.unlock();
            std::optional<Result> result;
            try {
                result = request.work(*request.cancelled);
            } catch (...) {
                // Services turn expected failures into Results. No exception may escape a worker.
            }
            lock.lock();
            if (!*request.cancelled && !state->stop)
                state->ready = std::move(result);
            state->active.reset();
        }
    }
    void cancel_locked() {
        if (state_->active)
            *state_->active = true;
        state_->pending.reset();
        state_->ready.reset();
    }

  public:
    LatestWorker() = default;
    LatestWorker(const LatestWorker &) = delete;
    LatestWorker &operator=(const LatestWorker &) = delete;
    ~LatestWorker() {
        {
            std::lock_guard lock(state_->mutex);
            cancel_locked();
            state_->stop = true;
        }
        state_->changed.notify_one();
        if (worker_.joinable())
            worker_.detach();
    }
    void cancel() {
        std::lock_guard lock(state_->mutex);
        cancel_locked();
    }
    void submit(Work work) {
        std::lock_guard lock(state_->mutex);
        cancel_locked();
        state_->pending = Request{std::move(work), std::make_shared<std::atomic_bool>(false)};
        if (!worker_.joinable())
            worker_ = std::thread(run, state_);
        state_->changed.notify_one();
    }
    std::optional<Result> take() {
        std::lock_guard lock(state_->mutex);
        auto result = std::move(state_->ready);
        state_->ready.reset();
        return result;
    }
};
inline int replay_cancelled(void *data) {
    return static_cast<const std::atomic_bool *>(data)->load(std::memory_order_relaxed);
}
} // namespace native
