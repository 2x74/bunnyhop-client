#pragma once
// When updates are checked without the player asking, and when an update may restart the game.
#include "data_location.hpp"
#include <nlohmann/json.hpp>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <set>
#include <string>

namespace native::updates {
inline constexpr int64_t automatic_check_interval_seconds = 24 * 60 * 60;

// Settings → Updates → "Check automatically": stored with the downloaded packages, not in game settings.
struct CheckSchedule {
    bool automatic = true;
    int64_t last_check = 0;  // unix seconds of the last check that reached the release manifest

    static CheckSchedule load(const std::filesystem::path &file) {
        CheckSchedule schedule;
        try {
            std::ifstream in(file, std::ios::binary);
            if (!in) return schedule;
            const auto json = nlohmann::json::parse(in);
            schedule.automatic = json.value("automatic", true);
            schedule.last_check = json.value("lastCheck", int64_t(0));
        } catch (...) {
        }
        return schedule;
    }

    void save(const std::filesystem::path &file) const noexcept {
        std::error_code ec;
        std::filesystem::create_directories(file.parent_path(), ec);
        std::ofstream out(file, std::ios::binary | std::ios::trunc);
        out << nlohmann::json{{"automatic", automatic}, {"lastCheck", last_check}}.dump();
    }

    // A clock that went backwards counts as due, so a bad timestamp can't stop checks for good.
    bool due(int64_t now) const {
        return automatic && (now < last_check || now - last_check >= automatic_check_interval_seconds);
    }
};

// What the game is doing when the player asks to restart.
struct GameActivity {
    uint32_t timer_status = 0;  // BhRunState::status
    bool in_start = false;
    uint64_t generation = 0;  // the current run's heartbeat generation
    bool exporting = false;   // a video export is recording or encoding
};

// Restarting to update would end a run in progress, drop a finished run's upload or cut a video export short.
class RestartGate {
    std::set<uint64_t> uploading_;  // runs the menu is still sending or checking
    std::set<uint64_t> answered_;   // runs with a final verdict (verified, rejected, kept, ...)

    static bool final_status(const std::string &status) {
        return status == "pending" || status == "verified" || status == "rejected" || status == "error"
               || status == "kept";
    }

public:
    // Every runService status the menu sends.
    void service_status(uint64_t generation, const std::string &status) {
        if (status == "checking" || status == "uploading") uploading_.insert(generation);
        if (!final_status(status)) return;
        uploading_.erase(generation);
        answered_.insert(generation);
        constexpr size_t remembered_runs = 16;
        while (answered_.size() > remembered_runs)
            answered_.erase(answered_.begin());
    }

    // Why the game can't restart right now, or "" when it can.
    std::string blocker(const GameActivity &game) const {
        constexpr uint32_t timer_running = 1;
        constexpr uint32_t timer_finished = 2;
        if (game.exporting) return "Finish or cancel the video export first.";
        if (game.timer_status == timer_running && !game.in_start) return "Finish or restart your run first.";
        const bool unanswered_finish = game.timer_status == timer_finished && !answered_.contains(game.generation);
        if (!uploading_.empty() || unanswered_finish)
            return "Wait for your run to finish uploading, or restart the run.";
        return {};
    }
};
}  // namespace native::updates
