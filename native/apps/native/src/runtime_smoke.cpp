#include "runtime_smoke.hpp"
#include "options.hpp"
#include "startup.hpp"
#include "renderer.hpp"
#include "hud.hpp"
#include "menu_webview.hpp"
#include "practice_controller.hpp"
#include "replay_player.hpp"
#include "leave_hold.hpp"
#include "room_state.hpp"
#include "map_jobs.hpp"
#include "online.hpp"
#include "menu_backdrop.hpp"
#include "client_util.hpp"
#include "data_location.hpp"
#include "replay_practice.hpp"
#include <chrono>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <thread>

namespace native {
namespace {

using Clock = std::chrono::steady_clock;
namespace data_location = native::data_location;
constexpr float noclip_forward_units_per_second = 450;
constexpr float start_half_extent_units = 32;
constexpr float end_height_units = 4096;
constexpr float leave_start_distance_units = 256;
constexpr double leave_hold_ms = 600;
constexpr std::array<float, 3> hud_scales_percent{50, 100, 175};
constexpr std::array<float, 3> free_camera_position_units{11, 22, 33};
constexpr float free_camera_yaw_degrees = 42;
constexpr float free_camera_pitch_degrees = 17;
constexpr float overlay_scale_percent = 100;
constexpr double fixture_fps = 60;
constexpr float leave_progress_fraction = .5f;
constexpr uint32_t seek_probe_ticks = 10;
constexpr auto worker_shutdown_timeout = std::chrono::seconds(1);

void check(bool ok, const char *why) {
    if (!ok) throw std::runtime_error(std::string("Runtime smoke: ") + why);
}

void require(bool ok, BhContext *core, const char *operation) {
    if (!ok) {
        const char *error = bh_last_error(core);
        throw std::runtime_error(std::string(operation) + ": " + (error && *error ? error : "native core failed"));
    }
}

}  // namespace

RuntimeSmoke::RuntimeSmoke(RuntimeSmokeState state, RuntimeSmokeActions actions)
    : RuntimeSmokeState(state)
    , actions_(std::move(actions)) {
}

int RuntimeSmoke::run() {
    prepare();
    check_practice();
    draw_hud_fixture();
    check_gauntlet();
    check_replay();
    check_leave();
    check_workers();
    write_result();
    return 0;
}

void RuntimeSmoke::act(const std::string &action, bool wheel) {
    actions_.action(action, wheel, false);
}

void RuntimeSmoke::practice_action(const std::string &action) {
    actions_.practice(action, false, std::nullopt);
}

void RuntimeSmoke::prepare() {
    output = data_location::from_utf8(opt.runtime_smoke);
    std::filesystem::create_directories(output);
    check(core && renderer && !menu, "needs a local BSP and no menu");
    check(!opt.replay.empty(), "needs a completed replay for the supplied BSP");
    const auto sidecar = native::data_location::from_utf8(opt.map).replace_extension(".zones.json");
    if (std::filesystem::exists(sidecar)) detail["zones"] = nlohmann::json::parse(native::read_text(sidecar));
    // A neutral host id allows tools on the tutorial fixture without enabling its lesson controller.
    actions_.load_map(opt.map, opt.content_root, "native-runtime-fixture", detail);
}

void RuntimeSmoke::check_practice() {
    check(actions_.practice_reason().empty(), "solo practice unavailable");
    act("thirdPerson");
    check(third_person && practice.active && practice.tool == "camera",
          "third person did not invalidate ranked admission");
    actions_.reset();
    check(practice.active && third_person, "restart lost third-person practice admission");
    act("thirdPerson");
    check(!third_person && !practice.active, "pre-start first person did not restore clean attempt");
    BhRunState before{};
    bh_run_state(core.get(), &before);
    const auto saved_tick = curr.tick;
    practice_action("save");
    BhRunState after{};
    bh_run_state(core.get(), &after);
    check(practice.number() == 1 && !practice.active && curr.tick == saved_tick,
          "save tainted attempt or advanced simulation");
    check(before.recording == after.recording && before.total_commands == after.total_commands,
          "save changed recording");
    // Gate exactly like a live timed run, without altering canonical movement.
    check(!practice.key_allowed("tele", true) && practice.key_allowed("save", true), "timed key guard");
    practice_action("menu");
    check(practice.menu_open && practice.key_allowed("noclip", true), "checkpoint menu guard");
    practice_action("tele");
    check(practice.active && practice.tool == "teleport", "teleport not practice");
    check(!native::practice_allows_event(practice.active, "beat")
                  && !native::practice_allows_event(practice.active, "finish"),
          "practice admission");
    const auto count = practice.checkpoints.size();
    actions_.reset();
    check(!practice.active && practice.checkpoints.size() == count && !practice.noclip,
          "restart did not clean attempt/preserve checkpoints");
    practice_action("toggle");
    actions_.reset();
    check(practice.mode && practice.active, "practice mode lost across restart");
    practice_action("toggle");
    check(!practice.mode && !practice.active, "leaving practice did not reset");
    practice_action("noclip");
    check(practice.noclip && practice.active, "noclip entry");
    command.forward = noclip_forward_units_per_second;
    require(bh_noclip_move(&practice.flight, &command, tick_interval_seconds), core.get(), "Smoke flight");
    require(bh_practice_noclip_tick(core.get(), &practice.flight, &snapshot), core.get(), "Smoke noclip tick");
    curr = prev = snapshot.player;
    practice_action("noclip");
    check(!practice.noclip && practice.active, "noclip exit cleared practice");
    practice_action("menu");
    if (!practice.menu_open) practice_action("menu");
}

void RuntimeSmoke::draw_hud_fixture() {
    SDL_GetWindowSizeInPixels(window, &w, &h);
    for (const float percent : hud_scales_percent) {
        bh_snapshot(core.get(), &snapshot);
        BhRunState timing{};
        bh_run_state(core.get(), &timing);
        BhWeaponReport weapon{};
        bh_weapon_report(core.get(), &weapon);
        const float eye[] = {curr.position[0], curr.position[1], curr.position[2] + curr.view_offset_z};
        renderer->draw(w, h, eye, input, &snapshot, 0);
        hud.draw(
                w,
                h,
                snapshot,
                timing,
                command,
                map_id,
                active_style,
                "",
                fixture_fps,
                true,
                true,
                false,
                weapon,
                "",
                std::nullopt,
                std::nullopt,
                true,
                nullptr,
                percent,
                &practice,
                true,
                "Gauntlet 1/3 | 00:01.000",
                "-0.500s",
                true,
                leave_progress_fraction
        );
        const auto png = backbuffer_png(gl, w, h);
        std::ofstream image(output / ("hud-" + std::to_string(int(percent)) + ".png"), std::ios::binary);
        image.write(png.data(), png.size());
    }
}

void RuntimeSmoke::check_gauntlet() {
    actions_.gauntlet_action(
            {{"id", "offline-smoke"},
             {"map", "native-runtime-fixture"},
             {"progress", {{"idx", 0}, {"maps", 2}, {"before", 0.0}, {"pbSplit", nullptr}}}}
    );
    check(!practice.active && !practice.mode && selected_style == "autohop" && active_track == 0,
          "gauntlet did not reset practice/style/track");
    check(actions_.practice_reason() == "No practice during a gauntlet.", "gauntlet permits practice");
    act("thirdPerson");
    check(!third_person && !practice.active, "third person escaped gauntlet admission");
    act("cycleStyle");
    act("restartBonus");
    check(selected_style == "autohop" && active_track == 0, "gauntlet bindings escaped lock");
    actions_.load_map(opt.map, opt.content_root, "native-runtime-fixture-next", detail);
    check(gauntlet_id == "offline-smoke" && !practice.active, "gauntlet map progression lost lock");
    actions_.gauntlet_action({{"id", nullptr}});
    check(actions_.practice_reason().empty(), "gauntlet clear left practice blocked");
    practice_action("save");
    practice_action("tele");
}

void RuntimeSmoke::check_replay() {
    actions_.open_replay(data_location::from_utf8(opt.replay), "play", 0, true);
    check(viewer.active && !practice.active && !practice.mode && practice.checkpoints.empty(),
          "replay retained practice state");
    viewer.camera.set_mode("free");
    viewer.camera.initialized = true;
    viewer.camera.position = free_camera_position_units;
    viewer.camera.yaw = free_camera_yaw_degrees;
    viewer.camera.pitch = free_camera_pitch_degrees;
    viewer.paused = true;
    actions_.seek_playback(0);
    check(curr.tick == 0 && viewer.paused, "replay seek start/pause");
    const auto replay_total = viewer.session.info.at("totalTicks").get<uint32_t>();
    actions_.seek_playback(replay_total);
    check(curr.tick == replay_total && viewer.paused, "replay seek end/pause");
    for (uint32_t tick = 0; tick < std::min(seek_probe_ticks, replay_total); ++tick)
        viewer.controls.pending = tick;
    viewer.controls.pending = std::min(seek_probe_ticks, replay_total);
    if (auto target = viewer.controls.take()) actions_.seek_playback(*target);
    check(curr.tick == std::min(seek_probe_ticks, replay_total) && !viewer.controls.take(),
          "replay rapid seeks did not coalesce latest");
    check(viewer.camera.initialized && viewer.camera.position == free_camera_position_units
                  && viewer.camera.yaw == free_camera_yaw_degrees && viewer.camera.pitch == free_camera_pitch_degrees,
          "seek lost free camera");
    viewer.camera.set_mode("eye");
    BhSnapshot replay_snapshot{};
    bh_snapshot(core.get(), &replay_snapshot);
    const float replay_eye[] = {curr.position[0], curr.position[1], curr.position[2] + curr.view_offset_z};
    renderer->draw(w, h, replay_eye, input, &replay_snapshot, 0);
    native::draw_replay_controls(
            hud,
            w,
            h,
            native::HudGeometry(w, h, overlay_scale_percent).scale,
            viewer.controls,
            curr.tick,
            replay_total,
            tick_interval_seconds,
            viewer.paused,
            viewer.speed,
            viewer.camera.mode
    );
    {
        const auto png = backbuffer_png(gl, w, h);
        std::ofstream image(output / "replay-controls.png", std::ios::binary);
        image.write(png.data(), png.size());
    }
    actions_.reset();
    check(!viewer.active && !practice.active, "replay restart not clean");
}

void RuntimeSmoke::start_timed_practice() {
    practice_action("toggle");
    check(practice.active, "timed practice setup");
    BhRunOptions options{};
    bh_default_run_options(&options);
    options.rules = 1;
    BhZone start{};
    for (int k = 0; k < 3; ++k) {
        start.mins[k] = curr.position[k] - start_half_extent_units;
        start.maxs[k] = curr.position[k] + start_half_extent_units;
    }
    BhZone end = start;
    end.kind = 1;
    end.mins[2] += end_height_units;
    end.maxs[2] += end_height_units;
    const BhZone test_zones[] = {start, end};
    require(bh_run_configure(core.get(), &options, test_zones, 2), core.get(), "Smoke timed practice configuration");
    BhCmd command{};
    require(bh_step(core.get(), &command, &curr), core.get(), "Smoke enter start");
    require(bh_set_position(
                    core.get(), curr.position[0] + leave_start_distance_units, curr.position[1], curr.position[2], 0
            ),
            core.get(),
            "Smoke leave start");
    require(bh_step(core.get(), &command, &curr), core.get(), "Smoke start practice timer");
    BhRunState timing{};
    require(bh_run_state(core.get(), &timing), core.get(), "Smoke read practice timer");
    check(timing.status == 1, "practice timer did not start");
}

void RuntimeSmoke::check_leave() {
    start_timed_practice();
    act("mainMenu");
    check(core && leave_hold.started >= 0, "timed practice skipped leave hold");
    const auto held_at = leave_hold.started;
    check(leave_hold.frame(held_at + leave_hold_ms - 1, true, false) == native::LeaveHold::Result::none,
          "practice leave fired early");
    check(leave_hold.frame(held_at + leave_hold_ms, true, false) == native::LeaveHold::Result::leave,
          "practice leave did not fire at 600ms");
    actions_.leave_map();
    actions_.load_map(opt.map, opt.content_root, "native-runtime-fixture-wheel", detail);
    start_timed_practice();
    act("mainMenu", true);
    check(core && renderer, "first timed practice wheel press left the map");
    act("mainMenu", true);
    check(!core && !renderer, "second timed practice wheel press did not leave");
}

void RuntimeSmoke::check_workers() {
    actions_.load_map(opt.map, opt.content_root, "native-runtime-fixture-room", detail);
    const nlohmann::json welcome = {
            {"t", "welcome"}, {"you", 1}, {"map", {{"name", map_id}}}, {"players", nlohmann::json::array()}
    };
    actions_.apply_room_event({{"generation", 7}, {"id", "old-room"}, {"event", welcome}});
    check(room.id == "old-room", "room setup");
    pending_replay = "stale";
    pending_action = "play";
    pending_room_map = "stale";
    pending_tutorial = "jump";
    std::atomic_bool entered = false, stopped = false;
    auto &worker_progress_mutex = progress_mutex;
    auto &worker_loading = loading;
    download.start(
            [&entered, &stopped, &worker_progress_mutex, &worker_loading](
                    const std::atomic_bool &cancel
            ) -> native::DownloadedMap {
                entered = true;
                while (!cancel)
                    std::this_thread::yield();
                {
                    std::lock_guard lock(worker_progress_mutex);
                    if (!cancel) worker_loading = "stale";
                }
                stopped = true;
                throw std::runtime_error("cancelled");
            }
    );
    while (!entered)
        std::this_thread::yield();
    const auto generation = heartbeat.generation;
    actions_.leave_map();
    const auto deadline = Clock::now() + worker_shutdown_timeout;
    while (!stopped && Clock::now() < deadline)
        std::this_thread::yield();
    download.poll();
    check(stopped && !core && !renderer && !download.valid() && map_id.empty() && zones.empty(),
          "leave-map core/worker shutdown");
    actions_.apply_room_event(
            {{"generation", 7}, {"id", "old-room"}, {"event", {{"t", "nativeMap"}, {"map", "bhop_late"}}}}
    );
    actions_.apply_room_event({{"generation", 7}, {"id", "old-room"}, {"event", welcome}});
    check(room.generation == 7 && room.id.empty() && room.map.empty() && !download.valid(),
          "late room callback revived map after leave");
    check(pending_replay.empty() && pending_room_map.empty() && pending_tutorial.empty() && loading.empty()
                  && heartbeat.generation > generation,
          "leave-map stale work/generation");
    actions_.load_map(opt.map, opt.content_root, "native-runtime-fixture-new", detail);
    check(core && renderer && !practice.active && practice.checkpoints.empty(), "new map after leave failed");
    check(gl.GetError() == GL_NO_ERROR, "OpenGL error");
}

void RuntimeSmoke::write_result() {
    const nlohmann::json result = {
            {"pass", true},
            {"practice", true},
            {"restart", true},
            {"newMap", true},
            {"replay", true},
            {"replayScrub", true},
            {"replaySeekPreservesFreeCamera", true},
            {"replaySeekEndpointsPaused", true},
            {"replaySeekCoalesced", true},
            {"checkpointMenu", true},
            {"hudScales", {50, 100, 175}},
            {"gauntlet", true},
            {"leaveMapWorkerShutdown", true},
            {"closedRoomGeneration", true},
            {"thirdPersonPracticeAdmission", true},
            {"timedPracticeLeaveHold", true},
            {"timedPracticeLeaveWheel", true},
            {"networkWrites", 0},
            {"webglContexts", 0}
    };
    std::ofstream(output / "result.json") << result.dump(2) << '\n';
    std::cout << "Native runtime lifecycle smoke: " << result.dump() << '\n';
}

}  // namespace native
