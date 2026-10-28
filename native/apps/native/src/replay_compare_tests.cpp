// Offline integration check; the supplied replay is never recorded or submitted.
#include "bunnyhop_native.h"
#include "graphics_settings.hpp"
#include "render_shaders.hpp"
#include <filesystem>
#include <memory>
#include <vector>
#include <iostream>
#define BUNNYHOP_NATIVE_RENDERER_AVAILABLE 1
#include "replay_controls.hpp"

static std::vector<uint8_t> snapshot_bytes(BhContext *core) {
    size_t count = 0;
    const auto *bytes = bh_snapshot_bytes(core, &count);
    if (!bytes) {
        throw std::runtime_error("No snapshot bytes");
    }
    return {bytes, bytes + count};
}
int main(int argc, char **argv) {
    try {
        if (argc != 3) {
            throw std::runtime_error("usage: replay-compare-tests MAP.bsp COMPLETED.bhr");
        }
        std::unique_ptr<BhContext, decltype(&bh_destroy)> core(bh_create(), &bh_destroy);
        if (!core || !bh_load_map(core.get(), argv[1], nullptr) || !bh_replay_load(core.get(), argv[2])) {
            throw std::runtime_error(core ? bh_last_error(core.get()) : "No core");
        }
        size_t size = 0;
        const auto *raw = bh_replay_info(core.get(), &size);
        if (!raw) {
            throw std::runtime_error("No replay info");
        }
        const auto info = nlohmann::json::parse(raw, raw + size);
        BhSnapshot state{};
        const uint32_t finish = info.at("endTick").get<uint32_t>();
        const uint32_t tick = std::min(37u, finish ? finish : info.at("totalTicks").get<uint32_t>());
        if (!bh_replay_seek(core.get(), tick, &state)) {
            throw std::runtime_error(bh_last_error(core.get()));
        }
        const auto before = snapshot_bytes(core.get());
        native::ReplayCompare compare;
        for (unsigned attempt = 0; attempt < 5; ++attempt) {
            compare.load(core.get(), argv[2], native_render::GhostSource::wr, info);
            if (!compare.active() || compare.state().at("source") != "wr") {
                throw std::runtime_error("Compare metadata/source missing");
            }
            const auto *actor = compare.sample(tick, info.at("settings").at("tickInterval"));
            if (!actor)
                throw std::runtime_error("Compare has no sample");
            if (actor->frame.tick != tick)
                throw std::runtime_error("Compare tick " + std::to_string(actor->frame.tick) + " expected " +
                                         std::to_string(tick));
            if (snapshot_bytes(core.get()) != before)
                throw std::runtime_error("Compare moved playback bytes");
            auto wrong = info;
            wrong["style"] = "sideways";
            bool rejected = false;
            try {
                compare.load(core.get(), argv[2], native_render::GhostSource::custom, wrong);
            } catch (const std::runtime_error &) {
                rejected = true;
            }
            if (!rejected || compare.active() || snapshot_bytes(core.get()) != before) {
                throw std::runtime_error("Compare mismatch leaked a handle or changed playback");
            }
        }
        compare.clear();
        std::cout
            << "Compare load/sample/clear/mismatch preserve exact playback bytes; five replacement cycles passed\n";
        return 0;
    } catch (const std::exception &error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
