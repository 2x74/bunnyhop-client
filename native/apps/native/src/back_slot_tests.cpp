#include "back_slot.hpp"
#include "nlohmann/json.hpp"
#include <cassert>
#include <fstream>
#include <iostream>

// Replays the website's back items over the oracle's stream (back-slot-oracle.ts): motion uniforms, the sleeves, the
// Cape's and the Robe's tones, and the packed options.
namespace {

using json = nlohmann::json;

native_back::Step step_from(const json &step, native_back::Kind kind, double length, bool tied) {
    native_back::Step out;
    out.kind = kind;
    for (size_t k = 0; k < 3; ++k)
        out.velocity[k] = step["velocity"][k].get<double>();
    out.yaw_degrees = step["yaw"];
    out.dt = step["dt"];
    out.jumped = step["jumped"];
    out.snap = step["snap"];
    out.cape_length = length;
    out.tied = tied;
    return out;
}

double check_runs(const json &oracle) {
    double worst = 0;
    const auto &steps = oracle.at("steps");
    for (const auto &run : oracle.at("runs")) {
        const auto kind = native_back::kind_named(run["kind"].get<std::string>());
        assert(kind != native_back::Kind::none);
        native_back::Motion motion;
        for (size_t i = 0; i < steps.size(); ++i) {
            const auto step = step_from(steps[i], kind, run["len"], run["tied"]);
            native_back::advance(motion, step);
            const auto u = native_back::uniforms(
                    motion, kind, std::hypot(step.velocity[0], step.velocity[1]), step.cape_length
            );
            const auto &want = run["uniforms"][i];
            for (size_t k = 0; k < 4; ++k) {
                // The key's angle grows with its clicks (thousands of radians); compare it relative to its size.
                const double scale = std::max(1., std::abs(want[k].get<double>()));
                worst = std::max(worst, std::abs(u.back[k] - want[k].get<double>()) / scale);
                worst = std::max(worst, std::abs(u.tip[k] - want[4 + k].get<double>()));
                worst = std::max(worst, std::abs(u.mid[k] - want[8 + k].get<double>()));
            }
        }
    }
    return worst;
}

double check_sleeves(const json &oracle) {
    double worst = 0;
    const auto &steps = oracle.at("steps");
    native_back::SleeveMotion sleeves;
    for (size_t i = 0; i < steps.size(); ++i) {
        const auto step = step_from(steps[i], native_back::Kind::robe, 1, false);
        const double swing = 6 * std::sin(double(i) / 11);
        const std::array<double, 6> anchors = {2 + swing, 12, 40, 2 - swing, -12, 40 + swing / 3};
        native_back::advance_sleeves(sleeves, anchors, step.velocity, step.yaw_degrees, step.dt, step.snap, false);
        const auto left = native_back::sleeve_uniform(sleeves, 0), right = native_back::sleeve_uniform(sleeves, 1);
        const auto &want = oracle["sleeveUniforms"][i];
        for (size_t k = 0; k < 4; ++k) {
            worst = std::max(worst, std::abs(left[k] - want[k].get<double>()));
            worst = std::max(worst, std::abs(right[k] - want[4 + k].get<double>()));
        }
    }
    return worst;
}

double check_first_person(const json &oracle) {
    double worst = 0;
    const auto &steps = oracle.at("steps");
    native_back::FirstPersonSleeves sleeves;
    for (size_t i = 0; i < steps.size(); ++i) {
        const auto step = step_from(steps[i], native_back::Kind::robe, 1, false);
        sleeves.update(step.dt, step.velocity, step.yaw_degrees, i < 500 ? 1 : .45, i > 600);
        // (The website's uniform starts as a fresh Vector4, (0, 0, 0, 1), until the first step.)
        if (i == 0) continue;
        const auto got = sleeves.uniform();
        for (size_t k = 0; k < 4; ++k)
            worst = std::max(worst, std::abs(got[k] - oracle["fpSleeveUniforms"][i][k].get<double>()));
    }
    return worst;
}

std::optional<uint32_t> pick(const json &value) {
    if (value.is_null()) return std::nullopt;
    return value.get<uint32_t>();
}

native_back::Rgb rgb(const json &value) {
    return {value[0].get<float>(), value[1].get<float>(), value[2].get<float>()};
}

double check_tones(const json &oracle) {
    double worst = 0;
    const auto accent = rgb(oracle["accent"]), pants = rgb(oracle["pants"]);
    for (const auto &row : oracle.at("tones")) {
        const auto cape = native_back::cape_tones(accent, pick(row["outer"]), pick(row["lining"]));
        const auto robe = native_back::robe_tones(pants, accent, pick(row["outer"]), pick(row["lining"]));
        for (size_t role = 0; role < 4; ++role)
            for (size_t k = 0; k < 3; ++k) {
                worst = std::max(worst, double(std::abs(cape[role][k] - row["cape"][role][k].get<float>())));
                worst = std::max(worst, double(std::abs(robe[role][k] - row["robe"][role][k].get<float>())));
            }
    }
    return worst;
}

void check_options(const json &oracle) {
    for (const auto &row : oracle.at("options")) {
        const auto field = row["field"].get<std::string>();
        const bool robe = row["robe"];
        const auto got = robe ? native_back::unpack_robe(field) : native_back::unpack_cape(field);
        const auto &want = row["value"];
        const auto color = [&](const char *key) -> std::optional<uint32_t> {
            if (!want.contains(key)) return std::nullopt;
            return want[key].get<uint32_t>();
        };
        if (robe) {
            assert(got.robe_pattern == want.value("robePattern", 0));
            assert(got.robe_tied == want.value("robeTied", false));
            assert(got.outer == color("robeColor"));
            assert(got.lining == color("robePrint"));
        } else {
            assert(got.cape_length == want.value("capeLength", native_back::cape_length_min));
            assert(got.outer == color("capeColor"));
            assert(got.lining == color("capeLining"));
        }
    }
}

void check_keys() {
    using native_back::fit_for;
    using native_back::mesh_key;
    assert(mesh_key("back-wings", fit_for("bunny", false, false, false), 100, false) == "back:back-wings|a|up");
    assert(mesh_key("back-cape", fit_for("bunny", true, true, true), 180, false) == "back:back-cape|b|down|l180");
    assert(mesh_key("back-cape", fit_for("plush", false, false, true), 100, true) == "back:back-cape|plush|up|tail");
    assert(mesh_key("back-robe", fit_for("bune", false, true, true), 200, true) == "back:back-robe|b|up|tail|tied");
    assert(mesh_key("back-key", fit_for("tek", false, false, false), 100, false) == "back:back-key|a|up");
    assert(native_back::drawn_cape_length(100, 20) == 100);
    assert(native_back::drawn_cape_length(105, 20) == 100);
    assert(native_back::drawn_cape_length(110, 20) == 120);
    assert(native_back::drawn_cape_length(255, 20) == 260);
    assert(native_back::drawn_cape_length(400, 20) == 260);
}

}  // namespace

int main(int argc, char **argv) {
    assert(argc == 2);
    std::ifstream file(argv[1]);
    const auto oracle = json::parse(file);
    constexpr double motion_tolerance = 2e-5, tone_tolerance = 2e-6;
    const double runs = check_runs(oracle), sleeves = check_sleeves(oracle), tones = check_tones(oracle);
    const double first_person = check_first_person(oracle);
    std::cout << "worst: motion " << runs << ", sleeves " << sleeves << ", first person " << first_person << ", tones "
              << tones << "\n";
    assert(first_person < motion_tolerance);
    assert(runs < motion_tolerance);
    assert(sleeves < motion_tolerance);
    assert(tones < tone_tolerance);
    check_options(oracle);
    check_keys();
    std::cout << "Back items match the website: " << oracle["runs"].size() << " motion runs, "
              << oracle["tones"].size() << " tone pairs, " << oracle["options"].size() << " packed options\n";
}
