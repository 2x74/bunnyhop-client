// Offline integration check; the supplied replay is never recorded or submitted.
#include "bunnyhop_native.h"
#include "graphics_settings.hpp"
#include "render_shaders.hpp"
#include <filesystem>
#include <memory>
#include <vector>
#include <iostream>
#include <thread>
#include "replay_controls.hpp"
#include "render_menu_contracts.hpp"

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
        if (native::render_menu_message_limit("replayCompare", 16384) != 12 * 1024 * 1024
            || native::render_menu_message_limit("settings", 16384) != 16384) {
            throw std::runtime_error("Compare base64 message limit mismatch");
        }
        native::ReplayCompare compare;
        for (unsigned attempt = 0; attempt < 5; ++attempt) {
            compare.load(core.get(), argv[2], native_render::GhostSource::wr, info);
            if (!compare.active() || compare.state().at("source") != "wr") {
                throw std::runtime_error("Compare metadata/source missing");
            }
            const auto *actor = compare.sample(tick, info.at("settings").at("tickInterval"));
            if (!actor) throw std::runtime_error("Compare has no sample");
            if (actor->frame.tick != tick)
                throw std::runtime_error(
                        "Compare tick " + std::to_string(actor->frame.tick) + " expected " + std::to_string(tick)
                );
            if (snapshot_bytes(core.get()) != before) throw std::runtime_error("Compare moved playback bytes");
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
        const auto cache = std::filesystem::temp_directory_path() / "bunnyhop-compare-contract-test";
        std::filesystem::create_directories(cache);
        std::ifstream input(argv[2], std::ios::binary);
        const std::vector<uint8_t> replay_bytes(std::istreambuf_iterator<char>(input), {});
        const nlohmann::json request = {
                {"type", "replayCompare"},
                {"action", "set"},
                {"kind", "pb"},
                {"name", "Your PB"},
                {"replayBase64", "fixture"}
        };
        native::compare_message(compare, core.get(), cache, request, info, [&](const std::string &) {
            return replay_bytes;
        });
        nlohmann::json host = {{"playback", nlohmann::json::object()}};
        BhSnapshot shown{};
        bh_snapshot(core.get(), &shown);
        native::render_playback_state(host, compare, info.at("settings").at("tickInterval"), shown.player);
        if (host.at("playback").at("features").at(0) != "compare"
            || !host.at("playback").at("compare").contains("delta")
            || host.at("playback").at("compare").at("kind") != "pb"
            || host.at("playback").at("compare").at("name") != "Your PB" || snapshot_bytes(core.get()) != before) {
            throw std::runtime_error("Compare contract mismatch");
        }

        struct Chat {
            std::string error;

            void push(const std::string &text, const std::string &, const std::string &, double) { error = text; }
        } chat;

        native::ReplayCompareImportService imports;
        imports.map(argv[1], {});
        compare.clear();
        auto async_request = request;
        async_request["name"] = "Async PB";
        imports.message(compare, core.get(), cache, async_request, info, "fixture.bhr", [&](const std::string &) {
            return replay_bytes;
        });
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
        while (!compare.active() && chat.error.empty() && std::chrono::steady_clock::now() < deadline) {
            imports.poll(compare, "fixture.bhr", true, chat, 0);
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        if (!compare.active() || !chat.error.empty() || compare.menu_state(.01).at("name") != "Async PB"
            || snapshot_bytes(core.get()) != before)
            throw std::runtime_error("Asynchronous Compare contract failed: " + chat.error);
        const auto wait_for_compare = [&] {
            const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
            while (!compare.active() && chat.error.empty() && std::chrono::steady_clock::now() < deadline) {
                imports.poll(compare, "fixture.bhr", true, chat, 0);
                std::this_thread::sleep_for(std::chrono::milliseconds(1));
            }
            if (!compare.active() || !chat.error.empty() || snapshot_bytes(core.get()) != before)
                throw std::runtime_error("Worker compare path failed: " + chat.error);
        };
        std::filesystem::copy_file(argv[2], cache / "existing.bhr", std::filesystem::copy_options::overwrite_existing);
        compare.clear();
        const nlohmann::json local_request = {{"action", "set"}, {"id", "existing.bhr"}, {"source", "wr"}};
        for (unsigned replacement = 0; replacement < 100; ++replacement)
            imports.message(
                    compare,
                    core.get(),
                    cache,
                    local_request,
                    info,
                    "fixture.bhr",
                    [](const std::string &) -> std::vector<uint8_t> {
                        throw std::runtime_error("Local compare must not decode base64");
                    }
            );
        wait_for_compare();
        if (compare.state().at("source") != "wr")
            throw std::runtime_error("Local-id worker did not adopt the prepared WR");
        imports.message(
                compare, core.get(), cache, async_request, info, "fixture.bhr", [replay_bytes](const std::string &) {
                    return replay_bytes;
                }
        );
        imports.message(
                compare, core.get(), cache, {{"action", "clear"}}, info, "fixture.bhr", [](const std::string &) {
                    return std::vector<uint8_t>{};
                }
        );
        if (compare.active()) throw std::runtime_error("Clear retained a prepared Compare");
        native::ReplayTimelineData bins;
        bins.step = 2;
        BhState sample{};
        sample.velocity[0] = 3;
        sample.velocity[1] = 4;
        bins.sample(0, sample);
        sample.velocity[0] = 8;
        sample.velocity[1] = 6;
        sample.events = 2;
        bins.sample(1, sample);
        bins.sample(2, sample);
        if (bins.speeds.size() != 2 || bins.speeds[0] != 10 || bins.speeds[1] != 10 || bins.jumps[0] != 1) {
            throw std::runtime_error("Timeline bins/jump ticks mismatch");
        }
        BhRunState split_state{};
        split_state.split_count = 1;
        split_state.update_flags = 16;
        BhZone stage{};
        stage.kind = 2;
        stage.index = 7;
        for (int axis = 0; axis < 3; ++axis) {
            stage.mins[axis] = -20;
            stage.maxs[axis] = 20;
        }
        sample.tick = 47;
        int64_t previous_split = -1;
        native::timeline_split(bins, sample, split_state, {stage}, previous_split);
        if (bins.splits.size() != 1 || bins.splits[0].tick != 47 || bins.splits[0].index != 7
            || bins.splits[0].checkpoint) {
            throw std::runtime_error("Timeline absolute split marker mismatch");
        }
        std::atomic_bool cancel = false;
        const auto timeline = native::build_replay_timeline(argv[1], {}, argv[2], cancel);
        const auto data = timeline.json("fixture.bhr");
        if (data.at("id") != "fixture.bhr" || data.at("speed").empty() || !data.at("desyncTick").is_null()
            || snapshot_bytes(core.get()) != before)
            throw std::runtime_error("Timeline altered playback or desynced");

        struct Menu {
            unsigned calls = 0;
            std::string script;

            void evaluate_js(const std::string &value) {
                script = value;
                ++calls;
            }
        } menu;

        native::ReplayTimelineService timeline_service;
        timeline_service.map(argv[1], {});
        timeline_service.request(argv[2], "fixture.bhr");
        const auto timeline_deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
        while (!menu.calls && std::chrono::steady_clock::now() < timeline_deadline) {
            timeline_service.poll(&menu, true, "fixture.bhr", true);
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        for (unsigned repeat = 0; repeat < 3; ++repeat)
            timeline_service.poll(&menu, true, "fixture.bhr", true);
        if (menu.calls != 1 || menu.script.find("onReplayTimeline") == std::string::npos
            || menu.script.find("fixture.bhr") == std::string::npos || snapshot_bytes(core.get()) != before) {
            throw std::runtime_error("Timeline delivery must be once per replay and preserve live state");
        }
        compare.clear();
        std::filesystem::remove_all(cache);
        std::cout << "Compare load/sample/clear/mismatch preserve exact playback bytes; five replacement cycles plus "
                     "Compare and timeline contracts passed\n";
        return 0;
    } catch (const std::exception &error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
