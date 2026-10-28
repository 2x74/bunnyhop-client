#pragma once
#include "settings.hpp"
#include <nlohmann/json.hpp>
#include <atomic>
#include <condition_variable>
#include <deque>
#include <exception>
#include <filesystem>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <utility>

namespace native {

// Writes small JSON files (settings, window bounds, tutorial progress, start points) on a worker thread, so the
// frame loop never waits on the disk. Each path keeps only its newest pending content; writes to one path happen in
// order. Failures come back through take_error() on the main thread. The destructor finishes every pending write.
class JsonFileWriter {
public:
    JsonFileWriter() : worker_([this] { run(); }) {}

    ~JsonFileWriter() {
        {
            std::lock_guard lock(mutex_);
            stopping_ = true;
        }
        wake_.notify_one();
        worker_.join();
    }

    JsonFileWriter(const JsonFileWriter &) = delete;
    JsonFileWriter &operator=(const JsonFileWriter &) = delete;

    void write(std::filesystem::path path, nlohmann::json content) {
        {
            std::lock_guard lock(mutex_);
            bool replaced = false;
            for (auto &job : pending_) {
                if (job.path == path) {
                    job.content = std::move(content);
                    replaced = true;
                    break;
                }
            }
            if (!replaced) {
                pending_.push_back({std::move(path), std::move(content)});
            }
        }
        wake_.notify_one();
    }

    // Blocks until everything written so far is on disk (shutdown paths only).
    void flush() {
        std::unique_lock lock(mutex_);
        idle_.wait(lock, [this] { return pending_.empty() && !busy_; });
    }

    std::optional<std::string> take_error() {
        if (!has_error_.load(std::memory_order_acquire)) {
            return std::nullopt;
        }
        std::lock_guard lock(mutex_);
        has_error_.store(false, std::memory_order_release);
        return std::exchange(error_, std::string());
    }

private:
    struct Job {
        std::filesystem::path path;
        nlohmann::json content;
    };

    std::mutex mutex_;
    std::condition_variable wake_;
    std::condition_variable idle_;
    std::deque<Job> pending_;
    bool busy_ = false;
    bool stopping_ = false;
    std::atomic<bool> has_error_ = false;
    std::string error_;
    std::thread worker_;

    void run() {
        std::unique_lock lock(mutex_);
        while (true) {
            wake_.wait(lock, [this] { return stopping_ || !pending_.empty(); });
            if (pending_.empty()) {
                return;
            }
            Job job = std::move(pending_.front());
            pending_.pop_front();
            busy_ = true;
            lock.unlock();
            const std::string failure = save(job);
            lock.lock();
            busy_ = false;
            if (!failure.empty()) {
                error_ = failure;
                has_error_.store(true, std::memory_order_release);
            }
            idle_.notify_all();
        }
    }

    // Never lets an exception leave the worker thread.
    static std::string save(const Job &job) {
        try {
            save_settings(job.path, job.content);
            return {};
        } catch (const std::exception &e) {
            return job.path.filename().string() + ": " + e.what();
        } catch (...) {
            return job.path.filename().string() + ": could not save";
        }
    }
};

}  // namespace native
