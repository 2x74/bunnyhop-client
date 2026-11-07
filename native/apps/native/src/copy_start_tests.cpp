#include "copy_start.hpp"
#include "copy_start_picker.hpp"
#include "menu_messages.hpp"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <fstream>
#include <iostream>
using Json = nlohmann::json;
using Core = std::unique_ptr<BhContext, decltype(&bh_destroy)>;

std::vector<BhZone> fixture_zones(uint32_t track) {
    return {{0, track, 0, {-100, -100, -10000}, {100, 100, 1000}},
            {1, track, 0, {150, -100, -10000}, {1000, 100, 1000}}};
}

Core load(const std::filesystem::path &directory) {
    Core core(bh_create(), bh_destroy);
    native::copy_start_check(
            core.get(),
            core && bh_load_map(core.get(), native::data_location::utf8(directory / "fixture.bsp").c_str(), nullptr)
    );
    return core;
}

void record(
        BhContext *core,
        const std::filesystem::path &path,
        uint32_t track,
        bool walk,
        const std::optional<native::StartPoint> &point = std::nullopt
) {
    auto zones = fixture_zones(track);
    BhRunOptions options{};
    bh_default_run_options(&options);
    native::copy_start_check(core, bh_style_set(core, "autohop"));
    native::copy_start_check(core, bh_run_configure(core, &options, zones.data(), zones.size()));
    native::copy_start_check(core, bh_reset(core));
    const native::StartPoint start = point.value_or(native::StartPoint{{10, 20, 65}, -120, 11, false});
    native::RestartPlacement::at(core, "fixture", track, start);
    native::copy_start_check(core, bh_record_begin(core, "", "autohop", "Copy start test", 10));
    BhState state{};
    if (walk) {
        for (unsigned tick = 0; tick < 65; ++tick) {
            BhCmd command{};
            command.forward = tick < 8 ? 200 : 0;
            command.yaw = tick < 8 ? 0 : 200;
            command.pitch = tick < 8 ? 0 : -7;
            native::copy_start_check(core, bh_step(core, &command, &state));
        }
    }
    BhRunState run{};
    for (unsigned tick = 0; tick < 1000 && run.status != 2; ++tick) {
        const BhCmd command{450, 0, 0, 11, 0};
        native::copy_start_check(core, bh_step(core, &command, &state));
        native::copy_start_check(core, bh_run_state(core, &run));
    }
    if (run.status != 2 || !run.start_tick)
        std::cerr << path << " status " << run.status << " start " << run.start_tick << " track " << run.track
                  << " position " << state.position[0] << "," << state.position[1] << "," << state.position[2]
                  << " grounded " << state.grounded << '\n';
    assert(run.status == 2 && run.start_tick > 0);
    native::copy_start_check(core, bh_record_end(core));
    std::filesystem::remove(path);
    native::copy_start_check(core, bh_record_write_bhr(core, native::data_location::utf8(path).c_str()));
}

void generate(const std::filesystem::path &directory) {
    std::filesystem::create_directories(directory);
    auto core = load(directory);
    record(core.get(), directory / "saved.bhr", 0, false);
    record(core.get(), directory / "walked.bhr", 0, true);
    record(core.get(), directory / "bonus.bhr", 2, true);
    record(core.get(), directory / "tiny-yaw.bhr", 0, false, native::StartPoint{{10, 20, 65}, 0.000001f, 11, false});
}

void compare(const std::filesystem::path &directory) {
    std::ifstream file(directory / "expected.json");
    const auto cases = Json::parse(file);
    std::atomic_bool cancelled = false;
    auto live = load(directory);
    record(live.get(), directory / "live.bhr", 0, false);
    BhSnapshot before{}, after{};
    native::copy_start_check(live.get(), bh_snapshot(live.get(), &before));
    for (const auto &example : cases) {
        auto core = load(directory);
        const auto zones = fixture_zones(example.value("track", 0u));
        try {
            const auto start = native::run_start_point(
                    core.get(),
                    directory / example.at("file").get<std::string>(),
                    example.value("map", std::string("fixture")),
                    zones,
                    cancelled
            );
            if (!example.at("ok").get<bool>()) {
                std::cerr << example.at("file") << " should have been refused\n";
                std::abort();
            }
            const auto &expected = example.at("point");
            assert(start.tick == example.at("tick") && start.track == example.at("track"));
            for (size_t axis = 0; axis < 3; ++axis)
                assert(start.point.position[axis] == expected.at("position").at(axis).get<float>());
            assert(start.point.yaw == expected.at("yaw").get<float>());
            assert(start.point.pitch == expected.at("pitch").get<float>());
            native::validate_copied_start(core.get(), "fixture", "autohop", zones, start);
            native::StartPoints saved;
            assert(start.save(saved, "fixture", zones));
            assert(saved.get("fixture", start.track) && !saved.get("fixture", start.track)->practice);
            record(live.get(),
                   directory / ("copied-" + example.at("file").get<std::string>()),
                   start.track,
                   false,
                   saved.get("fixture", start.track));
            // Another attempt keeps recording normally after the private replay probe.
            native::copy_start_check(live.get(), bh_snapshot(live.get(), &before));
        } catch (const std::exception &error) {
            if (example.at("ok").get<bool>()) {
                std::cerr << example.at("file") << ": " << error.what() << '\n';
                throw;
            }
        }
        native::copy_start_check(live.get(), bh_snapshot(live.get(), &after));
        assert(before.player.tick == after.player.tick);
        for (size_t axis = 0; axis < 3; ++axis) {
            assert(before.player.position[axis] == after.player.position[axis]);
            assert(before.player.velocity[axis] == after.player.velocity[axis]);
        }
    }
}

