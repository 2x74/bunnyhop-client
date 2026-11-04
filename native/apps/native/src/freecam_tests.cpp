// Freecam keeps a run ranked: while it flies, the body's commands are exactly a player's who let go of everything.
// The recorded check runs one route twice on the real core, once with freecam on mid-run (keys, mouse and wheel busy
// the whole time) and once with every key released by hand, and needs the same commands, look records and states.
// With an output directory argument it keeps both replays and the map, for tools/parity.ts --replay.
#include "free_cameras.hpp"
#include "data_location.hpp"
#include "input_scheduler.hpp"
#include "settings.hpp"
#include "test_bsp.hpp"
#include "turn_settings.hpp"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <bit>
#include <cassert>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iostream>
#include <memory>
#include <vector>

namespace {

using Core = std::unique_ptr<BhContext, decltype(&bh_destroy)>;
constexpr uint64_t tick_ns = 10'000'000;
constexpr uint64_t clock_start_ns = 1'000'000'000;
constexpr double tick_seconds = .01;

void check(int result, BhContext *core) {
    if (!result) {
        std::cerr << bh_last_error(core) << '\n';
        std::abort();
    }
}

native::InputTimeline default_timeline(bool timed, native::Input &input, std::set<std::string> &held) {
    native::InputTimeline timeline;
    timeline.rebuild_binds(native::default_settings().at("binds"));
    timeline.queue().holdback_ms = 0;
    timeline.set_timed(timed, input, held);
    return timeline;
}

void test_neutral_command_is_a_released_command() {
    native::Input pressed;
    pressed.set_angles(-12.5, 271.25);
    pressed.held = native::forward | native::left | native::jump | native::duck | native::attack | native::use;
    pressed.pulse = native::jump | native::turn_left | (3u << 14) | (1u << 12) | (1u << 13);
    const BhCmd neutral = native::neutral_command(pressed);
    native::Input released;
    released.set_angles(-12.5, 271.25);
    const BhCmd let_go = released.command();
    assert(neutral.forward == 0 && neutral.side == 0 && neutral.buttons == 0);
    assert(std::bit_cast<uint32_t>(neutral.yaw) == std::bit_cast<uint32_t>(let_go.yaw));
    assert(std::bit_cast<uint32_t>(neutral.pitch) == std::bit_cast<uint32_t>(let_go.pitch));
    assert(!pressed.held && !pressed.pulse);
}

void test_places_and_blocked_actions() {
    assert(native::freecam_unavailable({true, false, false}).empty());
    assert(native::freecam_unavailable({false, false, false}) == "Load a map to use freecam.");
    assert(native::freecam_unavailable({true, true, false}) == "Freecam isn't available in the tutorial.");
    assert(native::freecam_unavailable({true, false, true}) == "The replay viewer has its own free camera.");
    for (const char *action : {"inspect", "thirdPerson", "noclip", "cpSave", "giveUsp", "slot1", "drop", "setStart"})
        assert(native::freecam_blocks_action(action));
    for (const char *action : {"restart", "restartBonus", "restartMain", "cycleStyle", "freecam", "chat"})
        assert(!native::freecam_blocks_action(action));
}

void test_speeds_and_world_limit() {
    assert(native::free_look_speed_step(500, 1) == 625);
    assert(native::free_look_speed_step(500, 2) == 781);
    assert(native::free_look_speed_step(500, -20) == 100);
    assert(native::free_look_speed_step(3000, 3) == 3200);
    native::FreeLook camera;
    native::Input view;
    view.set_angles(0, 0);
    float eye[3] = {0, 0, 64};
    camera.place(eye, view, {native::forward, false, false}, 1);
    assert(std::abs(eye[0] - 50) < 1e-3f);  // a frame is at most 0.1 s
    for (int i = 0; i < 9; ++i)
        camera.place(eye, view, {native::forward, false, false}, .1);
    assert(std::abs(eye[0] - 500) < 1e-2f && std::abs(eye[1]) < 1e-3f && std::abs(eye[2] - 64) < 1e-3f);
    camera.place(eye, view, {native::forward, true, false}, .1);
    assert(std::abs(eye[0] - 660) < 1e-2f);
    camera.place(eye, view, {native::forward, false, true}, .1);
    assert(std::abs(eye[0] - 672) < 1e-2f);
    camera.place(eye, view, {native::jump, false, false}, .1);
    assert(std::abs(eye[2] - 114) < 1e-2f);
    camera.wheel(1);
    camera.place(eye, view, {native::back, false, false}, .1);
    assert(std::abs(eye[0] - 609.5f) < 1e-2f);
    for (int i = 0; i < 400; ++i)
        camera.place(eye, view, {native::jump, true, false}, .1);
    assert(eye[2] == native::FreeLook::world_limit_units);
}

void test_flying_follows_the_camera_view_with_pitch() {
    native::FreeLook camera;
    native::Input view;
    view.set_angles(89, 90);
    float eye[3] = {0, 0, 0};
    camera.place(eye, view, {}, 0);
    camera.mouse().motion(0, -89 / (2 * native::kDegreesPerCount));
    camera.place(eye, view, {native::forward, false, false}, .1);
    assert(std::abs(eye[0]) < 1e-3f && std::abs(eye[1] - 50) < 1e-2f && std::abs(view.pitch) < 1e-9);
    camera.mouse().motion(90 / (2 * native::kDegreesPerCount), 0);
    camera.place(eye, view, {native::forward, false, false}, .1);
    assert(std::abs(eye[0] - 50) < 1e-2f && std::abs(view.yaw()) < 1e-9);
}

void test_shift_and_alt_fly_when_bound() {
    native::BindTable binds;
    auto settings = native::default_settings().at("binds");
    binds.rebuild(settings);
    const std::set<std::string> held = {"KeyW", "ShiftLeft", "AltLeft"};
    const auto keys = native::free_look_keys(binds, held);
    assert(keys.held == native::forward && keys.fast && keys.slow);
    settings["duck"] = {"ShiftLeft"};
    binds.rebuild(settings);
    const auto bound = native::free_look_keys(binds, held);
    assert(bound.held == (native::forward | native::duck) && !bound.fast && bound.slow);
}

// R2: diverted motion turns the camera and nothing else, and keys queue no edges and hold nothing in a tick.
void test_diverted_input_leaves_the_counted_view() {
    for (const bool timed : {true, false}) {
        native::Input input;
        std::set<std::string> held;
        auto timeline = default_timeline(timed, input, held);
        native::Input camera;
        input.set_angles(5, 33);
        const double counts = input.yaw_counts;
        const uint32_t events = input.motion_events;
        timeline.divert(&camera);
        timeline.motion(input, 100, 100, 40, -12);
        timeline.key(held, "KeyW", true, false, 100, 100);
        assert(timeline.diverted() && held.contains("KeyW") && !timeline.held(held));
        assert(timeline.queue().pending_edges() == 0 && timeline.queue().pending_x == 0);
        assert(input.yaw_counts == counts && input.motion_events == events && input.pitch == 5);
        assert(input.acc_x == 0 && input.acc_events == 0);
        assert(camera.yaw_counts == 40 && camera.motion_events == 1);
        timeline.divert(nullptr);
        timeline.release_until_keyup(input, held);
        timeline.motion(input, 200, 200, 3, 0);
        assert(timed ? timeline.queue().pending_x == 3 : input.acc_x == 3);
    }
}

// R3: keys held when a camera starts or stops let go, and their key repeats don't bring them back.
void test_released_keys_stay_up_through_repeats() {
    native::Input input;
    std::set<std::string> held;
    auto timeline = default_timeline(true, input, held);
    held = {"KeyW", "Space"};
    input.held = native::forward | native::jump;
    input.pulse = native::jump;
    timeline.release_until_keyup(input, held);
    assert(held.empty() && !input.held && !input.pulse);
    assert(timeline.released_until_keyup("KeyW", true, true));
    assert(!timeline.released_until_keyup("KeyW", false, false));
    assert(!timeline.released_until_keyup("KeyW", true, true));
    assert(timeline.released_until_keyup("Space", true, true));
    assert(!timeline.released_until_keyup("Space", true, false));
    assert(!timeline.released_until_keyup("KeyA", true, true));
}

void test_hud_line() {
    native::Freecam freecam;
    assert(freecam.hud_line("") == "Freecam \xc2\xb7 500 u/s \xc2\xb7 !freecam to go back");
    assert(freecam.hud_line("KeyV") == "Freecam \xc2\xb7 500 u/s \xc2\xb7 V to go back");
    freecam.view().wheel(1);
    assert(freecam.hud_line("KeyV") == "Freecam \xc2\xb7 625 u/s \xc2\xb7 V to go back");
}

// ---- the recorded check ----------------------------------------------------------------------------------------

struct Map {
    std::filesystem::path directory =
            std::filesystem::temp_directory_path()
            / ("bunnyhop-freecam-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    std::filesystem::path bsp = directory / "fixture.bsp";

    Map() {
        std::filesystem::create_directories(directory / "models" / "fixture");
        write(bsp, native::test::make_bsp());
        write(directory / "models" / "fixture" / "box.mdl", native::test::make_box_model());
    }

    ~Map() {
        std::error_code error;
        std::filesystem::remove_all(directory, error);
    }

    static void write(const std::filesystem::path &path, const std::vector<uint8_t> &bytes) {
        std::ofstream output(path, std::ios::binary);
        output.write(reinterpret_cast<const char *>(bytes.data()), std::streamsize(bytes.size()));
    }
};

struct TickRow {
    BhCmd command{};
    BhLookSampleV2 look{};
    BhState state{};
    bool flying = false;
};

// The client loop's input path for one attempt (client.cpp run(): pump, ticks, the free camera's frame).
class Attempt {
public:
    native::Input input;
    std::set<std::string> held;
    native::InputTimeline timeline;
    native::FreeCameras cameras;
    std::vector<TickRow> rows;
    float camera_eye[3] = {};
    double camera_travel = 0;

