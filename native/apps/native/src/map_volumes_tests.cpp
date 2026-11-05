// The map volumes the bunnies of ghosts and other players swim and climb from (map_volumes.hpp): a small BSP built
// here (water below z = 0, one ladder brush), then the website's own code (map-volumes-oracle.ts) on the real maps in
// native/maps when there are any: ladder boxes, water at points, water levels, ladder gaps and the ladder guess.
#include "map_volumes.hpp"
#include <nlohmann/json.hpp>
#include <cassert>
#include <cstdio>
#include <fstream>
#include <memory>
#include <sstream>

namespace {
using Json = nlohmann::json;
using native::MapVolumes;

constexpr int missing_maps_exit = 77;
constexpr double box_tolerance = 1e-9, gap_tolerance = 1e-6, largest_gap = 1e6;

// A v20 BSP: planes 0-5 bound the ladder box [100, 0, 0] - [104, 64, 256], plane 6 is z = 0 with water below it.
std::string synthetic_bsp() {
    constexpr int header_bytes = 1036;
    const float planes[7][4] = {
            {1, 0, 0, 104}, {-1, 0, 0, -100}, {0, 1, 0, 64}, {0, -1, 0, 0}, {0, 0, 1, 256}, {0, 0, -1, 0}, {0, 0, 1, 0}
    };
    std::string bytes(header_bytes, '\0');
    auto put = [&bytes](size_t at, const void *data, size_t size) {
        if (bytes.size() < at + size) bytes.resize(at + size);
        std::memcpy(bytes.data() + at, data, size);
    };
    auto lump = [&](int index, const std::string &data) {
        const int32_t offset = int32_t(bytes.size()), length = int32_t(data.size());
        put(8 + size_t(index) * 16, &offset, 4);
        put(12 + size_t(index) * 16, &length, 4);
        bytes += data;
    };
    auto raw = [](const auto &value) {
        return std::string(reinterpret_cast<const char *>(&value), sizeof value);
    };
    const uint32_t vbsp = 0x50534256;
    const int32_t version = 20;
    put(0, &vbsp, 4);
    put(4, &version, 4);
    lump(native::BspVolumeLumps::planes, [&] {
        std::string out;
        for (const auto &plane : planes)
            out += raw(plane) + std::string(4, '\0');
        return out;
    }());
    const int32_t node[8] = {6, -1, -2, 0, 0, 0, 0, 0};
    lump(native::BspVolumeLumps::nodes, raw(node));
    std::string leafs(64, '\0');
    const int32_t water = MapVolumes::contents_water;
    std::memcpy(leafs.data() + 32, &water, 4);
    lump(native::BspVolumeLumps::leafs, leafs);
    std::string model(48, '\0');
    lump(native::BspVolumeLumps::models, model);
    const int32_t brush[3] = {0, 6, MapVolumes::contents_ladder};
    lump(native::BspVolumeLumps::brushes, raw(brush));
    std::string sides;
    for (uint16_t plane = 0; plane < 6; plane++)
        sides += raw(plane) + std::string(6, '\0');
    lump(native::BspVolumeLumps::brush_sides, sides);
    lump(native::BspVolumeLumps::entities, "{\n\"classname\" \"worldspawn\"\n}\n");
    return bytes;
}

std::unique_ptr<MapVolumes> parse(const std::string &bytes) {
    std::istringstream in(bytes);
    const auto lumps = native::BspVolumeLumps::read(in);
    return lumps ? std::make_unique<MapVolumes>(*lumps) : nullptr;
}

void test_synthetic() {
    const auto volumes = parse(synthetic_bsp());
    assert(volumes && volumes->has_water());
    assert(volumes->water_at(0, 0, -10) && !volumes->water_at(0, 0, 10));
    const float deep[3] = {0, 0, -100}, waist[3] = {0, 0, -40}, feet[3] = {0, 0, -20}, dry[3] = {0, 0, .5f};
    assert(volumes->recorded_water_level(deep, false) == 3);
    assert(volumes->recorded_water_level(waist, false) == 2);
    assert(volumes->recorded_water_level(feet, false) == 1 && volumes->recorded_water_level(feet, true) == 2);
    assert(volumes->recorded_water_level(dry, false) == 0);
    assert(volumes->ladders().size() == 1);
    const native::LadderBox box = {100, 0, 0, 104, 64, 256};
    assert(volumes->ladders()[0] == box);
    const float beside[3] = {80, 32, 100}, above[3] = {80, 32, 300};
    assert(std::abs(volumes->ladder_gap(beside, false) - 4) < gap_tolerance);
    assert(std::isinf(volumes->ladder_gap(above, false)));
    // Not a BSP, or one cut short: no volumes, no crash.
    assert(!parse(std::string(64, '\0')));
    const auto cut = parse(synthetic_bsp().substr(0, 1100));
    assert(!cut || (!cut->has_water() && cut->ladders().empty()));
}

// A player climbs the ladder, not one strafing past it or standing on the ground below it.
void test_ladder_guess() {
    const auto volumes = parse(synthetic_bsp());
    native::LadderGuess guess;
    const float on_it[3] = {82, 32, 100}, climbing[3] = {0, 0, 200}, falling_fast[3] = {0, 0, -300};
    double time = 0;
    bool climbed = false;
    for (int i = 0; i < 30; i++, time += .01)
        climbed = guess.update(on_it, climbing, false, false, time, *volumes);
    assert(climbed);
    guess.reset();
    bool fell = false;
    float velocity[3] = {0, 0, 0};
    for (int i = 0; i < 30; i++, time += .01) {
        velocity[2] = float(falling_fast[2] - 800 * i * .01);
        fell |= guess.update(on_it, velocity, false, false, time, *volumes);
    }
    assert(!fell);
    assert(!guess.update(on_it, climbing, false, true, time, *volumes));
}

void expect(bool ok, const std::string &what) {
    if (ok) return;
    std::fprintf(stderr, "map volumes: %s\n", what.c_str());
    assert(false);
}

void compare_map(const Json &map) {
    const auto path = map.at("path").get<std::string>();
    std::ifstream file(path, std::ios::binary);
    const auto lumps = native::BspVolumeLumps::read(file);
    expect(lumps.has_value(), path + " doesn't read");
    const auto volumes = std::make_unique<MapVolumes>(*lumps);
    expect(volumes->has_water() == map.at("hasWater").get<bool>(), path + ": water");
    const auto &ladders = map.at("ladders");
    expect(volumes->ladders().size() == ladders.size(), path + ": ladder count");
    for (size_t i = 0; i < ladders.size(); i++)
        for (size_t k = 0; k < 6; k++)
            expect(std::abs(volumes->ladders()[i][k] - ladders[i][k].get<double>()) < box_tolerance,
                   path + ": ladder " + std::to_string(i));
    for (const auto &sample : map.at("samples")) {
        const auto p = sample.at("p").get<std::array<float, 3>>();
        const std::string at = path + " at " + sample.at("p").dump();
        expect(volumes->water_at(p[0], p[1], p[2]) == sample.at("water").get<bool>(), at + ": water");
        expect(volumes->water_level(p.data(), 64, false) == sample.at("standing").get<int>(), at + ": level");
        expect(volumes->water_level(p.data(), 46, true) == sample.at("crouched").get<int>(), at + ": ducked level");
        const double gap = std::min(largest_gap, volumes->ladder_gap(p.data(), false));
        expect(std::abs(gap - sample.at("gap").get<double>()) < gap_tolerance, at + ": ladder gap");
    }
    for (const auto &steps : map.at("guesses")) {
        native::LadderGuess guess;
        for (const auto &step : steps) {
            const auto pos = step.at("pos").get<std::array<float, 3>>();
            const auto vel = step.at("vel").get<std::array<float, 3>>();
            const bool on = guess.update(pos.data(), vel.data(), false, false, step.at("time"), *volumes);
            expect(on == step.at("on").get<bool>(), path + ": ladder guess at " + step.at("time").dump());
        }
    }
}
}  // namespace

int main(int argc, char **argv) {
    test_synthetic();
    test_ladder_guess();
    if (argc < 2) {
        std::puts("map volumes: synthetic BSP passed (no website oracle given)");
        return 0;
    }
    std::ifstream file(argv[1]);
    const auto oracle = Json::parse(file);
    if (oracle.empty()) {
        std::puts("map volumes: no BSPs in native/maps to compare with the website");
        return missing_maps_exit;
    }
    size_t samples = 0, ladders = 0, climbs = 0;
    for (const auto &map : oracle) {
        compare_map(map);
        samples += map.at("samples").size();
        ladders += map.at("ladders").size();
        for (const auto &steps : map.at("guesses"))
            for (const auto &step : steps)
                climbs += step.at("on").get<bool>();
    }
    std::printf(
            "map volumes like the website's on %zu maps: %zu ladders, %zu water samples, %zu climbing steps\n",
            oracle.size(),
            ladders,
            samples,
            climbs
    );
    return 0;
}
