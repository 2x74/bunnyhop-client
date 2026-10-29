#pragma once
#include "activity.hpp"
#include "preferences.hpp"
#include "json_file_writer.hpp"
#include "turn_settings.hpp"
#include <array>
#include <filesystem>
#include <fstream>
#include <map>

namespace native {

// The menu's activity counters are deltas. Keep the host's lifetime totals separately so reloading them cannot
// credit playtime twice through that transport.
class RunHistory {
    static constexpr double idle_seconds = 2 * 3600;
    static constexpr uint64_t maximum_attempts = 10'000'000;
    static constexpr double maximum_seconds = 100'000'000;
    static constexpr uint64_t maximum_session_attempts = 1'000'000;
    static constexpr double maximum_session_seconds = 1'000'000;
    static constexpr size_t maximum_boards = 64;

    struct Board {
        std::string map, style;
        uint32_t track = 0;
        uint64_t starts = 0;
        double first = 0, last = 0;
    };

    std::map<std::string, ActivityCounter::Map> stored_;
    std::array<Board, maximum_boards> boards_{};
    Board *current_ = nullptr;
    uint64_t attempt_ = 0;
    double session_seconds_ = 0;
    double saved_at_ = 0;

public:
    void restore(const nlohmann::json &saved) {
        stored_.clear();
        if (!saved.is_object()) return;
        for (const auto &[map, counts] : saved.items()) {
            if (map.empty() || map.size() > 128 || !counts.is_array() || counts.size() != 2
                || !counts[0].is_number_unsigned() || !counts[1].is_number())
                continue;
            const auto attempts = counts[0].get<uint64_t>();
            const auto seconds = counts[1].get<double>();
            if (attempts <= maximum_attempts && std::isfinite(seconds) && seconds >= 0 && seconds <= maximum_seconds)
                stored_[map] = {seconds, 0, attempts};
        }
    }

    void load(const std::filesystem::path &path) {
        std::ifstream file(path);
        if (!file) return;
        const auto saved = nlohmann::json::parse(file, nullptr, false);
        if (!saved.is_discarded()) restore(saved);
    }

    // Called when a recording is prepared, never from a tick or motion event.
    void select(const std::string &map, uint32_t track, const std::string &style, double now) {
        current_ = nullptr;
        for (auto &board : boards_) {
            if (board.map == map && board.track == track && board.style == style) current_ = &board;
        }
        if (!current_) {
            current_ = &*std::min_element(boards_.begin(), boards_.end(), older);
            *current_ = {map, style, track};
        }
        if (now - current_->last > idle_seconds) current_->starts = 0;
        current_->last = now;
    }

    void start(double now) {
        if (!current_) return;
        if (now - current_->last > idle_seconds) current_->starts = 0;
        if (!current_->starts) current_->first = now;
        current_->last = now;
        attempt_ = ++current_->starts;
        session_seconds_ = std::round(std::max(0., now - current_->first));
    }

    nlohmann::json
    play(const ActivityCounter &activity, const std::string &map, const Preferences &prefs, TurnSettings turns) const {
        const auto counts = total(activity, map);
        nlohmann::json result = {{"frameCap", {{"limit", prefs.fps_limit}, {"vsync", prefs.vsync}}}};
        if (map != "bhop_lol_tutorial" && counts.attempts > 0 && counts.attempts <= maximum_attempts
            && counts.seconds <= maximum_seconds) {
            result["attempt"] = counts.attempts;
            result["seconds"] = std::round(counts.seconds);
        }
        if (attempt_ > 0 && attempt_ <= maximum_session_attempts && session_seconds_ <= maximum_session_seconds) {
            result["session"] = attempt_;
            result["sessionSeconds"] = session_seconds_;
        }
        if (turns.yaw_speed != TurnSettings::default_yaw_speed
            || turns.angle_speed_key != TurnSettings::default_angle_speed_key) {
            result["turn"] = {
                    {"yawSpeed", std::round(double(turns.yaw_speed) * 100) / 100},
                    {"angleSpeedKey", std::round(double(turns.angle_speed_key) * 100) / 100}
            };
        }
        return result;
    }

    nlohmann::json snapshot(const ActivityCounter &activity) const {
        auto result = nlohmann::json::object();
        for (const auto &[map, counts] : stored_)
            result[map] = {counts.attempts, counts.seconds};
        const auto sample = activity.sample(false);
        for (const auto &row : sample.at("maps")) {
            const auto map = row.at("map").get<std::string>();
            const auto counts = total(activity, map);
            result[map] = {counts.attempts, counts.seconds};
        }
        return result;
    }

    void
    persist(JsonFileWriter &writer,
            const std::filesystem::path &cache,
            const ActivityCounter &activity,
            double now,
            bool force = false) {
        constexpr double save_interval_seconds = 5;
        if (!force && now - saved_at_ < save_interval_seconds) return;
        saved_at_ = now;
        writer.write(cache / "run-history.json", snapshot(activity));
    }

private:
    static bool older(const Board &left, const Board &right) { return left.last < right.last; }

    ActivityCounter::Map total(const ActivityCounter &activity, const std::string &map) const {
        auto result = activity.on_map(map);
        if (const auto found = stored_.find(map); found != stored_.end()) {
            result.attempts += found->second.attempts;
            result.seconds += found->second.seconds;
        }
        return result;
    }
};

}  // namespace native