    Attempt(const Map &map, bool timed)
        : timeline(default_timeline(timed, input, held))
        , core_(bh_create(), bh_destroy) {
        check(bh_load_map(
                      core_.get(),
                      native::data_location::utf8(map.bsp).c_str(),
                      native::data_location::utf8(map.directory).c_str()
              ),
              core_.get());
        const std::array<BhZone, 2> zones{
                BhZone{0, 0, 0, {-100, -100, -10000}, {100, 100, 1000}},
                BhZone{1, 0, 0, {900, -2000, -10000}, {4000, 2000, 1000}}
        };
        BhRunOptions options{};
        bh_default_run_options(&options);
        check(bh_run_configure(core_.get(), &options, zones.data(), zones.size()), core_.get());
        check(bh_reset(core_.get()), core_.get());
        check(bh_set_position(core_.get(), 10, 20, 65, 0), core_.get());
        check(bh_record_begin(core_.get(), "", "autohop", "test", 100), core_.get());
        input.set_angles(0, 0);
        scheduler_.reset(clock_start_ns);
    }

    BhContext *core() const { return core_.get(); }

    uint64_t now() const { return now_; }

    // As handle_code: a repeat of a released key is dropped, a wheel notch steps a flying camera.
    void key(const std::string &code, bool down, bool repeat = false) {
        if (timeline.released_until_keyup(code, down, repeat)) return;
        timeline.key(held, code, down, false, now_ - 1, now_ - 1);
    }

