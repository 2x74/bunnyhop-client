// Frame-loop helpers: phase diagnostics, GPU frame pacing, off-thread settings writes and display defaults.
#include "diagnostics_report.hpp"
#include "display_defaults.hpp"
#include "frame_diagnostics.hpp"
#include "frame_pacing.hpp"
#include "json_file_writer.hpp"
#include "recoverable_action.hpp"
#include "start_point.hpp"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

namespace {

constexpr uint64_t ms = 1'000'000;

bool close(double a, double b) {
    return std::abs(a - b) < 1e-6;
}

// 100 frames of 10 ms (pump 1, simulation 2, render 3, swap 4) and one 80 ms stall in render.
void test_frame_phases_and_stalls() {
    native::FrameDiagnostics diagnostics;
    native::TimedInput queue;
    uint64_t now = 1000 * ms;
    for (int frame = 0; frame <= 101; ++frame) {
        diagnostics.start_frame(now, true);
        const uint64_t render_ms = frame == 50 ? 73 : 3;
        now += 1 * ms;
        diagnostics.mark(native::FrameDiagnostics::kPump, now);
        now += 2 * ms;
        diagnostics.mark(native::FrameDiagnostics::kSimulation, now);
        diagnostics.input(queue);
        now += render_ms * ms;
        diagnostics.mark(native::FrameDiagnostics::kRender, now);
        now += 4 * ms;
        diagnostics.mark(native::FrameDiagnostics::kSwap, now);
    }
    diagnostics.start_frame(now, true);
    const auto &sample = diagnostics.last();
    assert(sample.seconds >= 1);
    assert(sample.stalls == 1);
    assert(close(sample.longest_stall_ms, 80));
    assert(close(sample.phases[native::FrameDiagnostics::kPump].p50_ms, 1));
    assert(close(sample.phases[native::FrameDiagnostics::kRender].p50_ms, 3));
    assert(close(sample.phases[native::FrameDiagnostics::kRender].max_ms, 73));
    assert(close(sample.frame.p50_ms, 10));
    char line[320];
    native::format_frame_line(sample, line, sizeof(line));
    assert(std::strstr(line, "stalls>50ms 1") != nullptr);
    const auto json = native::diagnostics_json(diagnostics, native::EventStamps{}, true);
    assert(json.at("frame").at("stallsOver50Ms") == 1);
    assert(json.at("frame").at("phases").at("render").at("maxMs").get<double>() > 72);
    assert(json.at("input").at("motionStamps").at("source") == "event");
}

void test_input_window_counts() {
    native::FrameDiagnostics diagnostics;
    native::TimedInput queue;
    // Counters from before the overlay was turned on don't count.
    queue.add_edge(1, "KeyA", true);
    uint64_t now = 1000 * ms;
    for (int frame = 0; frame < 120; ++frame) {
        diagnostics.start_frame(now, true);
        diagnostics.input(queue);
        if (frame % 10 == 0) {
            queue.add_edge(int64_t(now), "KeyD", frame % 20 == 0);
        }
        now += 10 * ms;
    }
    diagnostics.start_frame(now, true);
    assert(close(diagnostics.last().key_edges_per_second, 10));
}

void test_disabled_diagnostics_record_nothing() {
    native::FrameDiagnostics diagnostics;
    for (uint64_t now = 0; now < 3000 * ms; now += 10 * ms) {
        diagnostics.start_frame(now, false);
        diagnostics.mark(native::FrameDiagnostics::kPump, now + ms);
    }
    assert(diagnostics.last().frames == 0);
}

struct FakeGl {
    using Sync = int *;
    std::vector<int> fences;
    int created = 0;
    int deleted = 0;
    std::vector<int> waited;
    Sync FenceSync(unsigned, unsigned) {
        fences.push_back(++created);
        return &fences.back();
    }
    unsigned ClientWaitSync(Sync sync, unsigned, unsigned long long) {
        waited.push_back(*sync);
        return 0;
    }
    void DeleteSync(Sync) { ++deleted; }
};

// After swapping frame N, wait for the fence placed after frame N-1, then fence N.
void test_frame_pacer_waits_for_the_previous_frame() {
    FakeGl gl;
    gl.fences.reserve(16);
    native::FramePacer<FakeGl> pacer;
    pacer.after_swap(gl, true);
    assert(gl.waited.empty());
    pacer.after_swap(gl, true);
    pacer.after_swap(gl, true);
    assert((gl.waited == std::vector<int>{1, 2}));
    pacer.after_swap(gl, false);
    assert(gl.created == gl.deleted);
    pacer.after_swap(gl, false);
    assert(gl.created == gl.deleted);
}

void test_json_writer_writes_off_thread_and_keeps_the_newest() {
    const auto dir = std::filesystem::temp_directory_path() / "bunnyhop-json-writer-test";
    std::filesystem::remove_all(dir);
    std::filesystem::create_directories(dir);
    {
        native::JsonFileWriter writer;
        for (int i = 0; i < 50; ++i) {
            writer.write(dir / "settings.json", {{"value", i}});
        }
        writer.write(dir / "missing" / "deeper" / "file.json", {{"value", 1}});
        writer.flush();
        const auto error = writer.take_error();
        assert(error && error->find("file.json") != std::string::npos);
        assert(!writer.take_error());
        writer.write(dir / "last.json", {{"value", 7}});
    }
    std::ifstream settings(dir / "settings.json");
    assert(nlohmann::json::parse(settings).at("value") == 49);
    std::ifstream last(dir / "last.json");
    assert(nlohmann::json::parse(last).at("value") == 7);
    std::filesystem::remove_all(dir);
}

void test_settings_recovery() {
    const auto directory = std::filesystem::temp_directory_path() / "bunnyhop-settings-recovery";
    std::filesystem::create_directories(directory);
    const auto file = directory / "settings.json";
    const native::Json saved = {{"futureOption", true}, {"fov", "bad"}, {"sensitivity", 3.5},
        {"binds", {{"jump", {"KeyJ"}}, {"futureAction", {"KeyK"}}, {"duck", {"Invalid"}},
                   {"forward", {"KeyZ"}}}}};
    native::save_settings(file, saved);
    const auto loaded = native::load_settings(file);
    assert(loaded.at("sensitivity") == 3.5);
    assert(loaded.at("fov") == 90);
    assert(loaded.at("binds").at("jump") == native::Json::array({"KeyJ"}));
    assert(loaded.at("binds").at("forward") == native::Json::array({"KeyZ"}));
    std::ifstream backup(directory / "settings.json.previous");
    assert(native::Json::parse(backup) == saved);
    backup.close();
    native::save_settings(file, loaded);
    std::ifstream still_saved(directory / "settings.json.previous");
    assert(native::Json::parse(still_saved) == saved);
    still_saved.close();
    {
        std::ofstream broken(file);
        broken << "{broken";
    }
    try {
        native::load_settings(file);
        assert(false);
    } catch (const std::exception&) {
        std::ifstream rejected(directory / "settings.json.previous");
        std::string text;
        rejected >> text;
        assert(text == "{broken");
    }
    int notices = 0;
    native::RecoverableAction action([](const std::string&, bool = false, bool = false) {
        throw std::runtime_error("settings locked");
    }, [&](const char*) { ++notices; });
    action("mute");
    native::RestartGuard guard;
    guard.press("restart", 100, true, true, false);
    const auto ready = guard.frame(5000, true, false);
    assert(ready);
    action(*ready, false, true);
    assert(notices == 2);
    std::filesystem::remove_all(directory);
}

void test_display_defaults() {
    const auto dir = std::filesystem::temp_directory_path() / "bunnyhop-display-defaults-test";
    std::filesystem::remove_all(dir);
    std::filesystem::create_directories(dir);
    auto fresh = native::initialize_data_directory(dir).settings;
    assert(std::filesystem::is_directory(dir / "replays"));
    assert(fresh.at("vsync") == false);
    assert(fresh.at("fpsLimit") == 500);
    assert(fresh.at("limitQueuedFrames") == true);
    // An install that played before but never saved settings keeps the old display defaults.
    std::filesystem::create_directories(dir / "replays");
    auto existing = native::startup_settings(dir);
    assert(existing.at("vsync") == true);
    assert(existing.at("fpsLimit") == 0);
    // A saved file keeps its own values; one from before these keys existed keeps the old defaults.
    native::save_settings(dir / "settings.json", {{"sensitivity", 3.0}});
    auto old_file = native::startup_settings(dir);
    assert(old_file.at("vsync") == true);
    assert(old_file.at("fpsLimit") == 0);
    assert(old_file.at("sensitivity") == 3.0);
    native::save_settings(dir / "settings.json", {{"vsync", false}, {"fpsLimit", 240}});
    auto saved = native::startup_settings(dir);
    assert(saved.at("vsync") == false);
    assert(saved.at("fpsLimit") == 240);
    std::filesystem::remove_all(dir);
}

void test_settings_replace_has_no_missing_destination() {
#ifndef _WIN32
    const auto directory = std::filesystem::temp_directory_path() / "bunnyhop-atomic-settings-test";
    std::filesystem::remove_all(directory);
    std::filesystem::create_directories(directory);
    const auto file = directory / "settings.json";
    native::save_settings(file, {{"generation", 0}});
    std::atomic<bool> done = false;
    std::atomic<bool> failed = false;
    std::atomic<size_t> reads = 0;
    std::thread reader([&] {
        while (!done.load()) {
            try {
                std::ifstream input(file);
                const auto saved = nlohmann::json::parse(input);
                if (!saved.at("generation").is_number_integer())
                    failed = true;
            } catch (const std::exception &) {
                failed = true;
            }
            ++reads;
        }
    });
    while (reads.load() == 0)
        std::this_thread::yield();
    for (int generation = 1; generation <= 200; ++generation) {
        native::save_settings(file, {{"generation", generation}});
    }
    done = true;
    reader.join();
    assert(!failed.load());
    assert(!std::filesystem::exists(directory / "settings.json.previous"));
    std::filesystem::remove_all(directory);
#endif
}

}  // namespace

int main() {
    test_frame_phases_and_stalls();
    test_input_window_counts();
    test_disabled_diagnostics_record_nothing();
    test_frame_pacer_waits_for_the_previous_frame();
    test_json_writer_writes_off_thread_and_keeps_the_newest();
    test_settings_recovery();
    test_display_defaults();
    test_settings_replace_has_no_missing_destination();
    std::puts("frame loop: all tests passed");
    return 0;
}
