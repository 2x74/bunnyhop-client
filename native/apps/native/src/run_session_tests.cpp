#include "run_session.hpp"
#include "data_location.hpp"
#include "test_bsp.hpp"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <fstream>
#include <memory>

namespace {

std::string read(const std::filesystem::path &path) {
    std::ifstream file(path, std::ios::binary);
    assert(file);
    return {std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>()};
}

void invalidation() {
    using Reset = native::RunHeartbeat::Reset;
    for (const auto reset : {Reset::range, Reset::start, Reset::generation}) {
        native::RunHeartbeat heartbeat;
        heartbeat.generation = 12;
        heartbeat.start = 7;
        heartbeat.upto = 400;
        heartbeat.hash = 123;
        heartbeat.paused = true;
        const auto previous_time = heartbeat.time;
        assert(heartbeat.invalidate(reset) == nlohmann::json({{"type", "reset"}}));
        assert(heartbeat.generation == 13);
        assert(heartbeat.start == (reset == Reset::generation ? 7u : 0u));
        assert(heartbeat.upto == (reset == Reset::range ? 0u : 400u));
        assert(heartbeat.hash == 123 && heartbeat.paused && heartbeat.time == previous_time);
        heartbeat.begin(24);
        assert(heartbeat.start == 24 && heartbeat.upto == 24);
        assert(heartbeat.hash == native::RunHeartbeat::initial_hash && !heartbeat.paused);
    }
}

void recording(const std::filesystem::path &root) {
    const auto map = root / "fixture.bsp";
    const auto bytes = native::test::make_bsp();
    std::ofstream(map, std::ios::binary).write(reinterpret_cast<const char *>(bytes.data()), bytes.size());
    const std::unique_ptr<BhContext, decltype(&bh_destroy)> core(bh_create(), bh_destroy);
    std::filesystem::create_directories(root / "models" / "fixture");
    const auto model = native::test::make_box_model();
    std::ofstream(root / "models" / "fixture" / "box.mdl", std::ios::binary)
            .write(reinterpret_cast<const char *>(model.data()), model.size());
    assert(core
           && bh_load_map(
                   core.get(), native::data_location::utf8(map).c_str(), native::data_location::utf8(root).c_str()
           ));
    BhRunOptions options{};
    bh_default_run_options(&options);
    const BhZone zones[] = {
            {0, 0, 0, {-100, -100, -10000}, {100, 100, 1000}}, {1, 0, 0, {150, -100, -10000}, {1000, 100, 1000}}
    };
    assert(bh_run_configure(core.get(), &options, zones, 2));
    assert(bh_reset(core.get()));
    assert(bh_set_position(core.get(), 10, 20, 65, 0));
    native::RunRecorder recorder;
    recorder.begin(core.get(), root, "fixture", "bunnyhop-native/test", "autohop", "player", {}, "");
    assert(recorder.input.active() && !recorder.ended);
    native::RunHeartbeat heartbeat;
    heartbeat.begin(0);
    uint32_t expected_hash = native::RunHeartbeat::initial_hash;
    uint32_t expected_upto = 0;
    BhRunState run{};
    for (unsigned tick = 0; tick < 1000 && run.status != 2; ++tick) {
        BhCmd command{};
        command.forward = 450;
        command.buttons = native::forward;
        command.yaw = 0;
        BhState state{};
        assert(bh_step(core.get(), &command, &state));
        assert(bh_run_state(core.get(), &run));
        if (tick % 13 != 0 && run.status != 2) continue;
        const auto length = uint32_t(run.total_commands);
        assert(bh_record_fold(core.get(), expected_hash, expected_upto, length, &expected_hash));
        expected_upto = length;
        heartbeat.paused = tick > 13;
        const auto event = heartbeat.fold(core.get(), run);
        char hex[9];
        std::snprintf(hex, sizeof(hex), "%08x", expected_hash);
        assert(event.at("hash") == hex && event.at("tick") == length);
        assert(event.at("paused") == heartbeat.paused && heartbeat.upto == length);
        heartbeat.sent(std::chrono::steady_clock::now());
        assert(!heartbeat.paused);
    }
    assert(run.status == 2);
    recorder.write(core.get());
    const auto direct = root / "direct.bhr";
    assert(bh_record_write_bhr(core.get(), native::data_location::utf8(direct).c_str()));
    assert(read(native::data_location::from_utf8(recorder.path)) == read(direct));
    assert(recorder.finish_event(1, 1.234, "M").at("replayBase64") == "TQ==");
    assert(recorder.finish_event(1, 1.234, "Ma").at("replayBase64") == "TWE=");
    const auto event = recorder.finish_event(1, 1.234, "Man");
    assert(event.at("replayBase64") == "TWFu" && event.at("timeMs") == 1234 && event.at("track") == 1);
    recorder.pending_capture = {"fixture.bhr", "fixture"};
    recorder.clear(true);
    assert(recorder.ended && recorder.path.empty() && !recorder.pending_capture);
    // Clearing replay/vault state does not alter the recording-input lifetime.
    assert(recorder.input.active());
}

}  // namespace

int main() {
    invalidation();
    const auto root =
            std::filesystem::temp_directory_path()
            / ("bunnyhop-run-session-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));

    struct Cleanup {
        std::filesystem::path path;

        ~Cleanup() {
            std::error_code error;
            std::filesystem::remove_all(path, error);
        }
    } cleanup{root};

    std::filesystem::create_directories(root / "replays");
    recording(root);
}