    void motion(double x, double y) { timeline.motion(input, now_ - 1, now_ - 1, x, y); }

    void wheel(double notches) {
        if (!cameras.wheel(notches, false)) input.pulse |= native::jump;
    }

    void toggle_freecam() {
        const native::FreeLookInput controls{timeline, input, held};
        assert(cameras.toggle(false, {true, false, false}, controls).empty());
    }

    // One rendered frame at 100 fps: its events, its tick, then the camera.
    void frame(const std::function<void(Attempt &)> &events) {
        now_ += tick_ns;
        scheduler_.frame(now_, true, tick_ns);
        timeline.begin_pump(input, now_, scheduler_, tick_ns);
        events(*this);
        timeline.begin_frame(input, true, now_);
        while (scheduler_.due(tick_ns))
            tick();
        input.frame();
        place_camera();
    }

    void finish(const std::filesystem::path &bhr) {
        check(bh_record_end(core_.get()), core_.get());
        check(bh_record_write_bhr(core_.get(), native::data_location::utf8(bhr).c_str()), core_.get());
    }

private:
    Core core_;
    native::InputScheduler scheduler_;
    native::TurnSettings turns_;
    uint64_t now_ = clock_start_ns;

    void tick() {
        timeline.take_tick(input, scheduler_.sim_ns, tick_ns, false);
        turns_.apply(input, timeline.held(held), tick_seconds, true);
        const bool flying = cameras.freecam.active();
        const BhCmd command = flying ? native::neutral_command(input) : input.command();
        const auto look = input.look_sample();
        assert(look);
        TickRow row{};
        row.look = *look;
        row.flying = flying;
        check(bh_step_look_v2(core_.get(), &command, &*look, &row.state), core_.get());
        check(bh_last_command(core_.get(), &row.command), core_.get());
        input.events(row.state);
        rows.push_back(row);
        scheduler_.consume(tick_ns);
    }

