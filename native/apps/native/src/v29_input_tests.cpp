#include "recording_input.hpp"
#include "input_timeline.hpp"
#include "settings.hpp"
#include "test_bsp.hpp"
#include "replay_practice.hpp"
#include "replay_session.hpp"
#include "replay_controls.hpp"
#include "replay_library.hpp"
#include <zlib.h>
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <array>
#include <cassert>
#include <chrono>
#include <cstring>
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
    std::filesystem::path directory =
        std::filesystem::temp_directory_path() /
        native::data_location::from_utf8("bunnyhop-v29-Jos\xc3\xa9-\xe6\xb8\xac-" +
                                         std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
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
        check(bh_load_map(core.get(), native::data_location::utf8(map).c_str(),
                          native::data_location::utf8(directory).c_str()),
              core.get());
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
            record_tick(input, timeline, scheduler, recording, tick, contribute);
            check(bh_run_state(core.get(), &run), core.get());
        }
        assert(run.status == 2);
        check(bh_record_end(core.get()), core.get());
        const auto path = directory / name;
        check(bh_record_write_bhr(core.get(), native::data_location::utf8(path).c_str()), core.get());
        return path;
    }

    void record_tick(native::Input &input, native::InputTimeline &timeline, native::InputScheduler &scheduler,
                     native::RecordingInput &recording, uint64_t tick,
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
        input.held = tick > 200 ? native::forward : 0;
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
        const char *data = bh_replay_header(core.get(), native::data_location::utf8(path).c_str(), &size);
        check(data != nullptr, core.get());
        return Json::parse(data, data + size);
    }
};

