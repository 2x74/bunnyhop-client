// Native timed input against golden vectors from the web's TimedInput (native/tools/timed-input/generate-vectors.ts):
// every tick must take exactly the counts, pitch and keys the web class gave it.
#include "input_timeline.hpp"
#include "settings.hpp"
#include <nlohmann/json.hpp>
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <set>
#include <string>

namespace {

constexpr uint64_t kTickNs = 10'000'000;

struct Failure {
    std::string scenario;
    size_t tick = 0;
    std::string what;
};

bool fail(const Failure &failure) {
    std::fprintf(stderr, "%s, tick %zu: %s\n", failure.scenario.c_str(), failure.tick, failure.what.c_str());
    return false;
}

class ScenarioReplay {
public:
    ScenarioReplay(const nlohmann::json &scenario, uint64_t start_ns)
        : scenario_(scenario), name_(scenario.at("name").get<std::string>()), start_ns_(start_ns) {
        timeline_.rebuild_binds(native::default_settings().at("binds"));
        timeline_.queue().holdback_ms = scenario.at("holdbackMs").get<double>();
        timeline_.queue().holdback_max_ms = scenario.at("holdbackMaxMs").get<double>();
    }

    bool run() {
        const auto &events = scenario_.at("events");
        const auto &ticks = scenario_.at("ticks");
        size_t next_event = 0;
        size_t next_tick = 0;
        for (const auto &frame : scenario_.at("frames")) {
            const uint64_t now = start_ns_ + frame.get<uint64_t>();
            while (next_event < events.size() && arrival(events[next_event]) <= now) {
                deliver(events[next_event++]);
            }
            while (next_tick < ticks.size() && boundary(ticks[next_tick]) <= now) {
                if (!check_tick(ticks[next_tick], next_tick)) {
                    return false;
                }
                ++next_tick;
            }
        }
        if (next_tick != ticks.size()) {
            return fail({name_, next_tick, "ticks left after the last frame"});
        }
        return check_totals();
    }

private:
    const nlohmann::json &scenario_;
    std::string name_;
    uint64_t start_ns_;
    native::Input input_;
    native::InputTimeline timeline_;
    std::set<std::string> held_codes_;

    uint64_t arrival(const nlohmann::json &event) const { return start_ns_ + event.at(2).get<uint64_t>(); }
    uint64_t boundary(const nlohmann::json &tick) const { return start_ns_ + tick.at(0).get<uint64_t>(); }

    void deliver(const nlohmann::json &event) {
        const uint64_t stamp = start_ns_ + event.at(1).get<uint64_t>();
        const uint64_t received = arrival(event);
        if (event.at(0) == "m") {
            timeline_.motion(input_, stamp, received, event.at(3).get<double>(), event.at(4).get<double>());
        } else {
            const auto code = event.at(3).get<std::string>();
            timeline_.key(held_codes_, code, event.at(4).get<bool>(), false, stamp, received);
        }
    }

    bool check_tick(const nlohmann::json &expected, size_t index) {
        uint64_t sim_ns = boundary(expected) - kTickNs;
        const double counts_before = input_.yaw_counts;
        const uint32_t reports_before = input_.motion_events;
        timeline_.take_tick(input_, sim_ns, kTickNs, false);
        const double counts = input_.yaw_counts - counts_before;
        const uint32_t reports = input_.motion_events - reports_before;
        const uint32_t held = timeline_.held(held_codes_);
        if (counts != expected.at(1).get<double>()) {
            return fail({name_, index, "counts " + std::to_string(counts) + ", web " + expected.at(1).dump()});
        }
        if (input_.pitch != expected.at(2).get<double>()) {
            return fail({name_, index, "pitch " + std::to_string(input_.pitch) + ", web " + expected.at(2).dump()});
        }
        if (held != expected.at(3).get<uint32_t>()) {
            return fail({name_, index, "held " + std::to_string(held) + ", web " + expected.at(3).dump()});
        }
        if (reports != expected.at(4).get<uint32_t>()) {
            return fail({name_, index, "reports " + std::to_string(reports) + ", web " + expected.at(4).dump()});
        }
        return true;
    }

    bool check_totals() {
        const auto &queue = timeline_.queue();
        if (queue.late != scenario_.at("late").get<uint64_t>()) {
            return fail({name_, 0, "late " + std::to_string(queue.late) + ", web " + scenario_.at("late").dump()});
        }
        if (queue.holdback_ms != scenario_.at("finalHoldbackMs").get<double>()) {
            return fail({name_, 0, "holdback " + std::to_string(queue.holdback_ms)});
        }
        if (queue.unreliable != scenario_.at("unreliable").get<bool>()) {
            return fail({name_, 0, "unreliable differs"});
        }
        return true;
    }
};

}  // namespace

int main(int argc, char **argv) {
    if (argc != 2) {
        std::fprintf(stderr, "usage: %s timed_input_vectors.json\n", argv[0]);
        return 2;
    }
    std::ifstream file(argv[1]);
    const auto vectors = nlohmann::json::parse(file);
    const uint64_t start_ns = vectors.at("startNs").get<uint64_t>();
    size_t ticks = 0;
    for (const auto &scenario : vectors.at("scenarios")) {
        ScenarioReplay replay(scenario, start_ns);
        if (!replay.run()) {
            return 1;
        }
        ticks += scenario.at("ticks").size();
    }
    std::printf("timed input parity: %zu scenarios, %zu ticks match the web\n", vectors.at("scenarios").size(), ticks);
    return 0;
}
