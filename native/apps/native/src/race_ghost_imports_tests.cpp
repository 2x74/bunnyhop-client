#include "race_ghost_imports.hpp"
#include "test_bsp.hpp"
#include "menu_messages.hpp"
#include <chrono>
#include <fstream>
#include <iostream>
#include <thread>

namespace {
void check(bool ok, const char *message) {
    if (!ok) throw std::runtime_error(message);
}

struct Renderer {
    std::array<native_render::GhostPath, 4> paths;

    void set_ghost_path(unsigned slot, native_render::GhostPath path) { paths[slot] = std::move(path); }
};

struct Chat {
    std::string error;

    void push(const std::string &message, const char *, const char *, double) { error = message; }
};
}  // namespace

int main() {
    const auto directory =
            std::filesystem::temp_directory_path()
            / ("bunnyhop-race-ghost-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    try {
        std::filesystem::create_directories(directory / "models" / "fixture");
        const auto box = native::test::make_box_model();
        std::ofstream(directory / "models" / "fixture" / "box.mdl", std::ios::binary)
                .write(reinterpret_cast<const char *>(box.data()), box.size());
        const auto bsp = native::test::make_bsp();
        const auto map = (directory / "fixture.bsp").string();
        std::ofstream(map, std::ios::binary).write(reinterpret_cast<const char *>(bsp.data()), bsp.size());
        std::unique_ptr<BhContext, decltype(&bh_destroy)> live(bh_create(), bh_destroy);
        check(live && bh_load_map(live.get(), map.c_str(), directory.string().c_str()), "fixture map failed");
        BhRunOptions options{};
        bh_default_run_options(&options);
        const std::array<BhZone, 2> zones = {
                BhZone{0, 0, 0, {-100, -100, -10000}, {18, 100, 1000}},
                BhZone{1, 0, 0, {300, -100, -10000}, {1000, 100, 1000}}
        };
        check(bh_run_configure(live.get(), &options, zones.data(), zones.size()) && bh_reset(live.get()),
              "fixture timer failed");
        check(bh_set_position(live.get(), 10, 20, 65, 0), "fixture placement failed");
        const auto replay = (directory / "fixture.bhr").string();
        check(bh_record_begin(live.get(), "", "autohop", "test", 100), "fixture recorder failed");
        BhCmd command{};
        BhState state{};
        command.forward = 400;
        BhRunState run{};
        for (unsigned tick = 0; tick < 4096 && run.status != 2; ++tick) {
            check(bh_step(live.get(), &command, &state) && bh_run_state(live.get(), &run), "fixture tick failed");
        }
        check(run.status == 2, "fixture run did not finish");
        if (!bh_record_end(live.get()) || !bh_record_write_bhr(live.get(), replay.c_str()))
            throw std::runtime_error(bh_last_error(live.get()));
        check(bh_reset(live.get()), "restart failed");
        check(bh_record_begin(live.get(), "", "autohop", "test", 200), "live recording failed");
        size_t count = 0;
        const auto *bytes = bh_snapshot_bytes(live.get(), &count);
        const std::vector<uint8_t> before(bytes, bytes + count);
        native::RaceGhostImports imports;
        native::GhostSlots ghosts;
        Renderer renderer;
        Chat chat;
        const nlohmann::json request = {
                {"ghostSlot", 0}, {"source", "pb"}, {"track", 0}, {"style", "autohop"}, {"id", "fixture.bhr"}
        };
        const auto decode = [](const std::string &) {
            return std::vector<uint8_t>{};
        };
        imports.request(request, map, directory.string(), directory, decode);
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(15);
        while (!ghosts.slots[0].loaded() && chat.error.empty() && std::chrono::steady_clock::now() < deadline) {
            imports.poll(ghosts, live.get(), &renderer, 0, "autohop", chat, 0);
            std::this_thread::sleep_for(std::chrono::milliseconds(5));
        }
        if (!chat.error.empty()) throw std::runtime_error(chat.error);
        check(ghosts.slots[0].loaded() && ghosts.slots[0].recording, "background import did not finish");
        check(renderer.paths[0].source == native_render::GhostSource::pb, "PB source lost");
        check(renderer.paths[0].motion_events.size() == renderer.paths[0].frames.size(), "exact route events lost");
        bytes = bh_snapshot_bytes(live.get(), &count);
        check(before == std::vector<uint8_t>(bytes, bytes + count), "background import changed the live run");
        check(bh_step(live.get(), &command, &state), "live recorder cannot continue");
        check(bh_record_end(live.get()), "live recording lost");
        BhCmd shown{};
        check(ghosts.slots[0].command(live.get(), 10, shown) && shown.forward == 400,
              "prepared ghost commands are unavailable after install");
        auto wire = request;
        wire.update({{"generation", imports.generation()}, {"map", "fixture"}});
        check(!imports.accepts(wire, ghosts, "fixture", "autohop", 0), "an occupied PB slot was replaced");
        ghosts.sources[0] = native_render::GhostSource::pb;
        ghosts.slots[0].info["track"] = 1;
        check(imports.accepts(wire, ghosts, "fixture", "autohop", 0), "old track PB could not be replaced");
        check(!imports.accepts(wire, ghosts, "next", "autohop", 0), "stale map request accepted");
        const auto generation = imports.generation();
        imports.reset();
        check(imports.generation() != generation, "map changes do not invalidate ghost requests");
        check(!imports.accepts(wire, ghosts, "fixture", "autohop", 0), "old map generation accepted");
        check(native::menu_message_limit("raceGhost") == native::kMenuReplayMessageBytes,
              "race replay bodies are truncated at the normal menu message limit");
        std::filesystem::remove_all(directory);
        std::cout << "Background race ghost, live recorder, exact events, source and map generation passed\n";
        return 0;
    } catch (const std::exception &error) {
        std::filesystem::remove_all(directory);
        std::cerr << error.what() << '\n';
        return 1;
    }
}
