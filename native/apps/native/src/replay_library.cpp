#include "replay_library.hpp"
#include "bunnyhop_native.h"
#include "data_location.hpp"
#include "run_timing.hpp"
#include <memory>
#include <set>

namespace native {
namespace {
constexpr std::uintmax_t replay_max_bytes = 8 * 1024 * 1024;
constexpr size_t replay_list_limit = 500;

// Imported BHRs contain ticks, not a score. Re-time them on the worker when the
// matching map is cached; never alter the replay bytes or block the frame loop.
std::optional<int64_t> replay_score(
        BhContext *core,
        const std::filesystem::path &cache,
        const std::filesystem::path &replay,
        const nlohmann::json &info
) {
    const auto map = info.at("map").get<std::string>();
    const auto hash = info.at("mapSha256").get<std::string>();
    if (map.empty()
        || map.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")
                   != std::string::npos
        || hash.size() != 64 || hash.find_first_not_of("0123456789abcdef") != std::string::npos) {
        return std::nullopt;
    }
    const auto directory = cache / "maps" / hash;
    const auto bsp = directory / (map + ".bsp");
    if (!std::filesystem::is_regular_file(bsp)) {
        return std::nullopt;
    }
    if (!bh_load_map(core, data_location::utf8(bsp).c_str(), data_location::utf8(directory / "content").c_str())
        || !bh_replay_load(core, data_location::utf8(replay).c_str())) {
        return std::nullopt;
    }
    BhSnapshot state{};
    BhRunState run{};
    if (!bh_replay_seek(core, info.at("endTick").get<uint32_t>(), &state) || !bh_run_state(core, &run)
        || run.status != 2) {
        return std::nullopt;
    }
    return score_ms(run.seconds);
}
}  // namespace

ReplayLibrary::ReplayLibrary(std::filesystem::path cache)
    : replays_(cache / "replays")
    , vault_(cache / "run-vault")
    , worker_([this] { work(); }) {
}

ReplayLibrary::~ReplayLibrary() {
    {
        std::lock_guard lock(mutex_);
        stopping_ = true;
    }
    wake_.notify_one();
    worker_.join();
}

void ReplayLibrary::refresh() {
    {
        std::lock_guard lock(mutex_);
        scan_ = true;
    }
    wake_.notify_one();
}

void ReplayLibrary::enqueue(Job job) {
    {
        std::lock_guard lock(mutex_);
        jobs_.push_back(std::move(job));
    }
    wake_.notify_one();
}

void ReplayLibrary::archive(std::string id, nlohmann::json summary, bool capture) {
    enqueue({Job::Kind::archive, std::move(id), std::move(summary), capture, {}});
}

void ReplayLibrary::attach(std::string id, std::string png) {
    enqueue({Job::Kind::attach, std::move(id), {}, false, std::move(png)});
}

void ReplayLibrary::trash(std::string id) {
    enqueue({Job::Kind::trash, std::move(id), {}, false, {}});
}

std::optional<ReplayLibrary::Update> ReplayLibrary::take() {
    std::lock_guard lock(mutex_);
    return std::exchange(update_, std::nullopt);
}

void ReplayLibrary::flush() {
    std::unique_lock lock(mutex_);
    idle_.wait(lock, [this] { return jobs_.empty() && !scan_ && !busy_; });
}

void ReplayLibrary::execute(const Job &job, Update &update) {
    switch (job.kind) {
        case Job::Kind::archive: {
            const auto summary = vault_.archive(job.id, job.summary);
            if (job.capture && summary.value("localPb", false)) update.captures.push_back({job.id, summary.at("map")});
            break;
        }
        case Job::Kind::attach:
            vault_.attach(job.id, job.png);
            break;
        case Job::Kind::trash:
            vault_.trash(job.id);
            break;
    }
}

void ReplayLibrary::work() {
    std::unique_lock lock(mutex_);
    while (true) {
        wake_.wait(lock, [this] { return stopping_ || scan_ || !jobs_.empty(); });
        if (stopping_ && jobs_.empty() && !scan_) return;
        auto jobs = std::move(jobs_);
        jobs_.clear();
        scan_ = false;
        busy_ = true;
        lock.unlock();
        Update update;
        for (const auto &job : jobs) {
            try {
                execute(job, update);
            } catch (const std::exception &error) {
                update.errors.push_back(error.what());
            } catch (...) {
                update.errors.push_back("Local replay operation failed");
            }
        }
        try {
            scan(update);
        } catch (const std::exception &error) {
            update.errors.push_back(error.what());
        } catch (...) {
            update.errors.push_back("Local replay scan failed");
        }
        lock.lock();
        if (!update_) update_.emplace();
        if (update.replays) update_->replays = std::move(update.replays);
        update_->decoded += update.decoded;
        for (auto &capture : update.captures)
            update_->captures.push_back(std::move(capture));
        for (auto &error : update.errors)
            update_->errors.push_back(std::move(error));
        busy_ = false;
        idle_.notify_all();
    }
}

void ReplayLibrary::scan(Update &update) {
    using Json = nlohmann::json;
    std::vector<std::filesystem::directory_entry> files;
    for (const auto &entry : std::filesystem::directory_iterator(replays_)) {
        if (!entry.is_symlink() && entry.is_regular_file() && entry.path().extension() == ".bhr"
            && entry.file_size() <= replay_max_bytes)
            files.push_back(entry);
    }
    std::sort(files.begin(), files.end(), [](const auto &left, const auto &right) {
        if (left.last_write_time() != right.last_write_time()) return left.last_write_time() > right.last_write_time();
        return left.path() < right.path();
    });
    if (files.size() > replay_list_limit) files.resize(replay_list_limit);
    std::unique_ptr<BhContext, decltype(&bh_destroy)> core(nullptr, bh_destroy);
    std::set<std::filesystem::path> seen;
    Json list = Json::array();
    for (const auto &entry : files) {
        const auto path = entry.path();
        seen.insert(path);
        try {
            const auto size = entry.file_size();
            const auto modified = entry.last_write_time();
            auto cached = headers_.find(path);
            if (cached == headers_.end() || cached->second.size != size || cached->second.modified != modified) {
                if (!core) core.reset(bh_create());
                if (!core) throw std::runtime_error("Could not create replay reader");
                size_t bytes = 0;
                ++update.decoded;
                const auto raw = bh_replay_header(core.get(), data_location::utf8(path).c_str(), &bytes);
                const auto info = raw ? Json::parse(raw, raw + bytes) : Json(nullptr);
                cached = headers_.insert_or_assign(path, CachedHeader{size, modified, info}).first;
            }
            auto &info = cached->second.info;
            if (!info.is_object()) continue;
            const auto id = data_location::utf8(path.filename());
            const auto summary = vault_.read(id);
            if (summary.is_object() && summary.value("timingPolicy", Json(nullptr)) == timing_policy) {
                info["timeMs"] = summary.at("timeMs");
            }
            if (!info.contains("timeMs")) {
                if (!core) core.reset(bh_create());
                if (core) {
                    if (const auto ms = replay_score(core.get(), replays_.parent_path(), path, info)) {
                        info["timeMs"] = *ms;
                    }
                }
            }
            const auto ms = info.contains("timeMs") ? info.at("timeMs").get<int64_t>() : legacy_replay_ms(info);
            Json listed = {
                    {"id", id},
                    {"name", info.value("player", std::string("Local run"))},
                    {"map", info.at("map")},
                    {"style", info.value("style", std::string("autohop"))},
                    {"track", info.value("track", 0)},
                    {"recordedAt", info.value("recordedAt", 0.)},
                    {"bytes", size},
                    {"seconds", score_seconds(ms)},
                    {"timeMs", ms},
                    {"timingPolicy", info.contains("timeMs") ? Json(timing_policy) : Json(nullptr)}
            };
            if (summary.is_object()) {
                listed["localSummary"] = summary;
            }
            listed["screenshot"] = vault_.screenshot(id).has_value();
            list.push_back(std::move(listed));
        } catch (const std::exception &error) {
            update.errors.push_back(data_location::utf8(path.filename()) + ": " + error.what());
        }
    }
    std::erase_if(headers_, [&seen](const auto &entry) { return !seen.contains(entry.first); });
    update.replays = std::move(list);
}

}  // namespace native
