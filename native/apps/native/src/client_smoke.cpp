#include "client_smoke.hpp"
#include "options.hpp"
#include "game_session.hpp"
#include "renderer.hpp"
#include "hud.hpp"
#include "online.hpp"
#include "menu_backdrop.hpp"
#include "presentation_smoke.hpp"
#include "hud_smoke.hpp"
#include "replay_player.hpp"
#include "menu_webview.hpp"
#include "map_download.hpp"
#include "data_location.hpp"
#include <fstream>
#include <iostream>
#include <stdexcept>

namespace native {
namespace {

using Clock = std::chrono::steady_clock;
constexpr uint32_t restored_tick = 37;
constexpr std::array<float, 3> free_camera_position_units{11, 22, 33};
constexpr float free_camera_yaw_degrees = 42;
constexpr float free_camera_pitch_degrees = 17;
constexpr double camera_angle_tolerance_degrees = .0001;
constexpr uint32_t export_ticks = 200;
constexpr uint32_t encoder_failure_ticks = 100;
constexpr int cancel_after_frames = 3;
constexpr int smoke_width_pixels = 640;
constexpr int smoke_height_pixels = 360;
constexpr double music_offset_seconds = 12;
constexpr double music_volume_fraction = 1;
constexpr double master_volume_fraction = .65;
constexpr auto video_timeout = std::chrono::minutes(3);
constexpr auto menu_timeout = std::chrono::seconds(90);

void require(bool ok, BhContext *core, const char *operation) {
    if (!ok) {
        const char *error = bh_last_error(core);
        throw std::runtime_error(std::string(operation) + ": " + (error && *error ? error : "native core failed"));
    }
}

}  // namespace

int run_presentation_smoke(const Options &opt, SDL_Window *window, Gl &gl, GameSession &game, NativeHud &hud) {
    if (!game.renderer || !game.core) throw std::runtime_error("Presentation smoke requires a local map");
    bh_record_end(game.core.get());
    int width = 0, height = 0;
    SDL_GetWindowSizeInPixels(window, &width, &height);
    const auto result = native::presentation_smoke(
            gl, game.core.get(), *game.renderer, hud, width, height, opt.presentation_smoke, game.map_id
    );
    native::hud_parity_smoke(gl, hud, width, height, std::filesystem::path(opt.presentation_smoke));
    std::cout << result.dump() << '\n';
    return 0;
}

VideoSmoke::VideoSmoke(VideoSmokeState state) : VideoSmokeState(state) {
}

// Exports run in their own process. The viewer must stay exactly where it was through a cancel, an encoder that
// cannot start and a completed export with music.
void VideoSmoke::begin() {
    if (!opt.video_smoke.empty()) {
        viewer.paused = true;
        BhSnapshot restored{};
        require(bh_replay_seek(game.core.get(), restored_tick, &restored), game.core.get(), "Video smoke initial seek");
        curr = prev = restored.player;
        viewer.camera.set_mode("free");
        viewer.camera.initialized = true;
        viewer.camera.position = free_camera_position_units;
        viewer.camera.yaw = free_camera_yaw_degrees;
        viewer.camera.pitch = free_camera_pitch_degrees;
        camera_controls.set_angles(free_camera_pitch_degrees, free_camera_yaw_degrees);
        game.video.wait_probe();
        native::VideoOptions options;
        options.width = smoke_width_pixels;
        options.height = smoke_height_pixels;
        options.full_recording = true;
        options.to = std::min(export_ticks, viewer.session.range.total);
        options.camera = "auto";
        game.video.request(options, "smoke cancel");
    }
    video_smoke_encoder = game.video.available.encoder;
    video_smoke_started = Clock::now();
}

void VideoSmoke::check_restored() const {
    if (!viewer.paused || curr.tick != restored_tick || viewer.camera.mode != "free" || !viewer.camera.initialized
        || viewer.camera.position != free_camera_position_units
        || std::abs(viewer.camera.yaw - free_camera_yaw_degrees) > camera_angle_tolerance_degrees
        || std::abs(viewer.camera.pitch - free_camera_pitch_degrees) > camera_angle_tolerance_degrees)
        throw std::runtime_error("Video export moved the viewer");
}

void VideoSmoke::request_music() {
    native::VideoOptions options;
    options.width = smoke_width_pixels;
    options.height = smoke_height_pixels;
    options.full_recording = true;
    options.to = std::min(export_ticks, viewer.session.range.total);
    options.camera = "auto";
    options.music = "game-airstrafe";
    options.music_offset = music_offset_seconds;
    // Smoke-only soundtrack. Regular exports keep the explicit No music default.
    preferences["musicPack"] = "default";
    preferences["muted"] = false;
    preferences["muteMusic"] = false;
    preferences["musicVolume"] = music_volume_fraction;
    preferences["volume"] = master_volume_fraction;
    game.video.request(options, "smoke music");
}

void VideoSmoke::frame(bool &running) {
    if (opt.video_smoke.empty()) return;
    const auto result = game.video.state();
    const auto phase = result.value("state", std::string());
    check_restored();
    if (video_smoke_stage == 0 && phase == "capturing" && result.value("frames", 0) >= cancel_after_frames) {
        game.video.cancel();
        video_smoke_stage = 1;
    } else if (video_smoke_stage == 1 && phase == "canceled") {
        game.video.available.encoder = "/bunnyhop-test-missing-encoder";
        native::VideoOptions options;
        options.width = smoke_width_pixels;
        options.height = smoke_height_pixels;
        options.full_recording = true;
        options.to = encoder_failure_ticks;
        game.video.request(options, "smoke missing encoder");
        video_smoke_stage = 2;
    } else if (video_smoke_stage == 2 && phase == "error") {
        game.video.available.encoder = video_smoke_encoder;
        request_music();
        video_smoke_stage = 3;
    } else if (video_smoke_stage == 3 && phase == "completed") {
        auto proof = result;
        proof["restoredTick"] = curr.tick;
        proof["viewerUntouched"] = true;
        std::ofstream(native::data_location::from_utf8(opt.video_smoke) / "result.json") << proof.dump(2) << '\n';
        running = false;
    } else if (video_smoke_stage == 3 && (phase == "error" || phase == "canceled"))
        throw std::runtime_error("Video smoke failed: " + result.dump());
    else if (Clock::now() - video_smoke_started > video_timeout)
        throw std::runtime_error("Video smoke timed out");
}

MenuSmoke::MenuSmoke(const Options &options) : opt(options) {
}

void MenuSmoke::bind(Context context) {
    context_.emplace(context);
}

void MenuSmoke::receive(nlohmann::json &message) {
    auto &context = *context_;
    message["engine"] = "native";
    message["renderer"] = "opengl";
    message["map"] = context.game.map_id;
    message["nativeTick"] = context.curr.tick;
    message["backdropHost"] =
            context.backdrop ? context.backdrop->state(context.backdrop_source) : nlohmann::json(nullptr);
    message["backdropShown"] = context.backdrop_shown;
    const auto ui_backdrop = message.value("backdrop", std::string());
    // Home: the real map tour the menu asked for is on screen
    // behind the web home. Pause: the loaded map itself.
    const bool matches_screen =
            opt.menu_home_smoke
                    ? context.game.map_id.empty() && message.value("screen", std::string()) == "home"
                              && message.value("uiMap", std::string()).empty() && message.value("tiles", 0) >= 1
                              && message.value("attractLive", false) && context.backdrop
                              && context.backdrop->status() == MenuBackdrop::Status::ready
                              && !context.backdrop_shown.empty() && context.backdrop_shown == context.backdrop->map()
                              && context.backdrop->shots() > 0
                    : !context.game.map_id.empty() && message.value("screen", std::string()) == "pause"
                              && message.value("uiMap", std::string()) == context.game.map_id
                              && context.backdrop_shown == context.game.map_id && bool(context.game.renderer);
    passed = message.value("apiStatus", 0) == 200 && message.value("origin", std::string()) == "https://bunnyhop.lol"
             && message.value("webglAttempts", 1) == 0 && message.value("webglContexts", 1) == 0
             && message.value("canvasCount", 1) == 0 && message.value("controlsVisible", false) && matches_screen
             && (ui_backdrop == "scene" || (ui_backdrop == "static" && message.value("stillShown", false)));
    message["pass"] = passed;
    std::ofstream(opt.menu_smoke + ".json") << message.dump(2) << '\n';
    std::cout << "Native menu smoke: " << message.dump() << '\n';
    capture_images();
}

void MenuSmoke::capture_images() {
    auto &context = *context_;
    int w = 0, h = 0;
    SDL_GetWindowSizeInPixels(context.window, &w, &h);
    if (context.game.renderer) context.game.renderer->screenshot(opt.menu_smoke + "-game.ppm", w, h);
    // The exact native frame the menu was handed.
    if (!context.backdrop_png.empty())
        std::ofstream(opt.menu_smoke + "-scene.png", std::ios::binary)
                .write(context.backdrop_png.data(), context.backdrop_png.size());
    snapshot_pending = context.menu->screenshot(opt.menu_smoke + ".png");
    if (!snapshot_pending) {
        passed = false;
        context.running = false;
    }
}

void MenuSmoke::snapshot(const nlohmann::json &message) {
    auto &context = *context_;
    passed = passed && message.value("ok", false);
    context.running = false;
}

void MenuSmoke::frame(Clock::time_point now, Clock::time_point started) {
    auto &context = *context_;
    if (!opt.menu_smoke.empty() && !opt.online_map.empty() && context.menu && context.menu_ready && !map_requested)
        request_map();
    const bool smoke_backdrop = opt.menu_home_smoke
                                        ? !context.game.renderer && context.backdrop
                                                  && ((context.backdrop->status() == MenuBackdrop::Status::ready
                                                       && !context.backdrop_shown.empty()
                                                       && context.backdrop_shown == context.backdrop->map())
                                                      || context.backdrop->status() == MenuBackdrop::Status::failed)
                                        : context.game.renderer && !context.game.map_id.empty()
                                                  && context.backdrop_shown == context.game.map_id
                                                  && !context.gameplay_backdrop_due;
    if (context.menu && context.menu_ready && smoke_backdrop && !context.download.valid() && !opt.menu_smoke.empty()
        && !requested) {
        requested = true;
        request();
    }
    if (!opt.menu_smoke.empty() && now - started > menu_timeout)
        throw std::runtime_error(
                "Native menu smoke timed out (ready=" + std::to_string(context.menu_ready) + ", backdrop="
                + (context.backdrop ? context.backdrop->state(context.backdrop_source).dump() : std::string("none"))
                + ", shown=" + context.backdrop_shown + ", requested=" + std::to_string(requested)
                + ", snapshot=" + std::to_string(snapshot_pending) + "): " + context.error
        );
}

void MenuSmoke::request_map() {
    map_requested = true;
    const nlohmann::json message = {{"type", "selectMap"}, {"id", opt.online_map}, {"style", opt.style}, {"track", 0}};
    context_->menu->evaluate_js(
            "window.webkit.messageHandlers.bunnyhop.postMessage(" + nlohmann::json(message.dump()).dump() + ")"
    );
}

void MenuSmoke::request() {
    auto &context = *context_;
    std::cout << "Native menu smoke: checking " << (opt.menu_home_smoke ? "home" : context.game.map_id) << std::endl;
    // App-owned integration check: reads the same live account API as the menu; never submits a run.
    context.menu->evaluate_js(
            "(()=>{const home=" + std::string(opt.menu_home_smoke ? "true" : "false")
            + ",expected=" + nlohmann::json(context.game.map_id).dump() + R"JS(;
                const post=value=>window.webkit.messageHandlers.bunnyhop.postMessage(JSON.stringify({type:'smoke',...value}));
                let attempts=0;
                // Painted, not merely present: on screen, and no ancestor hidden,
                // collapsed or still faded in (an entrance stuck at opacity 0).
                const visible=element=>{
                    if(!element?.isConnected || element.disabled) return false;
                    const rect=element.getBoundingClientRect();
                    if(rect.width<=0 || rect.height<=0 || rect.right<=0 || rect.bottom<=0 || rect.left>=innerWidth || rect.top>=innerHeight) return false;
                    let opacity=1;
                    for(let node=element;node;node=node.parentElement) {
                        const style=getComputedStyle(node);
                        if(style.display==='none' || style.visibility!=='visible' || style.contentVisibility==='hidden') return false;
                        opacity*=Number(style.opacity);
                    }
                    return opacity>.95;
                };
                const check=()=>{
                    const screen=document.body.dataset.screen??'';
                    const uiMap=document.body.dataset.map??'';
                    const buttons=[...document.querySelectorAll('.home-menu button, .rail-list button')].filter(visible);
                    const primary=document.querySelector(home?'.home-menu .home-item.primary':'.rail-list .rail-item.primary');
                    const tiles=[...document.querySelectorAll('.home-tile')].filter(visible).length;
                    const backdrop=document.documentElement.dataset.nativeBackdrop??'';
                    // A static backdrop is the host's PNG, decoded and showing (the scrim sits above it, not around it).
                    const still=document.querySelector('#native-backdrop > img.native-backdrop-still');
                    const stillShown=backdrop!=='static' || (!!still && still.complete && still.naturalWidth>0 && visible(still));
                    const attractLive=document.body.classList.contains('attract-live');
                    const status=document.getElementById('native-status')?.textContent??'';
                    const matchesScreen=home?screen==='home' && uiMap==='' && tiles>=1 && attractLive:screen==='pause' && uiMap===expected;
                    const controlsVisible=buttons.length>=3 && !!primary && visible(primary);
                    const facts={screen,uiMap,tiles,attractLive,controlsVisible,controls:buttons.length,backdrop,stillShown,status};
                    if(!matchesScreen || !controlsVisible || !backdrop || !stillShown || status) {
                        if(++attempts<100) {setTimeout(check,100);return;}
                        post({error:(home?'Home':'Loaded-map')+' controls did not become ready',...facts});return;
                    }
                    fetch('/api/me',{credentials:'include'}).then(async r=>{await window.bunnyhopNativeMenu?.settle?.();post({apiStatus:r.status,origin:location.origin,
                        canvasCount:document.querySelectorAll('canvas').length,webglAttempts:window.__nativeMenuGraphics?.attempts,webglContexts:window.__nativeMenuGraphics?.contexts,
                        ...facts});}).catch(e=>post({error:String(e)}));
                };
                setTimeout(check,300);
            })())JS"
    );
}

}  // namespace native
