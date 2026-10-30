#include "bunnyhop_native.h"
#include "data_location.hpp"
#include <array>
#include <bit>
#include <cstring>
#include <fstream>
#include <iostream>
#include <memory>
#include <nlohmann/json.hpp>
#include <stdexcept>
#include <tuple>

namespace {
using Json = nlohmann::json;
using Context = std::unique_ptr<BhContext, decltype(&bh_destroy)>;

void checked(BhContext *core, int result) {
    if (!result) throw std::runtime_error(bh_last_error(core));
}

void checked_pair(BhContext *first, int first_result, BhContext *second, int second_result) {
    if (first_result != second_result) throw std::logic_error("replay verdict differs with audio observations");
    if (first_result) return;
    const std::string first_error = bh_last_error(first);
    if (first_error != bh_last_error(second))
        throw std::logic_error("replay rejection differs with audio observations");
    throw std::runtime_error(first_error);
}

std::vector<uint8_t> snapshot(BhContext *core) {
    size_t size = 0;
    const auto *data = bh_snapshot_bytes(core, &size);
    if (!data) throw std::runtime_error("snapshot unavailable");
    return {data, data + size};
}

auto timer_key(const BhRunState &state) {
    return std::tuple{
            state.status,
            state.track,
            state.start_tick,
            state.end_tick,
            state.last_tick,
            state.jumps,
            state.strafes,
            state.perfect_jumps,
            state.measured_jumps,
            state.sync_good,
            state.sync_total,
            state.in_start,
            state.pending_start,
            state.update_flags,
            state.split_count,
            state.last_perfect_tick,
            state.recording,
            state.recording_valid,
            state.total_commands,
            state.rolling_hash,
            std::bit_cast<uint64_t>(state.seconds),
            std::bit_cast<uint64_t>(state.sync_percent),
            std::bit_cast<uint64_t>(state.perf_percent)
    };
}

struct Observations {
    std::array<BhMapSoundState, 4096> states{};
    std::array<uint8_t, 16384> commands{};
    uint32_t serial = ~0u;

    void read(BhContext *core) {
        const auto next = bh_map_sound_serial(core);
        if (next == serial) return;
        serial = next;
        bh_map_sound_states(core, states.data(), states.size());
        bh_map_sound_commands(core, commands.data(), commands.size());
    }
};

uint32_t compare(const Json &entry) {
    Context silent(bh_create(), bh_destroy), audible(bh_create(), bh_destroy);
    const auto map = entry.at("map").get<std::string>();
    const auto replay = entry.at("replay").get<std::string>();
    for (auto *core : {silent.get(), audible.get()}) {
        checked(core, bh_load_map(core, map.c_str(), nullptr));
        checked(core, bh_replay_load(core, replay.c_str()));
    }
    size_t size = 0;
    const auto *text = bh_replay_info(silent.get(), &size);
    const auto info = Json::parse(text, text + size);
    const uint32_t ticks = info.at("totalTicks");
    auto observations = std::make_unique<Observations>();
    for (uint32_t tick = 0; tick < ticks; ++tick) {
        BhSnapshot first{}, second{};
        const int first_result = bh_replay_step(silent.get(), &first);
        const int second_result = bh_replay_step(audible.get(), &second);
        checked_pair(silent.get(), first_result, audible.get(), second_result);
        observations->read(audible.get());
        if (snapshot(silent.get()) != snapshot(audible.get()))
            throw std::logic_error("simulation differs at tick " + std::to_string(tick));
        BhRunState first_timer{}, second_timer{};
        checked(silent.get(), bh_run_state(silent.get(), &first_timer));
        checked(audible.get(), bh_run_state(audible.get(), &second_timer));
        if (timer_key(first_timer) != timer_key(second_timer))
            throw std::logic_error("timer differs at tick " + std::to_string(tick));
    }
    return ticks;
}
}  // namespace

int main(int argc, char **argv) {
    if (argc != 2) {
        std::cerr << "usage: bunnyhop-native-map-audio-identity INVENTORY.json\n"
                  << "Inventory: [{\"map\":\"/path/map.bsp\",\"replay\":\"/path/run.bhr\"}]\n";
        return 1;
    }
    try {
        std::ifstream stream(native::data_location::from_utf8(argv[1]));
        const auto inventory = Json::parse(stream);
        size_t identical = 0, skipped = 0;
        uint64_t ticks = 0;
        for (const auto &entry : inventory) {
            try {
                ticks += compare(entry);
                ++identical;
            } catch (const std::logic_error &) {
                throw;
            } catch (const std::runtime_error &error) {
                ++skipped;
                std::cerr << entry.at("replay") << ": skipped: " << error.what() << '\n';
            }
        }
        std::cout << "identical " << identical << ", different 0, skipped " << skipped
                  << ", tick snapshots and timer states " << ticks << '\n';
        return identical ? 0 : 1;
    } catch (const std::exception &error) {
        std::cerr << "Native map audio identity: " << error.what() << '\n';
        return 1;
    }
}