std::vector<uint8_t> decompress(const std::filesystem::path &path) {
    gzFile file = gzopen(native::data_location::utf8(path).c_str(), "rb");
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

void test_practice_takeover() {
    Fixture fixture;
    const auto path = fixture.record("practice.bhr", true, true);
    const auto info = fixture.header(path);
    check(bh_replay_load(fixture.core.get(), native::data_location::utf8(path).c_str()), fixture.core.get());
    for (int rejection = 0; rejection < 4; ++rejection) {
        bool rejected = false;
        auto zones = fixture.zones;
        if (rejection == 3) {
            zones[0].maxs[0] += 1;
        }
        try {
            native::ReplayTakeover::take(fixture.core.get(), info, zones,
                rejection == 2 ? "legit" : "autohop", rejection == 0, rejection == 1, 10);
        } catch (const std::exception &) {
            rejected = true;
        }
        assert(rejected);
        BhState state{};
        check(bh_state(fixture.core.get(), &state), fixture.core.get());
        assert(state.tick == 0);
    }
    BhSnapshot expected{};
    check(bh_replay_seek(fixture.core.get(), 20, &expected), fixture.core.get());
    const auto takeover = native::ReplayTakeover::take(fixture.core.get(), info, fixture.zones,
                                                     "autohop", false, false, 20);
    assert(std::memcmp(&takeover.snapshot, &expected, sizeof(expected)) == 0);
    native::Practice practice;
    native::Input input;
    native::InputTimeline timeline;
    std::set<std::string> held{"KeyW"};
    timeline.motion(input, 1000, 1000, 7, 2);
    takeover.resume(practice, timeline, input, held);
    assert(practice.active && !practice.mode && practice.tool == "replay");
    assert(held.empty() && timeline.queue().pending() == 0);
    assert(input.yaw() == native::Input::normalize(takeover.view.yaw));
    assert(input.pitch == takeover.view.pitch);
    assert(!native::practice_allows_event(practice.active, "beat"));
    assert(!native::practice_allows_event(practice.active, "finish"));
    BhState state{};
    const BhCmd command{};
    check(bh_step(fixture.core.get(), &command, &state), fixture.core.get());
    assert(state.tick == 21);
    assert(!bh_record_begin(fixture.core.get(), "", "autohop", "test", 100));
    assert(!bh_record_write_bhr(fixture.core.get(),
                                native::data_location::utf8(fixture.directory / "invalid.bhr").c_str()));
    practice.restart();
    assert(!practice.active);
    check(bh_replay_load(fixture.core.get(), native::data_location::utf8(path).c_str()), fixture.core.get());
    const auto spawn = native::ReplayTakeover::take(fixture.core.get(), info, fixture.zones,
                                                  "autohop", false, false, 0);
    assert(spawn.snapshot.player.tick == 0 && spawn.view.yaw == 0);
}

void test_replay_playback_range() {
    Fixture fixture;
    const auto path = fixture.record("range.bhr", true, true);
    const auto before = decompress(path);
    auto session = native::ReplaySession::open(fixture.core.get(), path);
    assert(session.range.from > 0 && !session.range.full_recording);
    assert(session.initial.snapshot.player.tick == session.range.from);
    const auto trimmed = session.initial;
    session.set_full_recording(true);
    assert(session.range.from == 0 && session.range.to == session.range.total);
    const auto resimulated = session.seek(fixture.core.get(), trimmed.snapshot.player.tick);
    assert(std::memcmp(&resimulated.snapshot, &trimmed.snapshot, sizeof(trimmed.snapshot)) == 0);
    assert(std::memcmp(&resimulated.view, &trimmed.view, sizeof(trimmed.view)) == 0);
    session.set_full_recording(false);
    assert(session.seek(fixture.core.get(), 0).snapshot.player.tick == session.range.from);
    assert(session.seek(fixture.core.get(), session.range.total).snapshot.player.tick == session.range.to);
    assert(decompress(path) == before);

    Json info = {{"startTick", 1900}, {"endTick", 4300}, {"totalTicks", 5000},
                 {"settings", {{"tickInterval", .01}}}};
    const auto range = native::ReplayRange::make(info);
    assert(range.from == 1800 && range.to == 4450 && range.ticks() == 2650);
    struct ExportOptions {
        uint32_t from = 0;
        uint32_t to = 0;
        bool full_recording = false;
    };
    ExportOptions clip;
    range.export_bounds(clip);
    assert(clip.from == 1800 && clip.to == 4450);
    clip = {0, 5000, false};
    range.export_bounds(clip);
    assert(clip.from == 1800 && clip.to == 4450);
    clip = {0, 0, true};
    range.export_bounds(clip);
    assert(clip.from == 0 && clip.to == 5000);
    native::ReplayControls controls;
    controls.first_tick = range.from;
    bool paused = false;
    double speed = 1;
    controls.action(native::ReplayControls::Action::start, 3000, range, paused, speed);
    assert(controls.take() == range.from);
    controls.action(native::ReplayControls::Action::end, 3000, range, paused, speed);
    assert(controls.take() == range.to && paused);
    const auto bounds = native::ReplayControls::layout(1000, 700);
    controls.pointer(bounds, bounds.x, bounds.y + 40, range.to, true);
    assert(controls.take() == range.from);
    controls.motion(bounds, bounds.x + bounds.width, range.to);
    assert(controls.take() == range.to);
    session.range = range;
    const auto state = session.state(true, "fixture", 1900, false, 1, "eye", 0, .01);
    assert(state.at("tick") == 1900 && state.at("rangeTick") == 100);
    assert(state.at("rangeTotalTicks") == 2650 && state.at("elapsedSeconds") == 1);
}

void test_replay_library_cache() {
    Fixture fixture;
    const auto source = fixture.record("source.bhr", true, true);
    const auto replays = fixture.directory / "replays";
    std::filesystem::create_directories(replays);
    const auto replay = replays / "run.bhr";
    std::filesystem::copy_file(source, replay);
    {
        native::ReplayLibrary library(fixture.directory);
        library.refresh();
        library.flush();
        auto first = library.take();
        assert(first && first->errors.empty() && first->decoded == 1);
        assert(first->replays && first->replays->size() == 1);
        library.refresh();
        library.flush();
        auto unchanged = library.take();
        assert(unchanged && unchanged->decoded == 0 && unchanged->replays == first->replays);
        const auto modified = std::filesystem::last_write_time(replay);
        std::filesystem::last_write_time(replay, modified + std::chrono::seconds(1));
        library.refresh();
        library.flush();
        assert(library.take()->decoded == 1);
        {
            std::ofstream corrupt(replay, std::ios::binary | std::ios::app);
            corrupt << "bad";
        }
        library.refresh();
        library.flush();
        assert(library.take()->decoded == 1);
        std::filesystem::remove(replay);
        library.refresh();
        library.flush();
        const auto removed = library.take();
        assert(removed && removed->replays->empty());
        library.archive("saved.bhr",
                        {{"map", "fixture"},
                         {"style", "autohop"},
                         {"track", 0},
                         {"time", 10},
                         {"jumps", 2},
                         {"strafes", 3},
                         {"sync", 90},
                         {"finishedAt", 1234},
                         {"eligible", true}},
                        false);
        // Destructor drains accepted archive jobs.
    }
    native::RunVault vault(fixture.directory / "run-vault");
    assert(vault.read("saved.bhr").is_object());
}

void test_bonus_takeover_uses_normal_style() {
    Fixture fixture;
    for (auto &zone : fixture.zones) {
        zone.track = 1;
    }
    const auto path = fixture.record("bonus.bhr", true, true);
    const auto session = native::ReplaySession::open(fixture.core.get(), path);
    assert(session.info.at("track") == 1);
    const auto takeover = native::ReplayTakeover::take(fixture.core.get(), session.info, fixture.zones,
                                                     "legit", false, false, 0);
    assert(takeover.track == 1 && takeover.style == "autohop");
}

}  // namespace

int main() {
    test_replay_library_cache();
    test_recording_options_roundtrip();
    test_turn_settings_validation();
    test_practice_takeover();
    test_replay_playback_range();
    test_bonus_takeover_uses_normal_style();
    std::puts("v29 native recording input roundtrips passed");
}
