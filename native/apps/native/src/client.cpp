#include "preferences.hpp"
#include "options.hpp"
#include "startup.hpp"
#include "startup_display.hpp"
#include "bunnyhop_native.h"
#include "native_input.hpp"
#include "mouse_diagnostics.hpp"
#include "raw_keyboard.hpp"
#include "input_timeline.hpp"
#include "run_session.hpp"
#include "run_history.hpp"
#include "game_session.hpp"
#include "base64.hpp"
#include "replay_practice.hpp"
#include "ghost_slots.hpp"
#include "video_request.hpp"
#include "display_defaults.hpp"
#include "json_file_writer.hpp"
#include "diagnostics_report.hpp"
#include "frame_pacing.hpp"
#include "native_math.hpp"
#include "menu_webview.hpp"
#include "online.hpp"
#include "renderer.hpp"
#include "replay_player.hpp"
#include "menu_backdrop.hpp"
#include "loadout_preview.hpp"
#include "menu_gamepad.hpp"
#include "hud.hpp"
#include "hud_frame.hpp"
#include "capabilities.hpp"
#include "practice_controller.hpp"
#include "leave_hold.hpp"
#include "native_chat.hpp"
#include "sniper_zoom.hpp"
#include "activity.hpp"
#include "weapon_menu.hpp"
#include "start_point.hpp"
#include "restart_placement.hpp"
#include "run_timing.hpp"
#include "weapon_commands.hpp"
#include "replay_camera.hpp"
#include "replay_controls.hpp"
#include "render_menu_contracts.hpp"
#include "render_capabilities.hpp"
#include "map_jobs.hpp"
#include "ssj.hpp"
#include "strafe_trainer.hpp"
#include "audio.hpp"
#include "client_util.hpp"
#include "run_vault.hpp"
#include "replay_library.hpp"
#include "menu_state.hpp"
#include "menu_room_state.hpp"
#include "map_prefetch.hpp"
#include "recoverable_action.hpp"
#include "app_identity.hpp"
#include "room_state.hpp"
#include "room_bridge.hpp"
#include "room_modes.hpp"
#include "tutorial_runner.hpp"
#include "discord_rpc.hpp"
#include "data_location.hpp"
#include "relaunch.hpp"
#include "native_update.hpp"
#include "update_config.hpp"
#include "video_capture.hpp"
#include "client_smoke.hpp"
#include "runtime_smoke.hpp"
#include "window_sdl.hpp"
#include "window_mode_driver.hpp"
#include "menu_scripts.hpp"
#include "menu_files.hpp"
#include "menu_messages.hpp"
#include <SDL3/SDL.h>
#include <SDL3/SDL_opengl.h>
#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <filesystem>
#include <future>
#include <iostream>
#include <limits>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <sstream>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

