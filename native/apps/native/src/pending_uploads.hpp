#pragma once
// Runs whose upload failed for the connection or the server, kept on disk so the menu's run service can send them
// again, after a restart too (ui/run-service.ts). Each is a JSON record in pending-uploads/<replay id>.json beside the
// replay archive; the replay itself stays in replays/<replay id>. The menu's `pendingUpload` messages:
//   {action:"save", id, record}     writes the record
//   {action:"remove", id}           deletes it (never the replay)
//   {action:"list", request}        answers {request, records: [{id, record}]}
//   {action:"replay", id, request}  answers {request, id, replayBase64} or {request, id, error}
// Answers are bunnyhop:native-upload-store events in the menu document. Disk work happens on a worker thread.
#include "atomic_replace.hpp"
#include "base64.hpp"
#include "data_location.hpp"
#include "run_vault.hpp"
#include <nlohmann/json.hpp>
#include <condition_variable>
#include <deque>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <vector>

namespace native {

// The records themselves, on the calling thread. Ids are replay archive names (RunVault::valid_id).
class PendingUploadFiles {
public:
    // Heartbeat tokens dominate a record: 15,000 beats of up to 600 characters.
    static constexpr std::uintmax_t max_record_bytes = 12 * 1024 * 1024;
    // The server's upload cap; a larger replay can't be sent anyway.
    static constexpr std::uintmax_t max_replay_bytes = 16 * 1024 * 1024;
    static constexpr size_t max_records = 32;

    PendingUploadFiles(std::filesystem::path records, std::filesystem::path replays)
        : records_(std::move(records))
        , replays_(std::move(replays)) {}

    void save(const std::string &id, const nlohmann::json &record) const {
        check(id);
        if (!record.is_object()) throw std::runtime_error("A pending upload must be an object");
        const auto text = record.dump();
        if (text.size() > max_record_bytes) throw std::runtime_error("Pending upload is too large");
        if (std::filesystem::is_symlink(records_)) throw std::runtime_error("Pending uploads folder is a link");
        std::filesystem::create_directories(records_);
        if (!std::filesystem::exists(path(id)) && list().size() >= max_records)
            throw std::runtime_error("Too many runs are waiting to upload");
        atomic_write_file(path(id), text);
    }

    void remove(const std::string &id) const {
        check(id);
        std::error_code ignored;
        std::filesystem::remove(path(id), ignored);
    }

    // Readable records, newest first; anything unreadable or oversized is skipped.
    std::vector<std::pair<std::string, nlohmann::json>> list() const {
        std::vector<std::pair<std::string, nlohmann::json>> found;
        std::error_code error;
        if (std::filesystem::is_symlink(records_) || !std::filesystem::is_directory(records_, error)) return found;
        for (const auto &entry : std::filesystem::directory_iterator(records_, error)) {
            const auto name = data_location::utf8(entry.path().filename());
            if (!name.ends_with(".json") || entry.is_symlink() || !entry.is_regular_file()) continue;
            const auto id = name.substr(0, name.size() - 5);
            if (!RunVault::valid_id(id) || entry.file_size() > max_record_bytes) continue;
            std::ifstream input(entry.path(), std::ios::binary);
            auto record = nlohmann::json::parse(input, nullptr, false);
            if (record.is_object()) found.emplace_back(id, std::move(record));
        }
        return found;
    }

    // The archived replay's bytes, or nullopt when it's gone (deleted from the Replays list) or too large.
    std::optional<std::string> replay(const std::string &id) const {
        check(id);
        const auto file = replays_ / data_location::from_utf8(id);
        std::error_code error;
        if (std::filesystem::is_symlink(file) || !std::filesystem::is_regular_file(file, error)) return std::nullopt;
        if (std::filesystem::file_size(file) > max_replay_bytes) return std::nullopt;
        std::ifstream input(file, std::ios::binary);
        return std::string(std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>());
    }

private:
    std::filesystem::path records_, replays_;

    static void check(const std::string &id) {
        if (!RunVault::valid_id(id)) throw std::runtime_error("Invalid pending upload id");
    }

    std::filesystem::path path(const std::string &id) const {
        return records_ / data_location::from_utf8(id + ".json");
    }
};

// The menu's `pendingUpload` messages, answered from a worker thread.
class PendingUploads {
public:
    explicit PendingUploads(const std::filesystem::path &cache) : files_(cache / "pending-uploads", cache / "replays") {
        worker_ = std::thread([this] { work(); });
    }

    ~PendingUploads() {
        {
            std::lock_guard lock(mutex_);
            stopping_ = true;
        }
        wake_.notify_one();
        worker_.join();
    }

    PendingUploads(const PendingUploads &) = delete;
    PendingUploads &operator=(const PendingUploads &) = delete;

    void handle(nlohmann::json message) {
        {
            std::lock_guard lock(mutex_);
            jobs_.push_back(std::move(message));
        }
        wake_.notify_one();
    }

    // Scripts to evaluate in the menu. Cheap: once a frame is fine.
    std::vector<std::string> poll() {
        std::lock_guard lock(mutex_);
        std::vector<std::string> out;
        out.swap(outbox_);
        return out;
    }

    // What one message does, and its answer if it has one. Throws on a malformed message.
    static std::optional<nlohmann::json> answer(const PendingUploadFiles &files, const nlohmann::json &message) {
        const auto action = message.at("action").get<std::string>();
        if (action == "save") {
            files.save(message.at("id").get<std::string>(), message.at("record"));
            return std::nullopt;
        }
        if (action == "remove") {
            files.remove(message.at("id").get<std::string>());
            return std::nullopt;
        }
        const auto request = message.at("request").get<std::string>();
        if (action == "list") {
            auto records = nlohmann::json::array();
            for (auto &[id, record] : files.list())
                records.push_back({{"id", id}, {"record", std::move(record)}});
            return nlohmann::json{{"request", request}, {"records", std::move(records)}};
        }
        if (action != "replay") throw std::runtime_error("Unknown pending upload action");
        const auto id = message.at("id").get<std::string>();
        if (const auto bytes = files.replay(id))
            return nlohmann::json{{"request", request}, {"id", id}, {"replayBase64", base64(*bytes)}};
        return nlohmann::json{{"request", request}, {"id", id}, {"error", "The replay is no longer saved."}};
    }

private:
    PendingUploadFiles files_;
    std::mutex mutex_;
    std::condition_variable wake_;
    std::deque<nlohmann::json> jobs_;
    std::vector<std::string> outbox_;
    bool stopping_ = false;
    std::thread worker_;

    static std::string event(const nlohmann::json &detail) {
        const auto encoded = detail.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
        return "window.dispatchEvent(new CustomEvent('bunnyhop:native-upload-store',{detail:" + encoded + "}))";
    }

    void work() {
        std::unique_lock lock(mutex_);
        for (;;) {
            wake_.wait(lock, [this] { return stopping_ || !jobs_.empty(); });
            if (jobs_.empty()) return;
            auto message = std::move(jobs_.front());
            jobs_.pop_front();
            lock.unlock();
            std::optional<std::string> script;
            try {
                if (const auto detail = answer(files_, message)) script = event(*detail);
            } catch (const std::exception &error) {
                // A request still gets an answer, so the menu isn't left waiting.
                if (message.is_object() && message.contains("request"))
                    script = event({{"request", message["request"]}, {"error", error.what()}});
            }
            lock.lock();
            if (script) outbox_.push_back(std::move(*script));
        }
    }
};

}  // namespace native
