#pragma once
#include "run_vault.hpp"
#include <condition_variable>
#include <deque>
#include <map>
#include <mutex>
#include <thread>

namespace native {

class ReplayLibrary {
  public:
    struct Capture {
        std::string id;
        std::string map;
    };
    struct Update {
        std::optional<nlohmann::json> replays;
        std::vector<Capture> captures;
        std::vector<std::string> errors;
        size_t decoded = 0;
    };

    explicit ReplayLibrary(std::filesystem::path cache);
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
    };
    std::filesystem::path replays_;
    RunVault vault_;
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
};

} // namespace native