namespace {

void require(bool ok, BhContext *ctx, const char *operation) {
    if (!ok) {
        const char *error = bh_last_error(ctx);
        throw std::runtime_error(std::string(operation) + ": " + (error && *error ? error : "native core failed"));
    }
}

// Settings -> Game data: set by "Move now"; main() starts a fresh copy once run()
// has returned and every file in the old data folder is closed.
static bool relaunch_requested = false;

// The system folder picker answers on its own schedule (possibly another thread);
// static so a late answer during shutdown never lands in freed memory.
struct DataFolderPicker {
    std::mutex m;
    bool open = false, done = false;
    std::optional<std::string> result;
    std::string error;
};

static DataFolderPicker data_picker;

static void data_folder_picked(void *userdata, const char *const *files, int) {
    auto *picker = static_cast<DataFolderPicker *>(userdata);
    std::lock_guard lock(picker->m);
    picker->open = false;
    picker->done = true;
    if (!files)
        picker->error = SDL_GetError();
    else if (files[0])
        picker->result = files[0];
}

int run(const native::Options &opt) {
    if (bh_abi_version() != 1) throw std::runtime_error("Unsupported native core ABI version");
    if (!bh_v29_check_abi(BH_V29_ABI_VERSION, sizeof(BhRecordOptionsV29), sizeof(BhTimingSegmentV2))) {
        throw std::runtime_error("Unsupported native v29 ABI layout");
    }
    BhSettings settings{};
    bh_default_settings(&settings);
    const double dt = settings.tick_interval;
    if (!std::isfinite(dt) || dt <= 0 || dt > .1) throw std::runtime_error("Invalid core tick interval");
    BhState curr{}, prev{};
    native::Input input;
    input.set_sensitivity(opt.sensitivity);
    native::SdlSession sdl;
    auto window_and_gl = native::create_window_and_gl(opt);
    auto &window = window_and_gl.window;
    native::Gl gl;
    gl.load();
    native::FramePacer<native::Gl> frame_pacer;
    // Feedback context (the menu's "Attach game info"): the GPU the game draws with, not the menu web view's.
    const std::string gpu_renderer = [&] {
        const auto *name = gl.GetString(GL_RENDERER);
        return name ? std::string(reinterpret_cast<const char *>(name)) : std::string();
    }();
    const auto assets = native::resource("native-assets", BUNNYHOP_NATIVE_ASSET_ROOT);
    const auto menu_path = opt.menu_html == BUNNYHOP_MENU_HTML ? native::resource("menu.html", opt.menu_html)
                                                               : native::data_location::from_utf8(opt.menu_html);
    const auto manifest_path = native::resource("native-manifest.json", BUNNYHOP_NATIVE_MANIFEST);
    native::NativeHud hud(gl, assets);
    native::MenuGamepad menu_gamepad;
    std::unique_ptr<NativeLoadoutPreview> loadout_preview;
    std::optional<nlohmann::json> preview_request;
    native::NativeHud::Layout hud_layout;
    // Resolved before the audio device so the custom sound/ and bgm/ folders
    // are known at the point the packs are first applied.
    native::DataMoveDisplay display(window.get(), gl, hud);
    auto data_paths = native::resolve_data_folder(opt, window.get(), display);
    namespace data_location = native::data_location;
    const auto &default_root = data_paths.default_root;
    const auto &cache = data_paths.cache;
    auto &location = data_paths.location;
    const auto &data_startup_notice = data_paths.notice;
    auto &data_unavailable = data_paths.unavailable;
    std::optional<data_location::Choice> data_choice;
    std::string data_notice, last_data_state;
    const auto startup_data = native::initialize_data_directory(cache);
    native::Audio audio(assets, cache, !opt.hidden && !opt.frames);
    std::unique_ptr<native::MenuWebView> menu;
    std::string menu_failure;
    native::MenuFiles menu_files(cache);
    const bool wants_menu = !opt.no_menu && (!opt.frames || !opt.menu_smoke.empty());
    if (wants_menu) {
        menu = std::make_unique<native::MenuWebView>(window.get(), native::read_text(menu_path));
        if (!menu->available()) {
            std::cerr << "Menu unavailable: " << menu->error() << '\n';
            menu_failure = menu->error();
            menu.reset();
        }
    }
    if (!menu && opt.map.empty() && opt.online_map.empty())
        throw std::runtime_error("Menus are unavailable on this build; use --map PATH or --online-map NAME");
    // Every download_map call shares one content cache whose temporary names
    // are deterministic, so downloads take turns. Waiting gives up once its
    // own download is cancelled, so neither worker can hold up shutdown.
    std::mutex cache_mutex;
    auto lock_cache = [&cache_mutex](const std::atomic_bool &cancel) {
        std::unique_lock lock(cache_mutex, std::defer_lock);
        while (!lock.try_lock()) {
            if (cancel) throw std::runtime_error("Map download cancelled");
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
        }
        if (cancel) throw std::runtime_error("Map download cancelled");
        return lock;
    };
    // Home-screen backdrop: the web map tour over the map the menu picked,
    // from its own native context. Released as soon as a gameplay map loads.
    std::unique_ptr<native::MenuBackdrop> backdrop;
    if (menu)
        backdrop = std::make_unique<native::MenuBackdrop>(
                gl, assets, [&lock_cache, cache](const std::string &id, const std::atomic_bool &cancel) {
                    const auto lock = lock_cache(cancel);
                    native::DownloadLimits limits;
                    limits.bsp = 32 * 1024 * 1024;
                    limits.content_total = 256 * 1024 * 1024;
                    return native::download_map(id, cache, [](const std::string &) {}, &cancel, limits);
                }
        );
    // What the menu was last told: the backdrop source and the map it shows.
    bool menu_reduced_motion = true, backdrop_cut = false, gameplay_backdrop_due = false;
    std::string backdrop_source, backdrop_shown, backdrop_failed, backdrop_png;
    auto backdrop_clock = std::chrono::steady_clock::now();
    native::MenuSmoke menu_smoke(opt);
    auto &smoke_requested = menu_smoke.requested;
    auto &smoke_pass = menu_smoke.passed;
    bool captured = false, focused = true, running = true, menu_ready = false, resume_wanted = false;
    // Settings and other small JSON files are written off the frame loop.
    native::JsonFileWriter json_writer;
    auto preferences = startup_data.settings;
    native::MenuState menu_state;
    native::MenuRoomState room_menu_state;
    const bool first_settings = startup_data.first_settings;
    if (!startup_data.error.empty()) {
        std::cerr << "Settings: " << startup_data.error << '\n';
    }
    if (opt.sensitivity_set) preferences["sensitivity"] = opt.sensitivity;
    // Recovery: --windowed resets a display mode the player cannot leave and keeps it.
    if (opt.windowed && preferences.value("windowMode", std::string()) != "windowed") {
        preferences["windowMode"] = "windowed";
        try {
            native::save_settings(cache / "settings.json", preferences);
        } catch (const std::exception &e) {
            std::cerr << "Settings: " << e.what() << '\n';
        }
    }
    native::WindowController window_controller(window.get());
    const bool persist_window = !opt.hidden && !opt.frames && opt.menu_smoke.empty() && opt.runtime_smoke.empty();
    // Keep the display defaults this launch chose (display_defaults.hpp), so the next launch reads the same ones.
    if (first_settings && persist_window) {
        try {
            native::save_settings(cache / "settings.json", preferences);
        } catch (const std::exception &e) {
            std::cerr << "Settings: " << e.what() << '\n';
        }
    }
    std::optional<native::WindowBounds> saved_window;
    if (persist_window) try {
            const auto path = cache / "window-state.json";
            if (std::filesystem::exists(path) && std::filesystem::file_size(path) <= 16384)
                saved_window = native::read_window_bounds(nlohmann::json::parse(native::read_text(path)));
        } catch (const std::exception &e) {
            std::cerr << "Window bounds: " << e.what() << '\n';
        }
    // Exclusive fullscreen is borderless while the menu is open, and nothing
    // changes while the window is minimized (window_modes.hpp).
    native::WindowModeDriver window_modes(window_controller, preferences.value("windowMode", std::string("windowed")));
    if (persist_window && !window_modes.launch(preferences, bool(menu), saved_window)) {
        std::cerr << "Window: " << window_controller.error() << '\n';
        preferences["windowMode"] = window_controller.mode();
    }
    auto prefs = native::Preferences::from_settings(preferences);
    bool window_dirty = false;
    auto window_save_due = std::chrono::steady_clock::now();
    // While borderless/fullscreen, saved_bounds() is the last windowed bounds.
    auto save_window = [&]() {
        if (!persist_window || !prefs.remember_window_bounds) return;
        try {
            if (auto bounds = window_controller.saved_bounds())
                json_writer.write(cache / "window-state.json", native::window_bounds_json(*bounds));
            window_dirty = false;
        } catch (const std::exception &e) {
            std::cerr << "Window bounds: " << e.what() << '\n';
        }
    };
    std::string selected_style = opt.style, active_style = opt.style, outfit, packed_loadout,
                ghost_cosmetic = "ghost-default", trail_cosmetic = "trail-none";
    std::optional<native_render::Glow> player_glow;
    native::RoomBridge room_bridge;
    auto &room = room_bridge.room;
    auto &room_modes = room_bridge.room_modes;
    auto &observed_spectator = room_bridge.observed_spectator;
    auto epoch_ms = []() {
        return std::chrono::duration<double, std::milli>(std::chrono::system_clock::now().time_since_epoch()).count();
    };
    auto &room_events = room_bridge.room_events;
    uint32_t active_track = 0;
    native::GhostSlots ghosts;
    unsigned pending_ghost_slot = 0;
    std::string pending_replay, pending_action, score_notice;
    std::optional<double> known_world_record;
    uint64_t world_record_generation = ~uint64_t(0);
    nlohmann::json replay_list = nlohmann::json::array();
    native::ReplayPlayer viewer;
    bool pending_full_recording = false;
    native::GameSession game(viewer.camera);
    auto &core = game.core;
    auto &renderer = game.renderer;
    auto &map_id = game.map_id;
    auto &replay_compare = game.replay_compare;
    auto &replay_timeline = game.replay_timeline;
    auto &replay_compare_import = game.replay_compare_import;
    native::GraphicsMenuPacer graphics_menu_pacer;
    auto &video = game.video;
    auto &video_encoder = video.encoder;

    auto &video_capture = video.capture;
    auto &director_job = video.director_job;
    native::ReplayCamera third_camera;
    auto &video_error = video.error;
    auto &video_music_catalog = video.music_catalog;
    auto cancel_video = std::bind_front(&native::VideoController::cancel, &video);
    auto video_state = std::bind_front(&native::VideoController::state, &video);
    std::string pending_room_map;
    double display_fps = 0;
    native::TutorialRunner tutorial_runner;
    tutorial_runner.load_progress(cache);
    std::string pending_tutorial = opt.tutorial_lesson;
    bool pending_tutorial_demo = opt.tutorial_demo;
    std::function<void(const std::string &, bool)> start_tutorial;
    // Keys as last polled (actions, turnbinds, overlays). Timed ticks use their own key state (input.queue.keys).
    std::set<std::string> held_codes;
    native::InputTimeline input_timeline;
    native::FrameDiagnostics frame_diagnostics;
    native::TurnSettings configured_turns;
    native::RunRecorder recorder;
    auto &discord_settings = room_bridge.discord_settings;
    const char *video_driver = SDL_GetCurrentVideoDriver();
    input_timeline.configure_stamps(video_driver ? video_driver : "");
    native::Chat chat;
    native::RestartGuard restart_guard;
    native::AutoRestart auto_restart;
    native::RacePicker race_picker;
    native::StartPoints start_points;
    native::KeptWeapons kept_weapons;
    third_camera.set_mode("chase");
    native::Input camera_controls;
    native::SniperZoom scope;
    native::NativeWeaponMenu gun_menu;
    native::NativeTriggerMenu trigger_menu;
    bool third_person = false, flashlight = false, hide_players = false, show_scores = false;
    try {
        const auto path = cache / "start-points.json";
        if (std::filesystem::exists(path) && std::filesystem::file_size(path) <= 1024 * 1024)
            start_points.load(nlohmann::json::parse(native::read_text(path)));
    } catch (const std::exception &e) {
        std::cerr << "Start points: " << e.what() << '\n';
    }
    auto apply_preferences = [&]() {
        prefs = native::Preferences::from_settings(preferences);
        discord_settings = native::discord::settings_from(preferences);
        menu_state.settings_changed();
        graphics_menu_pacer.settings(preferences);
        flashlight = preferences.value("graphicsFlashlight", false);
        if (backdrop) backdrop->graphics_settings(preferences);
        hud_layout.clear();
        input_timeline.set_sensitivity(input, prefs.sensitivity);
        input.vertical_sensitivity = prefs.vertical_sensitivity;
        input.separate_vertical = prefs.separate_vertical;
        input.invert_y = prefs.invert_y;
        input_timeline.rebuild_binds(preferences.at("binds"));
        configured_turns = native::TurnSettings::from_settings(preferences);
        const bool timed_input = !opt.legacy_input && prefs.timed_input;
        input_timeline.set_timed(timed_input, input, held_codes);
        camera_controls.set_sensitivity(input.sensitivity);
        camera_controls.vertical_sensitivity = input.vertical_sensitivity;
        camera_controls.separate_vertical = input.separate_vertical;
        camera_controls.invert_y = input.invert_y;
        hud.preferences(preferences);
        audio.preferences(preferences);
        SDL_GL_SetSwapInterval(opt.frames ? 0 : prefs.vsync ? 1 : 0);
        audio.gain(preferences.at("muted").get<bool>() ? 0 : preferences.at("volume").get<float>());
        audio.set_sfx_pack(preferences.at("sfxPack").get<std::string>() == "custom");
        audio.set_music_pack(preferences.at("musicPack").get<std::string>() == "custom");
        video_music_catalog = audio.export_music_catalog(preferences.at("musicPack").get<std::string>() == "custom");
        if (renderer) {
            renderer->graphics_settings(preferences);
            renderer->set_player_glow(player_glow);
            renderer->set_glow_visible(
                    preferences.value("showPlayerGlow", true), preferences.value("firstPersonGlow", false)
            );
            renderer->set_fov(prefs.fov);
            renderer->set_viewmodel(
                    preferences.at("viewmodelFov").get<float>(),
                    preferences.at("viewmodelX").get<float>(),
                    preferences.at("viewmodelY").get<float>(),
                    preferences.at("viewmodelZ").get<float>(),
                    preferences.at("viewmodelLeftHand").get<bool>(),
                    prefs.viewmodel,
                    preferences.at("viewmodelBob").get<float>(),
                    preferences.at("viewmodelSway").get<float>()
            );
            renderer->set_color_blind(preferences.value("colorBlind", std::string("off")));
            renderer->set_actor_models(
                    preferences.value("playerModel", std::string("bunny")),
                    preferences.value("ghostModel", std::string("same"))
            );
            renderer->set_zones_visible(preferences.value("zonesVisible", true));
            renderer->set_effects_visible(preferences.value("effectsVisible", true));
            renderer->set_triggers_visible(preferences.value("triggersVisible", false));
            renderer->set_clips_visible(preferences.value("clipsVisible", false));
            renderer->set_water_quality(
                    preferences.value("waterQuality", std::string("simple")) == "refracted" ? 1 : 0
            );
        }
    };
    apply_preferences();
    std::string loading, error, last_requested_map;
    native::ReplayLibrary replay_library(cache);
    native::RunVault run_vault(cache / "run-vault");
    nlohmann::json load_progress = nullptr;
    const auto identity = native::load_release_identity(manifest_path, menu_path, assets);
    native::updates::Service updater(
            nlohmann::json::parse(native::update_config_json),
            cache / "updates",
            identity.value("version", std::string("local")),
            identity.value("build", std::string("bunnyhop-native/local"))
    );
    std::string last_update;
    // Jump stats (!ssj). Display only — it reads the same pre-state, command and
    // events the simulation already produced and never feeds anything back.
    native::MovementFeedback feedback;
    native::TurnAdmission turn_admission;
    native::PracticeController practice;
    native::LeaveHold leave_hold;
    std::string gauntlet_id, gauntlet_map;
    nlohmann::json gauntlet_progress;
    if (!data_startup_notice.empty()) {
        hud.toasts.push(data_startup_notice, double(SDL_GetTicksNS()) / 1e9, 8);
        data_notice = data_startup_notice;
    }

    auto reset_feedback = [&](bool incomplete_history = false, bool keep_jump_stats = false) {
        hud.reset_history(keep_jump_stats);
        const auto gain = feedback.ssj_gain;
        BhRunState timing{};
        BhSnapshot snapshot{};
        if (core) {
            bh_run_state(core.get(), &timing);
            bh_snapshot(core.get(), &snapshot);
        }
        feedback.reset(timing.in_start != 0, snapshot.movement_mode == 1, incomplete_history);
        if (keep_jump_stats) feedback.ssj_gain = gain;
    };
    native::RunHeartbeat heartbeat;
    auto &zones = game.zones;
    std::mutex progress_mutex;
    native::MapJobs<native::DownloadedMap> download;
    native::MapJobs<bool> prefetch;
    bool map_preparing = false;
    std::string prefetch_map, prefetch_sha, prefetch_active, prefetch_done;
    auto cancel_prefetch = [&]() {
        prefetch.cancel();
        prefetch_map.clear();
        prefetch_sha.clear();
        prefetch_active.clear();
    };
    native::InputScheduler input_scheduler;
    input_scheduler.reset(SDL_GetTicksNS());
    using Clock = std::chrono::steady_clock;
    native::ActivityCounter activity;
    constexpr double run_second_ns = 1'000'000'000;
    native::RunHistory run_history;
    run_history.load(cache / "run-history.json");
    activity.input(std::chrono::duration<double>(Clock::now().time_since_epoch()).count());
    auto activity_time = Clock::now();
    native::InputClock input_clock;
    // A focus, menu or restart reset: the simulation starts again from now and
    // motion from before it is dropped rather than handed to the next tick.
    auto reset_input_timing = [&]() {
        input_scheduler.reset(SDL_GetTicksNS());
        input_timeline.restart(input, held_codes);
        camera_controls.clear();
        SDL_FlushEvent(SDL_EVENT_MOUSE_MOTION);
        input_clock.reset();
        leave_hold.cancel();
        restart_guard.cancel();
    };
    auto capture = [&](bool on) {
        if (chat.active) {
            chat.close();
            SDL_StopTextInput(window.get());
        }
        input_timeline.release(input, held_codes);
        reset_input_timing();
        // Raw keys off before relative mode changes: SDL 3.4 restarts its raw-input thread on each toggle, and with raw
        // keys on, key-ups in that gap are lost. With them off, the message loop delivers them.
        if (!on) {
            native::set_raw_keyboard(false);
        }
        if (!SDL_SetWindowRelativeMouseMode(window.get(), on)) {
            captured = false;
            std::cerr << "Relative mouse mode failed: " << SDL_GetError() << '\n';
            ++frame_diagnostics.relative_mode_failures;
        } else
            captured = on;
        native::set_raw_keyboard(captured);
        input_clock.reset();
    };
    // from_focus_loss: the window mode change waits until focus returns.
    auto show_menu = [&](bool on, bool from_focus_loss = false) {
        if (on) menu_state.reset();
        if (on) input_timeline.keyboard_focus_lost();
        if (on) {
            viewer.controls.dragging = false;
            viewer.orbit_drag = false;
        }
        SDL_SetWindowAlwaysOnTop(window.get(), !on && prefs.always_on_top);
        // Hidden before the window goes exclusive, shown once it is composited.
        if (menu && !on) menu->set_visible(false);
        if (menu) window_modes.set_menu(on, from_focus_loss, preferences);
        if (menu && on) menu->set_visible(true);
        // Each pause re-announces the paused map (a fresh still for a
        // separate GTK window); sent with the menu state once it is visible.
        if (on && core && menu) gameplay_backdrop_due = true;
        if (on) audio.pause();
        resume_wanted = !on && bool(core);
        if (resume_wanted) SDL_RaiseWindow(window.get());
        capture(resume_wanted && focused && !(viewer.active && viewer.controls.visible));
        input_scheduler.reset(SDL_GetTicksNS());
        prev = curr;
    };
    uint64_t chat_request = 0;
    auto chat_suggest = [&]() {
        ++chat_request;
        if (menu && menu_ready)
            menu->evaluate_js(
                    "window.bunnyhopNativeMenu?.onChatSuggest?.("
                    + nlohmann::json({{"text", chat.input}, {"request", chat_request}}).dump() + ")"
            );
    };
    auto open_chat = [&](bool command) {
        if (!core || viewer.active || !captured || !menu || !menu_ready) return;
        input_timeline.release(input, held_codes);
        camera_controls.clear();
        leave_hold.cancel();
        restart_guard.cancel();
        // Keep gameplay running with neutral input while exposing the pointer for chat links.
        chat.open(command);
        native::set_raw_keyboard(false);
        SDL_SetWindowRelativeMouseMode(window.get(), false);
        SDL_StartTextInput(window.get());
        int w = 0, h = 0;
        SDL_GetWindowSize(window.get(), &w, &h);
        SDL_Rect area{16, std::max(0, h - 120), std::max(1, w - 32), 32};
        SDL_SetTextInputArea(window.get(), &area, 0);
        chat_suggest();
    };
    bool chat_drag = false;
    auto close_chat = [&]() {
        chat_drag = false;
        chat.close();
        SDL_StopTextInput(window.get());
        if (captured && focused && (!menu || !menu->visible())) {
            SDL_SetWindowRelativeMouseMode(window.get(), true);
            native::set_raw_keyboard(true);
        }
        input_timeline.release(input, held_codes);
        camera_controls.clear();
    };
    auto room_control = [&](const nlohmann::json &command) {
        if (menu && menu_ready) menu->evaluate_js("window.bunnyhopNativeMenu?.onRoomControl?.(" + command.dump() + ")");
    };
    auto run_event = [&](nlohmann::json event) {
        if (!native::practice_allows_event(practice.active, event.value("type", std::string()))
            || !turn_admission.allows_event(event.value("type", std::string())))
            return;
        if (!menu || !menu_ready || opt.frames || !opt.menu_smoke.empty()) return;
        event["generation"] = heartbeat.generation;
        event["map"] = map_id;
        event["style"] = active_style;
        event["build"] = identity.value("build", std::string("bunnyhop-native/local"));
        event["wasm"] = identity.value("wasm", std::string());
        menu->evaluate_js("window.bunnyhopNativeMenu?.onRunEvent?.(" + event.dump() + ")");
    };
    auto tutorial_practice = [&]() {
        return tutorial_runner.practice(map_id);
    };
    // The signed-in account's display name for replay headers (menu "playerName"), "player" until it says.
    std::string replay_player = "player";
    auto begin_record = [&]() {
        if (turn_admission.local_only) score_notice.clear();
        turn_admission.reset();
        recorder.input.stop();
        recorder.clear(false);
        const auto event = heartbeat.invalidate();
        heartbeat.restart();
        run_event(event);
        if (practice.active || viewer.active || room.spectator_target || tutorial_practice() || zones.empty()
            || opt.frames || !opt.menu_smoke.empty())
            return;
        recorder.begin(
                core.get(),
                cache,
                map_id,
                identity.at("build").get<std::string>(),
                active_style,
                replay_player,
                configured_turns,
                packed_loadout
        );
        run_history.select(map_id, active_track, active_style, double(SDL_GetTicksNS()) / run_second_ns);
    };
    auto reset = [&]() {
        cancel_video();
        viewer.controls = {};
        viewer.controls.pending.reset();
        viewer.orbit_drag = false;
        if (!core) return;
        if (pending_action != "play") cancel_prefetch();
        gun_menu.close();
        trigger_menu.close();
        bh_record_end(core.get());
        room_events |= 8;
        practice.restart();
        if (third_person && !room.spectator_target) {
            practice.active = true;
            if (practice.tool.empty()) practice.tool = "camera";
        }
        if (viewer.active) {
            require(bh_replay_stop(core.get()), core.get(), "Stopping replay");
            viewer.active = false;
            viewer.id.clear();
        }
        game.configure_timer();
        active_style = active_track ? "autohop" : selected_style;
        if (tutorial_runner.lesson && tutorial_runner.lesson->is_active() && active_style != "legit"
            && active_style != "scroll")
            active_style = "autohop";
        hud.context(replay_list, map_id, active_style, active_track);
        room.solo_display(map_id, replay_player, active_style);
        game.restart(active_style);
        const auto restart = native::RestartPlacement::place(
                core.get(),
                map_id,
                active_track,
                zones,
                tutorial_runner.lesson && tutorial_runner.lesson->is_active() ? nullptr : &start_points
        );
        curr = restart.state;
        if (tutorial_runner.lesson && tutorial_runner.lesson->is_active())
            tutorial_runner.restart(core.get(), active_style, curr);
        if (renderer) {
            renderer->reset_presentation();
            scope.reset();
            renderer->set_viewmodel_weapon(std::nullopt);
            renderer->set_cosmetics(outfit, packed_loadout);
        }
        audio.reset();
        hud.reset_history(true);
        viewer.camera.reset();
        prev = curr;
        reset_input_timing();
        input.set_angles(restart.pitch.value_or(curr.teleport_angles[0]), curr.teleport_angles[1]);
        if (restart.practice && !practice.active) {
            practice.active = true;
            practice.tool = "spawn";
        }
        kept_weapons.restarted(practice.active || zones.empty(), settings.physics >= 10);
        begin_record();
        reset_feedback(false, true);
        reset_input_timing();
        // (toast() is declared after reset; set its state directly.)
        if (restart.practice)
            hud.toasts.push(
                    "Custom practice spawn. !clearstart restores ranked restarts.", double(SDL_GetTicksNS()) / 1e9, 4
            );
    };
    auto practice_reason = [&]() {
        return native::practice_unavailable(
                bool(core),
                viewer.active,
                !room.id.empty(),
                map_id == native::TutorialRunner::map_id,
                !gauntlet_id.empty()
        );
    };
    auto toast = [&](const std::string &text, unsigned ms = 3000) {
        hud.toasts.push(text, double(SDL_GetTicksNS()) / 1e9, double(ms) / 1000);
    };
    native::PendingMenuScript menu_script;
    auto practice_use = [&](const std::string &tool) {
        if (const auto notice = practice.activate(core.get(), tool)) toast(*notice, 5000);
        run_event(practice.enter(core.get(), tool, recorder, heartbeat, score_notice));
    };
    auto practice_action =
            [&](const std::string &action, bool bound = false, std::optional<bool> value = std::nullopt) {
                const auto unavailable = practice_reason();
                if (!unavailable.empty()) {
                    toast(unavailable);
                    return;
                }
                BhRunState timing{};
                bh_run_state(core.get(), &timing);
                if (bound && action != "toggle" && !practice.key_allowed(action, timing.status == 1)) {
                    if (practice.hinted_run != timing.start_tick) {
                        practice.hinted_run = timing.start_tick;
                        toast("Type !cp to use checkpoints and noclip during a run.", 3500);
                    }
                    return;
                }
                if (action == "menu") {
                    practice.menu_open = !practice.menu_open;
                    return;
                }
                if (action == "keepVelocity") {
                    preferences["practiceKeepVelocity"] = value.value_or(!prefs.practice_keep_velocity);
                    prefs = native::Preferences::from_settings(preferences);
                    menu_state.settings_changed();
                    json_writer.write(cache / "settings.json", preferences);
                    return;
                }
                if (action == "toggle") {
                    practice.mode = !practice.mode;
                    if (practice.mode) {
                        practice.tool.clear();
                        practice_use("");
                        toast(native::PracticeController::help(input_timeline.binds()), 6000);
                    } else {
                        reset();
                        toast("Practice mode off. You're back at the start.");
                    }
                    return;
                }
                if (action == "save") {
                    practice.save(core.get(), input, selected_style, active_style, active_track);
                    toast("Checkpoint " + std::to_string(practice.number()) + " saved");
                    return;
                }
                if (action == "noclip") {
                    if (!practice.noclip) {
                        BhRunState before{};
                        bh_run_state(core.get(), &before);
                        practice_use("noclip");
                        practice.noclip = true;
                        if (before.status == 1) toast("Noclip: timer stopped. Press R for a real run.", 3500);
                        practice.begin_flight(curr);
                    } else {
                        const auto result = practice.exit_flight(core.get(), input, curr, prev);
                        if (!result) toast("You're stuck in a wall. Noclip again, or teleport to a checkpoint.", 4000);
                    }
                } else if (action == "tele" || action == "prev" || action == "next") {
                    if (practice.checkpoints.empty()) {
                        toast("No checkpoint yet. Press C to save one.");
                        return;
                    }
                    if (action != "tele") practice.step(action == "prev" ? -1 : 1);
                    const auto &cp = practice.checkpoints[practice.current];
                    if (cp.selected != selected_style) {
                        toast("That checkpoint was saved in another style.");
                        return;
                    }
                    const auto view = practice.restore(core.get());
                    practice_use("teleport");
                    practice.noclip = false;
                    active_style = cp.style;
                    active_track = cp.track;
                    curr = practice.restore_velocity(core.get(), prefs.practice_keep_velocity);
                    prev = curr;
                    input.set_angles(view.pitch, view.yaw);
                    toast("Checkpoint " + std::to_string(practice.number()) + " of "
                          + std::to_string(practice.checkpoints.size()));
                } else
                    throw std::runtime_error("Unknown practice action");
                if (renderer) renderer->reset_presentation();
                scope.reset();
                audio.reset();
                reset_feedback(true);
                reset_input_timing();
                room_events |= 8;
            };
    auto leave_map = [&]() {
        cancel_video();
        viewer.controls = {};
        viewer.controls.pending.reset();
        viewer.orbit_drag = false;
        show_menu(true);
        if (menu && menu_ready) menu->evaluate_js("window.bunnyhopNativeMenu?.onLeaveMap?.()");
        download.cancel();
        cancel_prefetch();
        {
            std::lock_guard lock(progress_mutex);
            loading.clear();
            load_progress = nullptr;
        }
        pending_replay.clear();
        pending_action.clear();
        pending_room_map.clear();
        pending_tutorial.clear();
        tutorial_runner.stopped = true;
        replay_compare.clear();
        replay_compare_import.reset();
        game.leave(practice);
        tutorial_runner.lesson.reset();
        viewer.active = false;
        viewer.paused = false;
        viewer.id.clear();
        viewer.session.info = nullptr;
        ghosts.handle = 0;
        ghosts.enabled = false;
        ghosts.id.clear();
        ghosts.info = nullptr;
        ghosts.slots = {};
        gauntlet_id.clear();
        gauntlet_map.clear();
        gauntlet_progress = nullptr;
        zones.clear();
        map_id.clear();
        audio.set_map(nullptr);
        active_track = 0;
        active_style = selected_style;
        curr = {};
        prev = {};
        recorder.clear(true);
        score_notice.clear();
        hud.toasts.clear();
        error.clear();
        turn_admission.reset();
        run_event(heartbeat.invalidate());
        reset_feedback();
        reset_input_timing();
        audio.reset();
        if (backdrop) backdrop->release();
        backdrop_shown.clear();
        backdrop_failed.clear();
        backdrop_source.clear();
        backdrop_cut = false;
        gameplay_backdrop_due = false;
        menu_state.reset();
        room.close();
        room_modes.close(room.generation);
        observed_spectator.reset();
    };
    auto apply_room_mode = [&](const native::RoomModeAction &action) {
        if (action.stop_spectating && menu && menu_ready)
            menu->evaluate_js("window.bunnyhopNativeMenu?.onRoomCommand?.({t:'spec',target:null})");
        if (action.restart && core) {
            if (tutorial_runner.lesson) tutorial_runner.lesson->stop();
            tutorial_runner.demo = false;
            if (!action.style.empty()) selected_style = action.style;
            active_track = action.track;
            reset();
            show_menu(false);
        }
    };
    auto load_map = [&](const std::string &path,
                        const std::string &content,
                        const std::string &id,
                        const nlohmann::json &detail) {
        game.prepare_workers(path, content);
        auto next = native::GameSession::prepare(path, content, settings, detail);
        const auto &next_zones = next.zones;
        std::unique_ptr<native::Tutorial> next_tutorial;
        if (id == native::TutorialRunner::map_id)
            next_tutorial = tutorial_runner.prepare(data_location::from_utf8(path), assets, selected_style);
        audio.set_classic_loader([content, cache]() {
            if (!content.empty()) native::download_classic_sounds(data_location::from_utf8(content), cache);
        });
        auto next_renderer = std::make_unique<native::Renderer>(gl, next.core.get(), assets);
        game.install(std::move(next.core), std::move(next_renderer), practice, audio);
        // The pause screen shows this map itself, never the home tour.
        if (backdrop) backdrop->release();
        backdrop_shown.clear();
        backdrop_failed.clear();
        backdrop_cut = false;
        gameplay_backdrop_due = true;
        if (pending_action != "play" && opt.replay.empty() && !opt.frames && opt.runtime_smoke.empty())
            activity.loaded(id);
        kept_weapons.forget();
        ghosts.slots = {};
        zones = next_zones;
        renderer->set_zones(zones);
        viewer.camera.reset();
        hud.reset_history();
        tutorial_runner.lesson = std::move(next_tutorial);
        tutorial_runner.demo = false;
        map_id = id;
        error.clear();
        viewer.active = false;
        ghosts.handle = 0;
        ghosts.enabled = false;
        ghosts.id.clear();
        reset();
        apply_preferences();
        renderer->set_cosmetics(outfit, packed_loadout);
        renderer->set_ghost_cosmetics(ghost_cosmetic, trail_cosmetic);
        apply_room_mode(room_modes.map_loaded(map_id, room.spectator_target.has_value(), epoch_ms()));
    };
    auto request_map = [&](const std::string &id) {
        if (!opt.runtime_smoke.empty()) throw std::runtime_error("Offline runtime smoke attempted a map download");
        if (download.valid()) throw std::runtime_error("A map is already loading");
        if (!native::valid_map_id(id)) throw std::runtime_error("Invalid map name");
        cancel_prefetch();
        error.clear();
        show_menu(true);
        if (core) bh_record_end(core.get());
        run_event(heartbeat.invalidate());
        // A background still downloading gives way; one already on screen
        // stays until this map has loaded.
        if (backdrop) backdrop->cancel_loading();
        last_requested_map = id;
        map_preparing = false;
        {
            std::lock_guard lock(progress_mutex);
            loading = "Reading " + id;
            load_progress = {{"map", id}, {"stage", "metadata"}, {"message", loading}};
        }
        download.start([&, id](const std::atomic_bool &cancel) {
            const auto lock = lock_cache(cancel);
            return native::download_map(
                    id,
                    cache,
                    [&](const std::string &message) {
                        std::lock_guard lock(progress_mutex);
                        if (!cancel) loading = message;
                    },
                    &cancel,
                    {},
                    [&, id](const native::LoadProgress &p) {
                        std::lock_guard lock(progress_mutex);
                        if (cancel) return;
                        loading = p.message;
                        load_progress = {
                                {"map", id},
                                {"stage", p.stage},
                                {"message", p.message},
                                {"received", p.received},
                                {"total", p.total},
                                {"filesDone", p.filesDone},
                                {"filesTotal", p.filesTotal},
                                {"cached", p.cached},
                                {"offline", p.offline}
                        };
                    }
            );
        });
    };
    auto apply_room_event = [&](const nlohmann::json &message) {
        const auto next = room.event(message);
        room.refresh_display(std::chrono::duration<double>(Clock::now().time_since_epoch()).count());
        room.refresh_spectators(hud.extras);
        if (!room.id.empty()) {
            const bool tainted = practice.active || practice.noclip;
            practice.clear(core.get());
            gauntlet_id.clear();
            gauntlet_map.clear();
            gauntlet_progress = nullptr;
            if (tainted && core) reset();
        }
        apply_room_mode(room_modes.event(message, map_id, room.spectator_target.has_value(), epoch_ms()));
        if (room.id.empty()) pending_room_map.clear();
        if (!next.empty() && native::valid_map_id(next) && next != map_id) {
            if (download.valid())
                pending_room_map = next;
            else {
                active_track = 0;
                request_map(next);
            }
        }
    };
    native::ReplayMetadata replay_metadata;
    // Only clean finishes archived by this host enter its local PB registry.
    // Old/unclassified and deliberately local-only archives remain replayable,
    // but must not silently become a personal best or an attract PB.
    nlohmann::json backdrop_pbs = nlohmann::json::object();
    try {
        if (std::filesystem::exists(cache / "backdrop-pbs.json")
            && std::filesystem::file_size(cache / "backdrop-pbs.json") < 128 * 1024) {
            const auto saved = nlohmann::json::parse(native::read_text(cache / "backdrop-pbs.json"));
            if (saved.is_object()) backdrop_pbs = saved;
        }
    } catch (const std::exception &e) {
        std::cerr << "Backdrop PBs: " << e.what() << '\n';
    }
    auto valid_backdrop_replay = [&](const std::filesystem::path &path, const std::string &map) {
        if (!std::filesystem::is_regular_file(path) || std::filesystem::is_symlink(path)
            || std::filesystem::file_size(path) > 8 * 1024 * 1024)
            throw std::runtime_error("Invalid backdrop replay file");
        const auto info = replay_metadata.read(path);
        if (info.at("map") != map || info.value("style", std::string("autohop")) != "autohop"
            || info.value("track", 0) != 0
            || info.at("endTick").get<uint32_t>() <= info.at("startTick").get<uint32_t>())
            throw std::runtime_error("Backdrop replay is not a completed Normal main-track run of this map");
        return info;
    };
    auto local_backdrop_replay = [&](const std::string &map) -> std::string {
        try {
            if (backdrop_pbs.contains(map)) {
                const auto path =
                        native::replay_file(cache / "replays", backdrop_pbs.at(map).at("id").get<std::string>());
                valid_backdrop_replay(path, map);
                return native::data_location::utf8(path);
            }
        } catch (const std::exception &e) {
            std::cerr << "Local backdrop PB: " << e.what() << '\n';
        }
        return {};
    };
    auto refresh_replays = [&]() {
        replay_library.refresh();
    };
    auto open_replay = [&](const std::filesystem::path &path,
                           const std::string &action,
                           unsigned ghost_slot = 0,
                           bool full_recording = false) {
        if (ghost_slot >= ghosts.slots.size()) throw std::runtime_error("Invalid ghost slot");
        if (action != "ghost") {
            replay_compare.clear();
            replay_compare_import.reset();
        }
        if (!core) throw std::runtime_error("Load the replay map first");
        recorder.input.stop();
        practice.clear(core.get());
        if (tutorial_runner.lesson) tutorial_runner.lesson->stop();
        tutorial_runner.demo = false;
        renderer->reset_presentation();
        scope.reset();
        bh_record_end(core.get());
        run_event(heartbeat.invalidate(native::RunHeartbeat::Reset::start));
        audio.reset();
        if (action == "ghost") {
            ghosts.load(core.get(), path, ghost_slot);
            const auto &slot = ghosts.slots[ghost_slot];
            renderer->register_ghost(ghost_slot, slot.handle, slot.info, ghosts.sources[ghost_slot]);
            if (ghost_slot == 0) {
                ghosts.select_primary();
                hud.extras.ghost(ghosts.info);
            }
            active_track = slot.info.value("track", 0u);
            selected_style = slot.info.value("style", std::string("autohop"));
            reset();
            show_menu(false);
        } else {
            try {
                viewer.session = native::ReplaySession::open(core.get(), path, full_recording);
            } catch (const std::exception &error) {
                reset();
                throw std::runtime_error(std::string("Loading native replay: ") + error.what());
            }
            renderer->set_cosmetics(
                    outfit,
                    viewer.session.info.value("packedLoadout", nlohmann::json()).is_string()
                            ? viewer.session.info.at("packedLoadout").get<std::string>()
                            : std::string()
            );
            viewer.begin(path);
            replay_timeline.request(path, viewer.id);
            recorder.clear(true);
            curr = prev = viewer.session.initial.snapshot.player;
            input.set_angles(viewer.session.initial.view.pitch, viewer.session.initial.view.yaw);
            reset_feedback();
            reset_input_timing();
            show_menu(false);
        }
    };
    auto refresh_playback_pose = [&]() {
        if (core && viewer.active) {
            bh_state(core.get(), &curr);
            prev = curr;
            BhCmd cmd{};
            bh_last_command(core.get(), &cmd);
            input.set_angles(cmd.pitch, cmd.yaw);
            renderer->reset_presentation();
            hud.reset_history();
            audio.reset();
            reset_input_timing();
        }
    };
    auto seek_playback = [&](uint32_t tick) {
        if (!core || !viewer.active) return;
        native::ReplayPose pose;
        try {
            pose = viewer.session.seek(core.get(), tick);
        } catch (const std::exception &failure) {
            reset();
            show_menu(true);
            throw std::runtime_error(std::string("Replay seek stopped: ") + failure.what());
        }
        curr = prev = pose.snapshot.player;
        input.set_angles(pose.view.pitch, pose.view.yaw);
        renderer->reset_presentation();
        scope.reset();
        audio.reset();
        hud.reset_history();
        if (viewer.camera.mode != "free") viewer.camera.reset();
        camera_controls.clear();
        reset_feedback(curr.tick != 0);
        reset_input_timing();
    };
    auto replay_action = [&](native::ReplayControls::Action action) {
        viewer.action(action, curr.tick, camera_controls);
    };
    video.bind(
            {gl, game, hud, viewer, curr, preferences, active_style, outfit, assets, cache, opt, audio, download},
            show_menu,
            refresh_playback_pose
    );
    menu_smoke.bind(
            {window.get(),
             game,
             curr,
             menu,
             backdrop,
             backdrop_source,
             backdrop_shown,
             backdrop_png,
             gameplay_backdrop_due,
             menu_ready,
             download,
             error,
             running}
    );
    auto request_video = std::bind_front(&native::VideoController::request, &video);
    auto request_replay = [&](const std::filesystem::path &path,
                              const std::string &action,
                              unsigned ghost_slot = 0,
                              bool full_recording = false) {
        if (ghost_slot >= ghosts.slots.size()) throw std::runtime_error("Invalid ghost slot");
        const auto info = replay_metadata.read(path);
        const auto id = info.at("map").get<std::string>();
        if (!native::valid_map_id(id)) throw std::runtime_error("Replay has invalid map name");
        if (map_id != id || !core) {
            pending_replay = native::data_location::utf8(path);
            pending_action = action;
            pending_ghost_slot = ghost_slot;
            pending_full_recording = full_recording;
            request_map(id);
        } else {
            open_replay(path, action, ghost_slot, full_recording);
        }
    };
    start_tutorial = [&](const std::string &lesson, bool demo) {
        if (!core || map_id != native::TutorialRunner::map_id || !tutorial_runner.lesson)
            throw std::runtime_error("Load the tutorial map before starting a lesson");
        tutorial_runner.start(lesson, core.get(), ghosts);
        active_track = lesson == "final" ? 1 : 0;
        reset();
        tutorial_runner.set_keys(input_timeline.binds());
        score_notice.clear();
        if (demo) {
            tutorial_runner.load_demo(core.get(), assets, active_style, ghosts);
            renderer->register_ghost(0, ghosts.handle, ghosts.info);
            hud.extras.ghost(ghosts.info);
            tutorial_runner.begin_demo(lesson, curr.tick, ghosts);
        }
        std::cout << "Native tutorial " << lesson << (demo ? " demonstration" : " lesson")
                  << (lesson == "final" ? "; ranked final course\n" : "; ranked recording disabled\n");
        show_menu(false);
    };
    auto gauntlet_action = [&](const nlohmann::json &message) {
        const auto id = message.at("id").is_null() ? std::string() : message.at("id").get<std::string>();
        if (id.size() > 128) throw std::runtime_error("Invalid gauntlet id");
        const auto map = message.value("map", std::string());
        if (!map.empty() && !native::valid_map_id(map)) throw std::runtime_error("Invalid gauntlet map");
        const auto progress = message.value("progress", nlohmann::json(nullptr));
        if (!progress.is_null()) {
            if (!progress.is_object()) throw std::runtime_error("Invalid gauntlet progress");
            const auto idx = progress.at("idx").get<unsigned>(), maps = progress.at("maps").get<unsigned>();
            const auto before = progress.at("before").get<double>();
            if (!maps || maps > 1000 || idx >= maps || !std::isfinite(before) || before < 0)
                throw std::runtime_error("Invalid gauntlet progress");
            if (!progress.at("pbSplit").is_null()) {
                const auto pb = progress.at("pbSplit").get<double>();
                if (!std::isfinite(pb) || pb < 0) throw std::runtime_error("Invalid gauntlet split");
            }
        }
        const bool restart = !id.empty() && core
                             && (practice.active || viewer.active || active_style != "autohop" || active_track != 0);
        gauntlet_id = id;
        gauntlet_map = id.empty() ? std::string() : map;
        gauntlet_progress = id.empty() ? nlohmann::json(nullptr) : progress;
        if (!id.empty()) {
            third_person = false;
            practice.clear(core.get());
            selected_style = "autohop";
            active_track = 0;
            if (restart) reset();
        }
    };
    uint32_t last_slot = 3, observed_slot = 3;
    auto held_action = [&](const std::string &action) {
        return input_timeline.binds().held_action(action, held_codes);
    };
    auto weapon_context = [&]() {
        return native::WeaponMenuContext{
                settings.physics,
                practice.active || zones.empty(),
                viewer.active,
                room.spectator_target.has_value(),
                practice.noclip
        };
    };
    auto act = native::RecoverableAction(
            [&](const std::string &action, bool wheel = false, bool instant = false) {
                if (action == "chat" || action == "commandChat") {
                    open_chat(action == "commandChat");
                    return;
                }
                if (action == "scoreboard") return;
                if (action == "spectatorNext" || action == "spectatorPrevious") {
                    room_control({{"action", action == "spectatorNext" ? "next" : "previous"}});
                    return;
                }
                if (action == "spectatorMode") {
                    if (room.spectator_target) third_person = !third_person;
                    return;
                }
                if (action == "thirdPerson") {
                    if (viewer.active) {
                        viewer.camera.set_mode(viewer.camera.mode == "eye" ? "chase" : "eye");
                        return;
                    }
                    if (room.spectator_target) {
                        third_person = !third_person;
                        return;
                    }
                    if (!core) return;
                    BhRunState timing{};
                    bh_run_state(core.get(), &timing);
                    if (!third_person && !gauntlet_id.empty()) {
                        toast("No third person during a gauntlet.");
                        return;
                    }
                    if (!third_person && timing.status == 1 && !practice.active && !turn_admission.local_only
                        && !zones.empty()) {
                        toast("No third person during a timed run.");
                        return;
                    }
                    third_person = !third_person;
                    if (third_person) {
                        practice_use("camera");
                        toast("Third person. This run is practice.");
                    } else {
                        if (timing.status == 0 && practice.tool == "camera" && !practice.mode) reset();
                        toast("First person");
                    }
                    return;
                }
                if (action == "flashlight") {
                    native::toggle_graphics_flashlight(preferences, flashlight);
                    menu_state.settings_changed();
                    json_writer.write(cache / "settings.json", preferences);
                    return;
                }
                if (action == "nextTrack") {
                    audio.music_control("next");
                    return;
                }
                if (action == "hudEditor") {
                    show_menu(true);
                    if (!menu) toast(native::menu_unavailable_text(menu_failure), 6000);
                    menu_script.open(
                            menu.get(), menu_ready, "window.bunnyhopNativeMenu?.open?.('settings','hud-editor')"
                    );
                    return;
                }
                if (action == "gunMenu") {
                    gun_menu.toggle();
                    return;
                }
                if (action == "showTriggers" || action == "showClips") {
                    const char *key = action == "showTriggers" ? "triggersVisible" : "clipsVisible";
                    const bool on = !preferences.at(key).get<bool>();
                    preferences[key] = on;
                    menu_state.settings_changed();
                    json_writer.write(cache / "settings.json", preferences);
                    apply_preferences();
                    toast(std::string(action == "showTriggers" ? "Triggers" : "Player clips")
                          + (on ? " shown" : " hidden"));
                    return;
                }
                if (action == "keysOverlay") {
                    preferences["keysOverlay"] = !preferences.at("keysOverlay").get<bool>();
                    menu_state.settings_changed();
                    json_writer.write(cache / "settings.json", preferences);
                    apply_preferences();
                    return;
                }
                if (action == "viewmodel" || action == "hideUi" || action == "mute") {
                    const std::string key = action == "hideUi" ? "hud" : action == "mute" ? "muted" : "viewmodel";
                    preferences[key] = !preferences[key].get<bool>();
                    menu_state.settings_changed();
                    json_writer.write(cache / "settings.json", preferences);
                    apply_preferences();
                    return;
                }
                if (action == "mainMenu") {
                    BhRunState timing{};
                    if (core) bh_run_state(core.get(), &timing);
                    const auto result = leave_hold.press(
                            epoch_ms(),
                            !viewer.active
                                    && native::leave_requires_confirmation(
                                            timing.status, room.spectator_target.has_value()
                                    ),
                            !wheel
                    );
                    if (result == native::LeaveHold::Result::leave)
                        leave_map();
                    else if (result == native::LeaveHold::Result::ask)
                        toast("Main menu key again to leave");
                    return;
                }
                if (viewer.active) return;
                if (action == "setStart" || action == "clearStart") {
                    if (!core) return;
                    if (action == "clearStart") {
                        start_points.clear(map_id, active_track);
                        toast("Start point cleared");
                    } else {
                        if (tutorial_runner.lesson && tutorial_runner.lesson->is_active()) {
                            toast("Start points are unavailable in tutorial lessons");
                            return;
                        }
                        const auto problem = native::start_point_problem(curr, practice.noclip);
                        if (!problem.empty()) {
                            toast(problem);
                            return;
                        }
                        const bool practice_spawn =
                                practice.active || !native::start_point_in_zone(curr, zones, active_track);
                        start_points.save(map_id, active_track, curr, input.yaw(), input.pitch, practice_spawn);
                        toast(practice.active
                                      ? "Spawn saved. Restarts stay practice because this attempt used practice. "
                                        "!clearstart undoes it."
                              : native::start_point_in_zone(curr, zones, active_track)
                                      ? "Start point saved"
                                      : "Start point saved outside the start zone: runs from it are practice, and the "
                                        "timer "
                                        "starts only from the start zone",
                              native::start_point_in_zone(curr, zones, active_track) ? 3000u : 5000u);
                    }
                    json_writer.write(cache / "start-points.json", start_points.points);
                    return;
                }
                if (action == "nextWeapon" || action == "prevWeapon") {
                    BhWeaponReport weapon{};
                    if (core && bh_weapon_report(core.get(), &weapon)) {
                        const uint32_t slot = weapon.active == weapon.primary && weapon.primary       ? 1
                                              : weapon.active == weapon.secondary && weapon.secondary ? 2
                                                                                                      : 3;
                        uint32_t next = slot;
                        for (int i = 0; i < 3; i++) {
                            next = action == "nextWeapon" ? next % 3 + 1 : (next + 1) % 3 + 1;
                            if (next == 3 || (next == 1 && weapon.primary) || (next == 2 && weapon.secondary)) break;
                        }
                        input.pulse = (input.pulse & ~(3u << 14)) | (next << 14);
                    }
                    return;
                }
                if (!instant && (action == "restart" || action == "restartMain" || action == "restartBonus")) {
                    BhRunState timing{};
                    if (core) bh_run_state(core.get(), &timing);
                    if (!restart_guard.press(action, epoch_ms(), prefs.hold_restart, timing.status == 1, wheel)) return;
                }
                if (action == "practice" || action == "noclip" || action == "cpSave" || action == "cpTeleport"
                    || action == "cpPrev" || action == "cpNext") {
                    practice_action(
                            action == "practice"     ? "toggle"
                            : action == "cpSave"     ? "save"
                            : action == "cpTeleport" ? "tele"
                            : action == "cpPrev"     ? "prev"
                            : action == "cpNext"     ? "next"
                                                     : "noclip",
                            true
                    );
                    return;
                }

                if (!gauntlet_id.empty() && (action == "restartBonus" || action == "cycleStyle")) {
                    toast("Gauntlets are Normal style on the main track.");
                    return;
                }
                if (action == "restart" || action == "restartMain") {
                    if (tutorial_runner.lesson && tutorial_runner.lesson->is_active())
                        start_tutorial(tutorial_runner.lesson->lesson_id(), tutorial_runner.demo);
                    else {
                        if (action == "restartMain") active_track = 0;
                        reset();
                    }
                } else if (action == "restartBonus") {
                    std::set<uint32_t> tracks;
                    for (const auto &z : zones)
                        if (z.kind == 0 && z.track) tracks.insert(z.track);
                    if (!tracks.empty()) {
                        auto next = tracks.upper_bound(active_track);
                        active_track = next == tracks.end() ? *tracks.begin() : *next;
                        reset();
                    }
                } else if (action == "cycleStyle") {
                    static const std::vector<std::string> order = {
                            "autohop", "legit", "scroll", "wonly", "sideways", "hsw", "lowgrav", "autostrafe"
                    };
                    auto at = std::find(order.begin(), order.end(), selected_style);
                    selected_style = order[(size_t(at - order.begin()) + 1) % order.size()];
                    reset();
                } else if (action == "slot1" || action == "slot2" || action == "slot3")
                    input.pulse = (input.pulse & ~(3u << 14)) | (uint32_t(action.back() - '0') << 14);
                else if (action == "lastWeapon")
                    input.pulse = (input.pulse & ~(3u << 14)) | (last_slot << 14);
                else if (action == "inspect") {
                    if (renderer) renderer->inspect_press();
                    if (core) bh_record_inspect(core.get(), 1);
                } else if (action == "drop")
                    input.pulse |= 1u << 12;
                else if (action == "reload")
                    input.pulse |= 1u << 13;
                else if (action == "giveUsp" || action == "giveGlock") {
                    kept_weapons.cancel();
                    input.pulse = (input.pulse & ~native::weapon_command_mask)
                                  | ((action == "giveUsp" ? 3u : 2u) << native::give_shift);
                }
            },
            toast
    );
    auto handle_code = native::RecoverableAction(
            [&](const std::string &code, bool down, bool repeat = false, bool wheel = false, uint64_t stamp = 0) {
                if (code.empty()) return;
                if (down && !repeat)
                    for (const char *action : {"chat", "commandChat"})
                        for (const auto &key : input_timeline.binds().codes(action))
                            if (key == code) {
                                open_chat(std::string(action) == "commandChat");
                                return;
                            }
                if (const auto action = trigger_menu.key(code, down, repeat)) {
                    if (!action->empty()) act(std::string(*action));
                    return;
                }
                if (gun_menu.open && down && !repeat && code.size() == 6 && code.starts_with("Digit")) {
                    const auto picked = gun_menu.key(code.back() - '0', weapon_context());
                    if (!picked.refusal.empty()) toast(picked.refusal);
                    if (picked.weapon) {
                        kept_weapons.cancel();
                        input.pulse =
                                (input.pulse & ~native::weapon_command_mask) | (*picked.weapon << native::give_shift);
                    }
                    if (picked.handled) return;
                }
                if (native::handle_race_key(
                            code, down, repeat, room_modes, race_picker, menu_script, menu.get(), menu_ready
                    ))
                    return;
                if (!practice.menu_open && !room.vote.is_null() && down && !repeat && code.size() == 6
                    && code.starts_with("Digit")) {
                    const int pick = code.back() - '0';
                    if (pick > 0 && room.vote.contains("options") && size_t(pick) <= room.vote.at("options").size()) {
                        room.voted(pick - 1);
                        room_control({{"action", "vote"}, {"option", pick - 1}});
                        return;
                    }
                }
                if (practice.menu_open && down && !repeat && code.size() == 6 && code.starts_with("Digit")) {
                    const int pick = code.back() - '0';
                    if (pick == 0) {
                        practice.menu_open = false;
                        return;
                    }
                    if (pick >= 1 && pick <= 6) {
                        if ((pick == 3 && practice.number() <= 1)
                            || (pick == 4 && practice.number() >= practice.checkpoints.size()))
                            return;
                        const char *actions[] = {"save", "tele", "prev", "next", "noclip", "keepVelocity"};
                        practice_action(actions[pick - 1]);
                        return;
                    }
                }
                if (!wheel) input.null_presses.edge(code, input_timeline.binds().of(code), down);
                input_timeline.key(held_codes, code, down, wheel, stamp, SDL_GetTicksNS());
                input.held = 0;
                const auto bindings = input_timeline.binds().snapshot();
                for (const auto &binding : *bindings) {
                    const auto bit = binding.bit;
                    bool matching = false, held = false;
                    for (const auto &raw : binding.codes) {
                        const auto &key = raw;
                        matching |= key == code || (wheel && key == "MouseWheel");
                        held |= held_codes.contains(key);
                    }
                    if (bit) {
                        if (bit == native::attack2 && matching && down && !repeat && core && !viewer.active
                            && !room.spectator_target) {
                            BhWeaponReport weapon{};
                            if (bh_weapon_report(core.get(), &weapon)) scope.secondary(weapon.active);
                        }
                        if (wheel && matching && down)
                            input.pulse |= bit;
                        else if (held)
                            input.held |= bit;
                    } else if (matching && down && !repeat)
                        act(binding.action, wheel);
                }
                if (renderer)
                    native_render::surface_tool_key(
                            *renderer, code, down, repeat, curr, input, !viewer.active && !room.spectator_target, toast
                    );
                if (wheel) held_codes.erase(code);
                const bool inspect = input_timeline.binds().held_action("inspect", held_codes);
                if (renderer) renderer->inspect_held(inspect);
                if (core && input_timeline.binds().is_bound("inspect", code))
                    bh_record_inspect(core.get(), down ? 3 : 4);
            },
            toast
    );
    refresh_replays();
    if (!opt.map.empty()) {
        nlohmann::json detail;
        const auto sidecar = native::data_location::from_utf8(opt.map).replace_extension(".zones.json");
        if (std::filesystem::exists(sidecar)) detail["zones"] = nlohmann::json::parse(native::read_text(sidecar));
        load_map(
                opt.map,
                opt.content_root,
                native::data_location::utf8(native::data_location::from_utf8(opt.map).stem()),
                detail
        );
    }
    if (!opt.online_map.empty()) request_map(opt.online_map);
    if (tutorial_runner.lesson) {
        const auto lesson = pending_tutorial.empty() ? "jump" : pending_tutorial;
        start_tutorial(lesson, pending_tutorial_demo);
        pending_tutorial.clear();
    }
    if (menu)
        show_menu(true);
    else if (!opt.hidden)
        capture(true);
    if (!opt.replay.empty() && opt.runtime_smoke.empty()) request_replay(data_location::from_utf8(opt.replay), "play");
    if (!opt.runtime_smoke.empty()) {
        return native::RuntimeSmoke(
                       {opt,
                        core,
                        renderer,
                        menu,
                        gl,
                        hud,
                        window.get(),
                        input,
                        curr,
                        prev,
                        practice,
                        third_person,
                        map_id,
                        active_style,
                        selected_style,
                        active_track,
                        gauntlet_id,
                        viewer,
                        leave_hold,
                        download,
                        progress_mutex,
                        loading,
                        heartbeat,
                        room,
                        zones,
                        pending_replay,
                        pending_action,
                        pending_room_map,
                        pending_tutorial,
                        dt},
                       {load_map,
                        practice_reason,
                        act,
                        reset,
                        practice_action,
                        gauntlet_action,
                        open_replay,
                        seek_playback,
                        leave_map,
                        apply_room_event}
        )
                .run();
    }
    auto title_time = Clock::now(), ui_time = title_time, started = title_time;
    uint64_t frame = 0, title_frames = 0;
    // BUNNYHOP_INPUT_LOG=path writes one line per tick: what that tick got from
    // the mouse and keyboard, and the frame it ran in. Off unless asked for.
    std::ofstream input_log;
    uint64_t input_frame = 0;
    if (const char *log_path = std::getenv("BUNNYHOP_INPUT_LOG"); log_path && *log_path) {
        input_log.open(log_path, std::ios::trunc);
        if (input_log)
            input_log << "tick,frame,frame_ms,sim_ms,counts,pending,keys,speed,grounded,jumped\n";
        else
            std::cerr << "Could not open BUNNYHOP_INPUT_LOG\n";
    }
    double input_frame_ms = 0;
    native::MouseDiagnostics mouse_diagnostics;
    room_bridge.bind_presence(opt, menu.get(), menu_ready, show_menu);
    auto &discord = room_bridge.discord;
    const bool discord_allowed = room_bridge.discord_allowed;
    if (!opt.presentation_smoke.empty()) {
        return native::run_presentation_smoke(opt, window.get(), gl, game, hud);
    }
    native::VideoSmoke video_smoke(
            {opt, game, viewer, curr, prev, camera_controls, preferences}, refresh_playback_pose
    );
    video_smoke.begin();
    while (running) {
        const auto frame_started = Clock::now();
        frame_diagnostics.start_frame(SDL_GetTicksNS(), prefs.mouse_diagnostics);
        recorder.diagnostics.frame(SDL_GetTicksNS(), input_timeline.queue());
        if (const auto failure = json_writer.take_error()) {
            std::cerr << "Could not save " << *failure << '\n';
            toast("Could not save " + *failure);
        }
        if (window_dirty && Clock::now() >= window_save_due) save_window();
        video.poll_probe();
        const uint64_t mouse_pump_start = SDL_GetTicksNS();
        const double pump_tick_seconds = viewer.active ? viewer.session.range.tick_interval : dt;
        const uint64_t pump_tick_ns = uint64_t(std::llround(pump_tick_seconds * 1e9));
        auto pump_schedule = input_scheduler;
        pump_schedule.frame(mouse_pump_start, true, pump_tick_ns);
        input_timeline.begin_pump(input, mouse_pump_start, pump_schedule, pump_tick_ns);
        mouse_diagnostics.begin(
                mouse_pump_start, prefs.mouse_diagnostics && captured && focused && !chat.active && !viewer.active
        );
        bool had_input_activity = false;
        SDL_Event event;
        while (SDL_PollEvent(&event)) {
            if (event.type == SDL_EVENT_KEY_DOWN || event.type == SDL_EVENT_MOUSE_BUTTON_DOWN
                || event.type == SDL_EVENT_MOUSE_MOTION || event.type == SDL_EVENT_MOUSE_WHEEL
                || event.type == SDL_EVENT_TEXT_INPUT)
                had_input_activity = true;
            switch (event.type) {
                case SDL_EVENT_QUIT:
                    running = false;
                    break;
                case SDL_EVENT_WINDOW_CLOSE_REQUESTED:
                    if (event.window.windowID == SDL_GetWindowID(window.get())) running = false;
                    break;
                case SDL_EVENT_WINDOW_MOVED:
                case SDL_EVENT_WINDOW_RESIZED:
                case SDL_EVENT_WINDOW_MAXIMIZED:
                case SDL_EVENT_WINDOW_RESTORED:
                    if (event.type == SDL_EVENT_WINDOW_RESTORED) window_modes.resumed(preferences);
                    if (event.window.windowID == SDL_GetWindowID(window.get())) {
                        window_dirty = true;
                        window_save_due = Clock::now() + std::chrono::milliseconds(500);
                    }
                    break;
                case SDL_EVENT_WINDOW_FOCUS_LOST:
                    ++frame_diagnostics.focus_losses;
                    if (!menu || !menu->visible()) window_controller.focus_lost(preferences);
                    focused = false;
                    audio.focus(false);
                    window_modes.focus_lost(SDL_GetWindowFlags(window.get()) & SDL_WINDOW_MINIMIZED);
                    show_menu(true, true);
                    break;
                case SDL_EVENT_WINDOW_FOCUS_GAINED:
                    audio.focus(true);
                    focused = true;
                    window_modes.resumed(preferences);
                    // Keyboard focus back to the open menu.
                    if (menu && menu->visible()) menu->set_visible(true);
                    if (resume_wanted && (!menu || !menu->visible()))
                        capture(!(viewer.active && viewer.controls.visible));
                    break;
                case SDL_EVENT_WINDOW_MINIMIZED:
                    window_modes.minimized();
                    break;
                case SDL_EVENT_WINDOW_DISPLAY_CHANGED:
                case SDL_EVENT_WINDOW_DISPLAY_SCALE_CHANGED:
                case SDL_EVENT_DISPLAY_CURRENT_MODE_CHANGED:
                case SDL_EVENT_DISPLAY_ADDED:
                case SDL_EVENT_DISPLAY_REMOVED:
                    window_modes.display_changed();
                    break;
                case SDL_EVENT_KEY_DOWN:
                case SDL_EVENT_KEY_UP: {
                    const bool down = event.type == SDL_EVENT_KEY_DOWN;
                    const bool menu_shown = menu && menu->visible();
                    const auto routed = input_timeline.key_event(
                            event.key.scancode,
                            down,
                            event.key.repeat,
                            native::game_owns_keyboard(menu_shown, menu && menu->supports_backdrop())
                    );
                    if (!routed) break;
                    const bool repeat = *routed;
                    if (down && !repeat && event.key.scancode == SDL_SCANCODE_F10) {
                        show_menu(true);
                        if (!menu) toast(native::menu_unavailable_text(menu_failure), 6000);
                        menu_script.open(
                                menu.get(), menu_ready, "window.bunnyhopNativeMenu?.open?.('settings','display')"
                        );
                        break;
                    }
                    if (down && !repeat && event.key.scancode == SDL_SCANCODE_RETURN
                        && (event.key.mod & SDL_KMOD_ALT)) {
                        save_window();
                        if (!(video_capture || director_job || video_encoder.busy())) {
                            if (auto changed = window_modes.toggle(preferences)) {
                                preferences = std::move(*changed);
                                menu_state.settings_changed();
                                json_writer.write(cache / "settings.json", preferences);
                            } else {
                                error = window_controller.error();
                            }
                        }
                        break;
                    }
                    if (video_capture || director_job || video_encoder.busy()) {
                        if (down && event.key.scancode == SDL_SCANCODE_ESCAPE) {
                            cancel_video();
                            refresh_playback_pose();
                        }
                        break;
                    }
                    if (chat.active) {
                        if (down) {
                            if (!chat.composition.empty()) {
                                if (event.key.scancode == SDL_SCANCODE_ESCAPE) {
                                    SDL_ClearComposition(window.get());
                                    chat.composition.clear();
                                }
                                break;
                            }
                            const bool shortcut = (event.key.mod & (SDL_KMOD_CTRL | SDL_KMOD_GUI)) != 0;
                            const bool extend = (event.key.mod & SDL_KMOD_SHIFT) != 0;
                            if (event.key.scancode == SDL_SCANCODE_ESCAPE)
                                close_chat();
                            else if (event.key.scancode == SDL_SCANCODE_RETURN
                                     || event.key.scancode == SDL_SCANCODE_KP_ENTER) {
                                if (chat.composition.empty()) {
                                    const auto text = chat.submit();
                                    close_chat();
                                    if (native::race_menu_command(text)) {
                                        race_picker.open(room.display(), zones);
                                        if (!race_picker.count) toast("No other players to race.");
                                    } else if (!text.empty() && menu && menu_ready)
                                        menu->evaluate_js(
                                                "window.bunnyhopNativeMenu?.onChatSubmit?.("
                                                + nlohmann::json(text).dump() + ")"
                                        );
                                }
                            } else if (shortcut && event.key.scancode == SDL_SCANCODE_V) {
                                char *text = SDL_GetClipboardText();
                                if (text) {
                                    chat.insert(text);
                                    SDL_free(text);
                                    chat_suggest();
                                }
                            } else if (shortcut && event.key.scancode == SDL_SCANCODE_C)
                                SDL_SetClipboardText(chat.selected_text().c_str());
                            else if (shortcut && event.key.scancode == SDL_SCANCODE_X) {
                                const auto selected = chat.selected_text();
                                if (!selected.empty()) {
                                    SDL_SetClipboardText(selected.c_str());
                                    chat.erase();
                                    chat_suggest();
                                }
                            } else if (shortcut && event.key.scancode == SDL_SCANCODE_A)
                                chat.select_all();
                            else if (event.key.scancode == SDL_SCANCODE_BACKSPACE) {
                                chat.backspace();
                                chat_suggest();
                            } else if (event.key.scancode == SDL_SCANCODE_DELETE) {
                                chat.erase();
                                chat_suggest();
                            } else if (event.key.scancode == SDL_SCANCODE_LEFT)
                                chat.visual_move(false, hud.chat_carets(chat.input), extend);
                            else if (event.key.scancode == SDL_SCANCODE_RIGHT)
                                chat.visual_move(true, hud.chat_carets(chat.input), extend);
                            else if (event.key.scancode == SDL_SCANCODE_HOME)
                                chat.home(extend);
                            else if (event.key.scancode == SDL_SCANCODE_END) {
                                chat.end(extend);
                                chat.scroll_bottom();
                            } else if (event.key.scancode == SDL_SCANCODE_PAGEUP)
                                chat.scroll(8);
                            else if (event.key.scancode == SDL_SCANCODE_PAGEDOWN)
                                chat.scroll(-8);
                            else if (event.key.scancode == SDL_SCANCODE_UP) {
                                chat.history_step(-1);
                                chat_suggest();
                            } else if (event.key.scancode == SDL_SCANCODE_DOWN) {
                                chat.history_step(1);
                                chat_suggest();
                            } else if (event.key.scancode == SDL_SCANCODE_TAB) {
                                chat.complete();
                                chat_suggest();
                            }
                        }
                        break;
                    }
                    if (viewer.active && !menu_shown && event.key.scancode == SDL_SCANCODE_TAB) {
                        if (viewer.controls.toggle_from_key(down, repeat)) {
                            capture(!viewer.controls.visible);
                        }
                        break;
                    }
                    if (down && !repeat) {
                        if (viewer.active && (!menu || !menu->visible()) && event.key.scancode == SDL_SCANCODE_SPACE) {
                            replay_action(native::ReplayControls::Action::pause);
                            break;
                        }
                        if (viewer.active && !menu_shown
                            && (event.key.scancode == SDL_SCANCODE_LEFT || event.key.scancode == SDL_SCANCODE_RIGHT)) {
                            viewer.paused = true;
                            const uint32_t target = event.key.scancode == SDL_SCANCODE_LEFT
                                                            ? (curr.tick ? curr.tick - 1 : 0)
                                                            : curr.tick + 1;
                            viewer.controls.pending = viewer.session.range.clamp(target);
                            break;
                        }
                        if (event.key.scancode == SDL_SCANCODE_ESCAPE) show_menu(!menu || !menu->visible());
                    }
                    if (captured) {
                        const auto code = native::key_code(event.key.scancode);
                        handle_code(code, down, repeat, false, event.key.timestamp);
                    }
                    break;
                }
                case SDL_EVENT_TEXT_INPUT:
                    if (chat.active) {
                        chat.insert(event.text.text);
                        chat_suggest();
                    }
                    break;
                case SDL_EVENT_TEXT_EDITING:
                    if (chat.active) chat.composition = native::Chat::clean(event.edit.text, 512);
                    break;
                case SDL_EVENT_MOUSE_MOTION: {
                    const uint64_t received = SDL_GetTicksNS();
                    if (captured && focused && !chat.active && !viewer.active && !room.spectator_target) {
                        recorder.diagnostics.motion(
                                event.motion.timestamp, received, event.motion.xrel, event.motion.yrel
                        );
                    }
                    if (mouse_diagnostics.active && captured && focused && !chat.active) {
                        mouse_diagnostics.motion(event.motion.timestamp, received);
                    }
                    if (video_capture || director_job || video_encoder.busy()) {
                        viewer.controls.dragging = false;
                        viewer.orbit_drag = false;
                        break;
                    }
                    if (viewer.active && viewer.controls.dragging && !chat.active && (!menu || !menu->visible())) {
                        int width = 0;
                        int height = 0;
                        SDL_GetWindowSizeInPixels(window.get(), &width, &height);
                        const auto geometry = native::HudGeometry(width, height, 100);
                        const float x = event.motion.x * SDL_GetWindowPixelDensity(window.get()) / geometry.scale;
                        viewer.controls.motion(
                                native::ReplayControls::layout(geometry.width, geometry.height),
                                x,
                                viewer.session.range.to
                        );
                        break;
                    }
                    if (chat.active && chat_drag) {
                        const float scale = SDL_GetWindowPixelDensity(window.get());
                        if (const auto byte =
                                    hud.chat_input_byte(event.motion.x * scale, event.motion.y * scale, chat.input))
                            chat.position(*byte, true);
                    }
                    if (captured && focused && !chat.active) {
                        if (viewer.active && viewer.camera.mode == "free")
                            camera_controls.accumulate(event.motion.xrel, event.motion.yrel);
                        else if (viewer.active && viewer.camera.mode == "chase")
                            viewer.camera.orbit(event.motion.xrel, event.motion.yrel);
                        else if (!viewer.active) {
                            const auto &motion = event.motion;
                            input_timeline.motion(input, motion.timestamp, received, motion.xrel, motion.yrel);
                        }
                    }
                    break;
                }
                case SDL_EVENT_MOUSE_BUTTON_DOWN:
                case SDL_EVENT_MOUSE_BUTTON_UP: {
                    if (video_capture || director_job || video_encoder.busy()) {
                        viewer.controls.dragging = false;
                        viewer.orbit_drag = false;
                        break;
                    }
                    const bool down = event.type == SDL_EVENT_MOUSE_BUTTON_DOWN;
                    if (viewer.active && !chat.active && (!menu || !menu->visible())
                        && event.button.button == SDL_BUTTON_RIGHT && (viewer.controls.visible || viewer.orbit_drag)) {
                        viewer.orbit_drag = down;
                        capture(down);
                        break;
                    }
                    if (viewer.active && viewer.controls.visible && !chat.active && (!menu || !menu->visible())
                        && event.button.button == SDL_BUTTON_LEFT) {
                        int width = 0;
                        int height = 0;
                        SDL_GetWindowSizeInPixels(window.get(), &width, &height);
                        const auto geometry = native::HudGeometry(width, height, 100);
                        const float scale = SDL_GetWindowPixelDensity(window.get()) / geometry.scale;
                        replay_action(viewer.controls.pointer(
                                native::ReplayControls::layout(geometry.width, geometry.height),
                                event.button.x * scale,
                                event.button.y * scale,
                                viewer.session.range.to,
                                down
                        ));
                        break;
                    }
                    if (chat.active) {
                        if (event.button.button == SDL_BUTTON_LEFT) {
                            chat_drag = false;
                            if (down && chat.composition.empty()) {
                                const float scale = SDL_GetWindowPixelDensity(window.get()), x = event.button.x * scale,
                                            y = event.button.y * scale;
                                if (const auto byte = hud.chat_input_byte(x, y, chat.input)) {
                                    chat.position(*byte, (SDL_GetModState() & SDL_KMOD_SHIFT) != 0);
                                    chat_drag = true;
                                } else if (const auto target = hud.chat_hit(x, y, chat.viewport(epoch_ms() / 1000.))) {
                                    close_chat();
                                    show_menu(true);
                                    if (menu && menu_ready)
                                        menu->evaluate_js(
                                                "window.bunnyhopNativeMenu?.onChatLink?.("
                                                + nlohmann::json(target->url).dump() + ")"
                                        );
                                }
                            }
                        }
                        break;
                    }
                    if (!captured && down && focused && (!menu || !menu->visible()) && core) {
                        capture(true);
                        break;
                    }
                    if (captured && !chat.active) {
                        const auto code = native::mouse_code(event.button.button);
                        const bool custom = input_timeline.binds().custom_mouse_binding(code);
                        if (!custom && room.spectator_target && down
                            && (event.button.button == SDL_BUTTON_LEFT || event.button.button == SDL_BUTTON_RIGHT))
                            room_control({{"action", event.button.button == SDL_BUTTON_LEFT ? "next" : "previous"}});
                        else if (!custom && room.spectator_target && down && event.button.button == SDL_BUTTON_MIDDLE)
                            third_person = !third_person;
                        else {
                            const auto code = native::mouse_code(event.button.button);
                            handle_code(code, down, false, false, event.button.timestamp);
                        }
                    }
                    break;
                }
                case SDL_EVENT_MOUSE_WHEEL:
                    if (chat.active) {
                        chat.scroll(event.wheel.y > 0 ? 3 : event.wheel.y < 0 ? -3 : 0);
                        break;
                    }
                    if (captured && viewer.active && viewer.camera.mode == "chase" && event.wheel.y != 0) {
                        viewer.camera.zoom_by(std::pow(1.12, -event.wheel.y));
                        break;
                    }
                    if (captured && !chat.active && event.wheel.y != 0)
                        handle_code(event.wheel.y > 0 ? "MWheelUp" : "MWheelDown", true, false, true);
                    break;
                default:
                    break;
            }
        }
        mouse_diagnostics.end(SDL_GetTicksNS(), mouse_pump_start);
        frame_diagnostics.mark(native::FrameDiagnostics::kPump, SDL_GetTicksNS());
        if (had_input_activity) activity.input(std::chrono::duration<double>(Clock::now().time_since_epoch()).count());
        if (menu)
            for (const auto &raw : menu->drain_messages()) {
                try {
                    if (raw.size() > 12 * 1024 * 1024) throw std::runtime_error("Menu command too large");
                    auto message = nlohmann::json::parse(raw);
                    const auto type = message.at("type").get<std::string>();
                    if (type == "loadoutPreview") {
                        if (menu->visible() && raw.size() <= 8192) preview_request = std::move(message);
                        continue;
                    }
                    if (type == "practiceFromReplay" && (video_capture || director_job || video_encoder.busy())) {
                        menu->evaluate_js(
                                "window.bunnyhopNativeMenu?.onPracticeFromReplayResult?.("
                                + native::practice_from_replay_reply(
                                          false, "Finish or cancel video export before continuing as practice."
                                )
                                          .dump()
                                + ")"
                        );
                        continue;
                    }
                    if ((video_capture || director_job || video_encoder.busy()) && type != "videoExport"
                        && type != "ready" && type != "update" && type != "audioCue" && type != "music"
                        && type != "quit") {
                        if (type == "settings")
                            throw std::runtime_error("Finish or cancel video export before changing settings.");
                        continue;
                    }
                    const size_t limit = native::render_menu_message_limit(
                            type, native::hud_message_limit(type, native::menu_message_limit(type))
                    );
                    if (raw.size() > limit) throw std::runtime_error("Menu command exceeds its type limit");
                    if (type == "ready") {
                        menu_ready = true;
                        menu_state.reset();
                        backdrop_shown.clear();
                        backdrop_failed.clear();
                        backdrop_cut = false;
                        gameplay_backdrop_due = bool(core);
                        run_event({{"type", "reset"}});
                        std::cout << "Native menu ready: " << raw << '\n';
                        menu_script.ready(menu.get());
                        menu_files.menu_ready();
                    } else if (type == "resume" && core && !download.valid())
                        show_menu(false);
                    else if (type == "prefetchMap") {
                        if (message.at("map").is_null()) {
                            cancel_prefetch();
                            continue;
                        }
                        const auto map = message.at("map").get<std::string>(),
                                   sha = message.at("sha").get<std::string>();
                        if (!native::valid_map_id(map) || sha.size() != 64
                            || sha.find_first_not_of("0123456789abcdef") != std::string::npos)
                            throw std::runtime_error("Invalid map prefetch");
                        if (!opt.runtime_smoke.empty() || opt.frames || (!viewer.active && pending_action != "play"))
                            continue;
                        const auto key = map + ":" + sha;
                        if (key == prefetch_active || key == prefetch_done) continue;
                        cancel_prefetch();
                        prefetch_map = map;
                        prefetch_sha = sha;
                    } else if (type == "menuAppearance") {
                        menu_reduced_motion = message.value("reducedMotion", true);
                    } else if (type == "menuBackdrop") {
                        // Home only: ignored once a gameplay map is loading or loaded.
                        const auto &value = message.at("map");
                        const auto id = value.is_null() ? std::string() : value.get<std::string>();
                        if (!id.empty() && !native::valid_map_id(id))
                            throw std::runtime_error("Invalid backdrop map name");
                        std::string replay_path;
                        if (backdrop && !core && !download.valid() && !id.empty()) {
                            replay_path = local_backdrop_replay(id);
                            if (message.contains("replay")) try {
                                    const auto &replay = message.at("replay");
                                    const auto run_id = replay.at("runId").get<std::string>();
                                    if (run_id.empty() || run_id.size() > 128)
                                        throw std::runtime_error("Invalid PB run id");
                                    const auto bytes =
                                            native::decode_base64(replay.at("replayBase64").get<std::string>());
                                    char hash[65]{};
                                    if (!bh_sha256(bytes.data(), bytes.size(), hash))
                                        throw std::runtime_error("Cannot hash backdrop replay");
                                    std::filesystem::create_directories(cache / "backdrop");
                                    const auto path = cache / "backdrop" / (std::string(hash) + ".bhr");
                                    if (!std::filesystem::exists(path)) {
                                        std::ofstream out(path, std::ios::binary);
                                        out.write(reinterpret_cast<const char *>(bytes.data()), bytes.size());
                                        if (!out) throw std::runtime_error("Cannot cache backdrop replay");
                                    }
                                    valid_backdrop_replay(path, id);
                                    replay_path = native::data_location::utf8(path);
                                } catch (const std::exception &e) {
                                    std::cerr << "PB backdrop: " << e.what() << "; using local PB/tour\n";
                                }
                        }
                        if (backdrop && !core && !download.valid() && backdrop->request(id, replay_path)) {
                            backdrop_shown.clear();
                            backdrop_failed.clear();
                            backdrop_cut = false;
                            backdrop_source.clear();
                            // Released at the menu's request: no map to match against.
                            if (id.empty()) menu->evaluate_js("window.bunnyhopNativeBackdrop?.('none')");
                        }
                    } else if (type == "chatLine") {
                        auto label = [&](const char *key) {
                            return message.contains(key) && message[key].is_string() ? message[key].get<std::string>()
                                                                                     : std::string();
                        };
                        const auto decoration = native::chat_decoration(message);
                        chat.push(
                                message.at("text").get<std::string>(),
                                label("name"),
                                label("kind"),
                                epoch_ms() / 1000.,
                                std::clamp(message.value("ms", 12000.), 1000., 60000.) / 1000.,
                                decoration
                        );
                    } else if (type == "roomScoreboard" || type == "scoreboard")
                        room.display_contract(message);
                    else if (type == "hudData")
                        hud.receive_data(message, heartbeat.generation, map_id, active_style, active_track);
                    else if (type == "hudToast")
                        hud.receive_toast(message, double(SDL_GetTicksNS()) / 1e9);
                    else if (type == "chatSuggestions") {
                        if (message.value("request", uint64_t(0)) != chat_request
                            || message.value("input", std::string()) != chat.input)
                            continue;
                        chat.suggestions.clear();
                        if (chat.active && message.at("items").is_array())
                            for (const auto &value : message.at("items")) {
                                if (chat.suggestions.size() >= 8) break;
                                if (value.is_string())
                                    chat.suggestions.push_back(native::Chat::clean(value.get<std::string>(), 512));
                            }
                    } else if (type == "chatAction") {
                        const auto action = message.at("action").get<std::string>();
                        if (native::surface_chat_action(action)) {
                            native::reply_surface_chat(
                                    renderer.get(),
                                    action,
                                    curr,
                                    input,
                                    chat,
                                    epoch_ms() / 1000.,
                                    !viewer.active && !room.spectator_target
                            );
                            if (action == "paintOptions") {
                                show_menu(true);
                                menu_script.open(
                                        menu.get(), menu_ready, "window.bunnyhopNativeMenu?.open?.('settings','paint')"
                                );
                            }
                        } else if (action == "scores")
                            show_scores = !show_scores;
                        else if (action == "triggerMenu")
                            trigger_menu.toggle();
                        else if (action == "movementStat") {
                            preferences = native::patch_settings(
                                    preferences, native::movement_stat_patch(preferences, message)
                            );
                            json_writer.write(cache / "settings.json", preferences);
                            apply_preferences();
                        } else if (action == "raceMenu")
                            race_picker.open(room.display(), zones);
                        else if (action == "lastLj")
                            hud.repeat_long_jump(chat, epoch_ms() / 1000.);
                        else if (action == "jumpStats") {
                            show_menu(true);
                            menu_script.open(
                                    menu.get(), menu_ready, "window.bunnyhopNativeMenu?.open?.('settings','hud')"
                            );
                        } else if (action == "showTriggers" || action == "showClips") {
                            const char *key = action == "showTriggers" ? "triggersVisible" : "clipsVisible";
                            const bool on = !preferences.at(key).get<bool>();
                            preferences[key] = on;
                            menu_state.settings_changed();
                            json_writer.write(cache / "settings.json", preferences);
                            apply_preferences();
                            toast(std::string(action == "showTriggers" ? "Triggers" : "Player clips")
                                  + (on ? " shown" : " hidden"));
                        } else if (action == "hidePlayers")
                            hide_players = message.value("hidden", !hide_players);
                        else if (action == "openRoom") {
                            show_menu(true);
                            menu->evaluate_js("window.bunnyhopNativeMenu?.open?.('room')");
                        } else if (core && !download.valid()) {
                            if ((action == "restart" || action == "restartBonus") && message.contains("track")) {
                                const auto track = message.at("track").get<uint32_t>();
                                bool found = false;
                                for (const auto &zone : zones)
                                    found |= zone.kind == 0 && zone.track == track;
                                if (!found) throw std::runtime_error("That track is unavailable");
                                if (!gauntlet_id.empty() && track)
                                    throw std::runtime_error("Gauntlets use the main track");
                                active_track = track;
                                reset();
                            } else if (action == "weapon") {
                                const auto weapon = message.value("weapon", std::string());
                                if (weapon == "menu" || weapon == "guns")
                                    gun_menu.show();
                                else {
                                    const unsigned id = message.value(
                                            "weaponId",
                                            weapon == "knife"   ? 1u
                                            : weapon == "glock" ? 2u
                                            : weapon == "usp"   ? 3u
                                                                : 0u
                                    );
                                    if (const auto reason = native::NativeWeaponMenu::refusal(id, weapon_context());
                                        !reason.empty())
                                        throw std::runtime_error(reason);
                                    if (!viewer.active && !room.spectator_target) {
                                        kept_weapons.cancel();
                                        input.pulse = (input.pulse & ~native::weapon_command_mask)
                                                      | (id << native::give_shift);
                                    }
                                }
                            } else if (action == "restart" || action == "restartBonus" || action == "setStart"
                                       || action == "clearStart")
                                act(action, false, true);
                            else
                                throw std::runtime_error("Unknown chat action");
                        }
                    } else if (type == "mapLoad") {
                        const auto action = message.at("action").get<std::string>();
                        if (action == "cancel") {
                            download.cancel();
                            pending_replay.clear();
                            pending_action.clear();
                            pending_tutorial.clear();
                            pending_tutorial_demo = false;
                            pending_room_map.clear();
                            {
                                std::lock_guard lock(progress_mutex);
                                loading.clear();
                                load_progress = nullptr;
                            }
                            error.clear();
                            if (core) reset();
                            if (backdrop && !core && backdrop->resume()) {
                                backdrop_shown.clear();
                                backdrop_failed.clear();
                                backdrop_cut = false;
                                backdrop_source.clear();
                            }
                        } else if (action == "retry") {
                            if (last_requested_map.empty()) throw std::runtime_error("No map to retry");
                            request_map(last_requested_map);
                        } else
                            throw std::runtime_error("Invalid loading action");
                    } else if (type == "leaveMap")
                        leave_map();
                    else if (type == "practiceFromReplay") {
                        try {
                            if (!core || !viewer.active || download.valid())
                                throw std::runtime_error("Open a replay before continuing as practice.");
                            const auto tick = message.contains("tick")
                                                      ? std::optional<uint32_t>(message.at("tick").get<uint32_t>())
                                                      : std::nullopt;
                            const auto takeover = native::ReplayTakeover::take(
                                    core.get(),
                                    viewer.session.info,
                                    zones,
                                    selected_style,
                                    !gauntlet_id.empty(),
                                    !room.id.empty(),
                                    tick,
                                    map_id
                            );
                            takeover.resume(practice, input_timeline, input, held_codes);
                            curr = prev = takeover.snapshot.player;
                            active_style = takeover.style;
                            active_track = takeover.track;
                            viewer.active = false;
                            viewer.id.clear();
                            viewer.controls = {};
                            recorder.input.stop();
                            recorder.clear(true);
                            run_event(heartbeat.invalidate());
                            renderer->reset_presentation();
                            scope.reset();
                            audio.reset();
                            reset_feedback(true);
                            reset_input_timing();
                            score_notice = "Practice from replay. Press R for a real run.";
                            menu->evaluate_js(
                                    "window.bunnyhopNativeMenu?.onPracticeFromReplayResult?.("
                                    + native::practice_from_replay_reply(true).dump() + ")"
                            );
                            show_menu(false);
                        } catch (const std::exception &failure) {
                            menu->evaluate_js(
                                    "window.bunnyhopNativeMenu?.onPracticeFromReplayResult?.("
                                    + native::practice_from_replay_reply(false, failure.what()).dump() + ")"
                            );
                            toast(failure.what());
                        }
                    } else if (type == "practice")
                        practice_action(
                                message.at("action").get<std::string>(),
                                false,
                                message.contains("value") ? std::optional<bool>(message.at("value").get<bool>())
                                                          : std::nullopt
                        );
                    else if (type == "music") {
                        const auto action = message.at("action").get<std::string>();
                        if (action != "previous" && action != "toggle" && action != "next")
                            throw std::runtime_error("Invalid music action");
                        audio.music_control(action);
                    } else if (type == "announce") {
                        const auto event = message.at("event").get<std::string>(),
                                   id = message.value("id", std::string()),
                                   preview = message.value("preview", std::string());
                        if (!native::announcer_event(event) || id.size() > 256
                            || (!preview.empty() && !native::announcer_line(preview)))
                            throw std::runtime_error("Invalid announcer request");
                        audio.announce(event, id, message.value("remote", false), preview);
                    } else if (type == "audioCue") {
                        const auto id = message.at("id").get<std::string>();
                        const double gain = message.value("gain", 1.), rate = message.value("rate", 1.);
                        if (id.empty() || id.size() > 64
                            || id.find_first_not_of("abcdefghijklmnopqrstuvwxyz0123456789_") != std::string::npos
                            || !std::isfinite(gain) || gain < 0 || gain > 1 || !std::isfinite(rate) || rate < .25
                            || rate > 4)
                            throw std::runtime_error("Invalid interface sound");
                        audio.play(id, float(gain), rate);
                    } else if (type == "gauntlet") {
                        gauntlet_action(message);
                    } else if (type == "restart" && core && !download.valid()) {
                        reset();
                        show_menu(false);
                    } else if (type == "selectMap") {
                        const auto style = message.value("style", selected_style);
                        if (!native::styles.contains(style)) throw std::runtime_error("Unknown style");
                        if (!gauntlet_id.empty()
                            && (style != "autohop" || message.value("track", 0u) != 0
                                || (!gauntlet_map.empty() && message.at("id").get<std::string>() != gauntlet_map)))
                            throw std::runtime_error("Gauntlets are Normal style on the main track.");
                        tutorial_runner.stopped = false;
                        selected_style = style;
                        active_track = message.value("track", 0u);
                        if (active_track > 64) throw std::runtime_error("Invalid track");
                        request_map(message.at("id").get<std::string>());
                    } else if (type == "style") {
                        if (!gauntlet_id.empty())
                            throw std::runtime_error("Gauntlets are Normal style on the main track.");
                        if (download.valid()) throw std::runtime_error("A map is loading");
                        const auto id = message.at("id").get<std::string>();
                        if (!native::styles.contains(id)) throw std::runtime_error("Unknown style");
                        selected_style = id;
                        active_track = 0;
                        reset();
                    } else if (type == "settings") {
                        save_window();
                        auto changed = native::patch_settings(preferences, message.at("patch"));
                        if (!window_modes.choose(changed)) throw std::runtime_error(window_controller.error());
                        json_writer.write(cache / "settings.json", changed);
                        preferences = std::move(changed);
                        input_timeline.settings_changed(input, held_codes);
                        apply_preferences();
                        error.clear();
                    } else if (type == "window") {
                        const auto action = message.at("action").get<std::string>();
                        bool ok = false;
                        if (action == "center") {
                            ok = window_controller.center();
                        } else if (action == "minimize") {
                            ok = window_controller.minimize();
                        } else if (action == "maximize") {
                            ok = window_controller.maximize();
                        } else if (action == "toggleFullscreen") {
                            save_window();
                            auto changed = window_modes.toggle(preferences);
                            ok = changed.has_value();
                            if (ok) {
                                preferences = std::move(*changed);
                                menu_state.settings_changed();
                                json_writer.write(cache / "settings.json", preferences);
                            }
                        } else {
                            throw std::runtime_error("Unknown window action");
                        }
                        if (!ok) throw std::runtime_error(window_controller.error());
                        window_dirty = true;
                        window_save_due = Clock::now() + std::chrono::milliseconds(500);
                    } else if (type == "file")
                        menu_files.handle(window.get(), message);
                    else if (type == "hudTheme")
                        hud.set_theme(native::parse_hud_theme(message.at("theme")));
                    else if (type == "replays")
                        refresh_replays();
                    else if ((type == "paint" || type == "measure") && renderer) {
                        score_notice =
                                renderer->tool_message(message, curr, input, !viewer.active && !room.spectator_target);
                    } else if (type == "replayCompare" && viewer.active) {
                        replay_compare_import.message(
                                replay_compare,
                                core.get(),
                                cache / "replays",
                                message,
                                viewer.session.info,
                                viewer.id,
                                native::decode_base64
                        );
                    } else if (type == "ghost") {
                        ghosts.toggle(message);
                        if (renderer) renderer->ghost_enabled(0, ghosts.enabled);
                    } else if (type == "ghostControl") {
                        if (ghosts.control(core.get(), message)) hud.extras.ghost(ghosts.info);
                        if (renderer) native::sync_ghost_visibility(*renderer, ghosts.slots);
                        if (renderer) renderer->reset_presentation();
                        scope.reset();
                    } else if (type == "replay") {
                        const auto path = native::replay_file(cache / "replays", message.at("id").get<std::string>());
                        const auto action = message.at("action").get<std::string>();
                        if (action == "play" || action == "ghost") {
                            native::set_requested_ghost_source(ghosts.sources, message);
                            request_replay(
                                    path, action, message.value("ghostSlot", 0u), message.value("fullRecording", false)
                            );
                        } else if (action == "screenshot") {
                            const auto screenshot = run_vault.screenshot(native::data_location::utf8(path.filename()));
                            if (!screenshot) throw std::runtime_error("This local run has no saved screenshot");
                            if (!SDL_OpenURL(native::RunVault::file_uri(*screenshot).c_str()))
                                throw std::runtime_error(SDL_GetError());
                        } else if (action == "export") {
                            const char *folder = SDL_GetUserFolder(SDL_FOLDER_DOWNLOADS);
                            if (!folder) throw std::runtime_error("Downloads folder unavailable");
                            const auto dest = native::data_location::from_utf8(folder) / path.filename();
                            std::filesystem::copy_file(path, dest, std::filesystem::copy_options::none);
                            score_notice = "Replay exported to Downloads";
                        } else if (action == "delete") {
                            std::filesystem::create_directories(cache / "replays" / "trash");
                            auto dest = cache / "replays" / "trash" / path.filename();
                            if (std::filesystem::exists(dest))
                                throw std::runtime_error("Replay already exists in local trash");
                            std::filesystem::rename(path, dest);
                            try {
                                replay_library.trash(native::data_location::utf8(path.filename()));
                            } catch (const std::exception &e) {
                                std::cerr << "Vault trash: " << e.what() << '\n';
                            }
                            refresh_replays();
                        } else
                            throw std::runtime_error("Unknown replay action");
                    } else if (type == "replayData" && message.value("action", std::string()) == "compare"
                               && viewer.active) {
                        auto request = message;
                        request["action"] = "set";
                        request["kind"] = message.value("source", std::string("custom"));
                        replay_compare_import.message(
                                replay_compare,
                                core.get(),
                                cache / "replays",
                                request,
                                viewer.session.info,
                                viewer.id,
                                native::decode_base64
                        );
                    } else if (type == "replayData") {
                        const auto bytes = native::decode_base64(message.at("replayBase64").get<std::string>());
                        char sha[65]{};
                        bh_sha256(bytes.data(), bytes.size(), sha);
                        const auto path = cache / "replays" / (std::string("import-") + sha + ".bhr");
                        if (!std::filesystem::exists(path)) {
                            std::ofstream out(path, std::ios::binary);
                            out.write(reinterpret_cast<const char *>(bytes.data()), bytes.size());
                            if (!out) throw std::runtime_error("Cannot save imported replay");
                        }
                        const auto action = message.at("action").get<std::string>();
                        if (action != "play" && action != "ghost")
                            throw std::runtime_error("Invalid replay import action");
                        native::set_requested_ghost_source(ghosts.sources, message);
                        request_replay(
                                path, action, message.value("ghostSlot", 0u), message.value("fullRecording", false)
                        );
                        refresh_replays();
                    } else if (type == "tutorial") {
                        const auto action = message.at("action").get<std::string>();
                        if (action == "stop") {
                            tutorial_runner.stopped = true;
                            pending_tutorial.clear();
                            if (tutorial_runner.lesson) tutorial_runner.lesson->stop();
                            if (tutorial_runner.demo && ghosts.handle) {
                                bh_ghost_free(core.get(), ghosts.handle);
                                ghosts.handle = 0;
                                ghosts.enabled = false;
                            }
                            tutorial_runner.demo = false;
                            score_notice.clear();
                            show_menu(true);
                        } else if (action == "start" || action == "demo") {
                            const auto lesson = message.at("lesson").get<std::string>();
                            if (lesson != "jump" && lesson != "strafe" && lesson != "speed" && lesson != "final")
                                throw std::runtime_error("Unknown tutorial lesson");
                            if (map_id == native::TutorialRunner::map_id && core && tutorial_runner.lesson)
                                start_tutorial(lesson, action == "demo");
                            else {
                                tutorial_runner.stopped = false;
                                pending_tutorial = lesson;
                                pending_tutorial_demo = action == "demo";
                                selected_style = "autohop";
                                active_track = 0;
                                request_map(native::TutorialRunner::map_id);
                            }
                        } else
                            throw std::runtime_error("Unknown tutorial action");
                    } else if (type == "videoExport") {
                        try {
                            const auto action = message.value("action", std::string());
                            if (action == "cancel") {
                                cancel_video();
                                refresh_playback_pose();
                            } else if (action == "start") {
                                request_video(native::parse_video_options(message.at("options")));
                            }
                        } catch (const std::exception &failure) {
                            cancel_video();
                            refresh_playback_pose();
                            video_error = failure.what();
                        }
                    } else if (type == "replayControl" && viewer.active) {
                        const auto action = message.at("action").get<std::string>();
                        if (action == "camera") {
                            if (!viewer.camera.set_mode(message.at("camera").get<std::string>()))
                                throw std::runtime_error("Invalid replay camera");
                            camera_controls.set_angles(viewer.camera.pitch, viewer.camera.yaw);
                            camera_controls.clear();
                            if (viewer.camera.mode == "auto") {
                                video.prepare_viewer_camera();
                            }
                        } else if (action == "pause")
                            viewer.paused = message.value("paused", !viewer.paused);
                        else if (action == "speed") {
                            const double value = message.at("speed").get<double>();
                            if (!std::isfinite(value) || value < .1 || value > 4)
                                throw std::runtime_error("Replay speed must be 0.1–4");
                            viewer.speed = value;
                        } else if (action == "fullRecording") {
                            viewer.session.set_full_recording(message.at("value").get<bool>());
                            viewer.controls.first_tick = viewer.session.range.from;
                            viewer.controls.pending = viewer.session.range.clamp(curr.tick);
                        } else if (action == "seek") {
                            const auto tick = message.at("tick").get<uint32_t>();
                            if (tick < viewer.session.range.from || tick > viewer.session.range.to)
                                throw std::runtime_error("Replay tick outside playback range");
                            viewer.controls.pending = tick;
                        } else if (action == "stop")
                            reset();
                    } else if (type == "sensitivity") {
                        preferences = native::patch_settings(preferences, {{"sensitivity", message.at("value")}});
                        menu_state.settings_changed();
                        json_writer.write(cache / "settings.json", preferences);
                        apply_preferences();
                    } else if (type == "playerName")
                        replay_player = native::replay_player_name(message.value("name", std::string()));
                    else if (type == "cosmetics") {
                        player_glow = native_render::parse_glow(message.value("playerGlow", nlohmann::json(nullptr)));
                        outfit = message.value("outfit", std::string());
                        packed_loadout = message.value("packedLoadout", std::string());
                        if (outfit.size() > 64 || packed_loadout.size() > 200)
                            throw std::runtime_error("Invalid cosmetic selection");
                        ghost_cosmetic = message.value("ghostId", ghost_cosmetic);
                        trail_cosmetic = message.value("trailId", trail_cosmetic);
                        if (ghost_cosmetic.size() > 64 || trail_cosmetic.size() > 64)
                            throw std::runtime_error("Invalid ghost cosmetic");
                        if (renderer) {
                            renderer->set_player_glow(player_glow);
                            renderer->set_cosmetics(outfit, packed_loadout);
                            renderer->set_ghost_cosmetics(ghost_cosmetic, trail_cosmetic);
                        }
                    } else if (type == "roomEvent") {
                        apply_room_event(message);
                    } else if (type == "roomSnapshot") {
                        const double now = std::chrono::duration<double>(Clock::now().time_since_epoch()).count();
                        room.snapshot(message, now);
                        room.refresh_display(now);
                    } else if (type == "openAuth")
                        menu->open_auth(message.at("url").get<std::string>());
                    else if (type == "update") {
                        const auto action = message.value("action", std::string());
                        if (action == "check")
                            updater.check();
                        else if (action == "download")
                            updater.download();
                        else if (action == "cancel")
                            updater.cancel();
                        else if (action == "reveal")
                            updater.reveal();
                        last_update.clear();
                    } else if (type == "dataFolder") {
                        // The host only ever moves to a folder it validated from its own
                        // picker (data_choice); the menu never supplies a path.
                        const auto action = message.value("action", std::string());
                        auto save_location = [&] {
                            try {
                                data_location::write(default_root, location);
                                return true;
                            } catch (const std::exception &e) {
                                data_notice = e.what();
                                return false;
                            }
                        };
                        if (action == "pick") {
                            bool start = false;
                            {
                                std::lock_guard lock(data_picker.m);
                                if (!data_picker.open) {
                                    data_picker.open = true;
                                    data_picker.done = false;
                                    data_picker.result.reset();
                                    data_picker.error.clear();
                                    start = true;
                                }
                            }
                            if (start) {
                                data_notice.clear();
                                const auto from = data_location::utf8(cache);
                                SDL_ShowOpenFolderDialog(
                                        &data_folder_picked, &data_picker, window.get(), from.c_str(), false
                                );
                            }
                        } else if (action == "useDefault") {
                            data_notice.clear();
                            data_choice = data_location::choose(default_root, cache, default_root);
                        } else if (action == "cancelChoice")
                            data_choice.reset();
                        else if (action == "move") {
                            const bool now = message.value("when", std::string()) == "now";
                            if (data_unavailable)
                                data_notice =
                                        "Reconnect the drive with your data folder first, or use the default folder.";
                            else if (!data_choice || !data_choice->problem.empty())
                                data_notice = "Pick a folder first.";
                            else {
                                location.pending = data_choice->target;
                                if (save_location()) {
                                    const auto where = data_location::utf8(data_choice->target);
                                    data_choice.reset();
                                    if (now) {
                                        relaunch_requested = true;
                                        running = false;
                                    } else {
                                        data_notice = "Your game data will move to " + where
                                                      + " the next time the game starts.";
                                        toast(data_notice, 5000);
                                    }
                                } else
                                    location.pending.reset();
                            }
                        } else if (action == "cancelPending") {
                            location.pending.reset();
                            if (save_location()) data_notice = "Data move cancelled.";
                        } else if (action == "forget" && data_unavailable) {
                            location = {default_root, std::nullopt};
                            if (save_location()) {
                                data_unavailable = false;
                                data_notice = "Using the default folder from now on.";
                            }
                        } else if (action == "reveal")
                            SDL_OpenURL(data_location::file_url(cache).c_str());
                        last_data_state.clear();
                    } else if (type == "openExternal")
                        native::open_external(message.at("url").get<std::string>());
                    else if (type == "auth")
                        menu->evaluate_js("window.bunnyhopNativeMenu?.onAuth(" + message.dump() + ")");
                    else if (type == "menuError") {
                        error = message.value("error", std::string("Menu failed"));
                        std::cerr << "Menu: " << error << '\n';
                    } else if (type == "worldRecord") {
                        if (message.value("generation", uint64_t(-1)) != heartbeat.generation
                            || message.value("map", std::string()) != map_id
                            || message.value("style", std::string()) != active_style
                            || message.value("track", ~0u) != active_track)
                            continue;
                        known_world_record.reset();
                        world_record_generation = heartbeat.generation;
                        if ((message.contains("seconds") && !message["seconds"].is_null())
                            || (message.contains("timeMs") && !message["timeMs"].is_null())) {
                            const auto ms = native::score_ms(message, "seconds");
                            if (ms <= 0 || ms > native::max_score_ms) {
                                throw std::runtime_error("Invalid world record time");
                            }
                            known_world_record = native::score_seconds(ms);
                        }
                    } else if (type == "hudLeaderboard") {
                        if (message.value("generation", ~uint64_t(0)) != heartbeat.generation
                            || message.value("map", std::string()) != map_id
                            || message.value("style", std::string()) != active_style
                            || message.value("track", ~0u) != active_track)
                            continue;
                        hud.extras.leaderboard(message.value("place", 0u), message.value("topPercent", 0.));
                    } else if (type == "runService") {
                        if (message.value("generation", uint64_t(-1)) != heartbeat.generation) continue;
                        hud.result.service(message, heartbeat.generation, double(SDL_GetTicksNS()) / 1e9);
                        if (message.value("status", std::string()) == "verified" && message.contains("rank"))
                            hud.extras.leaderboard(message.value("rank", 0u), message.value("topPercent", 0.));
                        if (message.value("status", std::string()) == "verified" && !practice.active
                            && !turn_admission.local_only) {
                            const auto id = message.value("id", std::string());
                            const auto event = message.value("announcer", std::string());
                            if (!id.empty() && (event == "pb" || event == "wr")) {
                                audio.verified_finish(event, id);
                            }
                        }
                        if (!practice.active && !turn_admission.local_only)
                            score_notice = message.value("message", std::string());
                        std::cout << "Score service: " << message.dump() << '\n';
                    } else if (type == "quit")
                        running = false;
                    else if (type == "smoke" && !opt.menu_smoke.empty()) {
                        menu_smoke.receive(message);
                    } else if (type == "menuSnapshot" && menu_smoke.snapshot_pending) {
                        menu_smoke.snapshot(message);
                    }
                } catch (const std::exception &e) {
                    error = e.what();
                    std::cerr << "Menu: " << error << '\n';
                    chat.push(error, "", "error", epoch_ms() / 1000.);
                    toast(error);
                }
            }
        frame_diagnostics.mark(native::FrameDiagnostics::kMenu, SDL_GetTicksNS());
        if (auto update = replay_library.take()) {
            if (update->replays) {
                replay_list = std::move(*update->replays);
                hud.context(replay_list, map_id, active_style, active_track);
                menu_state.replays_changed();
            }
            for (const auto &capture : update->captures) {
                if (capture.matches(map_id, recorder.path))
                    recorder.pending_capture = std::pair{capture.id, capture.map};
            }
            for (const auto &failure : update->errors) {
                std::cerr << "Replay library: " << failure << '\n';
                toast(failure);
            }
        }
        prefetch.poll();
        if (prefetch.valid() && prefetch.wait_for(std::chrono::seconds(0)) == std::future_status::ready) {
            try {
                if (prefetch.get()) prefetch_done = prefetch_active;
            } catch (const std::exception &e) {
                std::cerr << "Map prefetch: " << e.what() << '\n';
            }
            prefetch_active.clear();
            prefetch_map.clear();
            prefetch_sha.clear();
        }
        if (!prefetch.valid() && !prefetch_map.empty() && !download.valid() && viewer.active) {
            const auto id = prefetch_map;
            prefetch_active = id + ":" + prefetch_sha;
            prefetch.start([&, id, sha = prefetch_sha](const std::atomic_bool &cancel) {
                const auto lock = lock_cache(cancel);
                return native::prefetch_map(id, sha, cache, cancel);
            });
        }
        download.poll();
        if (download.valid() && download.wait_for(std::chrono::seconds(0)) == std::future_status::ready
            && !map_preparing) {
            map_preparing = true;
            nlohmann::json update;
            {
                std::lock_guard lock(progress_mutex);
                loading = "Preparing map, models and native renderer…";
                load_progress["stage"] = "renderer";
                load_progress["message"] = loading;
                update = {{"loading", loading}, {"loadProgress", load_progress}, {"error", ""}};
            }
            if (menu && menu_ready) menu->evaluate_js("window.bunnyhopNativeMenu?.onState?.(" + update.dump() + ")");
        } else if (download.valid() && map_preparing) {
            map_preparing = false;
            try {
                auto result = download.get();
                load_map(
                        native::data_location::utf8(result.bsp),
                        native::data_location::utf8(result.content_root),
                        result.id,
                        result.detail
                );
            } catch (const std::exception &e) {
                pending_replay.clear();
                pending_action.clear();
                pending_tutorial.clear();
                pending_tutorial_demo = false;
                const std::string failure = e.what();
                if (core) reset();
                error = failure;
                std::cerr << error << '\n';
                if (!menu || opt.frames) throw;
                // Back on the home screen: restart the tour this download interrupted.
                if (backdrop && !core && backdrop->resume()) {
                    backdrop_shown.clear();
                    backdrop_failed.clear();
                    backdrop_cut = false;
                    backdrop_source.clear();
                }
            }
            {
                std::lock_guard lock(progress_mutex);
                loading.clear();
                if (error.empty())
                    load_progress = nullptr;
                else if (load_progress.is_object()) {
                    load_progress["stage"] = "error";
                    load_progress["message"] = error;
                }
            }
            if (tutorial_runner.lesson && !tutorial_runner.stopped && error.empty() && pending_replay.empty()) {
                const auto lesson = pending_tutorial.empty() ? "jump" : pending_tutorial;
                try {
                    start_tutorial(lesson, pending_tutorial_demo);
                } catch (const std::exception &e) {
                    error = e.what();
                }
                pending_tutorial.clear();
                pending_tutorial_demo = false;
            }
            if (!pending_replay.empty() && error.empty()) {
                const auto path = data_location::from_utf8(pending_replay);
                const auto action = pending_action;
                pending_replay.clear();
                try {
                    open_replay(path, action, pending_ghost_slot, pending_full_recording);
                } catch (const std::exception &failure) {
                    error = failure.what();
                }
            }
            if (!pending_room_map.empty() && pending_room_map != map_id) {
                const auto next = pending_room_map;
                pending_room_map.clear();
                active_track = 0;
                request_map(next);
            } else
                pending_room_map.clear();
            if (!menu && core && !opt.hidden) capture(true);
        }
        if (!running) break;
        replay_timeline.poll(menu.get(), menu_ready, viewer.id, viewer.active);
        replay_compare_import.poll(replay_compare, viewer.id, viewer.active, chat, epoch_ms() / 1000.);
        if (menu && menu_ready) {
            if (const auto state = menu_gamepad.sample(menu->visible() && focused))
                menu->evaluate_js("window.bunnyhopNativeMenu?.onGamepad?.(" + state->dump() + ")");
            if (preview_request) {
                auto job = std::move(*preview_request);
                preview_request.reset();
                std::string png;
                try {
                    if (menu->visible()) {
                        if (!loadout_preview) loadout_preview = std::make_unique<NativeLoadoutPreview>(gl, assets);
                        png = loadout_preview->render(job, double(SDL_GetTicksNS()) / 1e9);
                    }
                } catch (const std::exception &e) {
                    std::cerr << "Loadout preview: " << e.what() << '\n';
                }
                const nlohmann::json result = {
                        {"id", job.value("id", 0u)},
                        {"png", png.empty() ? std::string() : "data:image/png;base64," + native::base64(png)}
                };
                menu->evaluate_js("window.bunnyhopNativeLoadoutPreview?.(" + result.dump() + ")");
            }
        }
        const auto now = Clock::now();
        const uint64_t now_ns = SDL_GetTicksNS();
        const bool leave_held = input_timeline.binds().held_action("mainMenu", held_codes);
        const auto leave_result = leave_hold.frame(epoch_ms(), leave_held, !captured || viewer.active);
        if (leave_result == native::LeaveHold::Result::leave)
            leave_map();
        else if (leave_result == native::LeaveHold::Result::tap)
            toast("Hold Main menu key to leave");
        const auto spectator = core && room.map == map_id ? room.spectator_target : std::optional<unsigned>();
        room_bridge.update_presence(
                now, map_id, active_style, viewer.active, captured, menu && menu->visible(), tutorial_practice()
        );
        if (spectator != observed_spectator) {
            if (spectator) {
                bh_record_end(core.get());
                recorder.clear(true);
                run_event(heartbeat.invalidate(native::RunHeartbeat::Reset::start));
                audio.reset();
                input_scheduler.reset(SDL_GetTicksNS());
                input.clear();
                renderer->reset_presentation();
                scope.reset();
                show_menu(false);
            } else if (observed_spectator && core && !viewer.active)
                reset();
            observed_spectator = spectator;
        }
        if (const auto ready = restart_guard.frame(
                    epoch_ms(), held_action(restart_guard.action), !captured || chat.active || viewer.active
            ))
            act(*ready, false, true);
        video.step();
        if (!video_capture && !director_job && !video_encoder.busy())
            if (const auto seek = viewer.controls.take()) try {
                    seek_playback(*seek);
                } catch (const std::exception &e) {
                    error = e.what();
                    viewer.paused = true;
                }
        const bool simulation_active =
                !video_capture && !director_job && !video_encoder.busy() && core && !spectator && !room_modes.frozen()
                && !download.valid()
                && ((focused && (captured || (viewer.active && (!menu || !menu->visible())))) || opt.frames)
                && (!viewer.active || (!viewer.paused && !viewer.controls.dragging));
        if (heartbeat.start && !simulation_active) heartbeat.paused = true;
        const double frame_seconds = input_clock.elapsed(now);
        const bool activity_active = core && !download.valid() && focused && captured && !viewer.active && !spectator
                                     && !opt.frames && opt.runtime_smoke.empty();
        activity.frame(
                map_id, frame_seconds, std::chrono::duration<double>(now.time_since_epoch()).count(), activity_active
        );
        if (!opt.frames && opt.runtime_smoke.empty()) {
            run_history.persist(json_writer, cache, activity, double(SDL_GetTicksNS()) / run_second_ns);
        }
        ++input_frame;
        input_frame_ms = frame_seconds * 1000;
        const double step_dt = viewer.active ? viewer.session.range.tick_interval : dt;
        const uint64_t tick_ns = uint64_t(std::llround(step_dt * 1e9));
        input_scheduler.frame(
                mouse_pump_start, simulation_active, tick_ns, viewer.active ? viewer.speed : 1, opt.frames != 0
        );
        frame_diagnostics.mark(native::FrameDiagnostics::kOther, SDL_GetTicksNS());
        uint64_t &sim_ns = input_scheduler.sim_ns;
        input_timeline.begin_frame(input, simulation_active, now_ns);
        while (input_scheduler.due(tick_ns)) {
            const double counts_before = input.yaw_counts;
            input_timeline.take_tick(input, sim_ns, tick_ns, opt.frames != 0);
            const double mouse_counts = input.yaw_counts - counts_before;
            BhRunState timing_before{};
            bh_run_state(core.get(), &timing_before);
            prev = curr;
            const BhState tutorial_pre = curr;
            BhCmd cmd{};
            if (viewer.active) {
                if (curr.tick >= viewer.session.range.to) {
                    viewer.paused = true;
                    input_scheduler.reset(SDL_GetTicksNS());
                    break;
                }
                BhSnapshot state{};
                if (!bh_replay_step(core.get(), &state)) {
                    const std::string failure = bh_last_error(core.get());
                    viewer.failed = true;
                    reset();
                    error = "Replay stopped: " + failure;
                    std::cerr << error << '\n';
                    show_menu(true);
                    input_scheduler.reset(SDL_GetTicksNS());
                    if (opt.frames) running = false;
                    break;
                }
                curr = state.player;
                bh_last_command(core.get(), &cmd);
                input.set_angles(cmd.pitch, cmd.yaw, 5);
            } else {
                const bool turns_allowed = captured
                                           && native::turn_binds_allowed(
                                                   active_style,
                                                   (tutorial_runner.lesson && tutorial_runner.lesson->is_active())
                                                           || practice.active || feedback.ssj_was_noclip
                                           );
                const auto &turns = recorder.input.active() ? recorder.input.turns : configured_turns;
                const double rate = turns.apply(input, input_timeline.held(held_codes), dt, turns_allowed);
                if (turn_admission.observe(rate, active_style == "scroll")) {
                    run_event(heartbeat.invalidate(native::RunHeartbeat::Reset::start));
                    score_notice = "Practice turn controls: local replay only";
                }
                if (!recorder.path.empty() && !recorder.ended) {
                    require(recorder.input.mark_timed(core.get(), input_timeline.tick_contributed()),
                            core.get(),
                            "Marking timed input recording");
                }
                if (!(input.pulse & native::give_mask)) {
                    if (const auto give = kept_weapons.next()) {
                        input.pulse = (input.pulse & ~native::weapon_command_mask) | (give << native::give_shift);
                    }
                }
                if (native::apply_null_binds(
                            input, input_timeline, hud.preferences().null_binds, active_style, practice.active
                    )
                    && turn_admission.observe(1, true)) {
                    run_event(heartbeat.invalidate(native::RunHeartbeat::Reset::generation));
                    score_notice = "Null binds: local replay only";
                }
                cmd = input.command();
                if (practice.noclip) {
                    BhSnapshot snapshot{};
                    require(bh_noclip_move(&practice.flight, &cmd, dt), core.get(), "Moving noclip");
                    require(bh_practice_noclip_tick(core.get(), &practice.flight, &snapshot),
                            core.get(),
                            "Stepping practice noclip");
                    curr = snapshot.player;
                } else {
                    const auto look = input.look_sample();
                    require(bh_step_look_v2(core.get(), &cmd, look ? &*look : nullptr, &curr),
                            core.get(),
                            "Stepping simulation");
                    require(bh_last_command(core.get(), &cmd), core.get(), "Reading filtered command");
                    input.events(curr);
                }
            }
            renderer->simulation_tick();
            hud.movement.tick_jump(cmd, curr);
            hud.tick(curr);
            hud.command_tick(cmd, curr.tick);
            if (input_log && !viewer.active) {
                const double moved = mouse_counts;
                input_log << curr.tick << ',' << input_frame << ',' << input_frame_ms << ',' << double(sim_ns) / 1e6
                          << ',' << moved << ',' << input_timeline.pending_counts(input) << ',' << cmd.buttons
                          << (cmd.side > 0   ? "R"
                              : cmd.side < 0 ? "L"
                                             : "")
                          << (cmd.forward > 0   ? "F"
                              : cmd.forward < 0 ? "B"
                                                : "")
                          << ',' << std::hypot(double(curr.velocity[0]), double(curr.velocity[1])) << ','
                          << int(curr.grounded != 0) << ',' << int((curr.events & 2u) != 0) << '\n';
            }
            if (curr.events & native::teleported) room_events |= 8;
            if (curr.events & 2) room_events |= 4;
            if (curr.events & (1u << 5)) {
                const bool stab = cmd.buttons & native::attack2;
                room_events |= stab ? 32 : 16;
                if (!viewer.active) bh_record_cosmetic(core.get(), stab ? 2 : 1);
            }
            if (viewer.active) {
                BhReplayEvents e{};
                if (bh_replay_events(core.get(), prev.tick, curr.tick, &e)) {
                    if (e.inspect_signal) renderer->inspect_press();
                    renderer->inspect_held(e.inspect_held != 0);
                }
            }
            BhSnapshot state{};
            bh_snapshot(core.get(), &state);
            BhRunState timing{};
            bh_run_state(core.get(), &timing);
            BhWeaponReport weapon{};
            bh_weapon_report(core.get(), &weapon);
            BhAttackReport attack{};
            if (!viewer.active && !practice.active && !tutorial_practice() && !opt.frames
                && opt.runtime_smoke.empty()) {
                if (curr.events & 2) activity.jump(map_id);
                if (timing.update_flags & 1) activity.attempt(map_id);
                if ((timing.update_flags & 1) && !recorder.path.empty()) {
                    const uint64_t started = SDL_GetTicksNS();
                    run_history.start(double(started) / run_second_ns);
                    recorder.diagnostics.start(started, input_timeline.queue(), input_timeline.timed());
                }
            }
            {
                // Jump stats. |prev| is the state before this tick, which is what the
                // plugin reads in OnPlayerRunCmd, and curr.events carries the jump.
                native::SsjState pre;
                pre.position = prev.position;
                pre.velocity = prev.velocity;
                pre.grounded = prev.grounded != 0;
                pre.on_ladder = prev.on_ladder != 0;
                const native::SsjCmd ssj_cmd{cmd.forward, cmd.side, cmd.yaw, cmd.buttons};
                native::SsjTick info;
                info.jumped = (curr.events & (1u << 1)) != 0;  // EVENT_JUMPED
                info.teleported = (curr.events & native::teleported) != 0;
                info.in_start = practice.noclip ? false : timing_before.in_start != 0;
                info.noclip = practice.noclip || feedback.ssj_was_noclip;
                if (timing_before.status == 1)
                    info.time = (timing_before.last_tick - timing_before.start_tick) * step_dt;
                hud.configure_feedback(feedback);
                if (timing.update_flags & 4) reset_feedback(false, true);  // restarted
                const bool history_ready = feedback.history_ready(pre.grounded, info.in_start, info.noclip);
                if (history_ready) {
                    if (const auto report = feedback.ssj.tick(pre, ssj_cmd, info)) {
                        hud.ssj_report(*report);
                        feedback.ssj_gain = report->gain;
                    }
                }
                feedback.ssj_was_in_start = timing.in_start != 0;
                feedback.ssj_was_noclip = state.movement_mode == 1;  // Mode::Noclip
                BhSettings trainer_settings{};
                const auto &style = viewer.active ? viewer.session.style : active_style;
                if (viewer.active)
                    trainer_settings = viewer.session.settings;
                else
                    bh_style_settings(style.c_str(), &trainer_settings);
                native::feed_strafe_trainer(
                        feedback, hud.preferences(), curr, ssj_cmd, trainer_settings, style, step_dt, info.noclip
                );
                if (info.teleported) {
                    feedback.ssj.reset();
                    feedback.ssj_was_in_start = timing.in_start != 0;
                }
            }
            BhSurfaceProbe surface{};
            surface.water_z = std::numeric_limits<float>::quiet_NaN();
            const bool surface_found =
                    bh_surface_at(core.get(), curr.position[0], curr.position[1], curr.position[2], &surface) != 0;
            const double water_depth =
                    surface_found ? surface.water_z - curr.position[2] : std::numeric_limits<double>::quiet_NaN();
            static const std::array<const char *, 6> surfaces = {"concrete", "metal", "wood", "grass", "tile", "water"};
            const bool attacked = bh_attack_report(core.get(), &attack);
            if (!viewer.active) scope.observe(weapon, attacked ? &attack : nullptr);
            audio.set_style(viewer.active ? viewer.session.info.value("style", active_style) : active_style);
            BhJumpObservation jump_observation{};
            const bool observed_jump = bh_jump_observation(core.get(), &jump_observation) != 0;
            hud.movement.color_blind = hud.preferences().color_blind;
            hud.movement.feed(
                    observed_jump ? &jump_observation : nullptr,
                    timing,
                    step_dt,
                    active_style,
                    hud.preferences().long_jump,
                    timing_before.in_start != 0,
                    practice.noclip
            );
            if (const auto pitch =
                        native::trainer_jump_sound(hud.preferences(), feedback.strafe_trainer.take_landing()))
                audio.play("count_tick", 1.6f, *pitch);
            audio.tick(
                    state,
                    timing,
                    weapon,
                    attacked ? &attack : nullptr,
                    step_dt,
                    surfaces[std::clamp(surface.surface, 0, 5)],
                    water_depth,
                    observed_jump ? &jump_observation : nullptr
            );
            if (timing.update_flags & 16) {
                char split[100];
                std::snprintf(split, sizeof(split), "Split %u  %.3fs", timing.split_count, timing.seconds);
                hud.set_run_comparison(split, "");
            }
            if (!viewer.active) kept_weapons.observe(weapon);
            const uint32_t slot = weapon.active == weapon.primary ? 1 : weapon.active == weapon.secondary ? 2 : 3;
            if (slot != observed_slot) {
                last_slot = observed_slot;
                observed_slot = slot;
            }
            if (curr.events & native::teleported) prev = curr;
            input_scheduler.consume(tick_ns);
            BhRunState tick_run{};
            if (viewer.active || !zones.empty())
                require(bh_run_state(core.get(), &tick_run), core.get(), "Reading native timer");
            if (tutorial_runner.lesson && tutorial_runner.lesson->is_active() && !viewer.active) {
                BhCmd filtered = cmd;
                bh_last_command(core.get(), &filtered);
                const auto result = tutorial_runner.tick(
                        tutorial_pre, curr, filtered, curr.events, dt, tick_run, cache, json_writer
                );
                if (result.next_lesson >= 0 && result.next_lesson < 4) {
                    constexpr const char *ids[] = {"jump", "strafe", "speed", "final"};
                    start_tutorial(ids[result.next_lesson], false);
                    input_scheduler.reset(SDL_GetTicksNS());
                    break;
                }
            }

            // Finish the recording on the exact native tick, before any further catch-up steps.
            if (!viewer.active && tick_run.status == 2 && !recorder.ended) {
                recorder.diagnostics.stop(SDL_GetTicksNS(), input_timeline.queue());
                reset_input_timing();
                break;
            }
        }
        hud.publish_movement_chat(chat, epoch_ms() / 1000.);
        frame_diagnostics.mark(native::FrameDiagnostics::kSimulation, SDL_GetTicksNS());
        frame_diagnostics.input(input_timeline.queue());
        BhRunState run_state{};
        if (core) {
            if (viewer.active || !zones.empty())
                require(bh_run_state(core.get(), &run_state), core.get(), "Reading native timer");
            if (!practice.active && !viewer.active && run_state.status == 1 && run_state.recording) {
                const bool started_run = heartbeat.start != run_state.start_tick;
                if (started_run) {
                    run_event(heartbeat.invalidate(native::RunHeartbeat::Reset::generation));
                    heartbeat.begin(run_state.start_tick);
                }
                if (started_run || now - heartbeat.time >= std::chrono::seconds(4)) {
                    run_event(heartbeat.fold(core.get(), run_state));
                    heartbeat.sent(now);
                }
            } else if (run_state.status == 0 && heartbeat.start) {
                run_event(heartbeat.invalidate(native::RunHeartbeat::Reset::start));
            }
            if (!viewer.active && run_state.status == 2 && !recorder.ended)
                hud.result.finish(
                        heartbeat.generation,
                        run_state.seconds,
                        double(SDL_GetTicksNS()) / 1e9,
                        hud.extras.personal_best,
                        !practice.active && !turn_admission.local_only
                );
            if (practice.active && !viewer.active && run_state.status == 2 && !recorder.ended) {
                recorder.ended = true;
            }
            if (!practice.active && !viewer.active && run_state.status == 2 && !recorder.ended) {
                recorder.ended = true;
                if (!recorder.path.empty()) {
                    try {
                        recorder.write(core.get());
                        // Local vault failures cannot withhold an otherwise valid replay submission.
                        const auto id = data_location::utf8(data_location::from_utf8(recorder.path).filename());
                        replay_library.archive(
                                id,
                                {{"map", map_id},
                                 {"style", active_style},
                                 {"track", run_state.track},
                                 {"time", run_state.seconds},
                                 {"timeMs", native::score_ms(run_state.seconds)},
                                 {"timingPolicy", native::timing_policy},
                                 {"jumps", run_state.jumps},
                                 {"strafes", run_state.strafes},
                                 {"sync", run_state.sync_percent},
                                 {"finishedAt", epoch_ms()},
                                 {"client", identity.value("build", std::string("local"))},
                                 {"eligible", !turn_admission.local_only && bool(run_state.recording_valid)}},
                                prefs.capture_pb_screenshots
                        );
                        refresh_replays();
                        if (!turn_admission.local_only && active_style == "autohop" && run_state.track == 0) {
                            const auto old = backdrop_pbs.find(map_id);
                            if (old == backdrop_pbs.end() || !old->is_object()
                                || native::score_ms(run_state.seconds) < native::score_ms(*old, "seconds")) {
                                backdrop_pbs[map_id] = {
                                        {"id",
                                         native::data_location::utf8(
                                                 native::data_location::from_utf8(recorder.path).filename()
                                         )},
                                        {"seconds", run_state.seconds},
                                        {"timeMs", native::score_ms(run_state.seconds)}
                                };
                                json_writer.write(cache / "backdrop-pbs.json", backdrop_pbs);
                            }
                        }
                        run_event(recorder.finish_event(
                                run_state.track,
                                run_state.seconds,
                                native::read_text(data_location::from_utf8(recorder.path)),
                                run_history.play(activity, map_id, prefs, recorder.input.turns),
                                {{"sensitivity", prefs.sensitivity}}
                        ));
                        std::cout << "Native finish " << run_state.seconds << " seconds; replay " << recorder.path
                                  << '\n';
                    } catch (const std::exception &e) {
                        error = std::string("Replay was not submitted: ") + e.what();
                        std::cerr << error << '\n';
                    }
                }
            }
            if (hud.auto_restart_due(
                        auto_restart,
                        heartbeat.generation,
                        run_state,
                        world_record_generation == heartbeat.generation ? known_world_record : std::nullopt,
                        hud.extras.ghost_target(map_id, active_style, active_track, ghosts.enabled && ghosts.handle),
                        practice.active || turn_admission.local_only || viewer.active || room_modes.has_race()
                                || (tutorial_runner.lesson && tutorial_runner.lesson->is_active()) || !captured
                )) {
                if (hud.preferences().auto_restart_sound)
                    audio.play("countdown_tick");
                else
                    act("restart", false, true);
            }
        }
        int width = 0, height = 0;
        SDL_GetWindowSizeInPixels(window.get(), &width, &height);
        if (renderer && !video_capture && !director_job) {
            const float blend = (opt.frames || !simulation_active) ? 1.0f : float(input_scheduler.seconds() / step_dt);
            float eye[3];
            for (int i = 0; i < 3; ++i)
                eye[i] = prev.position[i] + (curr.position[i] - prev.position[i]) * blend;
            eye[2] += prev.view_offset_z + (curr.view_offset_z - prev.view_offset_z) * blend;
            BhSnapshot state{};
            bh_snapshot(core.get(), &state);
            std::optional<native_render::Actor> audible_ghost;
            BhCmd ghost_command{};
            const BhCmd *shown_ghost_command = nullptr;
            if (ghosts.enabled && renderer->ghost_visible(0) && prefs.show_ghost && ghosts.handle && !viewer.active
                && !spectator
                && (tutorial_runner.demo
                    || (ghosts.info.value("track", 0u) == active_track
                        && ghosts.info.value("style", std::string("autohop")) == active_style))) {
                BhGhostFrame ghost{};
                const auto &path = renderer->ghost_path(0);
                const uint32_t elapsed = tutorial_runner.demo ? curr.tick - tutorial_runner.demo_start
                                         : run_state.status   ? curr.tick - run_state.start_tick
                                                              : 0;
                const uint32_t tick = tutorial_runner.demo ? ghosts.info.value("startTick", 0u) + elapsed
                                                           : std::min(path.start + elapsed, path.end);
                if (bh_ghost_frame(core.get(), ghosts.handle, tick, &ghost)) {
                    if (!tutorial_runner.demo) {
                        shown_ghost_command = &ghost_command;
                        if (path.start + elapsed <= path.end)
                            bh_ghost_command(core.get(), ghosts.handle, tick, &ghost_command);
                    }
                    const float opacity =
                            native::GhostSlots::opacity(curr, ghost, prefs.ghost_opacity, prefs.ghost_near_fade);
                    renderer->set_replay_actor(
                            ghost, tutorial_runner.demo ? "outfit-cream" : outfit, renderer->ghost_loadout(0), opacity
                    );
                    native_render::Actor actor;
                    actor.id = "replay-ghost";
                    actor.frame = ghost;
                    actor.opacity = opacity;
                    audible_ghost = actor;
                } else {
                    renderer->set_replay_actor(nullptr, 0, 0);
                    if (tutorial_runner.demo) {
                        ghosts.enabled = false;
                        tutorial_runner.demo = false;
                    }
                }
            } else
                renderer->set_replay_actor(nullptr, 0, 0);
            hud.extras.ghost_progress(renderer->ghost_path(0).frames, curr, run_state, shown_ghost_command);
            BhRunState display_run = run_state;
            std::string display_style = viewer.active ? viewer.session.info.value("style", active_style) : active_style;
            std::optional<native_render::Actor> spectated_actor;
            const double steady_seconds = std::chrono::duration<double>(now.time_since_epoch()).count();
            auto actors = room.actors(steady_seconds);
            auto camera_input = input_timeline.preview(input);
            // Show turnbind motion between ticks too, so turning is smooth at any frame rate.
            if (simulation_active && !viewer.active && !spectator) {
                const auto &turns = recorder.input.active() ? recorder.input.turns : configured_turns;
                const bool allowed = captured && native::turn_binds_allowed(active_style, practice.active);
                turns.apply(
                        camera_input,
                        input_timeline.binds().held(held_codes),
                        std::clamp(input_scheduler.seconds(), 0.0, dt),
                        allowed
                );
            }
            std::string shown_notice = tutorial_runner.lesson && tutorial_runner.lesson->is_active() && !viewer.active
                                               ? tutorial_runner.lesson->notice()
                                               : score_notice;

            renderer->set_player_glow(player_glow);
            if (!spectator) renderer->set_spectated_actor(std::nullopt);
            renderer->set_viewmodel_weapon(std::nullopt);
            renderer->set_viewmodel_visible(prefs.viewmodel && !opt.camera);
            renderer->set_source_look(prefs.source_look);
            if (spectator) {
                spectated_actor = room.spectated(steady_seconds);
                const auto &target = spectated_actor;
                if (target) {
                    renderer->set_spectated_actor(*target);
                    for (int k = 0; k < 3; k++) {
                        eye[k] = target->frame.position[k];
                        state.player.position[k] = target->frame.position[k];
                        state.player.velocity[k] = target->frame.velocity[k];
                    }
                    eye[2] += target->frame.view_offset_z;
                    state.player.tick = target->frame.tick;
                    state.player.view_offset_z = target->frame.view_offset_z;
                    state.player.grounded = !!(target->frame.flags & 2);
                    state.player.crouched = !!(target->frame.flags & 1);
                    camera_input.set_angles(target->frame.pitch, target->frame.yaw);
                    renderer->set_cosmetics(target->outfit, target->loadout);
                    renderer->set_player_glow(target->playerGlow);
                    renderer->set_viewmodel_weapon(target->frame.weapon);
                    shown_notice = "Spectating " + target->name + " - Esc for Room controls";
                    actors.erase(
                            std::remove_if(
                                    actors.begin(), actors.end(), [&](const auto &a) { return a.id == target->id; }
                            ),
                            actors.end()
                    );
                } else {
                    renderer->set_spectated_actor(std::nullopt);
                    renderer->set_viewmodel_visible(false);
                    shown_notice = "Waiting for spectator target";
                }
            }
            bool external_camera = false;
            if (viewer.active) {
                camera_controls.consume_all();
                camera_controls.held = chat.active ? 0 : input.held;
                if (viewer.camera.mode == "free")
                    viewer.camera.move(
                            camera_controls,
                            frame_seconds,
                            held_codes.contains("ShiftLeft") || held_codes.contains("ShiftRight")
                    );
                viewer.camera.sample(
                        core.get(),
                        state.player,
                        camera_input.yaw(),
                        camera_input.pitch,
                        curr.tick * step_dt,
                        eye,
                        camera_input,
                        frame_seconds
                );
                external_camera = viewer.camera.third_person();
            } else if (third_person) {
                third_camera.sample(
                        core.get(),
                        state.player,
                        camera_input.yaw(),
                        camera_input.pitch,
                        steady_seconds,
                        eye,
                        camera_input,
                        frame_seconds
                );
                external_camera = true;
            }
            if (spectator) room.spectator_run(display_run, display_style, *spectator, steady_seconds, epoch_ms());
            if (hide_players) actors.clear();
            if (!viewer.active && !spectator && !tutorial_runner.demo && prefs.show_ghost)
                for (unsigned i = 1; i < 4; i++) {
                    const auto &slot = ghosts.slots[i];
                    if (!slot.handle || !slot.enabled || !renderer->ghost_visible(i)
                        || slot.info.value("track", 0u) != active_track
                        || slot.info.value("style", std::string("autohop")) != active_style)
                        continue;
                    native_render::Actor actor;
                    actor.id = "ghost-" + std::to_string(i);
                    actor.name = renderer->ghost_name(i);
                    const uint32_t tick = slot.info.value("startTick", 0u)
                                          + (run_state.status ? curr.tick - run_state.start_tick : 0);
                    if (!bh_ghost_frame(core.get(), slot.handle, tick, &actor.frame)) continue;
                    actor.outfit = outfit;
                    actor.loadout = renderer->ghost_loadout(i);
                    renderer->decorate_ghost(actor, i);
                    actor.opacity =
                            native::GhostSlots::opacity(curr, actor.frame, prefs.ghost_opacity, prefs.ghost_near_fade);
                    actors.push_back(actor);
                }
            if (external_camera) {
                renderer->set_viewmodel_visible(false);
                native_render::Actor self;
                self.id = "local-camera-target";
                self.opacity = 1;
                self.outfit = outfit;
                self.loadout = packed_loadout;
                self.playerGlow = player_glow;
                for (int k = 0; k < 3; k++) {
                    self.frame.position[k] = state.player.position[k];
                    self.frame.velocity[k] = state.player.velocity[k];
                }
                self.frame.tick = state.player.tick;
                self.frame.flags = (state.player.crouched ? 1 : 0) | (state.player.grounded ? 2 : 0);
                self.frame.view_offset_z = state.player.view_offset_z;
                self.frame.pitch = input.pitch;
                self.frame.yaw = input.yaw();
                BhWeaponReport held{};
                bh_weapon_report(core.get(), &held);
                self.frame.weapon = held.active;
                if (spectator) {
                    if (const auto target = room.spectated(steady_seconds)) {
                        self = *target;
                        self.opacity = 1;
                    }
                }
                actors.push_back(self);
            }
            if (opt.camera) {
                for (int k = 0; k < 3; k++)
                    eye[k] = (*opt.camera)[k];
                camera_input.set_angles((*opt.camera)[3], (*opt.camera)[4]);
            }
            const bool local_scope = !viewer.active && !spectator && !external_camera && !opt.camera;
            if (local_scope && simulation_active) scope.frame(frame_seconds);
            renderer->set_camera_fov(local_scope ? scope.fov(prefs.fov) : prefs.fov);
            if (local_scope && scope.scoped()) renderer->set_viewmodel_visible(false);
            const bool world_record_finish =
                    !viewer.active && !spectator && !practice.active && !turn_admission.local_only
                    && display_run.recording_valid && world_record_generation == heartbeat.generation
                    && known_world_record
                    && native::score_ms(display_run.seconds) < native::score_ms(*known_world_record);
            renderer->set_zone_state(display_run.track, display_run, world_record_finish);
            renderer->set_flashlight(flashlight);
            audio.listener(eye, camera_input.yaw());
            if (focused && captured && !opt.frames) {
                for (const auto &actor : actors)
                    if (actor.id != "local-camera-target")
                        audio.spatial_actor(actor, frame_seconds, actor.id.starts_with("ghost-"));
                if (audible_ghost) audio.spatial_actor(*audible_ghost, frame_seconds, true);
                if (spectated_actor && !external_camera) audio.spatial_actor(*spectated_actor, frame_seconds, false);
            }
            native::update_compare_actor(*renderer, replay_compare, curr.tick, viewer.session.range, viewer.active);
            renderer->route_context(active_track, active_style, !viewer.active && !spectator && !tutorial_runner.demo);
            renderer->surface_tools_frame(
                    curr, input, simulation_active && captured && !viewer.active && !spectator, spectator.has_value()
            );
            renderer->set_room_actors(actors);
            renderer->draw(
                    width,
                    height,
                    eye,
                    camera_input,
                    &state,
                    (viewer.active || opt.frames) ? curr.tick * step_dt
                                                  : std::chrono::duration<double>(now - started).count()
            );
            renderer->draw_measure_label(
                    hud,
                    renderer->camera(eye, camera_input.yaw(), camera_input.pitch, float(width) / height),
                    eye,
                    width,
                    height
            );
            if ((!menu || !menu->visible()) && !opt.camera && prefs.hud) {
                const auto matrix = renderer->camera(
                        eye, camera_input.yaw(), camera_input.pitch, float(width) / std::max(height, 1)
                );
                native::draw_name_tags(
                        hud,
                        width,
                        height,
                        prefs.hud_scale,
                        matrix.data(),
                        actors,
                        room,
                        hud.preferences().tags_players,
                        prefs.ghost_tag,
                        hud.preferences().tags_through_walls,
                        native::NameTagTrace{core.get(), eye},
                        steady_seconds,
                        renderer->output_view(width, height)
                );
                if (audible_ghost && prefs.ghost_tag)
                    native::draw_ghost_name_tag(
                            hud,
                            width,
                            height,
                            prefs.hud_scale,
                            matrix.data(),
                            *audible_ghost,
                            hud.extras.ghost_name.view(),
                            hud.extras.ghost_seconds,
                            hud.extras.ghost_delta.view(),
                            hud.preferences().tags_through_walls,
                            native::NameTagTrace{core.get(), eye},
                            renderer->output_view(width, height)
                    );
            }
            std::string gauntlet_line, gauntlet_delta;
            bool gauntlet_good = false;
            if (!gauntlet_id.empty() && gauntlet_progress.is_object()) {
                const bool timed = run_state.status == 1;
                const double total = gauntlet_progress.at("before").get<double>() + (timed ? run_state.seconds : 0);
                char formatted[80];
                std::snprintf(formatted, sizeof(formatted), "%02u:%06.3f", unsigned(total) / 60, std::fmod(total, 60));
                gauntlet_line = "Gauntlet " + std::to_string(gauntlet_progress.at("idx").get<unsigned>() + 1) + "/"
                                + std::to_string(gauntlet_progress.at("maps").get<unsigned>()) + " | " + formatted;
                if (timed && !gauntlet_progress.at("pbSplit").is_null()) {
                    const auto delta = run_state.seconds - gauntlet_progress.at("pbSplit").get<double>();
                    std::snprintf(formatted, sizeof(formatted), "%+.3fs", delta);
                    gauntlet_delta = formatted;
                    gauntlet_good = delta < 0;
                }
            }
            native::HudFrame{
                    core.get(),
                    hud,
                    hud_layout,
                    prefs,
                    practice,
                    feedback,
                    mouse_diagnostics,
                    frame_diagnostics,
                    viewer,
                    chat,
                    room,
                    room_modes,
                    gun_menu,
                    trigger_menu,
                    race_picker,
                    leave_hold,
                    curr,
                    state,
                    display_run,
                    run_state,
                    map_id,
                    active_style,
                    display_style,
                    shown_notice,
                    gauntlet_line,
                    gauntlet_delta,
                    gauntlet_good,
                    display_fps,
                    steady_seconds,
                    width,
                    height,
                    (!menu || !menu->visible()) && !opt.camera,
                    bool(video_capture) || bool(director_job),
                    held_action("scoreboard") || show_scores,
                    weapon_context()
            }
                    .draw();
        }
        // Capture only the finished gameplay framebuffer, before any menu/backdrop layer.
        if (recorder.pending_capture) {
            const auto pending = *recorder.pending_capture;
            recorder.pending_capture.reset();
            if (renderer && pending.second == map_id && width > 0 && height > 0) {
                try {
                    replay_library.attach(pending.first, backbuffer_png(gl, width, height));
                } catch (const std::exception &e) {
                    std::cerr << "Local PB screenshot: " << e.what() << '\n';
                    score_notice = "Replay saved; optional screenshot could not be saved";
                }
            }
        }
        // Separate GTK windows and screenshot runs cannot show the SDL layer:
        // they get one bounded PNG of the still pose instead of a live scene.
        const bool backdrop_live = menu && menu->supports_backdrop() && opt.menu_smoke.empty();
        const bool backdrop_still = menu_reduced_motion || !backdrop_live;
        // An unfocused window holds the current shot rather than animating.
        const double backdrop_dt = focused ? std::chrono::duration<double>(now - backdrop_clock).count() : 0;
        backdrop_clock = now;
        bool backdrop_drawn = false;
        if (backdrop && !renderer) {
            backdrop->poll(!download.valid());
            backdrop_drawn = backdrop->draw(width, height, backdrop_dt, backdrop_still);
        }
        if (!renderer && !backdrop_drawn) {
            gl.Viewport(0, 0, width, height);
            gl.ClearColor(.03f, .04f, .06f, 1);
            gl.Clear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
        }
        // Tell the menu what it is drawn over: the home tour (once per map,
        // then fade cuts), or the paused gameplay map. "native" waits for the
        // frame to be presented; a PNG is read back from this frame first.
        std::string backdrop_call;
        bool backdrop_log = false;
        if (menu && menu_ready && width > 0 && height > 0) try {
                auto call = [](const std::string &source, const std::string &id) {
                    return "window.bunnyhopNativeBackdrop?.(" + nlohmann::json(source).dump() + ","
                           + nlohmann::json(id).dump() + ")";
                };
                auto png_source = [&] {
                    backdrop_png = backbuffer_png(gl, width, height);
                    return "data:image/png;base64," + native::base64(backdrop_png);
                };
                if (renderer && gameplay_backdrop_due && menu->visible()) {
                    gameplay_backdrop_due = false;
                    backdrop_source = backdrop_live ? "native" : "png";
                    backdrop_shown = map_id;
                    backdrop_call = call(backdrop_live ? std::string("native") : png_source(), map_id);
                    backdrop_log = true;
                } else if (!renderer && backdrop_drawn && backdrop_shown != backdrop->map()) {
                    backdrop_source = backdrop_live ? "native" : "png";
                    backdrop_shown = backdrop->map();
                    backdrop_cut = false;
                    backdrop_call = call(backdrop_live ? std::string("native") : png_source(), backdrop_shown);
                    backdrop_log = true;
                } else if (!renderer && backdrop_drawn && backdrop_live
                           && backdrop->cut(backdrop_still) != backdrop_cut) {
                    backdrop_cut = !backdrop_cut;
                    backdrop_call = call(backdrop_cut ? "cut" : "native", backdrop_shown);
                } else if (!renderer && backdrop && backdrop->status() == native::MenuBackdrop::Status::failed
                           && backdrop_failed != backdrop->map()) {
                    backdrop_failed = backdrop->map();
                    std::cerr << "Menu backdrop " << backdrop_failed << ": " << backdrop->error() << '\n';
                    backdrop_call = call("none", backdrop_failed);
                }
            } catch (const std::exception &e) {
                std::cerr << "Menu backdrop: " << e.what() << '\n';
            }
        room_bridge.publish_pose(
                now,
                started,
                menu.get(),
                menu_ready,
                core.get(),
                map_id,
                viewer.active,
                spectator.has_value(),
                curr,
                input,
                run_state,
                active_style
        );
        video_smoke.frame(running);
        ++frame;
        ++title_frames;
        if (simulation_active && !viewer.active) input.frame();
        audio.set_music_scene(bool(core) && (!menu || !menu->visible()));
        audio.pump();  // advances the music playlist; decoding cannot run on the audio thread
        if (opt.frames && renderer && !opt.screenshot.empty()
            && (curr.tick >= opt.frames || (viewer.active && viewer.paused && curr.tick >= viewer.session.range.to))) {
            renderer->screenshot(opt.screenshot, width, height);
        }
        const GLenum gl_error = gl.GetError();
        if (gl_error != GL_NO_ERROR) throw std::runtime_error("OpenGL error " + std::to_string(gl_error));
        frame_diagnostics.mark(native::FrameDiagnostics::kRender, SDL_GetTicksNS());
        if (!SDL_GL_SwapWindow(window.get()))
            throw std::runtime_error(std::string("Swapping framebuffer failed: ") + SDL_GetError());
        frame_diagnostics.mark(native::FrameDiagnostics::kSwap, SDL_GetTicksNS());
        frame_pacer.after_swap(gl, prefs.limit_queued_frames && !opt.frames);
        frame_diagnostics.mark(native::FrameDiagnostics::kGpuWait, SDL_GetTicksNS());
        // Answers from file dialogs and the watched Custom CSS file.
        if (menu && menu_ready) {
            for (const auto &script : menu_files.poll())
                menu->evaluate_js(script);
        }
        // State first: the menu accepts a backdrop only for its current or
        // requested map, so it must already know a newly loaded map. Scripts
        // run in the order they are queued.
        if (menu && menu_ready && now - activity_time >= std::chrono::seconds(1) && !opt.frames
            && opt.runtime_smoke.empty()) {
            menu->evaluate_js(
                    "window.bunnyhopNativeMenu?.onActivity?.(" + activity.sample(activity_active).dump() + ")"
            );
            activity_time = now;
        }
        if (menu && menu_ready && (menu->visible() || !room.id.empty())
            && (now - ui_time >= std::chrono::milliseconds(200) || !backdrop_call.empty()
                || (!opt.menu_smoke.empty() && (renderer || opt.menu_home_smoke) && !download.valid()
                    && !smoke_requested))) {
            const bool visible = menu->visible();
            const bool full = menu_state.needs_full(visible);
            nlohmann::json state;
            if (visible || full) {
                std::string progress;
                nlohmann::json progress_detail;
                {
                    std::lock_guard lock(progress_mutex);
                    progress = loading;
                    progress_detail = load_progress;
                }
                // The game window, as the web reports its page: logical size plus pixel density.
                int window_w = 0, window_h = 0;
                SDL_GetWindowSize(window.get(), &window_w, &window_h);
                const nlohmann::json client_info = {
                        {"version", identity.value("version", std::string("local"))},
                        {"build", identity.value("build", std::string("bunnyhop-native/local"))},
                        {"gpu", gpu_renderer},
                        {"viewport", {window_w, window_h}},
                        {"dpr", std::round(SDL_GetWindowPixelDensity(window.get()) * 100) / 100}
                };
                state = {
                        {"capabilities", native::native_capabilities()},
                        {"engine", "native"},
                        {"renderer", "opengl"},
                        {"client", client_info},
                        {"map", map_id},
                        {"loading", progress},
                        {"loadProgress", progress_detail},
                        {"error", error},
                        {"sensitivity", input.sensitivity},
                        {"paused", !captured},
                        {"recordingPath", recorder.path},
                        {"player",
                         {{"map", map_id},
                          {"style", viewer.active ? viewer.session.info.value("style", active_style) : active_style},
                          {"track", viewer.active ? viewer.session.info.value("track", active_track) : active_track},
                          {"mode",
                           viewer.active                              ? "replay"
                           : !room.id.empty()                         ? "multiplayer"
                           : !gauntlet_id.empty()                     ? "gauntlet"
                           : (practice.active || tutorial_practice()) ? "practice"
                                                                      : "solo"},
                          {"practice", practice.active || map_id == native::TutorialRunner::map_id}}},
                        {"practice",
                         practice.state(
                                 practice_reason(),
                                 third_person && !viewer.active && !room.spectator_target,
                                 prefs.practice_keep_velocity
                         )},
                        {"gauntlet",
                         {{"id", gauntlet_id.empty() ? nlohmann::json(nullptr) : nlohmann::json(gauntlet_id)},
                          {"map", gauntlet_map.empty() ? nlohmann::json(nullptr) : nlohmann::json(gauntlet_map)}}},
                        {"style", selected_style},
                        {"track", active_track},
                        {"room",
                         {{"id", room.id},
                          {"map", room.map},
                          {"spectating", spectator.has_value()},
                          {"target", spectator ? nlohmann::json(*spectator) : nlohmann::json(nullptr)},
                          {"raceFrozen", room_modes.frozen()}}},
                        {"tutorial",
                         tutorial_runner.lesson ? tutorial_runner.lesson->stateJSON()
                                                : nlohmann::
                                                          json{{"active", false},
                                                               {"lesson", "jump"},
                                                               {"completed", tutorial_runner.completed}}},
                        {"playback", viewer.state(curr.tick, run_state.seconds, dt)},
                        {"ghost",
                         {{"enabled", ghosts.enabled},
                          {"id", ghosts.id},
                          {"name",
                           ghosts.info.is_object() ? ghosts.info.value("player", std::string("Ghost")) : "Ghost"}}},
                        {"replayCompare", replay_compare.state()},
                        {"surfaceTools", renderer ? renderer->surface_tools_state() : nlohmann::json(nullptr)},
                        {"graphicsLimits", renderer ? renderer->graphics_limits() : nlohmann::json(nullptr)},
                        {"runGeneration", heartbeat.generation},
                        {"timer",
                         {{"status", run_state.status},
                          {"seconds", run_state.seconds},
                          {"timeMs", native::score_ms(run_state.seconds)},
                          {"jumps", run_state.jumps},
                          {"strafes", run_state.strafes},
                          {"sync", run_state.sync_percent}}},
                        {"videoExport", video_state()},
                        {"music", audio.music_state()},
                        {"audio", audio.status()},
                        {"discord",
                         {{"state", discord_allowed ? discord.state : "disabled"}, {"message", discord.message}}},
                        {"backdrop",
                         backdrop ? backdrop->state(backdrop_source)
                                  : nlohmann::json{
                                            {"status", "idle"},
                                            {"map", ""},
                                            {"renderer", "native-bsp"},
                                            {"kind", "tour"},
                                            {"shots", 0},
                                            {"source", ""},
                                            {"error", ""}
                                    }}
                };
                native::render_playback_state(state, replay_compare, viewer.session.range.tick_interval);
                state["ghosts"] = nlohmann::json::array();
                for (unsigned slot = 0; slot < 4; slot++) {
                    const auto &g = ghosts.slots[slot];
                    if (g.handle)
                        state["ghosts"].push_back(
                                {{"slot", slot},
                                 {"id", g.id},
                                 {"name", g.info.value("player", std::string("Ghost"))},
                                 {"enabled", g.enabled},
                                 {"map", map_id},
                                 {"style", g.info.value("style", std::string("autohop"))},
                                 {"track", g.info.value("track", 0u)}}
                        );
                }
                const auto &m = mouse_diagnostics.last;
                const int sdl_version = SDL_GetVersion();
                const nlohmann::json mouse_state = {
                        {"active", mouse_diagnostics.active},
                        {"seconds", m.seconds},
                        {"eventsPerSecond", m.events_per_second},
                        {"events", m.events},
                        {"peakBurst", m.peak_burst},
                        {"averageAgeMs", m.average_age_ms},
                        {"maxAgeMs", m.max_age_ms},
                        {"maxPumpMs", m.max_pump_ms},
                        {"relative", SDL_GetWindowRelativeMouseMode(window.get())},
                        {"systemScaling", SDL_GetHintBoolean(SDL_HINT_MOUSE_RELATIVE_SYSTEM_SCALE, false)},
                        {"sdl",
                         std::to_string(SDL_VERSIONNUM_MAJOR(sdl_version)) + "."
                                 + std::to_string(SDL_VERSIONNUM_MINOR(sdl_version)) + "."
                                 + std::to_string(SDL_VERSIONNUM_MICRO(sdl_version))}
                };
                auto diagnostics_state = mouse_state;
                const auto &stamps = input_timeline.stamps();
                diagnostics_state.update(native::diagnostics_json(frame_diagnostics, stamps, input_timeline.timed()));
                const std::string diagnostics_event =
                        "new CustomEvent('bunnyhop:mouse-diagnostics',{detail:" + diagnostics_state.dump() + "})";
                menu->evaluate_js("window.dispatchEvent(" + diagnostics_event + ")");
                const auto update_state = updater.state().dump();
                if (update_state != last_update) {
                    menu->evaluate_js(
                            "window.dispatchEvent(new CustomEvent('bunnyhop:update',{detail:" + update_state + "}))"
                    );
                    last_update = update_state;
                }
                {  // Settings -> Game data
                    std::optional<std::string> picked;
                    std::string pick_error;
                    bool picking = false;
                    {
                        std::lock_guard lock(data_picker.m);
                        picking = data_picker.open;
                        if (data_picker.done) {
                            data_picker.done = false;
                            picked = std::move(data_picker.result);
                            data_picker.result.reset();
                            pick_error = std::move(data_picker.error);
                            data_picker.error.clear();
                        }
                    }
                    if (picked)
                        data_choice = data_location::choose(data_location::from_utf8(*picked), cache, default_root);
                    else if (!pick_error.empty())
                        data_notice = "Folder picker: " + pick_error;
                    nlohmann::json data_state = {
                            {"path", data_location::utf8(cache)},
                            {"defaultPath", data_location::utf8(default_root)},
                            {"isDefault", data_location::same(cache, default_root)},
                            {"configured", data_location::utf8(location.active)},
                            {"unavailable", data_unavailable},
                            {"pending",
                             location.pending ? nlohmann::json(data_location::utf8(*location.pending))
                                              : nlohmann::json(nullptr)},
                            {"picking", picking},
                            {"notice", data_notice},
                            {"choice",
                             data_choice ? nlohmann::
                                                   json{{"path", data_location::utf8(data_choice->target)},
                                                        {"problem", data_choice->problem}}
                                         : nlohmann::json(nullptr)}
                    };
                    const auto encoded_data = data_state.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
                    if (encoded_data != last_data_state) {
                        menu->evaluate_js(
                                "window.dispatchEvent(new CustomEvent('bunnyhop:data-folder',{detail:" + encoded_data
                                + "}))"
                        );
                        last_data_state = encoded_data;
                    }
                }
            } else {
                state = room_menu_state.update(
                        {.map = map_id,
                         .selected_style = selected_style,
                         .active_style = active_style,
                         .room_id = room.id,
                         .room_map = room.map,
                         .track = active_track,
                         .generation = heartbeat.generation,
                         .target = spectator,
                         .loading = download.valid(),
                         .practice = practice.active,
                         .frozen = room_modes.frozen()}
                );
            }
            if (!state.is_null()) {
                const auto script = menu_state.publish(std::move(state), visible, preferences, replay_list);
                if (!script.empty()) menu->evaluate_js(script);
            }
            ui_time = now;
        }
        if (!backdrop_call.empty()) {
            menu->evaluate_js(backdrop_call);
            if (backdrop_log)
                std::cout << "Native menu backdrop: " << backdrop_source << " " << backdrop_shown
                          << " (live=" << backdrop_live << ")" << std::endl;
        }
        frame_diagnostics.mark(native::FrameDiagnostics::kMenu, SDL_GetTicksNS());
        menu_smoke.frame(now, started);
        const double elapsed = std::chrono::duration<double>(now - title_time).count();
        if (elapsed >= .5) {
            display_fps = title_frames / elapsed;
            char title[320];
            std::snprintf(
                    title,
                    sizeof(title),
                    "%s | %s | %.0f FPS | %.1f u/s | %.2fs | %s | Esc menu | R restart",
                    native::app_name,
                    map_id.c_str(),
                    title_frames / elapsed,
                    std::hypot(curr.velocity[0], curr.velocity[1]),
                    run_state.seconds,
                    captured ? "SDL raw input" : "paused"
            );
            SDL_SetWindowTitle(window.get(), title);
            title_time = now;
            title_frames = 0;
        }
        if (opt.frames && renderer
            && (curr.tick >= opt.frames || (viewer.active && viewer.paused && curr.tick >= viewer.session.range.to))) {
            running = false;
        }
        frame_diagnostics.mark(native::FrameDiagnostics::kOther, SDL_GetTicksNS());
        graphics_menu_pacer.frame(
                bool(core),
                backdrop_drawn && !backdrop_still,
                focused,
                download.valid(),
                bool(opt.frames),
                captured,
                menu && menu->visible(),
                std::chrono::duration<double>(Clock::now() - frame_started).count(),
                SDL_DelayNS,
                SDL_DelayPrecise
        );
        frame_diagnostics.mark(native::FrameDiagnostics::kSleep, SDL_GetTicksNS());
    }
    save_window();
    if (!opt.frames && opt.runtime_smoke.empty()) {
        run_history.persist(json_writer, cache, activity, double(SDL_GetTicksNS()) / run_second_ns, true);
    }
    frame_pacer.release(gl);
    if (core) bh_record_end(core.get());
    capture(false);
    std::cout << "Rendered " << frame << " frames; simulation tick " << curr.tick << "; position " << curr.position[0]
              << ' ' << curr.position[1] << ' ' << curr.position[2]
              << (renderer ? "; exposure " + std::to_string(renderer->exposure()) : std::string()) << '\n';
    return viewer.failed || (!opt.menu_smoke.empty() && !smoke_pass) ? 1 : 0;
}
}  // namespace

int main(int argc, char **argv) {
    bool interactive_errors = true;
    // Scripted checks must also exit on failure without a modal alert. Inspect
    // flags before parsing so malformed smoke invocations cannot wait for input.
    for (int i = 1; i < argc; ++i)
        if (std::string(argv[i]) == "--hidden" || std::string(argv[i]) == "--menu-smoke"
            || std::string(argv[i]) == "--menu-home-smoke" || std::string(argv[i]) == "--runtime-smoke")
            interactive_errors = false;
    try {
        native::Options opt = native::options(argc, argv);
        if (opt.help) {
            native::print_help(std::cout);
            return 0;
        }
        const int code = run(opt);
        if (relaunch_requested && !native::relaunch(native::executable_path()))
            std::cerr << "Bunnyhop native: could not restart; start the game again to move your data\n";
        return code;
    } catch (const std::exception &error) {
        std::cerr << "Bunnyhop native: " << error.what() << '\n';
        if (interactive_errors) SDL_ShowSimpleMessageBox(SDL_MESSAGEBOX_ERROR, native::app_name, error.what(), nullptr);
        return 1;
    }
}
