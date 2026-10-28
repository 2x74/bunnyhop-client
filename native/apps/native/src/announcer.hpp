#pragma once
#include <nlohmann/json.hpp>
#include <algorithm>
#include <cmath>
#include <deque>
#include <limits>
#include <set>
#include <string>

namespace native {
inline nlohmann::json default_announcer() {
    return {{"enabled", false},
            {"finish", true},
            {"movement", true},
            {"local", true},
            {"server", true},
            {"volume", .8},
            {"pb", "perfect"},
            {"wr", "godlike"},
            {"speed", "godlike"},
            {"highSpeed", "holyshit"},
            {"streak", "perfect"},
            {"lj", "perfect"},
            {"speedThreshold", 1500},
            {"highSpeedThreshold", 2500},
            {"streakThreshold", 3},
            {"ljThreshold", 250}};
}

inline bool announcer_event(const std::string &e) {
    return e == "pb" || e == "wr" || e == "speed" || e == "highSpeed" || e == "streak" || e == "lj";
}

inline bool announcer_line(const std::string &s) {
    return s == "off" || s == "perfect" || s == "godlike" || s == "holyshit";
}

inline nlohmann::json patch_announcer(nlohmann::json out, const nlohmann::json &p) {
    const auto defaults = default_announcer();
    if (!p.is_object() || p.size() > defaults.size()) throw std::runtime_error("Invalid announcer preferences");
    for (auto it = p.begin(); it != p.end(); ++it) {
        const auto &k = it.key();
        const auto &v = it.value();
        if (!defaults.contains(k)) throw std::runtime_error("Unknown announcer preference");
        if (defaults[k].is_boolean()) {
            if (!v.is_boolean()) throw std::runtime_error("Announcer toggle must be boolean");
        } else if (defaults[k].is_string()) {
            if (!v.is_string() || !announcer_line(v.get<std::string>()))
                throw std::runtime_error("Unknown announcer line");
        } else {
            if (!v.is_number() || !std::isfinite(v.get<double>()))
                throw std::runtime_error("Invalid announcer threshold");
            const double n = v.get<double>();
            const double lo = k == "volume"            ? 0
                              : k == "streakThreshold" ? 2
                              : k == "ljThreshold"     ? 200
                                                       : 300,
                         hi = k == "volume"            ? 1
                              : k == "streakThreshold" ? 100
                              : k == "ljThreshold"     ? 1000
                                                       : 10000;
            if (n < lo || n > hi || (k != "volume" && std::floor(n) != n))
                throw std::runtime_error("Announcer threshold out of range");
        }
        out[k] = v;
    }
    return out;
}

// Matches web/audio/announcer-policy.ts: no queue, verified result dedupe,
// WR interrupts PB/movement, PB interrupts movement, movement cooldown 8s.
class AnnouncerPolicy {
    std::set<std::string> seen, milestones;
    std::deque<std::string> order;
    double until = 0, movement_at = -std::numeric_limits<double>::infinity(), ground = 0;
    int priority = 0, streak = 0;
    bool streak_said = false;

public:
    void break_streak() {
        streak = 0;
        streak_said = false;
        ground = 0;
    }

    void reset_clock() {
        until = 0;
        movement_at = -std::numeric_limits<double>::infinity();
        priority = 0;
    }

    void reset_attempt() {
        milestones.clear();
        break_streak();
    }

    std::string tick(const nlohmann::json &p, double speed, int hop, bool grounded, double dt, bool broken) {
        if (broken) {
            break_streak();
            return {};
        }
        ground = grounded ? ground + dt : 0;
        if (ground >= .1) break_streak();
        if (hop == 0)
            break_streak();
        else if (hop == 1)
            ++streak;
        std::string candidate;
        double highest = -1;
        for (const char *e : {"speed", "highSpeed"}) {
            const double n = p.at(std::string(e) + "Threshold");
            if (speed >= n && !milestones.contains(e)) {
                milestones.insert(e);
                if (p.at(e) != "off" && n > highest) {
                    highest = n;
                    candidate = e;
                }
            }
        }
        const bool crossed = !streak_said && streak >= p.at("streakThreshold").get<int>();
        if (crossed) streak_said = true;
        return !candidate.empty() ? candidate : crossed && p.at("streak") != "off" ? "streak" : "";
    }

    std::string
    admit(const nlohmann::json &p,
          const std::string &event,
          double now,
          double duration,
          const std::string &id = {},
          bool remote = false,
          bool preview = false) {
        if (!announcer_event(event) || (event == "lj" && remote)) return {};
        const bool movement = event != "pb" && event != "wr";
        if (!preview && !id.empty()) {
            if (seen.contains(id)) return {};
            seen.insert(id);
            order.push_back(id);
            if (order.size() > 512) {
                seen.erase(order.front());
                order.pop_front();
            }
        }
        if (!preview
            && (!p.at("enabled").get<bool>() || !p.at(movement ? "movement" : "finish").get<bool>()
                || !p.at(remote ? "server" : "local").get<bool>()))
            return {};
        const std::string line = p.at(event);
        if (line == "off" || !announcer_line(line)) return {};
        const int rank = event == "wr" ? 3 : event == "pb" ? 2 : 1;
        if (!preview && ((now < until && rank <= priority) || (movement && now - movement_at < 8))) return {};
        priority = rank;
        until = now + duration;
        if (movement) movement_at = now;
        return line;
    }
};
}  // namespace native
