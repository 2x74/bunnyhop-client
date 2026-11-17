// The game's gain log windows against the website's GainLogTracker (vectors from
// tools/movement-hud/gain-log-vectors.ts): the same ticks give the same reports, tick for tick.
#include "gain_logs.hpp"
#include <cmath>
#include <cstdio>
#include <fstream>
#include <stdexcept>
#include <string>

namespace {
using Json = nlohmann::json;
unsigned checks = 0;

void check(bool condition, const std::string &where) {
    ++checks;
    if (!condition) throw std::runtime_error(where);
}

void check_scenario(const Json &scenario) {
    const auto name = scenario.at("name").get<std::string>();
    native::GainLogTracker tracker;
    const auto &ticks = scenario.at("ticks");
    const auto &expected = scenario.at("expected");
    unsigned reports = 0;
    for (size_t i = 0; i < ticks.size(); ++i) {
        const auto &tick = ticks[i];
        const float position[3] = {0, 0, 0};
        const float velocity[3] = {tick[1].get<float>(), tick[2].get<float>(), 0};
        const native::SsjState pre{position, velocity, tick[0].get<bool>(), false};
        const native::SsjCmd cmd{
                tick[3].get<float>(), tick[4].get<float>(), tick[5].get<float>(), tick[6].get<uint32_t>()
        };
        native::SsjTick flags;
        flags.jumped = tick[7].get<bool>();
        const auto report = tracker.tick(pre, cmd, flags);
        const auto &want = expected[i];
        const std::string where = name + " tick " + std::to_string(i);
        check(bool(report) == !want.is_null(), where + ": report or none");
        if (!report) continue;
        ++reports;
        check(report->jump == want.at("jump").get<unsigned>(), where + ": jump");
        check(report->jumps == want.at("jumps").get<unsigned>(), where + ": clean jumps");
        check(report->gain == want.at("gain").get<double>(), where + ": gain");
        check(std::abs(report->sync - want.at("sync").get<double>()) < 1e-9, where + ": sync");
        check(report->strafes == want.at("strafes").get<unsigned>(), where + ": strafes");
        check(report->ticks == want.at("ticks").get<unsigned>(), where + ": air ticks");
    }
    check(reports == scenario.at("reports").get<unsigned>(), name + ": report count");
}

// The menu gets the report with the run's style and practice flag, and nothing else.
void check_script() {
    native::GainLogReport report{12, 5, 91.25, 93.5, 41, 400};
    const auto script = native::gain_log_script(report, "autohop", false);
    const std::string prefix = "window.bunnyhopNativeMenu?.onGainLog?.(";
    check(script.starts_with(prefix) && script.ends_with(")"), "script call");
    const auto value = Json::parse(script.substr(prefix.size(), script.size() - prefix.size() - 1));
    check(value.at("gain") == 91.25 && value.at("jumps") == 5 && value.at("style") == "autohop"
                  && value.at("practice") == false,
          "script payload");
}
}  // namespace

int main(int argc, char **argv) {
    try {
        if (argc != 2) throw std::runtime_error("Pass gain_log_vectors.json");
        std::ifstream file(argv[1]);
        const auto data = Json::parse(file);
        for (const auto &scenario : data.at("scenarios"))
            check_scenario(scenario);
        check_script();
        std::printf("gain logs passed (%u checks)\n", checks);
        return 0;
    } catch (const std::exception &e) {
        std::fprintf(stderr, "gain logs: %s\n", e.what());
        return 1;
    }
}
