#pragma once
// Scores of replays that came without a finish summary (downloaded or imported), as the Replays list works them out
// by playing each replay through (replay_library.cpp). Playing one takes seconds for a 20-minute run and minutes for
// an 8-hour one, so each result is kept in run-vault/scores.json and a replay is scored once per build.
//
// A score is keyed by the replay file's sha256 and the identity of the code that played it: the verified release
// build (its hash covers the executable, and so the simulation linked into it), the web verifier it matches, and the
// timing policy. A dev build has no verified identity and keeps nothing. A replay that played through without
// finishing (a recording saved at the cap, a run abandoned) is kept as unscored, so it isn't played again either.
#include "atomic_replace.hpp"
#include "run_timing.hpp"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <optional>
#include <string>
#include <vector>

namespace native {

class ReplayScoreCache {
public:
    static constexpr size_t max_entries = 4096;
    static constexpr std::uintmax_t max_file_bytes = 1024 * 1024;
    static constexpr const char *local_build = "bunnyhop-native/local";

    struct Score {
        // Null: the replay played through without a finish.
        std::optional<int64_t> ms;
    };

    // `identity`: the release manifest's build and wasm (startup.cpp load_release_identity).
    ReplayScoreCache(std::filesystem::path file, const nlohmann::json &identity)
        : file_(std::move(file))
        , identity_(code_identity(identity)) {}

    static std::string code_identity(const nlohmann::json &identity) {
        const auto build = identity.is_object() ? identity.value("build", std::string()) : std::string();
        const auto wasm = identity.is_object() ? identity.value("wasm", std::string()) : std::string();
        if (build.empty() || build == local_build || wasm.empty()) return {};
        return build + "|" + wasm + "|timing-" + std::to_string(timing_policy);
    }

    bool enabled() const { return !identity_.empty(); }

    std::optional<Score> find(const std::string &digest) {
        if (!enabled() || digest.size() != 64) return std::nullopt;
        load();
        const auto found = entries_.find(key(digest));
        if (found == entries_.end() || !found->is_object()) return std::nullopt;
        const auto &ms = (*found)["ms"];
        if (ms.is_null()) return Score{};
        if (!ms.is_number_integer() || ms.get<int64_t>() <= 0) return std::nullopt;
        return Score{ms.get<int64_t>()};
    }

    void store(const std::string &digest, Score score) {
        if (!enabled() || digest.size() != 64) return;
        load();
        entries_[key(digest)] = {{"ms", score.ms ? nlohmann::json(*score.ms) : nlohmann::json(nullptr)}, {"at", now()}};
        prune();
        dirty_ = true;
    }

    // Writes what changed since the last save (once per Replays list scan).
    void save() {
        if (!dirty_) return;
        dirty_ = false;
        if (std::filesystem::is_symlink(file_)) throw std::runtime_error("Replay score cache is a symbolic link");
        std::filesystem::create_directories(file_.parent_path());
        atomic_write_file(file_, entries_.dump());
    }

private:
    std::filesystem::path file_;
    std::string identity_;
    nlohmann::json entries_ = nlohmann::json::object();
    bool loaded_ = false, dirty_ = false;

    std::string key(const std::string &digest) const { return digest + "|" + identity_; }

    static int64_t now() {
        return std::chrono::duration_cast<std::chrono::milliseconds>(
                       std::chrono::system_clock::now().time_since_epoch()
        )
                .count();
    }

    // A damaged or oversized file starts the cache over; it only costs replaying again.
    void load() {
        if (loaded_) return;
        loaded_ = true;
        std::error_code error;
        if (std::filesystem::is_symlink(file_) || !std::filesystem::is_regular_file(file_, error)
            || std::filesystem::file_size(file_, error) > max_file_bytes)
            return;
        std::ifstream input(file_, std::ios::binary);
        auto parsed = nlohmann::json::parse(input, nullptr, false);
        if (parsed.is_object()) entries_ = std::move(parsed);
    }

    // Past max_entries the oldest go first.
    void prune() {
        if (entries_.size() <= max_entries) return;
        std::vector<std::pair<int64_t, std::string>> ages;
        for (const auto &[key, entry] : entries_.items())
            ages.emplace_back(entry.is_object() ? entry.value("at", int64_t(0)) : 0, key);
        std::sort(ages.begin(), ages.end());
        for (size_t i = 0; i + max_entries < ages.size(); ++i)
            entries_.erase(ages[i].second);
    }
};

}  // namespace native
