#pragma once
#include "run_vault.hpp"
#include "data_location.hpp"
#include "replay_scores.hpp"
#include "bunnyhop_native.h"
#include <condition_variable>
#include <deque>
#include <map>
#include <memory>
#include <mutex>
#include <thread>

namespace native {

class ReplayLibrary {
public:
    struct Capture {
        std::string id;
        std::string map;

        bool matches(const std::string &current_map, const std::string &recording_path) const {
            if (map != current_map || recording_path.empty()) return false;
            return id == data_location::utf8(data_location::from_utf8(recording_path).filename());
        }
    };

    struct Update {
        std::optional<nlohmann::json> replays;
        std::vector<Capture> captures;
        std::vector<std::string> errors;
        size_t decoded = 0;
    };

    // `identity`: the release manifest's build and wasm, which key the scores of imported replays (replay_scores.hpp).
    explicit ReplayLibrary(std::filesystem::path cache, const nlohmann::json &identity = nullptr);
    ~ReplayLibrary();
    ReplayLibrary(const ReplayLibrary &) = delete;
    ReplayLibrary &operator=(const ReplayLibrary &) = delete;
    void refresh();
    void archive(std::string id, nlohmann::json summary, bool capture);
    void attach(std::string id, std::string png);
    void trash(std::string id);
    std::optional<Update> take();
    void flush();

private:
    struct Job {
        enum class Kind { archive, attach, trash };
        Kind kind;
        std::string id;
        nlohmann::json summary;
        bool capture = false;
        std::string png;
    };

    struct CachedHeader {
        std::uintmax_t size;
        std::filesystem::file_time_type modified;
        nlohmann::json info;
        // A replay without a summary had its score looked up or worked out (whether or not it has one).
        bool scored = false;
    };

    std::filesystem::path replays_;
    RunVault vault_;
    ReplayScoreCache scores_;
    std::map<std::filesystem::path, CachedHeader> headers_;
    std::mutex mutex_;
    std::condition_variable wake_;
    std::condition_variable idle_;
    std::deque<Job> jobs_;
    std::optional<Update> update_;
    bool scan_ = false;
    bool busy_ = false;
    bool stopping_ = false;
    std::thread worker_;

    void enqueue(Job job);
    void work();
    void execute(const Job &job, Update &update);
    void scan(Update &update);
    void
    score(std::unique_ptr<BhContext, decltype(&bh_destroy)> &core,
          const std::filesystem::path &path,
          CachedHeader &cached);
};

}  // namespace native