void worker_preserves_recording(const std::filesystem::path &directory) {
    auto core = load(directory);
    auto zones = fixture_zones(0);
    BhRunOptions options{};
    bh_default_run_options(&options);
    native::copy_start_check(core.get(), bh_run_configure(core.get(), &options, zones.data(), zones.size()));
    native::copy_start_check(core.get(), bh_reset(core.get()));
    native::copy_start_check(core.get(), bh_set_position(core.get(), 10, 20, 1, 0));
    native::copy_start_check(core.get(), bh_record_begin(core.get(), "", "autohop", "live", 10));
    const BhCmd command{450, 0, 0, 0, 1u << 3};
    BhState before{}, after{};
    native::copy_start_check(core.get(), bh_step(core.get(), &command, &before));
    uint32_t hash_before = 0, hash_after = 0;
    native::copy_start_check(core.get(), bh_record_fold(core.get(), 0, 0, 1, &hash_before));
    std::ifstream input(directory / "saved.bhr", std::ios::binary);
    const std::string replay((std::istreambuf_iterator<char>(input)), {});
    native::CopyStartImports imports;
    const Json request{
            {"id", 1},
            {"map", "fixture"},
            {"style", "autohop"},
            {"who", "Hopper"},
            {"replayBase64", native::base64(replay)}
    };
    imports.request(
            request, "fixture", "autohop", native::data_location::utf8(directory / "fixture.bsp"), "", directory, zones
    );
    std::optional<native::CopyStartImports::Result> result;
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (!result && std::chrono::steady_clock::now() < deadline) {
        result = imports.take("fixture", "autohop");
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    assert(result && result->start && result->error.empty());
    native::copy_start_check(core.get(), bh_state(core.get(), &after));
    native::copy_start_check(core.get(), bh_record_fold(core.get(), 0, 0, 1, &hash_after));
    assert(hash_before == hash_after && before.tick == after.tick);
    for (size_t axis = 0; axis < 3; ++axis) {
        assert(before.position[axis] == after.position[axis]);
        assert(before.velocity[axis] == after.velocity[axis]);
    }
    assert(!result->start->restart_now(1, false, 0));
    assert(result->start->restart_now(0, false, 0));
    auto bonus = *result->start;
    bonus.track = 2;
    assert(!bonus.restart_now(0, true, 0));
    assert(bonus.restart_now(0, true, 2));
    BhRunState run{};
    for (unsigned tick = 0; tick < 1000 && run.status != 2; ++tick) {
        native::copy_start_check(core.get(), bh_step(core.get(), &command, &after));
        native::copy_start_check(core.get(), bh_run_state(core.get(), &run));
    }
    assert(run.status == 2);
    native::copy_start_check(core.get(), bh_record_end(core.get()));
    std::filesystem::remove(directory / "live-during-copy.bhr");
    native::copy_start_check(
            core.get(),
            bh_record_write_bhr(core.get(), native::data_location::utf8(directory / "live-during-copy.bhr").c_str())
    );
    imports.request(
            request, "fixture", "autohop", native::data_location::utf8(directory / "fixture.bsp"), "", directory, zones
    );
    imports.reset();
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    assert(!imports.take("fixture", "autohop"));
}

void picker() {
    assert(native::menu_message_limit("copyStart") == native::kMenuReplayMessageBytes);
    native::HudScoreboard board;
    board.count = 12;
    for (size_t i = 0; i < board.count; ++i) {
        board.rows[i].slot = unsigned(i);
        board.rows[i].you = i == 0;
        board.rows[i].name = "Player " + std::to_string(i);
    }
    native::CopyStartPicker picker;
    picker.show(board);
    auto result = picker.key("Digit1", true, false);
    assert(result.handled && result.chosen && !result.slot && !picker.open());
    picker.show(board);
    result = picker.key("Digit2", true, false);
    assert(result.chosen && result.slot == 1);
    picker.show(board);
    picker.key("Digit9", true, false);
    result = picker.key("Digit1", true, false);
    assert(result.chosen && result.slot == 8);
    picker.show(board);
    picker.key("Digit0", true, false);
    assert(!picker.open());
}

int main(int argc, char **argv) {
    assert(argc == 3);
    const auto directory = native::data_location::from_utf8(argv[2]);
    if (std::string(argv[1]) == "--generate")
        generate(directory);
    else {
        compare(directory);
        picker();
        worker_preserves_recording(directory);
        std::cout << "Native Copy start matches the web, saves clean points and preserves the live context\n";
    }
}