    void place_camera() {
        const auto &state = rows.back().state;
        float eye[3] = {state.position[0], state.position[1], state.position[2] + state.view_offset_z};
        native::Input view = timeline.preview(input);
        const auto keys = native::free_look_keys(timeline.binds(), held);
        const float before[3] = {camera_eye[0], camera_eye[1], camera_eye[2]};
        const bool was_flying = cameras.freecam.view().started();
        if (!cameras.place(false, eye, view, keys, input, tick_seconds)) return;
        if (was_flying) camera_travel += std::hypot(eye[0] - before[0], eye[1] - before[1], eye[2] - before[2]);
        std::copy(eye, eye + 3, camera_eye);
    }
};

constexpr size_t walk_frame = 5;
constexpr size_t freecam_from = 60;
constexpr size_t freecam_to = 360;
constexpr size_t walk_again = 365;
constexpr size_t last_frame = 1500;

// Freecam on mid-run with W held; while it flies every kind of input comes in; Space is still held when it ends.
void with_freecam(Attempt &attempt, size_t frame) {
    if (frame == walk_frame) attempt.key("KeyW", true);
    if (frame == freecam_from) attempt.toggle_freecam();
    if (frame > freecam_from && frame < freecam_to) {
        attempt.motion(7, frame % 3 ? 2 : -3);
        if (frame == 70) attempt.key("KeyA", true);
        if (frame == 80) attempt.key("Space", true);
        if (frame == 90) attempt.key("ShiftLeft", true);
        if (frame == 100) attempt.key("ArrowLeft", true);
        if (frame == 110) attempt.key("Mouse1", true);
        if (frame == 120) attempt.key("ControlLeft", true);
        if (frame == 150) attempt.wheel(2);
        if (frame == 200) attempt.key("KeyW", true, true);
        if (frame == 210) attempt.key("Space", true, true);
        if (frame == 300) {
            for (const char *code : {"KeyA", "ShiftLeft", "ArrowLeft", "Mouse1", "ControlLeft"})
                attempt.key(code, false);
        }
        if (frame == 340) attempt.key("KeyW", false);
    }
    if (frame == freecam_to) attempt.toggle_freecam();
    if (frame == freecam_to + 2) attempt.key("Space", true, true);
    if (frame == walk_again) attempt.key("KeyW", true);
    if (frame == walk_again + 5) attempt.key("Space", false);
}

// The same route with every key let go by hand where freecam turned on, and nothing touched until it would end.
void released_by_hand(Attempt &attempt, size_t frame) {
    if (frame == walk_frame) attempt.key("KeyW", true);
    if (frame == freecam_from) attempt.key("KeyW", false);
    if (frame == walk_again) attempt.key("KeyW", true);
}

uint32_t bits(float value) {
    return std::bit_cast<uint32_t>(value);
}

bool same_tick(const TickRow &a, const TickRow &b) {
    const auto &x = a.state, &y = b.state;
    bool same = a.command.forward == b.command.forward && a.command.side == b.command.side
                && a.command.buttons == b.command.buttons && bits(a.command.yaw) == bits(b.command.yaw)
                && bits(a.command.pitch) == bits(b.command.pitch);
    same &= a.look.base == b.look.base && a.look.k == b.look.k && a.look.count == b.look.count
            && a.look.epoch == b.look.epoch && a.look.kind == b.look.kind && a.look.frames == b.look.frames
            && a.look.events == b.look.events && a.look.reports == b.look.reports;
    for (int axis = 0; axis < 3; ++axis)
        same &= bits(x.position[axis]) == bits(y.position[axis]) && bits(x.velocity[axis]) == bits(y.velocity[axis]);
    return same && x.tick == y.tick && x.grounded == y.grounded && x.crouched == y.crouched && x.events == y.events;
}

void test_freecam_run_matches_a_hands_off_run(const std::filesystem::path &keep) {
    for (const bool timed : {true, false}) {
        const Map map;
        Attempt flown(map, timed), released(map, timed);
        BhRunState run{};
        for (size_t frame = 1; frame <= last_frame && run.status != 2; ++frame) {
            flown.frame([frame](Attempt &a) { with_freecam(a, frame); });
            released.frame([frame](Attempt &a) { released_by_hand(a, frame); });
            check(bh_run_state(flown.core(), &run), flown.core());
        }
        assert(run.status == 2);
        assert(flown.rows.size() == released.rows.size());
        for (size_t tick = 0; tick < flown.rows.size(); ++tick) {
            if (!same_tick(flown.rows[tick], released.rows[tick])) {
                std::cerr << "freecam and hands-off runs differ at tick " << tick << (timed ? " (timed)\n" : "\n");
                std::abort();
            }
        }
        const auto first = std::find_if(flown.rows.begin(), flown.rows.end(), [](const auto &r) { return r.flying; });
        assert(first != flown.rows.end());
        const auto entry = *first;
        size_t flying = 0;
        for (auto row = first; row != flown.rows.end() && row->flying; ++row, ++flying) {
            assert(row->command.forward == 0 && row->command.side == 0 && row->command.buttons == 0);
            assert(bits(row->command.yaw) == bits(entry.command.yaw));
            assert(bits(row->command.pitch) == bits(entry.command.pitch));
            assert(row->look.count == entry.look.count && row->look.epoch == entry.look.epoch);
            assert(row->look.events == 0 && row->look.reports == 0);
        }
        assert(flying == freecam_to - freecam_from);
        // After the camera came back: nothing carried over until W is pressed again.
        for (size_t tick = size_t(first - flown.rows.begin()) + flying, end = tick + walk_again - freecam_to - 1;
             tick < end;
             ++tick)
            assert(!flown.rows[tick].command.buttons && flown.rows[tick].command.forward == 0);
        BhRunState timing{};
        check(bh_run_state(flown.core(), &timing), flown.core());
        assert(timing.start_tick < first->state.tick && timing.end_tick > first->state.tick + flying);
        assert(flown.camera_travel > 100);
        assert(flown.cameras.freecam.view().speed_ups() == 781);
        assert(!flown.cameras.freecam.active() && !flown.timeline.diverted());
        const auto directory = keep.empty() ? map.directory : keep / (timed ? "timed" : "frame-sampled");
        std::filesystem::create_directories(directory);
        flown.finish(directory / "freecam.bhr");
        released.finish(directory / "released.bhr");
        if (!keep.empty())
            std::filesystem::copy_file(
                    map.bsp, directory / "fixture.bsp", std::filesystem::copy_options::overwrite_existing
            );
        std::printf(
                "%s: %zu ticks identical, %zu with freecam on, camera flew %.0f u\n",
                timed ? "timed" : "frame-sampled",
                flown.rows.size(),
                flying,
                flown.camera_travel
        );
    }
}

}  // namespace

int main(int argc, char **argv) {
    test_neutral_command_is_a_released_command();
    test_places_and_blocked_actions();
    test_speeds_and_world_limit();
    test_flying_follows_the_camera_view_with_pitch();
    test_shift_and_alt_fly_when_bound();
    test_diverted_input_leaves_the_counted_view();
    test_released_keys_stay_up_through_repeats();
    test_hud_line();
    test_freecam_run_matches_a_hands_off_run(argc > 1 ? std::filesystem::path(argv[1]) : std::filesystem::path());
    std::puts("freecam passed");
}
