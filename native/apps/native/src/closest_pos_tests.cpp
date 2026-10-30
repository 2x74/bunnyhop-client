// Differential test: the routes of the website's closest-position tests, through the web search and through the C++
// port, answer for answer and to the bit: the search is IEEE-exact arithmetic. src/closest_pos_oracle.ts produces them.
#include "closest_pos.hpp"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <nlohmann/json.hpp>
#include <atomic>
#include <cassert>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <new>
#include <string>
#include <vector>

namespace {

std::atomic<size_t> allocations = 0;

int failures = 0;
long compared = 0;

void fail(const std::string &where, const std::string &what) {
    if (++failures <= 20) std::cerr << "MISMATCH " << where << ": " << what << '\n';
}

std::vector<BhGhostFrame> frames_from(const nlohmann::json &flat) {
    std::vector<BhGhostFrame> frames(flat.size() / 3);
    for (size_t t = 0; t < frames.size(); ++t) {
        for (size_t axis = 0; axis < 3; ++axis)
            frames[t].position[axis] = flat[t * 3 + axis].get<float>();
    }
    return frames;
}

void same_number(const std::string &where, const char *field, double actual, const nlohmann::json &expected) {
    if (expected.is_null()) {
        if (!std::isnan(actual)) fail(where, std::string(field) + " is " + std::to_string(actual) + ", expected NaN");
        return;
    }
    if (actual != expected.get<double>())
        fail(where, std::string(field) + " is " + nlohmann::json(actual).dump() + ", expected " + expected.dump());
}

void replay_case(const nlohmann::json &item) {
    const auto name = item.at("name").get<std::string>();
    const auto frames = frames_from(item.at("frames"));
    std::vector<uint8_t> teleports;
    if (!item.at("events").is_null()) teleports = item.at("events").get<std::vector<uint8_t>>();
    native::ClosestPos search(
            frames,
            item.at("start").get<uint32_t>(),
            item.at("end").get<uint32_t>(),
            item.at("interval").get<double>(),
            teleports
    );
    if (item.at("built").get<bool>()) search.build();
    const auto slice = item.at("slice").get<int64_t>();
    const auto &ops = item.at("ops");
    const auto &answers = item.at("answers");
    for (size_t i = 0; i < ops.size(); ++i) {
        if (slice) search.build(slice);
        if (ops[i].is_string()) {
            search.reset();
            continue;
        }
        const bool found = search.find(ops[i][0].get<double>(), ops[i][1].get<double>(), ops[i][2].get<double>());
        const auto &answer = answers[i];
        const std::string where = name + " question " + std::to_string(i);
        ++compared;
        if (found != answer.at("found").get<bool>()) fail(where, found ? "found a match" : "found no match");
        if (search.ready() != answer.at("ready").get<bool>()) fail(where, "index readiness");
        same_number(where, "tick", search.tick, answer.at("tick"));
        same_number(where, "distance", search.distance, answer.at("dist"));
        same_number(where, "speed", search.speed, answer.at("speed"));
    }
}

std::vector<BhGhostFrame> wandering_route(int ticks) {
    std::vector<BhGhostFrame> frames(size_t(ticks) + 1);
    for (int t = 0; t <= ticks; ++t) {
        frames[size_t(t)].position[0] = float(std::sin(t / 90.) * 2000);
        frames[size_t(t)].position[1] = float(t * 3);
        frames[size_t(t)].position[2] = float(std::abs(std::sin(t / 30.)) * 50);
    }
    return frames;
}

// The website's own check, here for the port: a run down the ghost's route reads no time difference on any tick.
void check_identical_run_reads_zero() {
    constexpr int ticks = 5000;
    constexpr double tick_tolerance = 1e-3;
    constexpr double interval = .01;
    const auto frames = wandering_route(ticks);
    native::ClosestPos search(frames, 0, ticks, interval);
    search.build();
    for (int t = 0; t <= ticks; t += 4) {
        const auto &position = frames[size_t(t)].position;
        assert(search.find(position[0], position[1], position[2]));
        assert(std::abs(search.tick - t) < tick_tolerance);
        assert(search.distance == 0);
    }
}

void check_speed_text(const nlohmann::json &oracle) {
    for (const auto &item : oracle.at("speedText")) {
        const auto text = native::speed_diff_text(item.at("value").get<double>());
        if (text.view() != item.at("text").get<std::string>())
            fail("speed text", std::string(text.view()) + ", expected " + item.dump());
    }
}

// A frame's work allocates nothing: find() always, and build() past the constructor.
void check_search_does_not_allocate() {
    constexpr int ticks = 20000;
    constexpr int64_t slice_frames = 2048;
    const auto frames = wandering_route(ticks);
    native::ClosestPos search(frames, 0, ticks, .01);
    const size_t before = allocations;
    for (int t = 0; t <= ticks; t += 4) {
        search.build(slice_frames);
        const auto &position = frames[size_t(t)].position;
        search.find(double(position[0]) + 30, double(position[1]) - 30, position[2]);
    }
    assert(search.ready());
    assert(allocations == before);
}

}  // namespace

void *operator new(std::size_t bytes) {
    ++allocations;
    if (void *memory = std::malloc(bytes ? bytes : 1)) return memory;
    throw std::bad_alloc();
}

void operator delete(void *memory) noexcept {
    std::free(memory);
}

void operator delete(void *memory, std::size_t) noexcept {
    std::free(memory);
}

int main(int argc, char **argv) {
    const std::string path = argc > 1 ? argv[1] : "closest-pos-oracle.json";
    std::ifstream file(path);
    if (!file) {
        std::cerr << "Cannot open the closest position oracle at " << path
                  << "\nGenerate it with: bun apps/native/src/closest_pos_oracle.ts " << path << '\n';
        return 2;
    }
    nlohmann::json oracle;
    file >> oracle;
    for (const auto &item : oracle.at("cases"))
        replay_case(item);
    check_speed_text(oracle);
    // A stream that produced nothing would otherwise pass silently.
    constexpr long least_answers = 1000;
    if (compared < least_answers) {
        std::cerr << "Only " << compared << " answers were compared; the oracle looks wrong\n";
        return 1;
    }
    if (failures) {
        std::cerr << failures << " mismatches across " << compared << " answers\n";
        return 1;
    }
    check_identical_run_reads_zero();
    check_search_does_not_allocate();
    std::cout << "Closest position port matches the web reference across " << compared << " answers\n";
    return 0;
}
