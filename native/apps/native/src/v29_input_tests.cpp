#include "recording_input.hpp"
#include "input_timeline.hpp"
#include "settings.hpp"
#include "test_bsp.hpp"
#include <zlib.h>
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <array>
#include <cassert>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <memory>

namespace {

using Json = nlohmann::json;
using Core = std::unique_ptr<BhContext, decltype(&bh_destroy)>;
constexpr uint64_t tick_ns = 10'000'000;

void check(int result, BhContext *core) {
    if (!result) {
        std::cerr << bh_last_error(core) << '\n';
        std::abort();
    }
}

struct Fixture {
    std::filesystem::path directory = std::filesystem::temp_directory_path() /
        ("bunnyhop-v29-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    Core core{bh_create(), bh_destroy};
    std::array<BhZone, 2> zones{};

    Fixture() {
        std::filesystem::create_directories(directory);
        const auto bytes = native::test::make_bsp();
        const auto map = directory / "fixture.bsp";
        std::ofstream output(map, std::ios::binary);
        output.write(reinterpret_cast<const char *>(bytes.data()), std::streamsize(bytes.size()));
        output.close();
        std::filesystem::create_directories(directory / "models" / "fixture");
        const auto model = native::test::make_box_model();
        std::ofstream model_output(directory / "models" / "fixture" / "box.mdl", std::ios::binary);
        model_output.write(reinterpret_cast<const char *>(model.data()), std::streamsize(model.size()));
        model_output.close();
        check(bh_load_map(core.get(), map.string().c_str(), directory.string().c_str()), core.get());
        zones[0] = {0, 0, 0, {-100, -100, -10000}, {100, 100, 1000}};
        zones[1] = {1, 0, 0, {150, -100, -10000}, {1000, 100, 1000}};
    }

    ~Fixture() {
        core.reset();
        std::error_code error;
        std::filesystem::remove_all(directory, error);
    }

    std::filesystem::path record(const char *name, bool timed, bool contribute) {
        BhRunOptions options{};
        bh_default_run_options(&options);
        check(bh_run_configure(core.get(), &options, zones.data(), zones.size()), core.get());
        check(bh_reset(core.get()), core.get());
        check(bh_set_position(core.get(), 10, 20, 65, 0), core.get());
        check(bh_record_begin(core.get(), "", "autohop", "test", 100), core.get());
        native::RecordingInput recording;
        check(recording.begin(core.get(), {300, 2.5}), core.get());
        native::Input input;
        input.set_angles(0, 0);
        native::InputTimeline timeline;
        timeline.rebuild_binds(native::default_settings().at("binds"));
        timeline.queue().holdback_ms = 0;
        std::set<std::string> held;
        timeline.set_timed(timed, input, held);
        native::InputScheduler scheduler;
        scheduler.reset(1'000'000'000);
        BhRunState run{};
        for (uint64_t tick = 1; tick <= 1000 && run.status != 2; ++tick) {
            record_tick(input, timeline, scheduler, recording, held, tick, contribute);
            check(bh_run_state(core.get(), &run), core.get());
        }
        assert(run.status == 2);
        check(bh_record_end(core.get()), core.get());
        const auto path = directory / name;
        check(bh_record_write_bhr(core.get(), path.string().c_str()), core.get());
        return path;
    }

    void record_tick(native::Input &input, native::InputTimeline &timeline, native::InputScheduler &scheduler,
                     native::RecordingInput &recording, std::set<std::string> &held, uint64_t tick,
                     bool contribute) {
        const uint64_t now = 1'000'000'000 + tick * tick_ns;
        scheduler.frame(now, true, tick_ns);
        timeline.begin_pump(input, now, scheduler, tick_ns);
        if (tick == 1 && contribute) {
            timeline.motion(input, now - 1, now, .125, 0);
        }
        timeline.begin_frame(input, true, now);
        timeline.take_tick(input, scheduler.sim_ns, tick_ns, false);
        scheduler.consume(tick_ns);
        check(recording.mark_timed(core.get(), timeline.tick_contributed()), core.get());
        input.held = tick > 40 ? native::forward : 0;
        const auto command = input.command();
        const auto look = input.look_sample();
        BhState state{};
        check(bh_step_look_v2(core.get(), &command, &*look, &state), core.get());
        if (tick == 1) {
            BhRecordOptionsV29 changed{1, sizeof(BhRecordOptionsV29), 301, 2.5, 0};
            assert(!bh_record_options_v29(core.get(), &changed));
        }
    }

    Json header(const std::filesystem::path &path) {
        size_t size = 0;
        const char *data = bh_replay_header(core.get(), path.string().c_str(), &size);
        check(data != nullptr, core.get());
        return Json::parse(data, data + size);
    }
};

std::vector<uint8_t> decompress(const std::filesystem::path &path) {
    gzFile file = gzopen(path.string().c_str(), "rb");
    assert(file);
    std::vector<uint8_t> result;
    std::array<uint8_t, 4096> buffer{};
    int count = 0;
    while ((count = gzread(file, buffer.data(), unsigned(buffer.size()))) > 0) {
        result.insert(result.end(), buffer.begin(), buffer.begin() + count);
    }
    assert(count == 0);
    assert(gzclose(file) == Z_OK);
    return result;
}

void test_recording_options_roundtrip() {
    Fixture fixture;
    for (const bool timed : {false, true}) {
        for (const bool contribute : {false, true}) {
            const auto name = std::to_string(timed) + std::to_string(contribute) + ".bhr";
            const auto path = fixture.record(name.c_str(), timed, contribute);
            const auto header = fixture.header(path);
            assert(header.value("timedInput", false) == (timed && contribute));
            assert(header.at("turnSpeed") == Json({{"yawSpeed", 300}, {"angleSpeedKey", 2.5}}));
            const auto raw = decompress(path);
            const std::array<uint8_t, 12> trailer{0x42, 0x48, 0x54, 0x53, 0, 0, 0x96, 0x43, 0, 0, 0x20, 0x40};
            assert(std::equal(trailer.begin(), trailer.end(), raw.end() - trailer.size()));
            assert(bool(raw.at(6) & BH_FLAG_TIMED_INPUT) == (timed && contribute));
        }
    }
}

void test_turn_settings_validation() {
    const auto defaults = native::default_settings();
    assert(defaults.at("yawSpeed") == 210 && defaults.at("angleSpeedKey") == 2);
    for (const auto &patch : {Json{{"yawSpeed", 60}}, Json{{"yawSpeed", 720}},
                              Json{{"angleSpeedKey", 1}}, Json{{"angleSpeedKey", 4}}}) {
        native::patch_settings(defaults, patch);
    }
    for (const auto &patch : {Json{{"yawSpeed", 59.99}}, Json{{"yawSpeed", 720.01}},
                              Json{{"angleSpeedKey", .99}}, Json{{"angleSpeedKey", 4.01}}}) {
        bool rejected = false;
        try {
            native::patch_settings(defaults, patch);
        } catch (const std::exception &) {
            rejected = true;
        }
        assert(rejected);
    }
}

}  // namespace

int main() {
    test_recording_options_roundtrip();
    test_turn_settings_validation();
    std::puts("v29 native recording input roundtrips passed");
}
