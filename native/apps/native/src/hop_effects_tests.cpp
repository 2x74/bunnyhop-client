#include "hop_effects.hpp"
#include <cassert>
#include <iostream>

// Replays the website's hop effects on the oracle's inputs (hop-effects-oracle.ts): every record of every burst, and
// the floor found round a hop on a synthetic block.
namespace {

using json = nlohmann::json;

native_hop::Spawn spawn_from(const json &j) {
    native_hop::Spawn s;
    s.x = j["x"];
    s.y = j["y"];
    s.z = j["z"];
    s.vx = j["vx"];
    s.vz = j["vz"];
    s.t = j["t"];
    s.slot = j["slot"];
    s.quality = j["quality"];
    s.motion = j["motion"];
    s.alpha = j["alpha"];
    for (size_t k = 0; k < 3; ++k) {
        s.tint[k] = j["tint"][k];
        s.tint2[k] = j["tint2"][k];
    }
    if (!j["reach"].is_null()) {
        native_hop::Reach reach{};
        for (size_t k = 0; k < reach.size(); ++k)
            reach[k] = j["reach"][k];
        s.reach = reach;
    }
    if (!j["slope"].is_null())
        s.slope = std::array<double, 2>{j["slope"][0].get<double>(), j["slope"][1].get<double>()};
    return s;
}

double check_bursts(const json &oracle, const native_hop::Recipes &recipes) {
    double worst = 0;
    for (const auto &burst : oracle.at("bursts")) {
        const auto *parts = recipes.effect(burst["id"]);
        assert(parts);
        const auto s = spawn_from(burst["spawn"]);
        const auto seed = native_hop::hop_seed(s.x, s.z, s.t);
        assert(seed == burst["seed"].get<int32_t>());
        std::vector<native_hop::Record> records;
        native_hop::spawn(*parts, recipes, s, seed, [&](const native_hop::Record &r) { records.push_back(r); });
        const auto &want = burst["records"];
        assert(records.size() == want.size());
        for (size_t i = 0; i < records.size(); ++i)
            for (size_t k = 0; k < native_hop::record_floats; ++k) {
                const double expected = want[i][k].get<double>();
                worst = std::max(worst, std::abs(records[i][k] - expected) / std::max(1., std::abs(expected)));
            }
    }
    return worst;
}

double ground(double x, double y) {
    if (x >= -20 && x <= 30 && y >= -50 && y <= 50) return 0;
    if (x >= -20 && x <= 30 && y > 50 && y <= 90) return (y - 50) * .5;
    return -40;
}

void check_places(const json &oracle, const native_hop::Recipes &recipes) {
    const native_hop::GroundProbe probe = [](double x, double y, double z) -> std::optional<double> {
        const double g = ground(x, y);
        if (g <= z && g >= z - 48) return g;
        return std::nullopt;
    };
    for (const auto &place : oracle.at("places")) {
        const double x = place["x"], y = place["y"], z = place["z"];
        std::array<double, 2> slope{};
        const auto reach = native_hop::floor_reach(recipes, probe, x, y, z, slope);
        assert(reach);
        for (size_t k = 0; k < reach->size(); ++k)
            assert(std::abs((*reach)[k] - place["reach"][k].get<double>()) < 1e-4);
        for (size_t k = 0; k < 2; ++k)
            assert(std::abs(slope[k] - place["slope"][k].get<double>()) < 1e-6);
        const auto moved = native_hop::settle(recipes, probe, *reach, x, y, z);
        assert(moved.has_value() == !place["moved"].is_null());
        if (moved)
            for (size_t k = 0; k < 2; ++k)
                assert(std::abs((*moved)[k] - place["moved"][k].get<double>()) < 1e-9);
    }
}

}  // namespace

int main(int argc, char **argv) {
    assert(argc == 3);
    std::ifstream file(argv[1]);
    const auto oracle = json::parse(file);
    const auto recipes = native_hop::Recipes::load(argv[2]);
    assert(recipes.effects.size() == 13);
    constexpr double record_tolerance = 1e-5;
    const double worst = check_bursts(oracle, recipes);
    std::cout << "worst record difference " << worst << "\n";
    assert(worst < record_tolerance);
    check_places(oracle, recipes);
    std::cout << "Hop effects match the website: " << oracle["bursts"].size() << " bursts, " << oracle["places"].size()
              << " floors\n";
}
