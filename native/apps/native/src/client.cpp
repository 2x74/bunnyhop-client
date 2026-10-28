#include "bunnyhop_native.h"
#include "native_input.hpp"
#include "mouse_diagnostics.hpp"
#include "native_math.hpp"
#include "menu_webview.hpp"
#include "online.hpp"
#include "renderer.hpp"
#include "menu_backdrop.hpp"
#include "loadout_preview.hpp"
#include "menu_gamepad.hpp"
#include "hud.hpp"
#include "practice.hpp"
#include "leave_hold.hpp"
#include "native_chat.hpp"
#include "sniper_zoom.hpp"
#include "activity.hpp"
#include "weapon_menu.hpp"
#include "start_point.hpp"
#include "weapon_commands.hpp"
#include "replay_camera.hpp"
#include "replay_controls.hpp"
#include "map_jobs.hpp"
#include "ssj.hpp"
#include "strafe_trainer.hpp"
#include "audio.hpp"
#include "client_util.hpp"
#include "run_vault.hpp"
#include "app_identity.hpp"
#include "room_state.hpp"
#include "room_modes.hpp"
#include "tutorial.hpp"
#include "discord_rpc.hpp"
#include "data_location.hpp"
#include "relaunch.hpp"
#ifdef __APPLE__
#include <mach-o/dyld.h>
#endif
#include "../packaging/executable_identity.hpp"
#include "../packaging/assets_identity.hpp"
#include "../packaging/release_identity.hpp"
#include "native_update.hpp"
#include "update_config.hpp"
#include "video_capture.hpp"
#include "presentation_smoke.hpp"
#include "window_sdl.hpp"
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
struct Options {
    std::string map, content_root, screenshot, online_map, menu_html = BUNNYHOP_MENU_HTML, menu_smoke;
    uint64_t frames = 0;
    double sensitivity = 2;
    bool hidden = false, help = false, no_menu = false, windowed = false, sensitivity_set=false, menu_home_smoke=false;
    std::string style="autohop", replay,tutorial_lesson,runtime_smoke,video_smoke,presentation_smoke;bool tutorial_demo=false;
    // Render checks: a fixed eye (Source x, y, z) and pitch, yaw, with no HUD or viewmodel.
    std::optional<std::array<float,5>> camera;
};
Options options(int argc, char **argv) {
    Options out;
    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        auto value = [&]() -> std::string { if (++i >= argc) throw std::runtime_error("Missing value for " + arg); return argv[i]; };
        if(arg=="--presentation-smoke"){out.presentation_smoke=value();out.hidden=true;out.no_menu=true;}
        else if(arg=="--video-smoke"){out.video_smoke=value();out.hidden=true;out.no_menu=true;}
        else if(arg=="--runtime-smoke"){out.runtime_smoke=value();out.hidden=true;out.no_menu=true;}
        else if(arg=="--tutorial")out.tutorial_lesson=value();
        else if(arg=="--tutorial-demo")out.tutorial_demo=true;
        else if(arg=="--style") out.style=value();
        else if(arg=="--replay") out.replay=value();
        else if (arg == "--map") out.map = value();
        else if (arg == "--online-map") out.online_map = value();
        else if (arg == "--menu-html") out.menu_html = value();
        else if (arg == "--menu-smoke") out.menu_smoke = value();
        else if (arg == "--menu-home-smoke") {out.menu_smoke=value();out.menu_home_smoke=true;}
        else if (arg == "--no-menu") out.no_menu = true;
        else if (arg == "--windowed") out.windowed = true;
        else if (arg == "--content-root") out.content_root = value();
        else if (arg == "--screenshot") out.screenshot = value();
        else if (arg == "--camera") {
            std::array<float,5> view{};std::stringstream parts(value());std::string part;size_t n=0;
            while(std::getline(parts,part,',')){if(n==5)throw std::runtime_error("--camera takes x,y,z,pitch,yaw");size_t used=0;view[n]=std::stof(part,&used);if(used!=part.size()||!std::isfinite(view[n]))throw std::runtime_error("--camera takes x,y,z,pitch,yaw");n++;}
            if(n!=5)throw std::runtime_error("--camera takes x,y,z,pitch,yaw");out.camera=view;
        }
        else if (arg == "--sensitivity") {
            out.sensitivity_set=true;const auto s=value(); size_t n=0; out.sensitivity=std::stod(s,&n);
            if(n!=s.size() || !std::isfinite(out.sensitivity) || out.sensitivity<=0) throw std::runtime_error("--sensitivity must be a positive finite number");
        }
        else if (arg == "--frames") {
            const auto s = value(); size_t n = 0;
            if (s.empty() || s[0] == '-') throw std::runtime_error("--frames must be positive");
            out.frames = std::stoull(s, &n);
            if (n != s.size() || out.frames == 0) throw std::runtime_error("--frames must be positive");
        } else if (arg == "--hidden") out.hidden = true;
        else if (arg == "--help" || arg == "-h") out.help = true;
        else throw std::runtime_error("Unknown argument: " + arg);
    }
    if(!out.runtime_smoke.empty()&&(out.map.empty()||!out.online_map.empty()||out.replay.empty()))throw std::runtime_error("Runtime smoke requires a local --map and --replay");
    if(!out.tutorial_lesson.empty()&&out.tutorial_lesson!="jump"&&out.tutorial_lesson!="strafe"&&out.tutorial_lesson!="speed"&&out.tutorial_lesson!="final")throw std::runtime_error("Unknown tutorial lesson");
    if(!native::styles.contains(out.style))throw std::runtime_error("Unknown movement style");
    if (!out.screenshot.empty() && !out.frames) out.frames = 1;
    if (!out.map.empty() && !out.online_map.empty()) throw std::runtime_error("Choose --map or --online-map");
    if (!out.online_map.empty() && !native::valid_map_id(out.online_map)) throw std::runtime_error("Invalid online map name");
    if (out.map.empty() && out.online_map.empty() && (out.no_menu || out.frames) && !out.help)
        throw std::runtime_error("This mode needs --map or --online-map");
    if(out.menu_home_smoke && (!out.map.empty()||!out.online_map.empty()||out.frames||out.no_menu||!out.replay.empty()||!out.tutorial_lesson.empty()))
        throw std::runtime_error("Home menu smoke must start without a map or gameplay mode");
    return out;
}

uint32_t key_bit(SDL_Scancode key) {
    switch(key) {
        case SDL_SCANCODE_W: return native::forward; case SDL_SCANCODE_S: return native::back;
        case SDL_SCANCODE_A: return native::left; case SDL_SCANCODE_D: return native::right;
        case SDL_SCANCODE_SPACE: return native::jump; case SDL_SCANCODE_LCTRL: case SDL_SCANCODE_RCTRL: return native::duck;
        case SDL_SCANCODE_E: return native::use; default: return 0;
    }
}
void require(bool ok,BhContext *ctx,const char *operation) {
    if (!ok) { const char *error=bh_last_error(ctx); throw std::runtime_error(std::string(operation)+": "+(error&&*error?error:"native core failed")); }
}

std::string read_text(const std::filesystem::path &path) {
    std::ifstream file(path, std::ios::binary);
    if (!file) throw std::runtime_error("Cannot open " + path.string());
    return {std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>()};
}

std::string base64(const std::string &bytes) {
    static constexpr char alphabet[]="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out; out.reserve((bytes.size()+2)/3*4);
    for(size_t i=0;i<bytes.size();i+=3) {
        const uint32_t n=(uint32_t(uint8_t(bytes[i]))<<16) |
            (i+1<bytes.size()?uint32_t(uint8_t(bytes[i+1]))<<8:0) | (i+2<bytes.size()?uint8_t(bytes[i+2]):0);
        out+=alphabet[(n>>18)&63];out+=alphabet[(n>>12)&63];
        out+=i+1<bytes.size()?alphabet[(n>>6)&63]:'=';out+=i+2<bytes.size()?alphabet[n&63]:'=';
    }
    return out;
}

std::string file_hash(const std::filesystem::path &path,const std::string &mode="sha256") {
    const auto raw=read_text(path);const std::vector<uint8_t> source(raw.begin(),raw.end());const auto bytes=native::executable_identity_bytes(source,mode);char hash[65]{};
    if(!bh_sha256(reinterpret_cast<const uint8_t *>(bytes.data()),bytes.size(),hash))
        throw std::runtime_error("Could not hash "+path.string());
    return hash;
}

std::filesystem::path executable_path() {
#ifdef __APPLE__
    uint32_t count=4096;std::vector<char> path(count);if(_NSGetExecutablePath(path.data(),&count)!=0){path.resize(count);if(_NSGetExecutablePath(path.data(),&count)!=0)throw std::runtime_error("Cannot locate native executable");}return std::filesystem::weakly_canonical(path.data());
#elif defined(__linux__)
    return std::filesystem::read_symlink("/proc/self/exe");
#else
    return std::filesystem::path(SDL_GetBasePath())/"bunnyhop-native.exe";
#endif
}

std::vector<BhZone> timer_zones(const nlohmann::json &detail) {
    std::vector<BhZone> out;
    if (!detail.contains("zones") || !detail["zones"].is_object()) return out;
    for (const auto &z : detail["zones"].value("zones", nlohmann::json::array())) {
        const auto kind=z.at("kind").get<std::string>();
        BhZone zone{};
        if(kind=="start") zone.kind=0; else if(kind=="end") zone.kind=1;
        else if(kind=="stage") zone.kind=2; else if(kind=="checkpoint") zone.kind=3; else continue;
        zone.track=z.value("track",0u); zone.index=z.value("index",0u);
        for(int i=0;i<3;++i) {zone.mins[i]=z.at("mins").at(i).get<float>();zone.maxs[i]=z.at("maxs").at(i).get<float>();}
        out.push_back(zone);
    }
    return out;
}

// Settings -> Game data: set by "Move now"; main() starts a fresh copy once run()
// has returned and every file in the old data folder is closed.
static bool relaunch_requested=false;
// The system folder picker answers on its own schedule (possibly another thread);
// static so a late answer during shutdown never lands in freed memory.
struct DataFolderPicker{std::mutex m;bool open=false,done=false;std::optional<std::string> result;std::string error;};
static DataFolderPicker data_picker;
static void data_folder_picked(void *userdata,const char *const *files,int){
    auto *picker=static_cast<DataFolderPicker*>(userdata);std::lock_guard lock(picker->m);
    picker->open=false;picker->done=true;if(!files)picker->error=SDL_GetError();else if(files[0])picker->result=files[0];
}

int run(const Options &opt) {
    using CorePtr=std::unique_ptr<BhContext,decltype(&bh_destroy)>;
    CorePtr core(nullptr,&bh_destroy);
    if (bh_abi_version()!=1) throw std::runtime_error("Unsupported native core ABI version");
    BhSettings settings{}; bh_default_settings(&settings);
    const double dt=settings.tick_interval;
    if (!std::isfinite(dt) || dt<=0 || dt>.1) throw std::runtime_error("Invalid core tick interval");
    BhState curr{},prev{};
    native::Input input; input.set_sensitivity(opt.sensitivity);
    SDL_SetHint(SDL_HINT_MOUSE_RELATIVE_SYSTEM_SCALE,"0"); SDL_SetHint(SDL_HINT_MOUSE_RELATIVE_SPEED_SCALE,"1");
    SDL_SetHint(SDL_HINT_MOUSE_RELATIVE_WARP_MOTION,"0");
    SDL_SetAppMetadata(native::app_name,nullptr,native::app_id);
    if (!SDL_Init(SDL_INIT_VIDEO)) throw std::runtime_error(std::string("SDL initialization failed: ")+SDL_GetError());
    struct SdlCleanup { ~SdlCleanup(){ SDL_Quit(); } } cleanup;
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION,3); SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION,3);
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK,SDL_GL_CONTEXT_PROFILE_CORE);
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_FLAGS,SDL_GL_CONTEXT_FORWARD_COMPATIBLE_FLAG);
    SDL_GL_SetAttribute(SDL_GL_DOUBLEBUFFER,1); SDL_GL_SetAttribute(SDL_GL_DEPTH_SIZE,24);
    SDL_GL_SetAttribute(SDL_GL_STENCIL_SIZE,8);
    SDL_WindowFlags flags=SDL_WINDOW_OPENGL|SDL_WINDOW_RESIZABLE|SDL_WINDOW_HIGH_PIXEL_DENSITY;
    if(opt.hidden) flags|=SDL_WINDOW_HIDDEN;
    using WindowPtr=std::unique_ptr<SDL_Window,decltype(&SDL_DestroyWindow)>;
    WindowPtr window(SDL_CreateWindow(native::app_name,1280,720,flags),&SDL_DestroyWindow);
    if(!window) throw std::runtime_error(std::string("Creating SDL window failed: ")+SDL_GetError());
    if(!native::set_app_icon(window.get()))std::cerr<<"Could not set native app icon: "<<SDL_GetError()<<'\n';
    SDL_GLContext context=SDL_GL_CreateContext(window.get());
    if(!context) throw std::runtime_error(std::string("Creating OpenGL 3.3 core context failed: ")+SDL_GetError());
    struct ContextCleanup { SDL_GLContext ctx; ~ContextCleanup(){SDL_GL_DestroyContext(ctx);} } context_cleanup{context};
    if (!SDL_GL_MakeCurrent(window.get(),context)) throw std::runtime_error(SDL_GetError());
    SDL_GL_SetSwapInterval(opt.frames?0:1);
    Gl gl; gl.load(); std::unique_ptr<Renderer> renderer;
    // Feedback context (the menu's "Attach game info"): the GPU the game draws with, not the menu web view's.
    const std::string gpu_renderer=[&]{const auto *name=gl.GetString(GL_RENDERER);return name?std::string(reinterpret_cast<const char*>(name)):std::string();}();
    const auto assets=native::resource("native-assets",BUNNYHOP_NATIVE_ASSET_ROOT);
    const auto menu_path=opt.menu_html==BUNNYHOP_MENU_HTML?native::resource("menu.html",opt.menu_html):std::filesystem::path(opt.menu_html);
    const auto manifest_path=native::resource("native-manifest.json",BUNNYHOP_NATIVE_MANIFEST);
    NativeHud hud(gl,assets);
    native::MenuGamepad menu_gamepad;
    std::unique_ptr<NativeLoadoutPreview> loadout_preview;
    std::optional<nlohmann::json> preview_request;
    NativeHud::Layout hud_layout;
    // Resolved before the audio device so the custom sound/ and bgm/ folders
    // are known at the point the packs are first applied.
    char *pref_path=SDL_GetPrefPath("bunnyhop.lol","Bunnyhop Native");
    if(!pref_path) throw std::runtime_error("Cannot find the native client data directory");
    const std::string isolated=!opt.runtime_smoke.empty()?opt.runtime_smoke:!opt.presentation_smoke.empty()?opt.presentation_smoke:opt.video_smoke;
    namespace data_location=native::data_location;
    const std::filesystem::path default_root=std::filesystem::path(pref_path); SDL_free(pref_path);
    // Settings -> Game data: the folder may live elsewhere (another drive), and a
    // move chosen there runs here, before anything opens the data folder.
    auto location=isolated.empty()?data_location::read(default_root):data_location::Location{default_root,std::nullopt};
    std::string data_startup_notice;bool data_unavailable=false;
    auto folder_available=[](const std::filesystem::path &p){std::error_code ec;return std::filesystem::is_directory(p,ec);};
    if(location.pending){
        if(!folder_available(location.active)&&!data_location::same(location.active,default_root))
            data_startup_notice="Your game data couldn't move: "+data_location::utf8(location.active)+" isn't available. The move will run once it is.";
        else{
            const auto from=location.active,to=*location.pending;data_location::Progress progress;std::string error;std::atomic<bool> finished=false;
            std::thread worker([&]{try{error=data_location::move(from,to,default_root,progress);}catch(const std::exception &e){error=e.what();}finished=true;});
            while(!finished){
                // Quit is ignored: stopping halfway would leave data split across folders.
                SDL_Event ignored;while(SDL_PollEvent(&ignored)){}
                int w=0,h=0;SDL_GetWindowSizeInPixels(window.get(),&w,&h);gl.Viewport(0,0,w,h);gl.ClearColor(.03f,.03f,.045f,1);gl.Clear(GL_COLOR_BUFFER_BIT);
                const double total=double(progress.total.load()),done=double(progress.done.load());char line[96];
                std::snprintf(line,sizeof line,"%.0f%%   %.2f / %.2f GB",total>0?100*done/total:0.,done/1e9,total/1e9);
                hud.draw_panel(w,h,"Moving game data",{"To "+data_location::utf8(to),line,"The game starts as soon as this finishes."});
                SDL_GL_SwapWindow(window.get());SDL_Delay(33);
            }
            worker.join();
            if(error.empty()){location={to,std::nullopt};data_startup_notice="Game data moved to "+data_location::utf8(to);}
            else{location.pending.reset();data_startup_notice="Moving game data failed and nothing changed: "+error;}
            try{data_location::write(default_root,location);}catch(const std::exception &e){std::cerr<<"Data folder: "<<e.what()<<'\n';}
            std::cerr<<"Data folder: "<<data_startup_notice<<'\n';
        }
    }
    if(!data_location::same(location.active,default_root)&&!folder_available(location.active)){
        data_unavailable=true;
        data_startup_notice="Your game data folder "+data_location::utf8(location.active)+" isn't available (is the drive connected?). Using the default folder this session.";
    }
    const std::filesystem::path cache=!isolated.empty()?std::filesystem::path(isolated)/"data":data_unavailable?default_root:location.active;
    std::optional<data_location::Choice> data_choice;std::string data_notice,last_data_state;
    std::filesystem::create_directories(cache/"replays");
    // Created empty so a player looking for where their own audio goes finds
    // the folders already there rather than having to guess the names.
    {std::error_code ec;std::filesystem::create_directories(cache/"sound",ec);std::filesystem::create_directories(cache/"bgm",ec);}
    native::Audio audio(assets,cache,!opt.hidden&&!opt.frames);
    std::unique_ptr<native::MenuWebView> menu;
    const bool wants_menu=!opt.no_menu && (!opt.frames || !opt.menu_smoke.empty());
    if(wants_menu) {
        menu=std::make_unique<native::MenuWebView>(window.get(),read_text(menu_path));
        if(!menu->available()) {
            std::cerr << "Menu unavailable: " << menu->error() << '\n'; menu.reset();
        }
    }
    if(!menu && opt.map.empty() && opt.online_map.empty())
        throw std::runtime_error("Menus are unavailable on this build; use --map PATH or --online-map NAME");
    // Every download_map call shares one content cache whose temporary names
    // are deterministic, so downloads take turns. Waiting gives up once its
    // own download is cancelled, so neither worker can hold up shutdown.
    std::mutex cache_mutex;
    auto lock_cache=[&cache_mutex](const std::atomic_bool &cancel) {
        std::unique_lock lock(cache_mutex,std::defer_lock);
        while(!lock.try_lock()){if(cancel)throw std::runtime_error("Map download cancelled");std::this_thread::sleep_for(std::chrono::milliseconds(20));}
        if(cancel)throw std::runtime_error("Map download cancelled");
        return lock;
    };
    // Home-screen backdrop: the web map tour over the map the menu picked,
    // from its own native context. Released as soon as a gameplay map loads.
    std::unique_ptr<MenuBackdrop> backdrop;
    if(menu)backdrop=std::make_unique<MenuBackdrop>(gl,assets,[&lock_cache,cache](const std::string &id,const std::atomic_bool &cancel) {
        const auto lock=lock_cache(cancel);
        native::DownloadLimits limits;limits.bsp=32*1024*1024;limits.content_total=256*1024*1024;
        return native::download_map(id,cache,[](const std::string &){},&cancel,limits);
    });
    // What the menu was last told: the backdrop source and the map it shows.
    bool menu_reduced_motion=true,backdrop_cut=false,gameplay_backdrop_due=false;
    std::string backdrop_source,backdrop_shown,backdrop_failed,backdrop_png;
    auto backdrop_clock=std::chrono::steady_clock::now();
    bool captured=false,focused=true,running=true,menu_ready=false,smoke_requested=false,smoke_pass=false,smoke_snapshot=false,resume_wanted=false;
    bool recording_ended=false;
    auto preferences=native::default_settings();
    try {preferences=native::load_settings(cache/"settings.json");}catch(const std::exception &e){std::cerr<<"Settings: "<<e.what()<<'\n';}
    if(opt.sensitivity_set)preferences["sensitivity"]=opt.sensitivity;
    // Recovery: --windowed resets a display mode the player cannot leave and keeps it.
    if(opt.windowed&&preferences.value("windowMode",std::string())!="windowed"){preferences["windowMode"]="windowed";try{native::save_settings(cache/"settings.json",preferences);}catch(const std::exception &e){std::cerr<<"Settings: "<<e.what()<<'\n';}}
    native::WindowController window_controller(window.get());
    const bool persist_window=!opt.hidden&&!opt.frames&&opt.menu_smoke.empty()&&opt.runtime_smoke.empty();
    std::optional<native::WindowBounds> saved_window;
    if(persist_window)try{const auto path=cache/"window-state.json";if(std::filesystem::exists(path)&&std::filesystem::file_size(path)<=16384)saved_window=native::read_window_bounds(nlohmann::json::parse(read_text(path)));}catch(const std::exception&e){std::cerr<<"Window bounds: "<<e.what()<<'\n';}
    // While the menu is open the window may not be always-on-top, and exclusive
    // fullscreen runs as borderless: the menu (a WebView2/WKWebView child, or the
    // separate GTK window) is composited by the desktop, which exclusive mode
    // bypasses, so it would be open, focused and invisible. Gameplay with the
    // menu closed keeps the exclusive mode the player chose.
    auto window_for_menu=[&](nlohmann::json p,bool menu_open){if(menu_open){p["alwaysOnTop"]=false;if(p.value("windowMode",std::string())=="fullscreen")p["windowMode"]="borderless";}return p;};
    // Launch opens the home menu, so start as it will be shown.
    auto initial_window_preferences=window_for_menu(preferences,bool(menu));
    if(persist_window&&!window_controller.apply(initial_window_preferences,true,saved_window)){std::cerr<<"Window: "<<window_controller.error()<<'\n';preferences["windowMode"]=window_controller.mode();}
    bool window_dirty=false;auto window_save_due=std::chrono::steady_clock::now();
    auto save_window=[&](){if(!persist_window||!preferences.value("rememberWindowBounds",true))return;try{if(auto bounds=window_controller.observe_bounds())native::save_settings(cache/"window-state.json",native::window_bounds_json(*bounds));window_dirty=false;}catch(const std::exception&e){std::cerr<<"Window bounds: "<<e.what()<<'\n';}};
    std::string selected_style=opt.style,active_style=opt.style,outfit,packed_loadout,ghost_cosmetic="ghost-default",trail_cosmetic="trail-none";
    std::optional<native_render::Glow> player_glow;
    native::RoomState room;native::RoomModes room_modes;std::optional<unsigned> observed_spectator;
    auto epoch_ms=[](){return std::chrono::duration<double,std::milli>(std::chrono::system_clock::now().time_since_epoch()).count();};
    uint32_t room_events=8;auto room_time=std::chrono::steady_clock::now();
    uint32_t active_track=0,ghost_handle=0;
    struct GhostSlot {uint32_t handle=0;std::string id;bool enabled=false;nlohmann::json info;};
    std::array<GhostSlot,4> ghost_slots;unsigned pending_ghost_slot=0;
    std::string ghost_id,playback_id,pending_replay,pending_action,score_notice;
    std::optional<double> known_world_record;uint64_t world_record_generation=~uint64_t(0);
    nlohmann::json replay_list=nlohmann::json::array(),playback_info,ghost_info;
    bool playback=false,playback_paused=false,ghost_enabled=false,playback_failed=false;
    native::ReplayControls replay_controls;
    bool replay_orbit_drag=false;
    native::NativeVideoExport video_encoder;
    native::VideoAvailability video_available{false,"Checking FFmpeg availability…","ffmpeg"};
    auto video_probe=std::async(std::launch::async,[]{return native::NativeVideoExport::probe();});
    std::unique_ptr<native::VideoCapture> video_capture;
    std::unique_ptr<native::ReplayDirectorJob> director_job;
    std::optional<native::VideoOptions> pending_video;
    native::ReplayCamera prepared_camera,replay_camera,third_camera;
    bool director_only=false;std::string video_error;
    nlohmann::json video_music_catalog=nlohmann::json::array();
    auto cancel_video=[&](){video_encoder.cancel();pending_video.reset();director_job.reset();prepared_camera.cancel_direct();replay_camera.cancel_direct();video_capture.reset();video_error.clear();};
    auto video_state=[&](){auto result=video_encoder.status();result["available"]=video_available.available;result["reason"]=video_available.reason;result["musicTracks"]=video_music_catalog;if(director_job){result["state"]="capturing";result["reason"]="Preparing cinematic cameras…";result["progress"]=0;}if(!video_error.empty()){result["state"]="error";result["error"]=video_error;}return result;};
    std::string pending_room_map;
    double playback_speed=1,display_fps=0;
    constexpr const char *tutorial_map="bhop_lol_tutorial";
    std::unique_ptr<native::Tutorial> tutorial;
    nlohmann::json tutorial_completed=nlohmann::json::array();
    try {if(std::filesystem::exists(cache/"tutorial-progress.json")&&std::filesystem::file_size(cache/"tutorial-progress.json")<=4096){const auto saved=nlohmann::json::parse(read_text(cache/"tutorial-progress.json"));if(saved.is_array())tutorial_completed=saved;}}catch(const std::exception &e){std::cerr<<"Tutorial progress: "<<e.what()<<'\n';}
    std::string pending_tutorial=opt.tutorial_lesson;bool pending_tutorial_demo=opt.tutorial_demo,tutorial_demo=false,tutorial_stopped=false,tutorial_final_saved=false;
    uint32_t tutorial_demo_start=0;
    std::function<void(const std::string&,bool)> start_tutorial;
    auto save_tutorial=[&](){if(!tutorial)return;tutorial_completed=tutorial->stateJSON().at("completed");native::save_settings(cache/"tutorial-progress.json",tutorial_completed);};
    std::set<std::string> held_codes;
    native::Chat chat;
    native::RestartGuard restart_guard;
    native::StartPoints start_points;native::KeptWeapons kept_weapons;
    third_camera.set_mode("chase");
    native::Input camera_controls;
    native::SniperZoom scope;
    native::NativeWeaponMenu gun_menu;
    bool third_person=false,flashlight=false,hide_players=false,show_scores=false;
    try {const auto path=cache/"start-points.json";if(std::filesystem::exists(path)&&std::filesystem::file_size(path)<=1024*1024)start_points.load(nlohmann::json::parse(read_text(path)));}catch(const std::exception &e){std::cerr<<"Start points: "<<e.what()<<'\n';}
    auto apply_preferences=[&]() {
        hud_layout.clear();
        for(const auto &[id,at]:preferences.at("hudLayout").items())hud_layout[id]={at.at("x").get<float>(),at.at("y").get<float>()};
        input.set_sensitivity(preferences.at("sensitivity").get<double>());
        input.vertical_sensitivity=preferences.at("verticalSensitivity").get<double>();input.separate_vertical=preferences.at("separateVertical").get<bool>();input.invert_y=preferences.at("invertY").get<bool>();
        camera_controls.set_sensitivity(input.sensitivity);camera_controls.vertical_sensitivity=input.vertical_sensitivity;camera_controls.separate_vertical=input.separate_vertical;camera_controls.invert_y=input.invert_y;
        hud.preferences(preferences);audio.preferences(preferences);
        SDL_GL_SetSwapInterval(opt.frames?0:preferences.at("vsync").get<bool>()?1:0);
        audio.gain(preferences.at("muted").get<bool>()?0:preferences.at("volume").get<float>());
        audio.set_sfx_pack(preferences.at("sfxPack").get<std::string>()=="custom");
        audio.set_music_pack(preferences.at("musicPack").get<std::string>()=="custom");
        video_music_catalog=audio.export_music_catalog(preferences.at("musicPack").get<std::string>()=="custom");
        if(renderer){renderer->set_player_glow(player_glow);renderer->set_glow_visible(preferences.value("showPlayerGlow",true),preferences.value("firstPersonGlow",false));renderer->set_fov(preferences.at("fov").get<float>());renderer->set_viewmodel(preferences.at("viewmodelFov").get<float>(),preferences.at("viewmodelX").get<float>(),preferences.at("viewmodelY").get<float>(),preferences.at("viewmodelZ").get<float>(),preferences.at("viewmodelLeftHand").get<bool>(),preferences.at("viewmodel").get<bool>(),preferences.at("viewmodelBob").get<float>(),preferences.at("viewmodelSway").get<float>());renderer->set_color_blind(preferences.value("colorBlind",std::string("off")));renderer->set_actor_models(preferences.value("playerModel",std::string("bunny")),preferences.value("ghostModel",std::string("same")));renderer->set_zones_visible(preferences.value("zonesVisible",true));renderer->set_effects_visible(preferences.value("effectsVisible",true));renderer->set_triggers_visible(preferences.value("triggersVisible",false));renderer->set_clips_visible(preferences.value("clipsVisible",false));renderer->set_water_quality(preferences.value("waterQuality",std::string("simple"))=="refracted"?1:0);}
    };
    apply_preferences();
    std::string map_id,loading,error,record_path,last_ui,last_requested_map;
    native::RunVault run_vault(cache/"run-vault");std::optional<std::pair<std::string,std::string>> pending_vault_capture;
    nlohmann::json load_progress=nullptr;
    nlohmann::json identity={{"build","bunnyhop-native/local"},{"wasm",""}};
    if(std::filesystem::exists(manifest_path)) {
        try {
            const auto manifest=nlohmann::json::parse(read_text(manifest_path));
            const auto executable=executable_path();
            native::verify_release_identity(manifest,file_hash(executable,native::release_hash_mode()),file_hash(menu_path),native::assets_identity_hash(assets));
            identity=manifest;
        } catch(const std::exception &e) {std::cerr<<"Native release manifest: "<<e.what()<<"; replays remain local\n";}
    }
    native::updates::Service updater(nlohmann::json::parse(native::update_config_json),cache/"updates",identity.value("version",std::string("local")),identity.value("build",std::string("bunnyhop-native/local")));
    std::string last_update;
    // Jump stats (!ssj). Display only — it reads the same pre-state, command and
    // events the simulation already produced and never feeds anything back.
    native::MovementFeedback feedback;
    native::TurnAdmission turn_admission;
    native::Practice practice;native::LeaveHold leave_hold;
    std::string gauntlet_id,gauntlet_map;
    nlohmann::json gauntlet_progress;
    std::string toast_text;auto toast_until=std::chrono::steady_clock::time_point{};
    if(!data_startup_notice.empty()){toast_text=data_startup_notice;toast_until=std::chrono::steady_clock::now()+std::chrono::seconds(8);data_notice=data_startup_notice;}
    const native::SsjFields ssj_fields;
    auto reset_feedback=[&](bool incomplete_history=false) {
        hud.reset_history();
        BhRunState timing{}; BhSnapshot snapshot{};
        if(core){bh_run_state(core.get(),&timing);bh_snapshot(core.get(),&snapshot);}
        feedback.reset(timing.in_start!=0,snapshot.movement_mode==1,incomplete_history);
    };
    uint64_t run_generation=0;
    uint32_t beat_start=0,beat_upto=0,beat_hash=0x811c9dc5;
    bool beat_paused=false;
    auto beat_time=std::chrono::steady_clock::now();
    std::vector<BhZone> zones;
    std::mutex progress_mutex;
    native::MapJobs<native::DownloadedMap> download,prefetch;
    bool map_preparing=false;
    std::string prefetch_map,prefetch_sha,prefetch_active,prefetch_done;
    auto cancel_prefetch=[&](){prefetch.cancel();prefetch_map.clear();prefetch_sha.clear();prefetch_active.clear();};
    double accumulator=0;
    using Clock=std::chrono::steady_clock;
    native::ActivityCounter activity;activity.input(std::chrono::duration<double>(Clock::now().time_since_epoch()).count());
    auto activity_time=Clock::now();
    native::InputClock input_clock;
    // A focus, menu or restart reset: the simulation starts again from now and
    // motion from before it is dropped rather than handed to the next tick.
    auto reset_input_timing=[&]() {accumulator=0;input.clear();camera_controls.clear();SDL_FlushEvent(SDL_EVENT_MOUSE_MOTION);input_clock.reset();leave_hold.cancel();restart_guard.cancel();};
    auto capture=[&](bool on) {
        if(chat.active){chat.close();SDL_StopTextInput(window.get());}
        reset_input_timing();held_codes.clear();
        if (!SDL_SetWindowRelativeMouseMode(window.get(),on)) {
            captured=false; std::cerr << "Relative mouse mode failed: " << SDL_GetError() << '\n';
        } else captured=on;
        input_clock.reset();
    };
    auto show_menu=[&](bool on) {
        if(on){replay_controls.dragging=false;replay_orbit_drag=false;}
        SDL_SetWindowAlwaysOnTop(window.get(),!on&&preferences.value("alwaysOnTop",false));
        if(menu&&preferences.value("windowMode",std::string())=="fullscreen"){const auto want=window_for_menu(preferences,on);if(window_controller.mode()!=want.at("windowMode").get<std::string>()&&!window_controller.apply(want))std::cerr<<"Window: "<<window_controller.error()<<'\n';}
        if(menu) menu->set_visible(on);
        // Each pause re-announces the paused map (a fresh still for a
        // separate GTK window); sent with the menu state once it is visible.
        if(on&&core&&menu)gameplay_backdrop_due=true;
        if(on)audio.pause();
        resume_wanted=!on&&bool(core);
        if(resume_wanted) SDL_RaiseWindow(window.get());
        capture(resume_wanted && focused&&!(playback&&replay_controls.visible)); accumulator=0; prev=curr;
    };
    uint64_t chat_request=0;
    auto chat_suggest=[&](){++chat_request;if(menu&&menu_ready)menu->evaluate_js("window.bunnyhopNativeMenu?.onChatSuggest?.("+nlohmann::json({{"text",chat.input},{"request",chat_request}}).dump()+")");};
    auto open_chat=[&](bool command){
        if(!core||playback||!captured||!menu||!menu_ready)return;
        input.clear();camera_controls.clear();held_codes.clear();leave_hold.cancel();restart_guard.cancel();
        // Keep gameplay running with neutral input while exposing the pointer for chat links.
        chat.open(command);SDL_SetWindowRelativeMouseMode(window.get(),false);SDL_StartTextInput(window.get());
        int w=0,h=0;SDL_GetWindowSize(window.get(),&w,&h);SDL_Rect area{16,std::max(0,h-120),std::max(1,w-32),32};SDL_SetTextInputArea(window.get(),&area,0);
        chat_suggest();
    };
    bool chat_drag=false;
    auto close_chat=[&](){chat_drag=false;chat.close();if(captured&&focused&&(!menu||!menu->visible()))SDL_SetWindowRelativeMouseMode(window.get(),true);SDL_StopTextInput(window.get());input.clear();camera_controls.clear();held_codes.clear();};
    auto room_control=[&](const nlohmann::json &command){if(menu&&menu_ready)menu->evaluate_js("window.bunnyhopNativeMenu?.onRoomControl?.("+command.dump()+")");};
    auto run_event=[&](nlohmann::json event) {
        if(!native::practice_allows_event(practice.active,event.value("type",std::string()))||!turn_admission.allows_event(event.value("type",std::string())))return;
        if(!menu || !menu_ready || opt.frames || !opt.menu_smoke.empty()) return;
        event["generation"]=run_generation;event["map"]=map_id;event["style"]=active_style;
        event["build"]=identity.value("build",std::string("bunnyhop-native/local"));
        event["wasm"]=identity.value("wasm",std::string());
        menu->evaluate_js("window.bunnyhopNativeMenu?.onRunEvent?.("+event.dump()+")");
    };
    // The tutorial's lessons are practice; its final course (bonus 1) is a ranked run with its own board, as on the
    // web (tutorial/flow.ts FINAL_TRACK) and the server.
    auto tutorial_practice=[&](){return map_id==tutorial_map&&!(tutorial&&tutorial->is_active()&&tutorial->lesson_id()=="final");};
    // The signed-in account's display name for replay headers (menu "playerName"), "player" until it says.
    std::string replay_player="player";
    auto begin_record=[&]() {
        if(turn_admission.local_only)score_notice.clear();
        turn_admission.reset();
        recording_ended=false; record_path.clear();pending_vault_capture.reset();
        ++run_generation;beat_start=beat_upto=0;beat_hash=0x811c9dc5;beat_paused=false;
        run_event({{"type","reset"}});
        if(practice.active || playback || room.spectator_target || tutorial_practice() || zones.empty() || opt.frames || !opt.menu_smoke.empty()) return;
        const auto stamp=std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
        record_path=(cache/"replays"/(map_id+"-"+std::to_string(stamp)+".bhr")).string();
        require(bh_record_identity(core.get(),identity.at("build").get<std::string>().c_str()),core.get(),"Setting native release identity");
        require(bh_record_begin(core.get(),"",active_style.c_str(),replay_player.c_str(),100),core.get(),"Starting native recording");
        bh_record_loadout(core.get(),packed_loadout.c_str());
    };
    auto reset=[&]() {
        cancel_video();
        replay_controls={};replay_controls.pending.reset();replay_orbit_drag=false;
        if(!core) return;
        if(pending_action!="play")cancel_prefetch();gun_menu.close();bh_record_end(core.get());room_events|=8;practice.restart();
        if(third_person&&!room.spectator_target){practice.active=true;if(practice.tool.empty())practice.tool="camera";}
        if(playback){require(bh_replay_stop(core.get()),core.get(),"Stopping replay");playback=false;playback_id.clear();}
        BhRunOptions canonical{};bh_default_run_options(&canonical);if(zones.empty())require(bh_run_clear(core.get()),core.get(),"Clearing replay timer");else require(bh_run_configure(core.get(),&canonical,zones.data(),zones.size()),core.get(),"Restoring canonical map timer");
        active_style=active_track?"autohop":selected_style;
        if(tutorial&&tutorial->is_active()&&active_style!="legit"&&active_style!="scroll")active_style="autohop";
        require(bh_style_set(core.get(),active_style.c_str()),core.get(),"Applying movement style");
        require(bh_reset(core.get()),core.get(),"Restarting map");
        require(bh_state(core.get(),&curr),core.get(),"Reading restart state");
        const BhZone *start=nullptr; bool spawn_inside=false;
        for(const auto &z:zones) if(z.kind==0 && z.track==active_track) {
            if(!start) start=&z;
            const auto *p=curr.position;
            if(p[0]-16<=z.maxs[0] && p[0]+16>=z.mins[0] && p[1]-16<=z.maxs[1] && p[1]+16>=z.mins[1] && p[2]<=z.maxs[2] && p[2]+62>=z.mins[2]) spawn_inside=true;
        }
        if(start && (!spawn_inside || map_id=="bhop_japan")) {
            require(bh_set_position(core.get(),float((double(start->mins[0])+start->maxs[0])/2),float((double(start->mins[1])+start->maxs[1])/2),start->mins[2]+1,curr.teleport_angles[1]),core.get(),"Placing player in start zone");
            if(map_id=="bhop_japan") require(bh_set_restart_names(core.get(),"","beginner"),core.get(),"Applying map restart names");
            require(bh_state(core.get(),&curr),core.get(),"Reading settled restart");
        }
        std::optional<float> custom_pitch;bool outside_spawn=false;
        if(!(tutorial&&tutorial->is_active()))if(const auto point=start_points.get(map_id,active_track)){
            const BhState fallback=curr;
            if(bh_set_position(core.get(),point->position[0],point->position[1],point->position[2],point->yaw)&&bh_state(core.get(),&curr)&&native::start_point_landed(curr,*point)){custom_pitch=point->pitch;outside_spawn=!native::start_point_in_zone(curr,zones,active_track);}
            else{require(bh_set_position(core.get(),fallback.position[0],fallback.position[1],fallback.position[2],fallback.teleport_angles[1]),core.get(),"Restoring default start");require(bh_state(core.get(),&curr),core.get(),"Reading default start");}
        }
        if(tutorial&&tutorial->is_active()){
            tutorial->set_legit(active_style=="legit"||active_style=="scroll");tutorial->start(tutorial->lesson_index());
            const auto spawn=tutorial->spawn();require(bh_set_position(core.get(),spawn.position[0],spawn.position[1],spawn.position[2],spawn.yaw),core.get(),"Placing tutorial player");
            require(bh_set_velocity(core.get(),0,0,0),core.get(),"Stopping tutorial player");require(bh_state(core.get(),&curr),core.get(),"Reading tutorial restart");
            if(tutorial_demo)tutorial_demo_start=curr.tick;
        }
        if(renderer){renderer->reset_presentation();scope.reset();renderer->set_viewmodel_weapon(std::nullopt);renderer->set_cosmetics(outfit,packed_loadout);}
        audio.reset();hud.reset_history();replay_camera.reset();prev=curr;reset_input_timing();input.set_angles(custom_pitch.value_or(curr.teleport_angles[0]),curr.teleport_angles[1]);
        if(outside_spawn&&!practice.active){practice.active=true;practice.tool="spawn";}
        kept_weapons.restarted(practice.active||zones.empty(),settings.physics>=10);begin_record();reset_feedback();reset_input_timing();
        // (toast() is declared after reset; set its state directly.)
        if(outside_spawn){toast_text="Custom spawn outside the start zone: practice run. Enter and leave the start zone to time it.";toast_until=Clock::now()+std::chrono::milliseconds(4000);}
    };
    auto practice_reason=[&](){return native::practice_unavailable(bool(core),playback,!room.id.empty(),map_id==tutorial_map,!gauntlet_id.empty());};
    auto toast=[&](const std::string &text,unsigned ms=3000){toast_text=text;toast_until=Clock::now()+std::chrono::milliseconds(ms);};
    auto practice_use=[&](const std::string &tool){
        if(!practice.active){BhRunState timing{};bh_run_state(core.get(),&timing);practice.active=true;practice.tool=tool;toast(timing.status==1?"This run is practice now. Press R to restart for a real run.":"Practice until you restart. Press R for a real run.",5000);}
        require(bh_practice_enter(core.get(),tool=="noclip"),core.get(),"Entering practice");
        recording_ended=false;record_path.clear();pending_vault_capture.reset();score_notice.clear();++run_generation;beat_start=beat_upto=0;run_event({{"type","reset"}});
    };
    auto practice_action=[&](const std::string &action,bool bound=false,std::optional<bool> value=std::nullopt){
        const auto unavailable=practice_reason();if(!unavailable.empty()){toast(unavailable);return;}
        BhRunState timing{};bh_run_state(core.get(),&timing);
        if(bound&&action!="toggle"&&!practice.key_allowed(action,timing.status==1)){if(practice.hinted_run!=timing.start_tick){practice.hinted_run=timing.start_tick;toast("Type !cp to use checkpoints and noclip during a run.",3500);}return;}
        if(action=="menu"){practice.menu_open=!practice.menu_open;return;}
        if(action=="keepVelocity"){preferences["practiceKeepVelocity"]=value.value_or(!preferences.at("practiceKeepVelocity").get<bool>());native::save_settings(cache/"settings.json",preferences);return;}
        if(action=="toggle"){
            practice.mode=!practice.mode;
            if(practice.mode){practice.tool.clear();practice_use("");const auto bound=[&](const char *action)->std::string{const auto &keys=preferences.at("binds").at(action);if(keys.empty()){const std::string_view a(action);return a=="cpSave"?"!save":a=="cpTeleport"?"!tele":"!nc";}std::string k=keys[0].get<std::string>();if(k=="Backquote")return "`";if(k.starts_with("Key")||k.starts_with("Digit"))return k.substr(k.starts_with("Key")?3:5);if(k.starts_with("Mouse"))return "M"+k.substr(5);return k;};toast("Practice: no scores. "+bound("noclip")+": noclip | "+bound("cpSave")+": save checkpoint | "+bound("cpTeleport")+": teleport.",6000);}
            else{reset();toast("Practice mode off. You're back at the start.");}
            return;
        }
        if(action=="save"){
            auto handle=bh_practice_save(core.get(),float(input.yaw()),float(input.pitch));
            // Retain the newest 100 snapshots within the bridge's 128 MiB cap.
            // On large maps evict the oldest and retry, as the web checkpoint store does.
            while(!handle&&!practice.checkpoints.empty()){
                bh_practice_free(core.get(),practice.checkpoints.front().handle);practice.checkpoints.erase(practice.checkpoints.begin());
                handle=bh_practice_save(core.get(),float(input.yaw()),float(input.pitch));
            }
            require(handle!=0,core.get(),"Saving checkpoint");practice.retain({handle,selected_style,active_style,active_track});
            toast("Checkpoint "+std::to_string(practice.number())+" saved");return;
        }
        if(action=="noclip"){
            if(!practice.noclip){BhRunState before{};bh_run_state(core.get(),&before);practice_use("noclip");practice.noclip=true;if(before.status==1)toast("Noclip: timer stopped. Press R for a real run.",3500);for(int k=0;k<3;k++){practice.flight.position[k]=curr.position[k];practice.flight.velocity[k]=curr.velocity[k];}}
            else{BhSnapshot snapshot{};const auto result=bh_practice_noclip_exit(core.get(),&practice.flight,float(input.yaw()),float(input.pitch),&snapshot);practice.noclip=false;curr=prev=snapshot.player;if(!result)toast("You're stuck in a wall. Noclip again, or teleport to a checkpoint.",4000);}
        } else if(action=="tele"||action=="prev"||action=="next"){
            if(practice.checkpoints.empty()){toast("No checkpoint yet. Press C to save one.");return;}
            if(action!="tele")practice.step(action=="prev"?-1:1);
            const auto &cp=practice.checkpoints[practice.current];
            if(cp.selected!=selected_style){toast("That checkpoint was saved in another style.");return;}
            BhSnapshot snapshot{};BhCmd view{};
            require(bh_practice_restore(core.get(),cp.handle,&view,&snapshot),core.get(),"Restoring checkpoint");
            practice_use("teleport");practice.noclip=false;active_style=cp.style;active_track=cp.track;
            if(!preferences.at("practiceKeepVelocity").get<bool>())require(bh_set_velocity(core.get(),0,0,0),core.get(),"Clearing checkpoint speed");
            require(bh_state(core.get(),&curr),core.get(),"Reading checkpoint");prev=curr;input.set_angles(view.pitch,view.yaw);
            toast("Checkpoint "+std::to_string(practice.number())+" of "+std::to_string(practice.checkpoints.size()));
        } else throw std::runtime_error("Unknown practice action");
        if(renderer)renderer->reset_presentation();scope.reset();audio.reset();reset_feedback(true);reset_input_timing();room_events|=8;
    };
    auto leave_map=[&](){
        cancel_video();
        replay_controls={};replay_controls.pending.reset();replay_orbit_drag=false;
        show_menu(true);
        if(menu&&menu_ready)menu->evaluate_js("window.bunnyhopNativeMenu?.onLeaveMap?.()");
        download.cancel();cancel_prefetch();
        {std::lock_guard lock(progress_mutex);loading.clear();load_progress=nullptr;}
        pending_replay.clear();pending_action.clear();pending_room_map.clear();pending_tutorial.clear();tutorial_stopped=true;
        if(core)bh_record_end(core.get());practice.clear(core.get());renderer.reset();core.reset();tutorial.reset();
        playback=false;playback_paused=false;playback_id.clear();playback_info=nullptr;ghost_handle=0;ghost_enabled=false;ghost_id.clear();ghost_info=nullptr;ghost_slots={};
        gauntlet_id.clear();gauntlet_map.clear();gauntlet_progress=nullptr;zones.clear();map_id.clear();audio.set_map(nullptr);active_track=0;active_style=selected_style;
        curr={};prev={};recording_ended=true;record_path.clear();pending_vault_capture.reset();score_notice.clear();toast_text.clear();error.clear();turn_admission.reset();
        ++run_generation;beat_start=beat_upto=0;run_event({{"type","reset"}});reset_feedback();reset_input_timing();audio.reset();
        if(backdrop)backdrop->release();backdrop_shown.clear();backdrop_failed.clear();backdrop_source.clear();backdrop_cut=false;gameplay_backdrop_due=false;last_ui.clear();
        room.close();room_modes.close(room.generation);observed_spectator.reset();
    };
    auto apply_room_mode=[&](const native::RoomModeAction &action){
        if(action.stop_spectating&&menu&&menu_ready)menu->evaluate_js("window.bunnyhopNativeMenu?.onRoomCommand?.({t:'spec',target:null})");
        if(action.restart&&core){if(tutorial)tutorial->stop();tutorial_demo=false;if(!action.style.empty())selected_style=action.style;active_track=action.track;reset();show_menu(false);}
    };
    auto load_map=[&](const std::string &path,const std::string &content,const std::string &id,const nlohmann::json &detail) {
        cancel_video();
        CorePtr next(bh_create(),&bh_destroy); if(!next) throw std::runtime_error("Could not create native core");
        require(bh_load_map(next.get(),path.c_str(),content.empty()?nullptr:content.c_str()),next.get(),"Loading BSP map");
        require(bh_set_settings(next.get(),&settings),next.get(),"Applying settings");
        const auto next_zones=timer_zones(detail);
        BhRunOptions timing{}; bh_default_run_options(&timing);
        if(!next_zones.empty())require(bh_run_configure(next.get(),&timing,next_zones.data(),next_zones.size()),next.get(),"Configuring timer");
        std::unique_ptr<native::Tutorial> next_tutorial;
        if(id==tutorial_map){const auto metadata=nlohmann::json::parse(read_text(assets/"tutorial.json"));if(file_hash(path)!=metadata.at("bspSha256").get<std::string>())throw std::runtime_error("Tutorial BSP does not match bundled lessons; update the tutorial assets and map together");next_tutorial=std::make_unique<native::Tutorial>(metadata,selected_style=="legit"||selected_style=="scroll");next_tutorial->set_completed(tutorial_completed);}
        audio.set_classic_loader([content,cache](){if(!content.empty())native::download_classic_sounds(content,cache);});
        auto next_renderer=std::make_unique<Renderer>(gl,next.get(),assets);
        practice.clear(core.get());renderer.reset(); core=std::move(next);audio.set_map(core.get()); renderer=std::move(next_renderer);
        // The pause screen shows this map itself, never the home tour.
        if(backdrop)backdrop->release();backdrop_shown.clear();backdrop_failed.clear();backdrop_cut=false;gameplay_backdrop_due=true;
        if(pending_action!="play"&&opt.replay.empty()&&!opt.frames&&opt.runtime_smoke.empty())activity.loaded(id);
        kept_weapons.forget();ghost_slots={};zones=next_zones;renderer->set_zones(zones);replay_camera.reset();hud.reset_history();tutorial=std::move(next_tutorial);tutorial_demo=false; map_id=id; error.clear();playback=false;ghost_handle=0;ghost_enabled=false;ghost_id.clear(); reset();apply_preferences();renderer->set_cosmetics(outfit,packed_loadout);renderer->set_ghost_cosmetics(ghost_cosmetic,trail_cosmetic);apply_room_mode(room_modes.map_loaded(map_id,room.spectator_target.has_value(),epoch_ms()));
    };
    auto request_map=[&](const std::string &id) {
        if(!opt.runtime_smoke.empty())throw std::runtime_error("Offline runtime smoke attempted a map download");
        if(download.valid()) throw std::runtime_error("A map is already loading");
        if(!native::valid_map_id(id)) throw std::runtime_error("Invalid map name");
        cancel_prefetch();error.clear(); show_menu(true);
        if(core)bh_record_end(core.get());++run_generation;beat_start=beat_upto=0;run_event({{"type","reset"}});
        // A background still downloading gives way; one already on screen
        // stays until this map has loaded.
        if(backdrop)backdrop->cancel_loading();
        last_requested_map=id;map_preparing=false;
        {std::lock_guard lock(progress_mutex); loading="Reading "+id;load_progress={{"map",id},{"stage","metadata"},{"message",loading}};}
        download.start([&,id](const std::atomic_bool &cancel) {
            const auto lock=lock_cache(cancel);
            return native::download_map(id,cache,[&](const std::string &message) {std::lock_guard lock(progress_mutex);if(!cancel)loading=message;},&cancel,{},[&,id](const native::LoadProgress &p){
                std::lock_guard lock(progress_mutex);if(cancel)return;
                loading=p.message;load_progress={{"map",id},{"stage",p.stage},{"message",p.message},{"received",p.received},{"total",p.total},{"filesDone",p.filesDone},{"filesTotal",p.filesTotal},{"cached",p.cached},{"offline",p.offline}};
            });
        });
    };
    auto apply_room_event=[&](const nlohmann::json &message){
        const auto next=room.event(message);
        if(!room.id.empty()){
            const bool tainted=practice.active||practice.noclip;
            practice.clear(core.get());gauntlet_id.clear();gauntlet_map.clear();gauntlet_progress=nullptr;
            if(tainted&&core)reset();
        }
        apply_room_mode(room_modes.event(message,map_id,room.spectator_target.has_value(),epoch_ms()));
        if(room.id.empty())pending_room_map.clear();
        if(!next.empty()&&native::valid_map_id(next)&&next!=map_id){
            if(download.valid())pending_room_map=next;else{active_track=0;request_map(next);}
        }
    };
    CorePtr metadata_core(bh_create(),&bh_destroy);
    auto replay_metadata=[&](const std::filesystem::path &path) {
        size_t bytes=0;const char *json=bh_replay_header(metadata_core.get(),path.string().c_str(),&bytes);
        require(json!=nullptr,metadata_core.get(),"Reading replay header");
        return nlohmann::json::parse(json,json+bytes);
    };
    // Only clean finishes archived by this host enter its local PB registry.
    // Old/unclassified and deliberately local-only archives remain replayable,
    // but must not silently become a personal best or an attract PB.
    nlohmann::json backdrop_pbs=nlohmann::json::object();
    try{if(std::filesystem::exists(cache/"backdrop-pbs.json")&&std::filesystem::file_size(cache/"backdrop-pbs.json")<128*1024){const auto saved=nlohmann::json::parse(read_text(cache/"backdrop-pbs.json"));if(saved.is_object())backdrop_pbs=saved;}}catch(const std::exception &e){std::cerr<<"Backdrop PBs: "<<e.what()<<'\n';}
    auto valid_backdrop_replay=[&](const std::filesystem::path &path,const std::string &map){
        if(!std::filesystem::is_regular_file(path)||std::filesystem::is_symlink(path)||std::filesystem::file_size(path)>8*1024*1024)throw std::runtime_error("Invalid backdrop replay file");
        const auto info=replay_metadata(path);
        if(info.at("map")!=map||info.value("style",std::string("autohop"))!="autohop"||info.value("track",0)!=0||info.at("endTick").get<uint32_t>()<=info.at("startTick").get<uint32_t>())throw std::runtime_error("Backdrop replay is not a completed Normal main-track run of this map");
        return info;
    };
    auto local_backdrop_replay=[&](const std::string &map)->std::string{
        try{if(backdrop_pbs.contains(map)){const auto path=native::replay_file(cache/"replays",backdrop_pbs.at(map).at("id").get<std::string>());valid_backdrop_replay(path,map);return path.string();}}catch(const std::exception &e){std::cerr<<"Local backdrop PB: "<<e.what()<<'\n';}
        return {};
    };
    auto refresh_replays=[&]() {
        replay_list=nlohmann::json::array();
        std::vector<std::filesystem::directory_entry> files;
        for(const auto &entry:std::filesystem::directory_iterator(cache/"replays"))
            if(entry.is_regular_file()&&!entry.is_symlink()&&entry.path().extension()==".bhr"&&entry.file_size()<=8*1024*1024)files.push_back(entry);
        std::sort(files.begin(),files.end(),[](const auto &a,const auto &b){return a.last_write_time()>b.last_write_time();});
        if(files.size()>500)files.resize(500);
        for(const auto &entry:files)try {
            const auto info=replay_metadata(entry.path());
            nlohmann::json listed={{"id",entry.path().filename().string()},{"name",info.value("player",std::string("Local run"))},
                {"map",info.at("map")},{"style",info.value("style",std::string("autohop"))},{"track",info.value("track",0)},
                {"seconds",(info.at("endTick").get<double>()-info.at("startTick").get<double>())*info.at("settings").value("tickInterval",.01)},
                {"recordedAt",info.value("recordedAt",0.)},{"bytes",entry.file_size()}};
            const auto summary=run_vault.read(entry.path().filename().string());if(summary.is_object())listed["localSummary"]=summary;listed["screenshot"]=run_vault.screenshot(entry.path().filename().string()).has_value();replay_list.push_back(std::move(listed));
        }catch(const std::exception &e){std::cerr<<"Skipping replay "<<entry.path().filename()<<": "<<e.what()<<'\n';}
    };
    auto open_replay=[&](const std::filesystem::path &path,const std::string &action,unsigned ghost_slot=0) {
        if(ghost_slot>=ghost_slots.size())throw std::runtime_error("Invalid ghost slot");
        if(!core)throw std::runtime_error("Load the replay map first");
        practice.clear(core.get());if(tutorial)tutorial->stop();tutorial_demo=false;renderer->reset_presentation();scope.reset();
        bh_record_end(core.get());++run_generation;run_event({{"type","reset"}});beat_start=0;audio.reset();
        if(action=="ghost") {
            auto &slot=ghost_slots[ghost_slot];if(slot.handle)bh_ghost_free(core.get(),slot.handle);slot={};
            if(ghost_slot==0){ghost_handle=0;ghost_enabled=false;ghost_id.clear();}
            const auto handle=bh_ghost_load(core.get(),path.string().c_str());require(handle!=0,core.get(),"Loading ghost");
            size_t bytes=0;const auto raw=bh_ghost_info(core.get(),handle,&bytes);require(raw!=nullptr,core.get(),"Reading ghost");
            slot={handle,path.filename().string(),true,nlohmann::json::parse(raw,raw+bytes)};
            if(ghost_slot==0){ghost_handle=handle;ghost_info=slot.info;ghost_id=slot.id;ghost_enabled=true;}
            active_track=slot.info.value("track",0u);selected_style=slot.info.value("style",std::string("autohop"));
            reset();show_menu(false);
        } else {
            if(!bh_replay_load(core.get(),path.string().c_str())){const std::string failure=bh_last_error(core.get());reset();throw std::runtime_error("Loading native replay: "+failure);}
            size_t bytes=0;const auto raw=bh_replay_info(core.get(),&bytes);playback_info=nlohmann::json::parse(raw,raw+bytes);
            renderer->set_cosmetics(outfit,(playback_info.contains("packedLoadout")&&playback_info["packedLoadout"].is_string()?playback_info["packedLoadout"].get<std::string>():std::string()));
            playback=true;playback_paused=false;playback_speed=1;replay_controls={};replay_camera.set_mode("eye");replay_orbit_drag=false;playback_id=path.filename().string();recording_ended=true;record_path.clear();pending_vault_capture.reset();
            BhCmd cmd{};bh_last_command(core.get(),&cmd);bh_state(core.get(),&curr);prev=curr;input.set_angles(cmd.pitch,cmd.yaw);
            reset_feedback();reset_input_timing();show_menu(false);
        }
    };
    auto refresh_playback_pose=[&](){if(core&&playback){bh_state(core.get(),&curr);prev=curr;BhCmd cmd{};bh_last_command(core.get(),&cmd);input.set_angles(cmd.pitch,cmd.yaw);renderer->reset_presentation();hud.reset_history();audio.reset();reset_input_timing();}};
    auto seek_playback=[&](uint32_t tick){
        if(!core||!playback)return;const auto total=playback_info.at("totalTicks").get<uint32_t>();if(tick>total)throw std::runtime_error("Replay tick outside run");
        BhSnapshot state{};if(!bh_replay_seek(core.get(),tick,&state)){const std::string failure=bh_last_error(core.get());reset();show_menu(true);throw std::runtime_error("Replay seek stopped: "+failure);}
        curr=prev=state.player;BhCmd view{};bh_last_command(core.get(),&view);input.set_angles(view.pitch,view.yaw);renderer->reset_presentation();scope.reset();audio.reset();hud.reset_history();
        if(replay_camera.mode!="free")replay_camera.reset();camera_controls.clear();reset_feedback(tick!=0);reset_input_timing();
    };
    auto replay_action=[&](native::ReplayControls::Action action){using A=native::ReplayControls::Action;const auto total=playback_info.value("totalTicks",0u);const double interval=playback_info.at("settings").value("tickInterval",dt);
        switch(action){case A::start:replay_controls.pending=0;break;case A::end:replay_controls.pending=total;playback_paused=true;break;case A::back:replay_controls.pending=native::ReplayControls::offset(curr.tick,-5,interval,total);break;case A::forward:replay_controls.pending=native::ReplayControls::offset(curr.tick,5,interval,total);break;case A::pause:playback_paused=!playback_paused;break;case A::slower:playback_speed=native::ReplayControls::speed(playback_speed,false);break;case A::faster:playback_speed=std::min(4.,native::ReplayControls::speed(playback_speed,true));break;case A::camera:replay_camera.set_mode(replay_camera.mode=="eye"?"chase":replay_camera.mode=="chase"?"free":"eye");camera_controls.set_angles(replay_camera.pitch,replay_camera.yaw);camera_controls.clear();break;default:break;}
    };
    auto begin_video=[&](const native::VideoOptions &options){
        const auto timeline=native::VideoTimeline::make(options,playback_info.at("totalTicks").get<uint32_t>());
        const char *downloads=SDL_GetUserFolder(SDL_FOLDER_DOWNLOADS);if(opt.video_smoke.empty()&&!downloads)throw std::runtime_error("Downloads folder unavailable");
        const auto directory=opt.video_smoke.empty()?std::filesystem::path(downloads):std::filesystem::absolute(opt.video_smoke);std::filesystem::create_directories(directory);
        const auto destination=directory/("bunnyhop-"+map_id+"-"+std::to_string(SDL_GetTicksNS())+".mp4");
        video_capture=std::make_unique<native::VideoCapture>(gl,core.get(),*renderer,hud,video_encoder,options,playback_info.at("totalTicks").get<uint32_t>(),curr.tick,preferences,map_id,playback_info.value("style",active_style),outfit,(playback_info.contains("packedLoadout")&&playback_info["packedLoadout"].is_string()?playback_info["packedLoadout"].get<std::string>():std::string()),prepared_camera,assets,cache);
        try{video_encoder.start(options,destination,timeline.frames,video_available.encoder);}catch(...){video_capture.reset();throw;}
        audio.pause();
    };
    auto request_video=[&](native::VideoOptions options){
        if(!playback||!renderer||!core||download.valid())throw std::runtime_error("Open a replay before exporting video");
        if(video_capture||director_job||video_encoder.busy())throw std::runtime_error("A video export is already running");
        if(!video_available.available)throw std::runtime_error(video_available.reason);
        options.tick_interval=playback_info.at("settings").value("tickInterval",dt);
        native::VideoTimeline::make(options,playback_info.at("totalTicks").get<uint32_t>());video_error.clear();show_menu(true);prepared_camera={};prepared_camera.set_mode(options.camera);
        if(options.camera=="auto"){pending_video=options;director_only=false;director_job=std::make_unique<native::ReplayDirectorJob>(core.get(),playback_info.at("totalTicks").get<uint32_t>(),curr.tick);}
        else begin_video(options);
    };
    auto request_replay=[&](const std::filesystem::path &path,const std::string &action,unsigned ghost_slot=0) {
        if(ghost_slot>=ghost_slots.size())throw std::runtime_error("Invalid ghost slot");
        const auto info=replay_metadata(path);const auto id=info.at("map").get<std::string>();
        if(!native::valid_map_id(id))throw std::runtime_error("Replay has invalid map name");
        if(map_id!=id||!core) {pending_replay=path.string();pending_action=action;pending_ghost_slot=ghost_slot;request_map(id);}
        else open_replay(path,action,ghost_slot);
    };
    start_tutorial=[&](const std::string &lesson,bool demo){
        if(!core||map_id!=tutorial_map||!tutorial)throw std::runtime_error("Load the tutorial map before starting a lesson");
        for(size_t i=1;i<ghost_slots.size();++i)if(ghost_slots[i].handle)bh_ghost_free(core.get(),ghost_slots[i].handle);ghost_slots={};
        if(ghost_handle){bh_ghost_free(core.get(),ghost_handle);ghost_handle=0;}ghost_enabled=false;tutorial_demo=false;
        tutorial_stopped=false;tutorial_final_saved=false;tutorial->start(lesson);active_track=lesson=="final"?1:0;reset();
        std::array<std::string,4> labels{"Space","W","A","D"};const char *actions[]={"jump","forward","left","right"};for(int k=0;k<4;k++){const auto &bound=preferences.at("binds").at(actions[k]);if(!bound.empty()){labels[k]=bound[0];if(labels[k].rfind("Key",0)==0)labels[k].erase(0,3);}}
        tutorial->set_keys(labels);score_notice.clear();
        if(demo){const auto &meta=tutorial->lesson_data();const auto key=(active_style=="legit"||active_style=="scroll")&&meta.contains("nativeDemoLegit")?"nativeDemoLegit":"nativeDemo";if(!meta.contains(key))throw std::runtime_error("Tutorial demonstration is absent");const auto file=meta.at(key).get<std::string>();if(file.find_first_of("/\\")!=std::string::npos)throw std::runtime_error("Invalid bundled tutorial replay path");
            ghost_handle=bh_ghost_load(core.get(),(assets/"tutorial"/file).string().c_str());require(ghost_handle!=0,core.get(),"Loading native tutorial demonstration");size_t bytes=0;const auto *raw=bh_ghost_info(core.get(),ghost_handle,&bytes);require(raw!=nullptr,core.get(),"Reading tutorial demonstration");ghost_info=nlohmann::json::parse(raw,raw+bytes);ghost_enabled=true;tutorial_demo=true;tutorial_demo_start=curr.tick;ghost_id="tutorial-"+lesson;
        }
        std::cout<<"Native tutorial "<<lesson<<(demo?" demonstration":" lesson")<<(lesson=="final"?"; ranked final course\n":"; ranked recording disabled\n");show_menu(false);
    };
    auto gauntlet_action=[&](const nlohmann::json &message){
                    const auto id=message.at("id").is_null()?std::string():message.at("id").get<std::string>();
                    if(id.size()>128)throw std::runtime_error("Invalid gauntlet id");
                    const auto map=message.value("map",std::string());if(!map.empty()&&!native::valid_map_id(map))throw std::runtime_error("Invalid gauntlet map");
                    const auto progress=message.value("progress",nlohmann::json(nullptr));
                    if(!progress.is_null()){
                        if(!progress.is_object())throw std::runtime_error("Invalid gauntlet progress");
                        const auto idx=progress.at("idx").get<unsigned>(),maps=progress.at("maps").get<unsigned>();const auto before=progress.at("before").get<double>();
                        if(!maps||maps>1000||idx>=maps||!std::isfinite(before)||before<0)throw std::runtime_error("Invalid gauntlet progress");
                        if(!progress.at("pbSplit").is_null()){const auto pb=progress.at("pbSplit").get<double>();if(!std::isfinite(pb)||pb<0)throw std::runtime_error("Invalid gauntlet split");}
                    }
                    const bool restart=!id.empty()&&core&&(practice.active||playback||active_style!="autohop"||active_track!=0);
                    gauntlet_id=id;gauntlet_map=id.empty()?std::string():map;gauntlet_progress=id.empty()?nlohmann::json(nullptr):progress;
                    if(!id.empty()){third_person=false;practice.clear(core.get());selected_style="autohop";active_track=0;if(restart)reset();}
    };
    uint32_t last_slot=3,observed_slot=3;
    auto movement_bit=[](const std::string &action)->uint32_t {
        if(action=="forward")return native::forward;if(action=="back")return native::back;
        if(action=="left")return native::left;if(action=="right")return native::right;
        if(action=="jump")return native::jump;if(action=="duck")return native::duck;
        if(action=="use")return native::use;if(action=="attack")return native::attack;if(action=="attack2")return native::attack2;return 0;
    };
    // Turnbinds: +left / +right turn at yawSpeed degrees per second (cl_yawspeed),
    // or yawSpeedAlt while Turn modifier is held. Positive is left (yaw goes up).
    auto turn_rate=[&]()->double {
        if(!captured || !native::turn_binds_allowed(active_style,
            (tutorial&&tutorial->is_active()) || practice.active || feedback.ssj_was_noclip))return 0;
        auto held=[&](const char *action){for(const auto &key:preferences.at("binds").at(action))if(held_codes.contains(key.get<std::string>()))return true;return false;};
        return native::configured_turn_rate(held("turnLeft"),held("turnRight"),
            preferences.at(held("turnFast")?"yawSpeedAlt":"yawSpeed").get<double>());
    };
    auto held_action=[&](const std::string &action){const auto &binds=preferences.at("binds");if(!binds.contains(action))return false;for(const auto &key:binds.at(action))if(held_codes.contains(key.get<std::string>()))return true;return false;};
    auto weapon_context=[&](){return native::WeaponMenuContext{settings.physics,practice.active||zones.empty(),playback,room.spectator_target.has_value(),practice.noclip};};
    auto act=[&](const std::string &action,bool wheel=false,bool instant=false) {
        if(action=="chat"||action=="commandChat"){open_chat(action=="commandChat");return;}
        if(action=="scoreboard")return;
        if(action=="spectatorNext"||action=="spectatorPrevious"){room_control({{"action",action=="spectatorNext"?"next":"previous"}});return;}
        if(action=="spectatorMode"){if(room.spectator_target)third_person=!third_person;return;}
        if(action=="thirdPerson"){
            if(playback){replay_camera.set_mode(replay_camera.mode=="eye"?"chase":"eye");return;}
            if(room.spectator_target){third_person=!third_person;return;}
            if(!core)return;
            BhRunState timing{};bh_run_state(core.get(),&timing);
            if(!third_person&&!gauntlet_id.empty()){toast("No third person during a gauntlet.");return;}
            if(!third_person&&timing.status==1&&!practice.active&&!turn_admission.local_only&&!zones.empty()){toast("No third person during a timed run.");return;}
            third_person=!third_person;
            if(third_person){practice_use("camera");toast("Third person. This run is practice.");}
            else{if(timing.status==0&&practice.tool=="camera"&&!practice.mode)reset();toast("First person");}
            return;
        }
        if(action=="flashlight"){flashlight=!flashlight;return;}
        if(action=="nextTrack"){audio.music_control("next");return;}
        if(action=="hudEditor"){if(menu){show_menu(true);menu->evaluate_js("window.bunnyhopNativeMenu?.open?.('settings','hud-editor')");}return;}
        if(action=="gunMenu"){gun_menu.toggle();return;}
        if(action=="showTriggers"||action=="showClips"){const char *key=action=="showTriggers"?"triggersVisible":"clipsVisible";const bool on=!preferences.at(key).get<bool>();preferences[key]=on;native::save_settings(cache/"settings.json",preferences);apply_preferences();toast(std::string(action=="showTriggers"?"Triggers":"Player clips")+(on?" shown":" hidden"));return;}
        if(action=="keysOverlay"){preferences["keysOverlay"]=!preferences.at("keysOverlay").get<bool>();native::save_settings(cache/"settings.json",preferences);apply_preferences();return;}
        if(action=="viewmodel"||action=="hideUi"||action=="mute") {
            const std::string key=action=="hideUi"?"hud":action=="mute"?"muted":"viewmodel";
            preferences[key]=!preferences[key].get<bool>();native::save_settings(cache/"settings.json",preferences);apply_preferences();return;
        }
        if(action=="mainMenu"){
            BhRunState timing{};if(core)bh_run_state(core.get(),&timing);
            const auto result=leave_hold.press(epoch_ms(),!playback&&native::leave_requires_confirmation(timing.status,room.spectator_target.has_value()),!wheel);
            if(result==native::LeaveHold::Result::leave)leave_map();else if(result==native::LeaveHold::Result::ask)toast("Main menu key again to leave");return;
        }
        if(playback)return;
        if(action=="setStart"||action=="clearStart"){
            if(!core)return;
            if(action=="clearStart"){start_points.clear(map_id,active_track);toast("Start point cleared");}
            else{if(tutorial&&tutorial->is_active()){toast("Start points are unavailable in tutorial lessons");return;}const auto problem=native::start_point_problem(curr,practice.noclip);if(!problem.empty()){toast(problem);return;}start_points.save(map_id,active_track,curr,input.yaw(),input.pitch);toast(native::start_point_in_zone(curr,zones,active_track)?"Start point saved":"Start point saved outside the start zone: runs from it are practice, and the timer starts only from the start zone",native::start_point_in_zone(curr,zones,active_track)?3000u:5000u);}
            native::save_settings(cache/"start-points.json",start_points.points);return;
        }
        if(action=="nextWeapon"||action=="prevWeapon"){
            BhWeaponReport weapon{};if(core&&bh_weapon_report(core.get(),&weapon)){const uint32_t slot=weapon.active==weapon.primary&&weapon.primary?1:weapon.active==weapon.secondary&&weapon.secondary?2:3;uint32_t next=slot;for(int i=0;i<3;i++){next=action=="nextWeapon"?next%3+1:(next+1)%3+1;if(next==3||(next==1&&weapon.primary)||(next==2&&weapon.secondary))break;}input.pulse=(input.pulse&~(3u<<14))|(next<<14);}return;
        }
        if(!instant&&(action=="restart"||action=="restartMain"||action=="restartBonus")){
            BhRunState timing{};if(core)bh_run_state(core.get(),&timing);
            if(!restart_guard.press(action,epoch_ms(),preferences.at("holdRestart").get<bool>(),timing.status==1,wheel))return;
        }
        if(action=="practice"||action=="noclip"||action=="cpSave"||action=="cpTeleport"||action=="cpPrev"||action=="cpNext"){
            practice_action(action=="practice"?"toggle":action=="cpSave"?"save":action=="cpTeleport"?"tele":action=="cpPrev"?"prev":action=="cpNext"?"next":"noclip",true);return;
        }

        if(!gauntlet_id.empty()&&(action=="restartBonus"||action=="cycleStyle")){toast("Gauntlets are Normal style on the main track.");return;}
        if(action=="restart"||action=="restartMain") {if(tutorial&&tutorial->is_active())start_tutorial(tutorial->lesson_id(),tutorial_demo);else{if(action=="restartMain")active_track=0;reset();}}
        else if(action=="restartBonus") {
            std::set<uint32_t> tracks;for(const auto &z:zones)if(z.kind==0&&z.track)tracks.insert(z.track);
            if(!tracks.empty()){auto next=tracks.upper_bound(active_track);active_track=next==tracks.end()?*tracks.begin():*next;reset();}
        } else if(action=="cycleStyle") {
            static const std::vector<std::string> order={"autohop","legit","scroll","wonly","sideways","hsw","lowgrav","autostrafe"};
            auto at=std::find(order.begin(),order.end(),selected_style);selected_style=order[(size_t(at-order.begin())+1)%order.size()];reset();
        } else if(action=="slot1"||action=="slot2"||action=="slot3") input.pulse=(input.pulse&~(3u<<14))|(uint32_t(action.back()-'0')<<14);
        else if(action=="lastWeapon") input.pulse=(input.pulse&~(3u<<14))|(last_slot<<14);
        else if(action=="inspect") {if(renderer)renderer->inspect_press();if(core)bh_record_inspect(core.get(),1);}
        else if(action=="drop")input.pulse|=1u<<12;
        else if(action=="reload")input.pulse|=1u<<13;
        else if(action=="giveUsp"||action=="giveGlock"){kept_weapons.cancel();input.pulse=(input.pulse&~native::weapon_command_mask)|((action=="giveUsp"?3u:2u)<<native::give_shift);}

    };
    auto handle_code=[&](const std::string &code,bool down,bool repeat=false,bool wheel=false) {
        if(code.empty())return;
        if(down&&!repeat)for(const char *action:{"chat","commandChat"})for(const auto &key:preferences.at("binds").at(action))if(key==code){open_chat(std::string(action)=="commandChat");return;}
        if(gun_menu.open&&down&&!repeat&&code.size()==6&&code.starts_with("Digit")){const auto picked=gun_menu.key(code.back()-'0',weapon_context());if(!picked.refusal.empty())toast(picked.refusal);if(picked.weapon){kept_weapons.cancel();input.pulse=(input.pulse&~native::weapon_command_mask)|(*picked.weapon<<native::give_shift);}if(picked.handled)return;}
        if(!practice.menu_open&&!room.vote.is_null()&&down&&!repeat&&code.size()==6&&code.starts_with("Digit")){const int pick=code.back()-'0';if(pick>0&&room.vote.contains("options")&&size_t(pick)<=room.vote.at("options").size()){room_control({{"action","vote"},{"option",pick-1}});return;}}
        if(practice.menu_open&&down&&!repeat&&code.size()==6&&code.starts_with("Digit")){
            const int pick=code.back()-'0';
            if(pick==0){practice.menu_open=false;return;}
            if(pick>=1&&pick<=6){
                if((pick==3&&practice.number()<=1)||(pick==4&&practice.number()>=practice.checkpoints.size()))return;
                const char *actions[]={"save","tele","prev","next","noclip","keepVelocity"};practice_action(actions[pick-1]);return;
            }
        }
        if(down)held_codes.insert(code);else held_codes.erase(code);
        input.held=0;
        for(auto binding=preferences["binds"].begin();binding!=preferences["binds"].end();++binding) {
            const auto bit=movement_bit(binding.key());bool matching=false,held=false;
            for(const auto &raw:binding.value()) {const auto key=raw.get<std::string>();matching|=key==code||(wheel&&key=="MouseWheel");held|=held_codes.contains(key);}
            if(bit){if(bit==native::attack2&&matching&&down&&!repeat&&core&&!playback&&!room.spectator_target){BhWeaponReport weapon{};if(bh_weapon_report(core.get(),&weapon))scope.secondary(weapon.active);}
                if(wheel&&matching&&down)input.pulse|=bit;else if(held)input.held|=bit;}
            else if(matching&&down&&!repeat)act(binding.key(),wheel);
        }
        if(wheel)held_codes.erase(code);
        bool inspect=false;for(const auto &key:preferences["binds"]["inspect"])inspect|=held_codes.contains(key.get<std::string>());
        if(renderer)renderer->inspect_held(inspect);
        if(core&&std::find(preferences["binds"]["inspect"].begin(),preferences["binds"]["inspect"].end(),code)!=preferences["binds"]["inspect"].end())bh_record_inspect(core.get(),down?3:4);
    };
    refresh_replays();
    if(!opt.map.empty()) {
        nlohmann::json detail;
        const auto sidecar=std::filesystem::path(opt.map).replace_extension(".zones.json");
        if(std::filesystem::exists(sidecar)) detail["zones"]=nlohmann::json::parse(read_text(sidecar));
        load_map(opt.map,opt.content_root,std::filesystem::path(opt.map).stem().string(),detail);
    }
    if(!opt.online_map.empty()) request_map(opt.online_map);
    if(tutorial){const auto lesson=pending_tutorial.empty()?"jump":pending_tutorial;start_tutorial(lesson,pending_tutorial_demo);pending_tutorial.clear();}
    if(menu) show_menu(true); else if(!opt.hidden) capture(true);
    if(!opt.replay.empty()&&opt.runtime_smoke.empty())request_replay(opt.replay,"play");
    if(!opt.runtime_smoke.empty()){
        const std::filesystem::path output(opt.runtime_smoke);std::filesystem::create_directories(output);
        auto check=[](bool ok,const char *why){if(!ok)throw std::runtime_error(std::string("Runtime smoke: ")+why);};
        check(core&&renderer&&!menu,"needs a local BSP and no menu");
        check(!opt.replay.empty(),"needs a completed replay for the supplied BSP");
        nlohmann::json detail;const auto sidecar=std::filesystem::path(opt.map).replace_extension(".zones.json");
        if(std::filesystem::exists(sidecar))detail["zones"]=nlohmann::json::parse(read_text(sidecar));
        // A neutral host id allows tools on the tutorial fixture without enabling its lesson controller.
        load_map(opt.map,opt.content_root,"native-runtime-fixture",detail);
        check(practice_reason().empty(),"solo practice unavailable");
        act("thirdPerson");check(third_person&&practice.active&&practice.tool=="camera","third person did not invalidate ranked admission");
        reset();check(practice.active&&third_person,"restart lost third-person practice admission");
        act("thirdPerson");check(!third_person&&!practice.active,"pre-start first person did not restore clean attempt");
        BhRunState before{};bh_run_state(core.get(),&before);
        const auto saved_tick=curr.tick;practice_action("save");BhRunState after{};bh_run_state(core.get(),&after);
        check(practice.number()==1&&!practice.active&&curr.tick==saved_tick,"save tainted attempt or advanced simulation");
        check(before.recording==after.recording&&before.total_commands==after.total_commands,"save changed recording");
        // Gate exactly like a live timed run, without altering canonical movement.
        check(!practice.key_allowed("tele",true)&&practice.key_allowed("save",true),"timed key guard");
        practice_action("menu");check(practice.menu_open&&practice.key_allowed("noclip",true),"checkpoint menu guard");
        practice_action("tele");check(practice.active&&practice.tool=="teleport","teleport not practice");
        check(!native::practice_allows_event(practice.active,"beat")&&!native::practice_allows_event(practice.active,"finish"),"practice admission");
        const auto count=practice.checkpoints.size();reset();check(!practice.active&&practice.checkpoints.size()==count&&!practice.noclip,"restart did not clean attempt/preserve checkpoints");
        practice_action("toggle");reset();check(practice.mode&&practice.active,"practice mode lost across restart");
        practice_action("toggle");check(!practice.mode&&!practice.active,"leaving practice did not reset");
        practice_action("noclip");check(practice.noclip&&practice.active,"noclip entry");
        BhCmd command{};command.forward=450;BhSnapshot snapshot{};
        require(bh_noclip_move(&practice.flight,&command,dt),core.get(),"Smoke flight");require(bh_practice_noclip_tick(core.get(),&practice.flight,&snapshot),core.get(),"Smoke noclip tick");curr=prev=snapshot.player;
        practice_action("noclip");check(!practice.noclip&&practice.active,"noclip exit cleared practice");
        practice_action("menu");if(!practice.menu_open)practice_action("menu");
        int w=0,h=0;SDL_GetWindowSizeInPixels(window.get(),&w,&h);
        for(const float percent:{50.f,100.f,175.f}){
            bh_snapshot(core.get(),&snapshot);BhRunState timing{};bh_run_state(core.get(),&timing);BhWeaponReport weapon{};bh_weapon_report(core.get(),&weapon);
            const float eye[]={curr.position[0],curr.position[1],curr.position[2]+curr.view_offset_z};renderer->draw(w,h,eye,input,&snapshot,0);
            hud.draw(w,h,snapshot,timing,command,map_id,active_style,"",60,true,true,false,weapon,"",std::nullopt,std::nullopt,true,nullptr,percent,&practice,true,"Gauntlet 1/3 | 00:01.000","-0.500s",true,.5f);
            const auto png=backbuffer_png(gl,w,h);std::ofstream image(output/("hud-"+std::to_string(int(percent))+".png"),std::ios::binary);image.write(png.data(),png.size());
        }
        gauntlet_action({{"id","offline-smoke"},{"map","native-runtime-fixture"},{"progress",{{"idx",0},{"maps",2},{"before",0.0},{"pbSplit",nullptr}}}});
        check(!practice.active&&!practice.mode&&selected_style=="autohop"&&active_track==0,"gauntlet did not reset practice/style/track");
        check(practice_reason()=="No practice during a gauntlet.","gauntlet permits practice");
        act("thirdPerson");check(!third_person&&!practice.active,"third person escaped gauntlet admission");
        act("cycleStyle");act("restartBonus");check(selected_style=="autohop"&&active_track==0,"gauntlet bindings escaped lock");
        load_map(opt.map,opt.content_root,"native-runtime-fixture-next",detail);check(gauntlet_id=="offline-smoke"&&!practice.active,"gauntlet map progression lost lock");
        gauntlet_action({{"id",nullptr}});check(practice_reason().empty(),"gauntlet clear left practice blocked");
        practice_action("save");practice_action("tele");open_replay(opt.replay,"play");
        check(playback&&!practice.active&&!practice.mode&&practice.checkpoints.empty(),"replay retained practice state");
        replay_camera.set_mode("free");replay_camera.initialized=true;replay_camera.position={11,22,33};replay_camera.yaw=42;replay_camera.pitch=17;
        playback_paused=true;seek_playback(0);check(curr.tick==0&&playback_paused,"replay seek start/pause");
        const auto replay_total=playback_info.at("totalTicks").get<uint32_t>();seek_playback(replay_total);check(curr.tick==replay_total&&playback_paused,"replay seek end/pause");
        for(uint32_t tick=0;tick<std::min(10u,replay_total);++tick)replay_controls.pending=tick;
        replay_controls.pending=std::min(10u,replay_total);if(auto target=replay_controls.take())seek_playback(*target);
        check(curr.tick==std::min(10u,replay_total)&&!replay_controls.take(),"replay rapid seeks did not coalesce latest");
        check(replay_camera.initialized&&replay_camera.position==std::array<float,3>{11,22,33}&&replay_camera.yaw==42&&replay_camera.pitch==17,"seek lost free camera");
        replay_camera.set_mode("eye");BhSnapshot replay_snapshot{};bh_snapshot(core.get(),&replay_snapshot);const float replay_eye[]={curr.position[0],curr.position[1],curr.position[2]+curr.view_offset_z};renderer->draw(w,h,replay_eye,input,&replay_snapshot,0);
        native::draw_replay_controls(hud,w,h,native::HudGeometry(w,h,100).scale,replay_controls,curr.tick,replay_total,dt,playback_paused,playback_speed,replay_camera.mode);
        {const auto png=backbuffer_png(gl,w,h);std::ofstream image(output/"replay-controls.png",std::ios::binary);image.write(png.data(),png.size());}
        reset();check(!playback&&!practice.active,"replay restart not clean");
        auto start_timed_practice=[&](){
            practice_action("toggle");check(practice.active,"timed practice setup");
            BhRunOptions options{};bh_default_run_options(&options);options.rules=1;
            BhZone start{};for(int k=0;k<3;++k){start.mins[k]=curr.position[k]-32;start.maxs[k]=curr.position[k]+32;}
            BhZone end=start;end.kind=1;end.mins[2]+=4096;end.maxs[2]+=4096;const BhZone test_zones[]={start,end};
            require(bh_run_configure(core.get(),&options,test_zones,2),core.get(),"Smoke timed practice configuration");
            BhCmd command{};require(bh_step(core.get(),&command,&curr),core.get(),"Smoke enter start");
            require(bh_set_position(core.get(),curr.position[0]+256,curr.position[1],curr.position[2],0),core.get(),"Smoke leave start");
            require(bh_step(core.get(),&command,&curr),core.get(),"Smoke start practice timer");
            BhRunState timing{};require(bh_run_state(core.get(),&timing),core.get(),"Smoke read practice timer");check(timing.status==1,"practice timer did not start");
        };
        start_timed_practice();act("mainMenu");check(core&&leave_hold.started>=0,"timed practice skipped leave hold");
        const auto held_at=leave_hold.started;
        check(leave_hold.frame(held_at+599,true,false)==native::LeaveHold::Result::none,"practice leave fired early");
        check(leave_hold.frame(held_at+600,true,false)==native::LeaveHold::Result::leave,"practice leave did not fire at 600ms");leave_map();
        load_map(opt.map,opt.content_root,"native-runtime-fixture-wheel",detail);start_timed_practice();
        act("mainMenu",true);check(core&&renderer,"first timed practice wheel press left the map");
        act("mainMenu",true);check(!core&&!renderer,"second timed practice wheel press did not leave");
        load_map(opt.map,opt.content_root,"native-runtime-fixture-room",detail);
        const nlohmann::json welcome={{"t","welcome"},{"you",1},{"map",{{"name",map_id}}},{"players",nlohmann::json::array()}};
        apply_room_event({{"generation",7},{"id","old-room"},{"event",welcome}});check(room.id=="old-room","room setup");
        pending_replay="stale";pending_action="play";pending_room_map="stale";pending_tutorial="jump";
        std::atomic_bool entered=false,stopped=false;
        download.start([&](const std::atomic_bool &cancel)->native::DownloadedMap{entered=true;while(!cancel)std::this_thread::yield();{std::lock_guard lock(progress_mutex);if(!cancel)loading="stale";}stopped=true;throw std::runtime_error("cancelled");});
        while(!entered)std::this_thread::yield();const auto generation=run_generation;leave_map();
        const auto deadline=Clock::now()+std::chrono::seconds(1);while(!stopped&&Clock::now()<deadline)std::this_thread::yield();download.poll();
        check(stopped&&!core&&!renderer&&!download.valid()&&map_id.empty()&&zones.empty(),"leave-map core/worker shutdown");
        apply_room_event({{"generation",7},{"id","old-room"},{"event",{{"t","nativeMap"},{"map","bhop_late"}}}});
        apply_room_event({{"generation",7},{"id","old-room"},{"event",welcome}});
        check(room.generation==7&&room.id.empty()&&room.map.empty()&&!download.valid(),"late room callback revived map after leave");
        check(pending_replay.empty()&&pending_room_map.empty()&&pending_tutorial.empty()&&loading.empty()&&run_generation>generation,"leave-map stale work/generation");
        load_map(opt.map,opt.content_root,"native-runtime-fixture-new",detail);check(core&&renderer&&!practice.active&&practice.checkpoints.empty(),"new map after leave failed");
        check(gl.GetError()==GL_NO_ERROR,"OpenGL error");
        const nlohmann::json result={{"pass",true},{"practice",true},{"restart",true},{"newMap",true},{"replay",true},{"replayScrub",true},{"replaySeekPreservesFreeCamera",true},{"replaySeekEndpointsPaused",true},{"replaySeekCoalesced",true},{"checkpointMenu",true},{"hudScales",{50,100,175}},{"gauntlet",true},{"leaveMapWorkerShutdown",true},{"closedRoomGeneration",true},{"thirdPersonPracticeAdmission",true},{"timedPracticeLeaveHold",true},{"timedPracticeLeaveWheel",true},{"networkWrites",0},{"webglContexts",0}};
        std::ofstream(output/"result.json")<<result.dump(2)<<'\n';std::cout<<"Native runtime lifecycle smoke: "<<result.dump()<<'\n';return 0;
    }
    auto title_time=Clock::now(),ui_time=title_time,started=title_time; uint64_t frame=0,title_frames=0;
    // Discord Rich Presence / Join. Never from scripted or hidden runs, so a
    // smoke test can't show up on the developer's own profile.
    // BUNNYHOP_INPUT_LOG=path writes one line per tick: what that tick got from
    // the mouse and keyboard, and the frame it ran in. Off unless asked for.
    std::ofstream input_log;uint64_t input_frame=0;
    if(const char *log_path=std::getenv("BUNNYHOP_INPUT_LOG");log_path&&*log_path){
        input_log.open(log_path,std::ios::trunc);
        if(input_log)input_log<<"tick,frame,frame_ms,sim_ms,counts,pending,keys,speed,grounded,jumped\n";
        else std::cerr<<"Could not open BUNNYHOP_INPUT_LOG\n";
    }
    double input_frame_ms=0;
    native::MouseDiagnostics mouse_diagnostics;
    native::discord::Client discord;
    const bool discord_allowed=!opt.frames&&!opt.hidden&&opt.menu_smoke.empty();
    std::string presence_map;int64_t presence_started=0;auto presence_time=std::chrono::steady_clock::time_point{};
    discord.on_join=[&](const std::string &id){
        if(!menu||!menu_ready)return;
        show_menu(true);menu->evaluate_js("window.bunnyhopNativeMenu?.joinRoom?.("+nlohmann::json(id).dump()+")");
    };
    if(!opt.presentation_smoke.empty()){
        if(!renderer||!core)throw std::runtime_error("Presentation smoke requires a local map");bh_record_end(core.get());int width=0,height=0;SDL_GetWindowSizeInPixels(window.get(),&width,&height);const auto result=native::presentation_smoke(gl,core.get(),*renderer,hud,width,height,opt.presentation_smoke,map_id);std::cout<<result.dump()<<'\n';return 0;
    }
    if(!opt.video_smoke.empty()){
        // The viewer now plays with a free cursor too. Hold the fixture paused
        // so restoration can be inspected after each asynchronous export phase.
        playback_paused=true;
        BhSnapshot restored{};require(bh_replay_seek(core.get(),37,&restored),core.get(),"Video smoke initial seek");curr=prev=restored.player;replay_camera.set_mode("free");replay_camera.initialized=true;replay_camera.position={11,22,33};replay_camera.yaw=42;replay_camera.pitch=17;camera_controls.set_angles(17,42);
        if(video_probe.valid())video_available=video_probe.get();native::VideoOptions options;options.from=0;options.to=std::min(200u,playback_info.at("totalTicks").get<uint32_t>());options.camera="auto";request_video(options);
    }
    int video_smoke_stage=0;std::string video_smoke_encoder=video_available.encoder;
    auto check_video_restored=[&](){if(!playback_paused||curr.tick!=37||replay_camera.mode!="free"||!replay_camera.initialized||replay_camera.position!=std::array<float,3>{11,22,33}||std::abs(replay_camera.yaw-42)>.0001||std::abs(replay_camera.pitch-17)>.0001)throw std::runtime_error("Video export did not restore the viewer state");};
    const auto video_smoke_started=Clock::now();
    while(running) {
        if(window_dirty&&Clock::now()>=window_save_due)save_window();
        if(video_probe.valid()&&video_probe.wait_for(std::chrono::seconds(0))==std::future_status::ready)video_available=video_probe.get();
        const uint64_t mouse_pump_start=SDL_GetTicksNS();
        mouse_diagnostics.begin(mouse_pump_start,preferences.value("mouseDiagnostics",false)&&captured&&focused&&!chat.active&&!playback);
        bool had_input_activity=false;
        SDL_Event event;
        while(SDL_PollEvent(&event)) {
            if(event.type==SDL_EVENT_KEY_DOWN||event.type==SDL_EVENT_MOUSE_BUTTON_DOWN||event.type==SDL_EVENT_MOUSE_MOTION||event.type==SDL_EVENT_MOUSE_WHEEL||event.type==SDL_EVENT_TEXT_INPUT)had_input_activity=true;
            switch(event.type) {
                case SDL_EVENT_QUIT: running=false; break;
                case SDL_EVENT_WINDOW_CLOSE_REQUESTED:
                    if(event.window.windowID==SDL_GetWindowID(window.get()))running=false;
                    break;
                case SDL_EVENT_WINDOW_MOVED:case SDL_EVENT_WINDOW_RESIZED:case SDL_EVENT_WINDOW_MAXIMIZED:case SDL_EVENT_WINDOW_RESTORED:
                    if(event.window.windowID==SDL_GetWindowID(window.get())){window_dirty=true;window_save_due=Clock::now()+std::chrono::milliseconds(500);}break;
                case SDL_EVENT_WINDOW_FOCUS_LOST: if(!menu||!menu->visible())window_controller.focus_lost(preferences);focused=false;audio.focus(false); show_menu(true); break;
                case SDL_EVENT_WINDOW_FOCUS_GAINED: audio.focus(true); focused=true;if(resume_wanted&&(!menu||!menu->visible())) capture(!(playback&&replay_controls.visible));break;
                case SDL_EVENT_KEY_DOWN:
                case SDL_EVENT_KEY_UP: {
                    const bool down=event.type==SDL_EVENT_KEY_DOWN;
                    if(down&&!event.key.repeat&&event.key.scancode==SDL_SCANCODE_F10){show_menu(true);if(menu)menu->evaluate_js("window.bunnyhopNativeMenu?.open?.('settings','display')");break;}
                    if(down&&!event.key.repeat&&event.key.scancode==SDL_SCANCODE_RETURN&&(event.key.mod&SDL_KMOD_ALT)){
                        save_window();
                        if(!(video_capture||director_job||video_encoder.busy())){auto changed=preferences;changed["windowMode"]=native::toggled_window_mode(window_controller.mode());if(window_controller.apply(changed)){preferences=changed;native::save_settings(cache/"settings.json",preferences);}else error=window_controller.error();if(menu&&menu->visible())SDL_SetWindowAlwaysOnTop(window.get(),false);}break;}
                    if(video_capture||director_job||video_encoder.busy()){if(down&&event.key.scancode==SDL_SCANCODE_ESCAPE){cancel_video();refresh_playback_pose();}break;}
                    if(chat.active){
                        if(down){
                            if(!chat.composition.empty()){if(event.key.scancode==SDL_SCANCODE_ESCAPE){SDL_ClearComposition(window.get());chat.composition.clear();}break;}
                            const bool shortcut=(event.key.mod&(SDL_KMOD_CTRL|SDL_KMOD_GUI))!=0;const bool extend=(event.key.mod&SDL_KMOD_SHIFT)!=0;
                            if(event.key.scancode==SDL_SCANCODE_ESCAPE)close_chat();
                            else if(event.key.scancode==SDL_SCANCODE_RETURN||event.key.scancode==SDL_SCANCODE_KP_ENTER){
                                if(chat.composition.empty()){const auto text=chat.submit();close_chat();if(!text.empty()&&menu&&menu_ready)menu->evaluate_js("window.bunnyhopNativeMenu?.onChatSubmit?.("+nlohmann::json(text).dump()+")");}
                            }else if(shortcut&&event.key.scancode==SDL_SCANCODE_V){char *text=SDL_GetClipboardText();if(text){chat.insert(text);SDL_free(text);chat_suggest();}}
                            else if(shortcut&&event.key.scancode==SDL_SCANCODE_C)SDL_SetClipboardText(chat.selected_text().c_str());
                            else if(shortcut&&event.key.scancode==SDL_SCANCODE_X){const auto selected=chat.selected_text();if(!selected.empty()){SDL_SetClipboardText(selected.c_str());chat.erase();chat_suggest();}}
                            else if(shortcut&&event.key.scancode==SDL_SCANCODE_A)chat.select_all();
                            else if(event.key.scancode==SDL_SCANCODE_BACKSPACE){chat.backspace();chat_suggest();}
                            else if(event.key.scancode==SDL_SCANCODE_DELETE){chat.erase();chat_suggest();}
                            else if(event.key.scancode==SDL_SCANCODE_LEFT)chat.visual_move(false,hud.chat_carets(chat.input),extend);
                            else if(event.key.scancode==SDL_SCANCODE_RIGHT)chat.visual_move(true,hud.chat_carets(chat.input),extend);
                            else if(event.key.scancode==SDL_SCANCODE_HOME)chat.home(extend);
                            else if(event.key.scancode==SDL_SCANCODE_END){chat.end(extend);chat.scroll_bottom();}
                            else if(event.key.scancode==SDL_SCANCODE_PAGEUP)chat.scroll(8);
                            else if(event.key.scancode==SDL_SCANCODE_PAGEDOWN)chat.scroll(-8);
                            else if(event.key.scancode==SDL_SCANCODE_UP){chat.history_step(-1);chat_suggest();}
                            else if(event.key.scancode==SDL_SCANCODE_DOWN){chat.history_step(1);chat_suggest();}
                            else if(event.key.scancode==SDL_SCANCODE_TAB){chat.complete();chat_suggest();}
                        }
                        break;
                    }
                    if(down && !event.key.repeat) {
                        if(playback&&(!menu||!menu->visible())&&event.key.scancode==SDL_SCANCODE_TAB){replay_controls.visible=!replay_controls.visible;replay_controls.dragging=false;capture(!replay_controls.visible);break;}
                        if(playback&&(!menu||!menu->visible())&&event.key.scancode==SDL_SCANCODE_SPACE){replay_action(native::ReplayControls::Action::pause);break;}
                        if(playback&&(!menu||!menu->visible())&&(event.key.scancode==SDL_SCANCODE_LEFT||event.key.scancode==SDL_SCANCODE_RIGHT)){playback_paused=true;replay_controls.pending=event.key.scancode==SDL_SCANCODE_LEFT?(curr.tick?curr.tick-1:0):std::min(curr.tick+1,playback_info.value("totalTicks",0u));break;}
                        if(event.key.scancode==SDL_SCANCODE_ESCAPE) show_menu(!menu||!menu->visible());

                    }
                    if(captured)handle_code(native::key_code(event.key.scancode),down,event.key.repeat);
                    break;
                }
                case SDL_EVENT_TEXT_INPUT: if(chat.active){chat.insert(event.text.text);chat_suggest();}break;
                case SDL_EVENT_TEXT_EDITING: if(chat.active)chat.composition=native::Chat::clean(event.edit.text,512);break;
                case SDL_EVENT_MOUSE_MOTION:
                    if(mouse_diagnostics.active&&captured&&focused&&!chat.active)mouse_diagnostics.motion(event.motion.timestamp,SDL_GetTicksNS());
                    if(video_capture||director_job||video_encoder.busy()){replay_controls.dragging=false;replay_orbit_drag=false;break;}
                    if(playback&&replay_controls.dragging&&!chat.active&&(!menu||!menu->visible())){int w,h;SDL_GetWindowSizeInPixels(window.get(),&w,&h);const auto geometry=native::HudGeometry(w,h,100);replay_controls.motion(native::ReplayControls::layout(geometry.width,geometry.height),event.motion.x*SDL_GetWindowPixelDensity(window.get())/geometry.scale,playback_info.value("totalTicks",0u));break;}
                    if(chat.active&&chat_drag){const float scale=SDL_GetWindowPixelDensity(window.get());if(const auto byte=hud.chat_input_byte(event.motion.x*scale,event.motion.y*scale,chat.input))chat.position(*byte,true);}
                    if(captured&&focused&&!chat.active){if(playback&&replay_camera.mode=="free")camera_controls.accumulate(event.motion.xrel,event.motion.yrel);else if(playback&&replay_camera.mode=="chase")replay_camera.orbit(event.motion.xrel,event.motion.yrel);else if(!playback)input.accumulate(event.motion.xrel,event.motion.yrel);}break;
                case SDL_EVENT_MOUSE_BUTTON_DOWN:
                case SDL_EVENT_MOUSE_BUTTON_UP: {
                    if(video_capture||director_job||video_encoder.busy()){replay_controls.dragging=false;replay_orbit_drag=false;break;}
                    const bool down=event.type==SDL_EVENT_MOUSE_BUTTON_DOWN;
                    if(playback&&!chat.active&&(!menu||!menu->visible())&&event.button.button==SDL_BUTTON_RIGHT&&(replay_controls.visible||replay_orbit_drag)){replay_orbit_drag=down;capture(down);break;}
                    if(playback&&replay_controls.visible&&!chat.active&&(!menu||!menu->visible())&&event.button.button==SDL_BUTTON_LEFT){int w,h;SDL_GetWindowSizeInPixels(window.get(),&w,&h);const auto geometry=native::HudGeometry(w,h,100);const float scale=SDL_GetWindowPixelDensity(window.get())/geometry.scale;replay_action(replay_controls.pointer(native::ReplayControls::layout(geometry.width,geometry.height),event.button.x*scale,event.button.y*scale,playback_info.value("totalTicks",0u),down));break;}
                    if(chat.active){if(event.button.button==SDL_BUTTON_LEFT){chat_drag=false;if(down&&chat.composition.empty()){
                        const float scale=SDL_GetWindowPixelDensity(window.get()),x=event.button.x*scale,y=event.button.y*scale;
                        if(const auto byte=hud.chat_input_byte(x,y,chat.input)){chat.position(*byte,(SDL_GetModState()&SDL_KMOD_SHIFT)!=0);chat_drag=true;}
                        else if(const auto target=hud.chat_hit(x,y,chat.viewport(epoch_ms()/1000.))){close_chat();show_menu(true);if(menu&&menu_ready)menu->evaluate_js("window.bunnyhopNativeMenu?.onChatLink?.("+nlohmann::json(target->url).dump()+")");}
                    }}break;}
                    if(!captured&&down&&focused&&(!menu||!menu->visible())&&core) {capture(true);break;}
                    if(captured&&!chat.active){
                        const auto code=native::mouse_code(event.button.button);bool custom=false;for(auto binding=preferences["binds"].begin();binding!=preferences["binds"].end();++binding)if(binding.key()!="attack"&&binding.key()!="attack2")for(const auto &key:binding.value())custom|=key==code;
                        if(!custom&&room.spectator_target&&down&&(event.button.button==SDL_BUTTON_LEFT||event.button.button==SDL_BUTTON_RIGHT))room_control({{"action",event.button.button==SDL_BUTTON_LEFT?"next":"previous"}});
                        else if(!custom&&room.spectator_target&&down&&event.button.button==SDL_BUTTON_MIDDLE)third_person=!third_person;
                        else handle_code(native::mouse_code(event.button.button),down);
                    }
                    break;
                }
                case SDL_EVENT_MOUSE_WHEEL: if(chat.active){chat.scroll(event.wheel.y>0?3:event.wheel.y<0?-3:0);break;}if(captured&&playback&&replay_camera.mode=="chase"&&event.wheel.y!=0){replay_camera.zoom_by(std::pow(1.12,-event.wheel.y));break;}if(captured&&!chat.active&&event.wheel.y!=0)handle_code(event.wheel.y>0?"MWheelUp":"MWheelDown",true,false,true); break;
                default: break;
            }
        }
        mouse_diagnostics.end(SDL_GetTicksNS(),mouse_pump_start);
        if(had_input_activity)activity.input(std::chrono::duration<double>(Clock::now().time_since_epoch()).count());
        if(menu) for(const auto &raw:menu->drain_messages()) {
            try {
                if(raw.size()>12*1024*1024)throw std::runtime_error("Menu command too large");
                auto message=nlohmann::json::parse(raw);const auto type=message.at("type").get<std::string>();
                if(type=="loadoutPreview") {if(menu->visible()&&raw.size()<=8192)preview_request=std::move(message);continue;}
                if((video_capture||director_job||video_encoder.busy())&&type!="videoExport"&&type!="ready"&&type!="update"&&type!="audioCue"&&type!="music"&&type!="quit"){if(type=="settings")throw std::runtime_error("Finish or cancel video export before changing settings.");continue;}
                const size_t limit=(type=="replayData"||type=="menuBackdrop")?12*1024*1024:(type=="roomSnapshot"||type=="roomEvent")?128*1024:16*1024;
                if(raw.size()>limit)throw std::runtime_error("Menu command exceeds its type limit");
                if(type=="ready") {menu_ready=true;backdrop_shown.clear();backdrop_failed.clear();backdrop_cut=false;gameplay_backdrop_due=bool(core);run_event({{"type","reset"}});std::cout<<"Native menu ready: "<<raw<<'\n';}
                else if(type=="resume" && core && !download.valid()) show_menu(false);
                else if(type=="prefetchMap"){
                    if(message.at("map").is_null()){cancel_prefetch();continue;}
                    const auto map=message.at("map").get<std::string>(),sha=message.at("sha").get<std::string>();
                    if(!native::valid_map_id(map)||sha.size()!=64||sha.find_first_not_of("0123456789abcdef")!=std::string::npos)throw std::runtime_error("Invalid map prefetch");
                    if(!opt.runtime_smoke.empty()||opt.frames||(!playback&&pending_action!="play"))continue;
                    const auto key=map+":"+sha;if(key==prefetch_active||key==prefetch_done)continue;
                    cancel_prefetch();prefetch_map=map;prefetch_sha=sha;
                }
                else if(type=="menuAppearance") {menu_reduced_motion=message.value("reducedMotion",true);}
                else if(type=="menuBackdrop") {
                    // Home only: ignored once a gameplay map is loading or loaded.
                    const auto &value=message.at("map");const auto id=value.is_null()?std::string():value.get<std::string>();
                    if(!id.empty()&&!native::valid_map_id(id))throw std::runtime_error("Invalid backdrop map name");
                    std::string replay_path;
                    if(backdrop&&!core&&!download.valid()&&!id.empty()){
                        replay_path=local_backdrop_replay(id);
                        if(message.contains("replay"))try{
                            const auto &replay=message.at("replay");const auto run_id=replay.at("runId").get<std::string>();if(run_id.empty()||run_id.size()>128)throw std::runtime_error("Invalid PB run id");
                            const auto bytes=native::decode_base64(replay.at("replayBase64").get<std::string>());char hash[65]{};if(!bh_sha256(bytes.data(),bytes.size(),hash))throw std::runtime_error("Cannot hash backdrop replay");
                            std::filesystem::create_directories(cache/"backdrop");const auto path=cache/"backdrop"/(std::string(hash)+".bhr");
                            if(!std::filesystem::exists(path)){std::ofstream out(path,std::ios::binary);out.write(reinterpret_cast<const char*>(bytes.data()),bytes.size());if(!out)throw std::runtime_error("Cannot cache backdrop replay");}
                            valid_backdrop_replay(path,id);replay_path=path.string();
                        }catch(const std::exception &e){std::cerr<<"PB backdrop: "<<e.what()<<"; using local PB/tour\n";}
                    }
                    if(backdrop&&!core&&!download.valid()&&backdrop->request(id,replay_path)) {
                        backdrop_shown.clear();backdrop_failed.clear();backdrop_cut=false;backdrop_source.clear();
                        // Released at the menu's request: no map to match against.
                        if(id.empty())menu->evaluate_js("window.bunnyhopNativeBackdrop?.('none')");
                    }
                }
                else if(type=="chatLine"){
                    auto label=[&](const char *key){return message.contains(key)&&message[key].is_string()?message[key].get<std::string>():std::string();};
                    native::ChatDecoration decoration;decoration.color=label("nativeNameColor");decoration.badge=label("nativeBadge");decoration.rank=label("nativeRank");decoration.country=label("nativeCountry");decoration.profile=label("nativeProfileId");
                    chat.push(message.at("text").get<std::string>(),label("name"),label("kind"),epoch_ms()/1000.,std::clamp(message.value("ms",12000.),1000.,60000.)/1000.,decoration);
                }
                else if(type=="chatSuggestions"){if(message.value("request",uint64_t(0))!=chat_request||message.value("input",std::string())!=chat.input)continue;chat.suggestions.clear();if(chat.active&&message.at("items").is_array())for(const auto &value:message.at("items")){if(chat.suggestions.size()>=8)break;if(value.is_string())chat.suggestions.push_back(native::Chat::clean(value.get<std::string>(),512));}}
                else if(type=="chatAction"){
                    const auto action=message.at("action").get<std::string>();
                    if(action=="scores")show_scores=!show_scores;
                    else if(action=="jumpStats"){preferences["jumpStats"]=!preferences.at("jumpStats").get<bool>();native::save_settings(cache/"settings.json",preferences);apply_preferences();}
                    else if(action=="showTriggers"||action=="showClips"){const char *key=action=="showTriggers"?"triggersVisible":"clipsVisible";const bool on=!preferences.at(key).get<bool>();preferences[key]=on;native::save_settings(cache/"settings.json",preferences);apply_preferences();toast(std::string(action=="showTriggers"?"Triggers":"Player clips")+(on?" shown":" hidden"));}
                    else if(action=="hidePlayers")hide_players=message.value("hidden",!hide_players);
                    else if(action=="openRoom"){show_menu(true);menu->evaluate_js("window.bunnyhopNativeMenu?.open?.('room')");}
                    else if(core&&!download.valid()){
                        if((action=="restart"||action=="restartBonus")&&message.contains("track")){const auto track=message.at("track").get<uint32_t>();bool found=false;for(const auto &zone:zones)found|=zone.kind==0&&zone.track==track;if(!found)throw std::runtime_error("That track is unavailable");if(!gauntlet_id.empty()&&track)throw std::runtime_error("Gauntlets use the main track");active_track=track;reset();}
                        else if(action=="weapon"){const auto weapon=message.value("weapon",std::string());if(weapon=="menu"||weapon=="guns")gun_menu.show();else{const unsigned id=message.value("weaponId",weapon=="knife"?1u:weapon=="glock"?2u:weapon=="usp"?3u:0u);if(const auto reason=native::NativeWeaponMenu::refusal(id,weapon_context());!reason.empty())throw std::runtime_error(reason);if(!playback&&!room.spectator_target){kept_weapons.cancel();input.pulse=(input.pulse&~native::weapon_command_mask)|(id<<native::give_shift);}}}
                        else if(action=="restart"||action=="restartBonus"||action=="setStart"||action=="clearStart")act(action,false,true);
                        else throw std::runtime_error("Unknown chat action");
                    }
                }
                else if(type=="mapLoad"){
                    const auto action=message.at("action").get<std::string>();
                    if(action=="cancel"){
                        download.cancel();pending_replay.clear();pending_action.clear();pending_tutorial.clear();pending_tutorial_demo=false;pending_room_map.clear();
                        {std::lock_guard lock(progress_mutex);loading.clear();load_progress=nullptr;}
                        error.clear();if(core)reset();
                        if(backdrop&&!core&&backdrop->resume()){backdrop_shown.clear();backdrop_failed.clear();backdrop_cut=false;backdrop_source.clear();}
                    }else if(action=="retry"){if(last_requested_map.empty())throw std::runtime_error("No map to retry");request_map(last_requested_map);}
                    else throw std::runtime_error("Invalid loading action");
                }
                else if(type=="leaveMap")leave_map();
                else if(type=="practice")practice_action(message.at("action").get<std::string>(),false,message.contains("value")?std::optional<bool>(message.at("value").get<bool>()):std::nullopt);
                else if(type=="music"){const auto action=message.at("action").get<std::string>();if(action!="previous"&&action!="toggle"&&action!="next")throw std::runtime_error("Invalid music action");audio.music_control(action);}
                else if(type=="announce"){
                    const auto event=message.at("event").get<std::string>(),id=message.value("id",std::string()),preview=message.value("preview",std::string());
                    if(!native::announcer_event(event)||id.size()>256||(!preview.empty()&&!native::announcer_line(preview)))throw std::runtime_error("Invalid announcer request");
                    audio.announce(event,id,message.value("remote",false),preview);
                }
                else if(type=="audioCue"){
                    const auto id=message.at("id").get<std::string>();const double gain=message.value("gain",1.),rate=message.value("rate",1.);
                    if(id.empty()||id.size()>64||id.find_first_not_of("abcdefghijklmnopqrstuvwxyz0123456789_")!=std::string::npos||!std::isfinite(gain)||gain<0||gain>1||!std::isfinite(rate)||rate<.25||rate>4)throw std::runtime_error("Invalid interface sound");audio.play(id,float(gain),rate);
                }
                else if(type=="hudToast"){const auto text=message.at("text").get<std::string>();if(text.size()>500)throw std::runtime_error("HUD toast too long");toast(text,std::clamp(message.value("ms",3000u),500u,15000u));}
                else if(type=="gauntlet"){
                    gauntlet_action(message);
                }
                else if(type=="restart" && core && !download.valid()) {reset();show_menu(false);}
                else if(type=="selectMap") {
                    const auto style=message.value("style",selected_style);if(!native::styles.contains(style))throw std::runtime_error("Unknown style");
                    if(!gauntlet_id.empty()&&(style!="autohop"||message.value("track",0u)!=0||(!gauntlet_map.empty()&&message.at("id").get<std::string>()!=gauntlet_map)))throw std::runtime_error("Gauntlets are Normal style on the main track.");
                    tutorial_stopped=false;selected_style=style;active_track=message.value("track",0u);if(active_track>64)throw std::runtime_error("Invalid track");
                    request_map(message.at("id").get<std::string>());
                }
                else if(type=="style") {if(!gauntlet_id.empty())throw std::runtime_error("Gauntlets are Normal style on the main track.");if(download.valid())throw std::runtime_error("A map is loading");const auto id=message.at("id").get<std::string>();if(!native::styles.contains(id))throw std::runtime_error("Unknown style");selected_style=id;active_track=0;reset();}
                else if(type=="settings") {save_window();auto changed=native::patch_settings(preferences,message.at("patch"));const auto effective=window_for_menu(changed,menu&&menu->visible());if(!window_controller.apply(effective))throw std::runtime_error(window_controller.error());native::save_settings(cache/"settings.json",changed);preferences=std::move(changed);input.held=input.pulse=0;held_codes.clear();apply_preferences();error.clear();}
                else if(type=="window") {const auto action=message.at("action").get<std::string>();bool ok=false;if(action=="center")ok=window_controller.center();else if(action=="minimize")ok=window_controller.minimize();else if(action=="maximize")ok=window_controller.maximize();else if(action=="toggleFullscreen"){save_window();auto changed=preferences;changed["windowMode"]=native::toggled_window_mode(window_controller.mode());const auto effective=window_for_menu(changed,menu&&menu->visible());ok=window_controller.apply(effective);if(ok){preferences=changed;native::save_settings(cache/"settings.json",preferences);}}else throw std::runtime_error("Unknown window action");if(!ok)throw std::runtime_error(window_controller.error());window_dirty=true;window_save_due=Clock::now()+std::chrono::milliseconds(500);}
                else if(type=="replays")refresh_replays();
                else if(type=="ghost"){ghost_enabled=ghost_handle&&message.at("enabled").get<bool>();ghost_slots[0].enabled=ghost_enabled;}
                else if(type=="ghostControl"){
                    const auto action=message.at("action").get<std::string>();const unsigned slot=message.value("slot",0u);if(slot>=4)throw std::runtime_error("Invalid ghost slot");
                    if(action!="remove"&&action!="clear"&&action!="toggle")throw std::runtime_error("Invalid ghost action");
                    for(unsigned i=0;i<4;i++)if(action=="clear"||i==slot){auto &ghost=ghost_slots[i];if(action=="toggle")ghost.enabled=ghost.handle&&message.value("enabled",!ghost.enabled);else{if(core&&ghost.handle)bh_ghost_free(core.get(),ghost.handle);ghost={};}if(i==0){ghost_handle=ghost.handle;ghost_enabled=ghost.enabled;ghost_id=ghost.id;ghost_info=ghost.info;}}
                    if(renderer)renderer->reset_presentation();scope.reset();
                }
                else if(type=="replay") {
                    const auto path=native::replay_file(cache/"replays",message.at("id").get<std::string>());const auto action=message.at("action").get<std::string>();
                    if(action=="play"||action=="ghost")request_replay(path,action,message.value("ghostSlot",0u));
                    else if(action=="screenshot"){const auto screenshot=run_vault.screenshot(path.filename().string());if(!screenshot)throw std::runtime_error("This local run has no saved screenshot");if(!SDL_OpenURL(native::RunVault::file_uri(*screenshot).c_str()))throw std::runtime_error(SDL_GetError());}
                    else if(action=="export") {
                        const char *folder=SDL_GetUserFolder(SDL_FOLDER_DOWNLOADS);if(!folder)throw std::runtime_error("Downloads folder unavailable");
                        const auto dest=std::filesystem::path(folder)/path.filename();std::filesystem::copy_file(path,dest,std::filesystem::copy_options::none);score_notice="Replay exported to Downloads";
                    } else if(action=="delete") {
                        std::filesystem::create_directories(cache/"replays"/"trash");auto dest=cache/"replays"/"trash"/path.filename();
                        if(std::filesystem::exists(dest))throw std::runtime_error("Replay already exists in local trash");std::filesystem::rename(path,dest);try{run_vault.trash(path.filename().string());}catch(const std::exception&e){std::cerr<<"Vault trash: "<<e.what()<<'\n';}refresh_replays();
                    } else throw std::runtime_error("Unknown replay action");
                }
                else if(type=="replayData") {
                    const auto bytes=native::decode_base64(message.at("replayBase64").get<std::string>());
                    char sha[65]{};bh_sha256(bytes.data(),bytes.size(),sha);
                    const auto path=cache/"replays"/(std::string("import-")+sha+".bhr");
                    if(!std::filesystem::exists(path)){std::ofstream out(path,std::ios::binary);out.write(reinterpret_cast<const char*>(bytes.data()),bytes.size());if(!out)throw std::runtime_error("Cannot save imported replay");}
                    const auto action=message.at("action").get<std::string>();if(action!="play"&&action!="ghost")throw std::runtime_error("Invalid replay import action");
                    request_replay(path,action,message.value("ghostSlot",0u));refresh_replays();
                }
                else if(type=="tutorial"){
                    const auto action=message.at("action").get<std::string>();if(action=="stop"){tutorial_stopped=true;pending_tutorial.clear();if(tutorial)tutorial->stop();if(tutorial_demo&&ghost_handle){bh_ghost_free(core.get(),ghost_handle);ghost_handle=0;ghost_enabled=false;}tutorial_demo=false;score_notice.clear();show_menu(true);}
                    else if(action=="start"||action=="demo"){const auto lesson=message.at("lesson").get<std::string>();if(lesson!="jump"&&lesson!="strafe"&&lesson!="speed"&&lesson!="final")throw std::runtime_error("Unknown tutorial lesson");if(map_id==tutorial_map&&core&&tutorial)start_tutorial(lesson,action=="demo");else{tutorial_stopped=false;pending_tutorial=lesson;pending_tutorial_demo=action=="demo";selected_style="autohop";active_track=0;request_map(tutorial_map);}}
                    else throw std::runtime_error("Unknown tutorial action");
                }
                else if(type=="videoExport") {
                    try{if(message.value("action",std::string())=="cancel"){cancel_video();refresh_playback_pose();}
                    else if(message.value("action",std::string())=="start"){const auto &v=message.at("options");native::VideoOptions options;options.width=v.at("width");options.height=v.at("height");options.fps=v.at("fps");options.quality=v.at("quality");options.camera=v.at("camera");options.hud=v.at("hud");options.audio=v.value("audio",true);options.music=v.value("music",std::string("none"));options.music_offset=v.value("musicOffset",0.);options.music_level=v.value("musicLevel",1.f);options.music_loop=v.value("musicLoop",true);options.music_duck=v.value("musicDuck",true);options.from=v.at("from");options.to=v.at("to");request_video(options);}}
                    catch(const std::exception &e){cancel_video();refresh_playback_pose();video_error=e.what();}
                }
                else if(type=="replayControl"&&playback) {
                    const auto action=message.at("action").get<std::string>();
                    if(action=="camera"){if(!replay_camera.set_mode(message.at("camera").get<std::string>()))throw std::runtime_error("Invalid replay camera");camera_controls.set_angles(replay_camera.pitch,replay_camera.yaw);camera_controls.clear();if(replay_camera.mode=="auto"){director_only=true;director_job=std::make_unique<native::ReplayDirectorJob>(core.get(),playback_info.at("totalTicks").get<uint32_t>(),curr.tick);}}
                    else if(action=="pause")playback_paused=message.value("paused",!playback_paused);
                    else if(action=="speed") {const double value=message.at("speed").get<double>();if(!std::isfinite(value)||value<.1||value>4)throw std::runtime_error("Replay speed must be 0.1–4");playback_speed=value;}
                    else if(action=="seek") {const auto tick=message.at("tick").get<uint32_t>();if(tick>playback_info.at("totalTicks").get<uint32_t>())throw std::runtime_error("Replay tick outside run");replay_controls.pending=tick;}
                    else if(action=="stop")reset();
                }
                else if(type=="sensitivity") {preferences=native::patch_settings(preferences,{{"sensitivity",message.at("value")}});native::save_settings(cache/"settings.json",preferences);apply_preferences();}
                else if(type=="playerName") replay_player=native::replay_player_name(message.value("name",std::string()));
                else if(type=="cosmetics") {
                    player_glow=native_render::parse_glow(message.value("playerGlow",nlohmann::json(nullptr)));
                    outfit=message.value("outfit",std::string());packed_loadout=message.value("packedLoadout",std::string());
                    if(outfit.size()>64||packed_loadout.size()>200)throw std::runtime_error("Invalid cosmetic selection");
                    ghost_cosmetic=message.value("ghostId",ghost_cosmetic);trail_cosmetic=message.value("trailId",trail_cosmetic);if(ghost_cosmetic.size()>64||trail_cosmetic.size()>64)throw std::runtime_error("Invalid ghost cosmetic");
                    if(renderer){renderer->set_player_glow(player_glow);renderer->set_cosmetics(outfit,packed_loadout);renderer->set_ghost_cosmetics(ghost_cosmetic,trail_cosmetic);}
                }
                else if(type=="roomEvent") {
                    apply_room_event(message);
                }
                else if(type=="roomSnapshot")room.snapshot(message,std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch()).count());
                else if(type=="openAuth") menu->open_auth(message.at("url").get<std::string>());
                else if(type=="update") {
                    const auto action=message.value("action",std::string());
                    if(action=="check")updater.check();else if(action=="download")updater.download();else if(action=="cancel")updater.cancel();else if(action=="reveal")updater.reveal();
                    last_update.clear();
                }
                else if(type=="dataFolder") {
                    // The host only ever moves to a folder it validated from its own
                    // picker (data_choice); the menu never supplies a path.
                    const auto action=message.value("action",std::string());
                    auto save_location=[&]{try{data_location::write(default_root,location);return true;}catch(const std::exception &e){data_notice=e.what();return false;}};
                    if(action=="pick"){
                        bool start=false;{std::lock_guard lock(data_picker.m);if(!data_picker.open){data_picker.open=true;data_picker.done=false;data_picker.result.reset();data_picker.error.clear();start=true;}}
                        if(start){data_notice.clear();const auto from=data_location::utf8(cache);SDL_ShowOpenFolderDialog(&data_folder_picked,&data_picker,window.get(),from.c_str(),false);}
                    }
                    else if(action=="useDefault"){data_notice.clear();data_choice=data_location::choose(default_root,cache,default_root);}
                    else if(action=="cancelChoice")data_choice.reset();
                    else if(action=="move"){
                        const bool now=message.value("when",std::string())=="now";
                        if(data_unavailable)data_notice="Reconnect the drive with your data folder first, or use the default folder.";
                        else if(!data_choice||!data_choice->problem.empty())data_notice="Pick a folder first.";
                        else{location.pending=data_choice->target;if(save_location()){const auto where=data_location::utf8(data_choice->target);data_choice.reset();
                            if(now){relaunch_requested=true;running=false;}
                            else{data_notice="Your game data will move to "+where+" the next time the game starts.";toast(data_notice,5000);}}
                            else location.pending.reset();}
                    }
                    else if(action=="cancelPending"){location.pending.reset();if(save_location())data_notice="Data move cancelled.";}
                    else if(action=="forget"&&data_unavailable){location={default_root,std::nullopt};if(save_location()){data_unavailable=false;data_notice="Using the default folder from now on.";}}
                    else if(action=="reveal")SDL_OpenURL(data_location::file_url(cache).c_str());
                    last_data_state.clear();
                }
                else if(type=="openExternal") native::open_external(message.at("url").get<std::string>());
                else if(type=="auth") menu->evaluate_js("window.bunnyhopNativeMenu?.onAuth("+message.dump()+")");
                else if(type=="menuError") {error=message.value("error",std::string("Menu failed"));std::cerr<<"Menu: "<<error<<'\n';}
                else if(type=="worldRecord") {
                    if(message.value("generation",uint64_t(-1))!=run_generation||message.value("map",std::string())!=map_id||message.value("style",std::string())!=active_style||message.value("track",~0u)!=active_track)continue;
                    known_world_record.reset();world_record_generation=run_generation;
                    if(message.contains("seconds")&&!message["seconds"].is_null()){const double seconds=message.at("seconds").get<double>();if(!std::isfinite(seconds)||seconds<=0)throw std::runtime_error("Invalid world record time");known_world_record=seconds;}
                }
                else if(type=="runService") {
                    if(message.value("generation",uint64_t(-1))!=run_generation)continue;
                    if(message.value("status",std::string())=="verified"&&!practice.active&&!turn_admission.local_only){
                        const auto id=message.value("id",std::string());const auto event=message.value("announcer",std::string());
                        if(!id.empty()&&(event=="pb"||event=="wr")){audio.verified_finish(event,id);}
                    }
                    if(!practice.active&&!turn_admission.local_only)score_notice=message.value("message",std::string());std::cout<<"Score service: "<<message.dump()<<'\n';
                }
                else if(type=="quit") running=false;
                else if(type=="smoke" && !opt.menu_smoke.empty()) {
                    message["engine"]="native";message["renderer"]="opengl";message["map"]=map_id;message["nativeTick"]=curr.tick;
                    message["backdropHost"]=backdrop?backdrop->state(backdrop_source):nlohmann::json(nullptr);message["backdropShown"]=backdrop_shown;
                    const auto ui_backdrop=message.value("backdrop",std::string());
                    // Home: the real map tour the menu asked for is on screen
                    // behind the web home. Pause: the loaded map itself.
                    const bool matches_screen=opt.menu_home_smoke
                        ? map_id.empty() && message.value("screen",std::string())=="home" && message.value("uiMap",std::string()).empty() && message.value("tiles",0)>=1 && message.value("attractLive",false)
                            && backdrop && backdrop->status()==MenuBackdrop::Status::ready && !backdrop_shown.empty() && backdrop_shown==backdrop->map() && backdrop->shots()>0
                        : !map_id.empty() && message.value("screen",std::string())=="pause" && message.value("uiMap",std::string())==map_id && backdrop_shown==map_id && bool(renderer);
                    smoke_pass=message.value("apiStatus",0)==200 && message.value("origin",std::string())=="https://bunnyhop.lol" && message.value("webglAttempts",1)==0 && message.value("webglContexts",1)==0 && message.value("canvasCount",1)==0 && message.value("controlsVisible",false) && matches_screen
                        && (ui_backdrop=="scene"||(ui_backdrop=="static"&&message.value("stillShown",false)));
                    message["pass"]=smoke_pass;
                    std::ofstream(opt.menu_smoke+".json")<<message.dump(2)<<'\n';
                    std::cout<<"Native menu smoke: "<<message.dump()<<'\n';
                    int w=0,h=0;SDL_GetWindowSizeInPixels(window.get(),&w,&h);
                    if(renderer) renderer->screenshot(opt.menu_smoke+"-game.ppm",w,h);
                    // The exact native frame the menu was handed.
                    if(!backdrop_png.empty())std::ofstream(opt.menu_smoke+"-scene.png",std::ios::binary).write(backdrop_png.data(),backdrop_png.size());
                    smoke_snapshot=menu->screenshot(opt.menu_smoke+".png");
                    if(!smoke_snapshot) {smoke_pass=false;running=false;}
                }
                else if(type=="menuSnapshot" && smoke_snapshot) {smoke_pass=smoke_pass&&message.value("ok",false);running=false;}
            } catch(const std::exception &e) {error=e.what();std::cerr<<"Menu: "<<error<<'\n';chat.push(error,"","error",epoch_ms()/1000.);toast(error);}
        }
        prefetch.poll();
        if(prefetch.valid()&&prefetch.wait_for(std::chrono::seconds(0))==std::future_status::ready){
            try{auto result=prefetch.get();if(file_hash(result.bsp.string())==prefetch_sha)prefetch_done=prefetch_active;}
            catch(const std::exception &e){std::cerr<<"Map prefetch: "<<e.what()<<'\n';}
            prefetch_active.clear();prefetch_map.clear();prefetch_sha.clear();
        }
        if(!prefetch.valid()&&!prefetch_map.empty()&&!download.valid()&&playback){
            const auto id=prefetch_map;prefetch_active=id+":"+prefetch_sha;
            prefetch.start([&,id](const std::atomic_bool &cancel){const auto lock=lock_cache(cancel);native::DownloadLimits limits;limits.bsp=64*1024*1024;limits.content_total=256*1024*1024;return native::download_map(id,cache,[](const std::string &){},&cancel,limits);});
        }
        download.poll();
        if(download.valid() && download.wait_for(std::chrono::seconds(0))==std::future_status::ready && !map_preparing) {
            map_preparing=true;
            nlohmann::json update;
            {std::lock_guard lock(progress_mutex);loading="Preparing map, models and native renderer…";load_progress["stage"]="renderer";load_progress["message"]=loading;update={{"loading",loading},{"loadProgress",load_progress},{"error",""}};}
            if(menu&&menu_ready)menu->evaluate_js("window.bunnyhopNativeMenu?.onState?.("+update.dump()+")");
        } else if(download.valid() && map_preparing) {
            map_preparing=false;
            try {auto result=download.get();load_map(result.bsp.string(),result.content_root.string(),result.id,result.detail);}
            catch(const std::exception &e) {
                pending_replay.clear();pending_action.clear();pending_tutorial.clear();pending_tutorial_demo=false;
                const std::string failure=e.what();if(core)reset();error=failure;std::cerr<<error<<'\n';if(!menu||opt.frames)throw;
                // Back on the home screen: restart the tour this download interrupted.
                if(backdrop&&!core&&backdrop->resume()){backdrop_shown.clear();backdrop_failed.clear();backdrop_cut=false;backdrop_source.clear();}
            }
            {std::lock_guard lock(progress_mutex);loading.clear();if(error.empty())load_progress=nullptr;else if(load_progress.is_object()){load_progress["stage"]="error";load_progress["message"]=error;}}
            if(tutorial&&!tutorial_stopped&&error.empty()&&pending_replay.empty()){const auto lesson=pending_tutorial.empty()?"jump":pending_tutorial;try{start_tutorial(lesson,pending_tutorial_demo);}catch(const std::exception &e){error=e.what();}pending_tutorial.clear();pending_tutorial_demo=false;}
            if(!pending_replay.empty()&&error.empty()) {auto path=pending_replay,action=pending_action;pending_replay.clear();try{open_replay(path,action,pending_ghost_slot);}catch(const std::exception &e){error=e.what();}}
            if(!pending_room_map.empty()&&pending_room_map!=map_id){const auto next=pending_room_map;pending_room_map.clear();active_track=0;request_map(next);}
            else pending_room_map.clear();
            if(!menu && core && !opt.hidden) capture(true);
        }
        if(!running) break;
        if(menu&&menu_ready){
            if(const auto state=menu_gamepad.sample(menu->visible()&&focused))menu->evaluate_js("window.bunnyhopNativeMenu?.onGamepad?.("+state->dump()+")");
            if(preview_request){
                auto job=std::move(*preview_request);preview_request.reset();std::string png;
                try {if(menu->visible()) {if(!loadout_preview)loadout_preview=std::make_unique<NativeLoadoutPreview>(gl,assets);png=loadout_preview->render(job,double(SDL_GetTicksNS())/1e9);}}catch(const std::exception &e){std::cerr<<"Loadout preview: "<<e.what()<<'\n';}
                const nlohmann::json result={{"id",job.value("id",0u)},{"png",png.empty()?std::string():"data:image/png;base64,"+base64(png)}};
                menu->evaluate_js("window.bunnyhopNativeLoadoutPreview?.("+result.dump()+")");
            }
        }
        const auto now=Clock::now();
        bool leave_held=false;for(const auto &key:preferences.at("binds").at("mainMenu"))leave_held|=held_codes.contains(key.get<std::string>());
        const auto leave_result=leave_hold.frame(epoch_ms(),leave_held,!captured||playback);
        if(leave_result==native::LeaveHold::Result::leave)leave_map();
        else if(leave_result==native::LeaveHold::Result::tap)toast("Hold Main menu key to leave");
        const auto spectator=core&&room.map==map_id?room.spectator_target:std::optional<unsigned>();
        if(now-presence_time>=std::chrono::milliseconds(250)) {
            presence_time=now;
            const auto unix_now=int64_t(std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count());
            if(map_id!=presence_map){presence_map=map_id;presence_started=unix_now;}
            const auto settings=native::discord::settings_from(preferences);
            nlohmann::json activity;
            if(discord_allowed&&settings.enabled&&!settings.privacy) {
                static const std::map<std::string,std::string> style_names={{"autohop","Normal"},{"legit","EZ Scroll"},{"scroll","Legit Scroll"},{"wonly","W-Only"},
                    {"sideways","Sideways"},{"hsw","Half-Sideways"},{"lowgrav","Low Gravity"},{"autostrafe","Auto-strafe"}};
                native::discord::Status status;
                status.kind=map_id.empty()?"menu":playback?"replay":(!captured||(menu&&menu->visible()))?"paused":"playing";
                status.mode=playback?"replay":!room.id.empty()?"multiplayer":tutorial_practice()?"practice":"solo";
                status.map=map_id==tutorial_map?"the tutorial":map_id;
                const auto named=style_names.find(active_style);status.style=named==style_names.end()?active_style:named->second;
                status.started_at=presence_started;status.room=room.id;
                activity=native::discord::build_activity(status,settings,[](const std::string &text){
                    char hex[65]{};bh_sha256(reinterpret_cast<const uint8_t *>(text.data()),text.size(),hex);return std::string(hex);},unix_now);
            }
            discord.update(discord_allowed&&settings.enabled&&!settings.privacy,activity);
        }
        if(spectator!=observed_spectator){
            if(spectator){bh_record_end(core.get());recording_ended=true;record_path.clear();pending_vault_capture.reset();beat_start=0;++run_generation;run_event({{"type","reset"}});audio.reset();accumulator=0;input.clear();renderer->reset_presentation();scope.reset();show_menu(false);}
            else if(observed_spectator&&core&&!playback)reset();observed_spectator=spectator;
        }
        if(const auto ready=restart_guard.frame(epoch_ms(),held_action(restart_guard.action),!captured||chat.active||playback))act(*ready,false,true);
        if(director_job)try{if(director_job->step()){
            const auto interval=playback_info.at("settings").value("tickInterval",dt);
            if(director_only){if(director_job->plan(replay_camera,interval,0,playback_info.at("totalTicks").get<uint32_t>())){director_job.reset();refresh_playback_pose();}}
            else{const auto options=*pending_video;if(director_job->plan(prepared_camera,interval,options.from,options.to)){director_job.reset();pending_video.reset();begin_video(options);}}
        }}catch(const std::exception &e){cancel_video();refresh_playback_pose();video_error=e.what();}
        if(video_capture)try{if(!video_encoder.busy()){video_capture.reset();refresh_playback_pose();}else{video_capture->step();if(video_capture->done()){video_capture.reset();refresh_playback_pose();}}}catch(const std::exception &e){cancel_video();refresh_playback_pose();video_error=e.what();}
        if(!video_capture&&!director_job&&!video_encoder.busy())if(const auto seek=replay_controls.take())try{seek_playback(*seek);}catch(const std::exception&e){error=e.what();playback_paused=true;}
        const bool simulation_active=!video_capture&&!director_job&&!video_encoder.busy()&&core && !spectator && !room_modes.frozen() && !download.valid() && ((focused&&(captured||(playback&&(!menu||!menu->visible()))))||opt.frames)&&(!playback||(!playback_paused&&!replay_controls.dragging));
        if(beat_start&&!simulation_active) beat_paused=true;
        const double frame_seconds=input_clock.elapsed(now);
        const bool activity_active=core&&!download.valid()&&focused&&captured&&!playback&&!spectator&&!opt.frames&&opt.runtime_smoke.empty();
        activity.frame(map_id,frame_seconds,std::chrono::duration<double>(now.time_since_epoch()).count(),activity_active);
        ++input_frame;input_frame_ms=frame_seconds*1000;
        const double step_dt=playback?playback_info.at("settings").value("tickInterval",dt):dt;
        if(simulation_active) accumulator+=(opt.frames?step_dt:std::clamp(frame_seconds,0.0,.25))*(playback?playback_speed:1);
        // Where simulated time has reached, on SDL's clock. accumulator is how
        // far behind the simulation is, so now minus it is where the next tick
        // starts. This frame's motion arrived now; the ticks below share it by
        // how much of the span up to now each covers (see Input::take_tick).
        const uint64_t wall_ns=SDL_GetTicksNS();
        const uint64_t behind_ns=uint64_t(std::max(0.0,accumulator)*1e9);
        uint64_t sim_ns=behind_ns<wall_ns?wall_ns-behind_ns:0;
        const uint64_t tick_ns=uint64_t(step_dt*1e9);
        // Not simulating means no tick will take it, so apply it now.
        if(!simulation_active) input.consume_all(); else input.arrived(wall_ns);
        while(accumulator>=step_dt) {
            // --frames is a deterministic mode with no wall clock to share by,
            // so a tick there takes whatever is waiting.
            const double counts_before=input.yaw_counts;
            if(opt.frames) input.consume_all();
            else {input.take_tick(sim_ns,sim_ns+tick_ns);sim_ns+=tick_ns;}
            const double mouse_counts=input.yaw_counts-counts_before;
            prev=curr;const BhState tutorial_pre=curr;
            BhCmd cmd{};
            if(playback) {
                if(curr.tick>=playback_info.at("totalTicks").get<uint32_t>()){playback_paused=true;accumulator=0;break;}
                BhSnapshot state{};if(!bh_replay_step(core.get(),&state)){const std::string failure=bh_last_error(core.get());playback_failed=true;reset();error="Replay stopped: "+failure;std::cerr<<error<<'\n';show_menu(true);accumulator=0;if(opt.frames)running=false;break;}curr=state.player;bh_last_command(core.get(),&cmd);input.set_angles(cmd.pitch,cmd.yaw,5);
            } else {
                if(const double rate=turn_rate()) {
                    input.turn(rate,dt);
                    if(turn_admission.observe(rate,active_style=="scroll")) {
                        // Invalidate any open ranked session, but keep recording the local archive.
                        ++run_generation;run_event({{"type","reset"}});beat_start=0;
                        score_notice="Practice turn controls: local replay only";
                    }
                }
                input.held=0;for(auto b=preferences["binds"].begin();b!=preferences["binds"].end();++b){const auto bit=movement_bit(b.key());if(bit)for(const auto &key:b.value())if(held_codes.contains(key.get<std::string>()))input.held|=bit;}if(!(input.pulse&native::give_mask))if(const auto give=kept_weapons.next())input.pulse=(input.pulse&~native::weapon_command_mask)|(give<<native::give_shift);cmd=input.command();
                if(practice.noclip){BhSnapshot snapshot{};require(bh_noclip_move(&practice.flight,&cmd,dt),core.get(),"Moving noclip");require(bh_practice_noclip_tick(core.get(),&practice.flight,&snapshot),core.get(),"Stepping practice noclip");curr=snapshot.player;}
                else{const auto look=input.look_sample();require(bh_step_look_v2(core.get(),&cmd,look?&*look:nullptr,&curr),core.get(),"Stepping simulation");require(bh_last_command(core.get(),&cmd),core.get(),"Reading filtered command");input.events(curr);}}
            renderer->simulation_tick();hud.tick(curr);
            if(input_log&&!playback) {
                const double moved=mouse_counts;
                input_log<<curr.tick<<','<<input_frame<<','<<input_frame_ms<<','<<double(sim_ns)/1e6<<','<<moved<<','<<input.pending_counts()<<','
                    <<cmd.buttons<<(cmd.side>0?"R":cmd.side<0?"L":"")<<(cmd.forward>0?"F":cmd.forward<0?"B":"")<<','
                    <<std::hypot(double(curr.velocity[0]),double(curr.velocity[1]))<<','<<int(curr.grounded!=0)<<','<<int((curr.events&2u)!=0)<<'\n';
            }
            if(curr.events&native::teleported)room_events|=8;if(curr.events&2)room_events|=4;
            if(curr.events&(1u<<5)){const bool stab=cmd.buttons&native::attack2;room_events|=stab?32:16;if(!playback)bh_record_cosmetic(core.get(),stab?2:1);}
            if(playback){BhReplayEvents e{};if(bh_replay_events(core.get(),prev.tick,curr.tick,&e)){if(e.inspect_signal)renderer->inspect_press();renderer->inspect_held(e.inspect_held!=0);}}
            BhSnapshot state{};bh_snapshot(core.get(),&state);BhRunState timing{};bh_run_state(core.get(),&timing);BhWeaponReport weapon{};bh_weapon_report(core.get(),&weapon);BhAttackReport attack{};
            if(!playback&&!practice.active&&!tutorial_practice()&&!opt.frames&&opt.runtime_smoke.empty()){if(curr.events&2)activity.jump(map_id);if(timing.update_flags&1)activity.attempt(map_id);}
            {
                // Jump stats. |prev| is the state before this tick, which is what the
                // plugin reads in OnPlayerRunCmd, and curr.events carries the jump.
                native::SsjState pre;
                pre.position=prev.position;pre.velocity=prev.velocity;
                pre.grounded=prev.grounded!=0;pre.on_ladder=prev.on_ladder!=0;
                const native::SsjCmd ssj_cmd{cmd.forward,cmd.side,cmd.yaw,cmd.buttons};
                native::SsjTick info;
                info.jumped=(curr.events&(1u<<1))!=0;              // EVENT_JUMPED
                info.teleported=(curr.events&native::teleported)!=0;
                info.in_start=practice.noclip?false:feedback.ssj_was_in_start;info.noclip=practice.noclip||feedback.ssj_was_noclip;
                if(timing.status==1)info.time=timing.seconds;
                {
                    const auto mode=preferences.at("jumpStatsMode").get<std::string>();
                    feedback.ssj.set_mode(mode=="every"?native::SsjMode::every:mode=="interval"?native::SsjMode::every_nth:native::SsjMode::sixth);
                    feedback.ssj.set_interval(preferences.at("jumpStatsInterval").get<unsigned>());
                }
                if(timing.update_flags&4)reset_feedback();  // restarted
                const bool history_ready=feedback.history_ready(pre.grounded,info.in_start,info.noclip);
                if(history_ready)if(const auto report=feedback.ssj.tick(pre,ssj_cmd,info)) {
                    feedback.ssj_line=native::ssj_text(*report,ssj_fields);
                    feedback.ssj_gain=report->gain;
                }
                feedback.ssj_was_in_start=timing.in_start!=0;feedback.ssj_was_noclip=state.movement_mode==1;  // Mode::Noclip
                if(info.teleported)reset_feedback();
                else if(history_ready&&!info.noclip) {
                    feedback.strafe_trainer.set_smoothing(preferences.at("strafeTrainerSmoothing").get<unsigned>());
                    if(const auto reading=feedback.strafe_trainer.tick(pre.grounded,std::hypot(pre.velocity[0],pre.velocity[1]),cmd.yaw,cmd.forward,cmd.side))feedback.strafe_reading=reading;
                    feedback.strafe_ground_ticks=pre.grounded?feedback.strafe_ground_ticks+1:0;
                    if(feedback.strafe_ground_ticks>native::bhop_frames)feedback.strafe_reading.reset();
                }
            }
            BhSurfaceProbe surface{};surface.water_z=std::numeric_limits<float>::quiet_NaN();const bool surface_found=bh_surface_at(core.get(),curr.position[0],curr.position[1],curr.position[2],&surface)!=0;const double water_depth=surface_found?surface.water_z-curr.position[2]:std::numeric_limits<double>::quiet_NaN();
            static const std::array<const char*,6> surfaces={"concrete","metal","wood","grass","tile","water"};
            const bool attacked=bh_attack_report(core.get(),&attack);if(!playback)scope.observe(weapon,attacked?&attack:nullptr);
            audio.set_style(playback?playback_info.value("style",active_style):active_style);
            BhJumpObservation jump_observation{};const bool observed_jump=bh_jump_observation(core.get(),&jump_observation)!=0;
            audio.tick(state,timing,weapon,attacked?&attack:nullptr,step_dt,surfaces[std::clamp(surface.surface,0,5)],water_depth,observed_jump?&jump_observation:nullptr);
            if(timing.update_flags&16){char split[100];std::snprintf(split,sizeof(split),"Split %u  %.3fs",timing.split_count,timing.seconds);hud.set_run_comparison(split,"");}
            if(!playback)kept_weapons.observe(weapon);
            const uint32_t slot=weapon.active==weapon.primary?1:weapon.active==weapon.secondary?2:3;if(slot!=observed_slot){last_slot=observed_slot;observed_slot=slot;}
             if(curr.events&native::teleported) prev=curr;
            accumulator-=step_dt;
            BhRunState tick_run{};
            if(playback||!zones.empty())require(bh_run_state(core.get(),&tick_run),core.get(),"Reading native timer");
            if(tutorial&&tutorial->is_active()&&!playback){BhCmd filtered=cmd;bh_last_command(core.get(),&filtered);const auto result=tutorial->tick(tutorial_pre,curr,filtered,curr.events,dt);if(result.completed)save_tutorial();if(tick_run.status==2&&tutorial->lesson_id()=="final"&&!tutorial_final_saved){tutorial->finish(tick_run.seconds);save_tutorial();tutorial_final_saved=true;}if(result.next_lesson>=0&&result.next_lesson<4){const char *ids[]={"jump","strafe","speed","final"};start_tutorial(ids[result.next_lesson],false);accumulator=0;break;}}

            // Finish the recording on the exact native tick, before any further catch-up steps.
            if(!playback&&tick_run.status==2&&!recording_ended) {reset_input_timing();break;}
        }
        BhRunState run_state{};
        if(core) {
            if(playback||!zones.empty())require(bh_run_state(core.get(),&run_state),core.get(),"Reading native timer");
            if(!practice.active&&!playback&&run_state.status==1&&run_state.recording) {
                const bool started_run=beat_start!=run_state.start_tick;
                if(started_run) {
                    ++run_generation;run_event({{"type","reset"}});
                    beat_start=beat_upto=run_state.start_tick;beat_hash=0x811c9dc5;beat_paused=false;
                }
                if(started_run||now-beat_time>=std::chrono::seconds(4)) {
                    const auto length=uint32_t(run_state.total_commands);
                    require(bh_record_fold(core.get(),beat_hash,beat_upto,length,&beat_hash),core.get(),"Hashing native heartbeat");
                    beat_upto=length;char hex[9];std::snprintf(hex,sizeof(hex),"%08x",beat_hash);
                    run_event({{"type","beat"},{"track",run_state.track},{"tick",length-beat_start},{"hash",hex},{"paused",beat_paused}});
                    beat_time=now;beat_paused=false;
                }
            } else if(run_state.status==0&&beat_start) {
                beat_start=0;++run_generation;run_event({{"type","reset"}});
            }
            if(practice.active&&!playback&&run_state.status==2&&!recording_ended){recording_ended=true;show_menu(true);}
            if(!practice.active&&!playback&&run_state.status==2 && !recording_ended) {
                recording_ended=true;
                if(!record_path.empty()) {
                    try {
                        require(bh_record_end(core.get()),core.get(),"Finishing native recording");
                        require(bh_record_write_bhr(core.get(),record_path.c_str()),core.get(),"Writing native replay");
                        // Local vault failures cannot withhold an otherwise valid replay submission.
                        try{const auto id=std::filesystem::path(record_path).filename().string();const auto summary=run_vault.archive(id,{{"map",map_id},{"style",active_style},{"track",run_state.track},{"time",run_state.seconds},{"jumps",run_state.jumps},{"strafes",run_state.strafes},{"sync",run_state.sync_percent},{"finishedAt",epoch_ms()},{"client",identity.value("build",std::string("bunnyhop-native/local"))},{"eligible",!turn_admission.local_only&&bool(run_state.recording_valid)}});if(preferences.value("capturePbScreenshots",false)&&summary.value("localPb",false))pending_vault_capture=std::pair{id,map_id};}
                        catch(const std::exception&e){std::cerr<<"Local run vault: "<<e.what()<<'\n';score_notice="Replay saved; finish summary could not be saved";}
                        refresh_replays();
                        if(!turn_admission.local_only&&active_style=="autohop"&&run_state.track==0){
                            const auto old=backdrop_pbs.find(map_id);
                            if(old==backdrop_pbs.end()||!old->is_object()||run_state.seconds<old->value("seconds",std::numeric_limits<double>::infinity())){
                                backdrop_pbs[map_id]={{"id",std::filesystem::path(record_path).filename().string()},{"seconds",run_state.seconds}};
                                native::save_settings(cache/"backdrop-pbs.json",backdrop_pbs);
                            }
                        }
                        run_event({{"type","finish"},{"track",run_state.track},{"replayBase64",base64(read_text(record_path))}});
                        std::cout<<"Native finish "<<run_state.seconds<<" seconds; replay "<<record_path<<'\n';
                    } catch(const std::exception &e) {
                        error=std::string("Replay was not submitted: ")+e.what();
                        std::cerr<<error<<'\n';
                    }
                    show_menu(true);
                }
            }
        }
        int width=0,height=0; SDL_GetWindowSizeInPixels(window.get(),&width,&height);
        if(renderer&&!video_capture&&!director_job) {
            const float blend=(opt.frames||!simulation_active)?1.0f:float(accumulator/step_dt); float eye[3];
            for(int i=0;i<3;++i) eye[i]=prev.position[i]+(curr.position[i]-prev.position[i])*blend;
            eye[2]+=prev.view_offset_z+(curr.view_offset_z-prev.view_offset_z)*blend;
            BhSnapshot state{};bh_snapshot(core.get(),&state);
            std::optional<native_render::Actor> audible_ghost;
            if(ghost_enabled&&preferences.value("showGhost",true)&&ghost_handle&&!playback&&!spectator&&(tutorial_demo||(ghost_info.value("track",0u)==active_track&&ghost_info.value("style",std::string("autohop"))==active_style))) {
                BhGhostFrame ghost{};const uint32_t tick=ghost_info.value("startTick",0u)+(tutorial_demo?curr.tick-tutorial_demo_start:run_state.status?curr.tick-run_state.start_tick:0);
                if(bh_ghost_frame(core.get(),ghost_handle,tick,&ghost)){
                    const float distance=std::hypot(std::hypot(ghost.position[0]-curr.position[0],ghost.position[1]-curr.position[1]),ghost.position[2]-curr.position[2]);
                    const float opacity=preferences.value("ghostOpacity",.4f)*(preferences.value("ghostNearFade",true)?std::clamp((distance-24.f)/80.f,0.f,1.f):1.f);
                    renderer->set_replay_actor(ghost,tutorial_demo?"outfit-cream":outfit,(ghost_info.contains("packedLoadout")&&ghost_info["packedLoadout"].is_string()?ghost_info["packedLoadout"].get<std::string>():std::string()),opacity);
                    native_render::Actor actor;actor.id="replay-ghost";actor.frame=ghost;actor.opacity=opacity;audible_ghost=actor;
                }
                else{renderer->set_replay_actor(nullptr,0,0);if(tutorial_demo){ghost_enabled=false;tutorial_demo=false;}}
            } else renderer->set_replay_actor(nullptr,0,0);
            BhRunState display_run=run_state;std::string display_style=playback?playback_info.value("style",active_style):active_style;std::optional<native_render::Actor> spectated_actor;
            const double steady_seconds=std::chrono::duration<double>(now.time_since_epoch()).count();auto actors=room.actors(steady_seconds);auto camera_input=input;camera_input.consume_all();
            // Show turnbind motion between ticks too, so turning is smooth at any frame rate.
            if(simulation_active&&!playback&&!spectator)if(const double rate=turn_rate())camera_input.turn(rate,std::clamp(accumulator,0.0,dt));std::string shown_notice=tutorial&&tutorial->is_active()&&!playback?tutorial->notice():score_notice;
            const auto race_notice=room_modes.notice(epoch_ms());if(!race_notice.empty())shown_notice=race_notice;
            renderer->set_player_glow(player_glow);if(!spectator)renderer->set_spectated_actor(std::nullopt);renderer->set_viewmodel_weapon(std::nullopt);renderer->set_viewmodel_visible(preferences.at("viewmodel").get<bool>()&&!opt.camera);renderer->set_source_look(preferences.at("sourceLook").get<bool>());
            if(spectator){spectated_actor=room.spectated(steady_seconds);const auto &target=spectated_actor;if(target){renderer->set_spectated_actor(*target);for(int k=0;k<3;k++){eye[k]=target->frame.position[k];state.player.position[k]=target->frame.position[k];state.player.velocity[k]=target->frame.velocity[k];}eye[2]+=target->frame.view_offset_z;state.player.tick=target->frame.tick;state.player.view_offset_z=target->frame.view_offset_z;state.player.grounded=!!(target->frame.flags&2);state.player.crouched=!!(target->frame.flags&1);camera_input.set_angles(target->frame.pitch,target->frame.yaw);renderer->set_cosmetics(target->outfit,target->loadout);renderer->set_player_glow(target->playerGlow);renderer->set_viewmodel_weapon(target->frame.weapon);shown_notice="Spectating "+target->name+" - Esc for Room controls";actors.erase(std::remove_if(actors.begin(),actors.end(),[&](const auto &a){return a.id==target->id;}),actors.end());}else{renderer->set_spectated_actor(std::nullopt);renderer->set_viewmodel_visible(false);shown_notice="Waiting for spectator target";}}
            bool external_camera=false;
            if(playback){
                camera_controls.consume_all();camera_controls.held=chat.active?0:input.held;
                if(replay_camera.mode=="free")replay_camera.move(camera_controls,frame_seconds,held_codes.contains("ShiftLeft")||held_codes.contains("ShiftRight"));
                replay_camera.sample(core.get(),state.player,camera_input.yaw(),camera_input.pitch,curr.tick*step_dt,eye,camera_input,frame_seconds);external_camera=replay_camera.third_person();
            }else if(third_person){third_camera.sample(core.get(),state.player,camera_input.yaw(),camera_input.pitch,steady_seconds,eye,camera_input,frame_seconds);external_camera=true;}
            if(spectator){display_run={};for(const auto &row:room.scoreboard(steady_seconds))if(row.value("slot",256u)==*spectator){display_run.track=row.value("track",0u);display_style=row.value("style",std::string("autohop"));break;}if(const auto timing=room.timer(*spectator,steady_seconds)){display_run.seconds=timing->second;display_run.in_start=timing->first==1;display_run.status=timing->first==3?2:timing->first==2?1:0;}}
            if(hide_players)actors.clear();
            if(!playback&&!spectator&&!tutorial_demo&&preferences.value("showGhost",true))for(unsigned i=1;i<4;i++){
                const auto &slot=ghost_slots[i];if(!slot.handle||!slot.enabled||slot.info.value("track",0u)!=active_track||slot.info.value("style",std::string("autohop"))!=active_style)continue;
                native_render::Actor actor;actor.id="ghost-"+std::to_string(i);actor.name=slot.info.value("player",std::string("Ghost ")+std::to_string(i+1));
                const uint32_t tick=slot.info.value("startTick",0u)+(run_state.status?curr.tick-run_state.start_tick:0);
                if(!bh_ghost_frame(core.get(),slot.handle,tick,&actor.frame))continue;
                actor.outfit=outfit;actor.loadout=slot.info.value("packedLoadout",std::string());
                const float distance=std::hypot(std::hypot(actor.frame.position[0]-curr.position[0],actor.frame.position[1]-curr.position[1]),actor.frame.position[2]-curr.position[2]);
                actor.opacity=preferences.value("ghostOpacity",.4f)*(preferences.value("ghostNearFade",true)?std::clamp((distance-24.f)/80.f,0.f,1.f):1.f);actors.push_back(actor);
            }
            if(external_camera){
                renderer->set_viewmodel_visible(false);
                native_render::Actor self;self.id="local-camera-target";self.opacity=1;self.outfit=outfit;self.loadout=packed_loadout;self.playerGlow=player_glow;
                for(int k=0;k<3;k++){self.frame.position[k]=state.player.position[k];self.frame.velocity[k]=state.player.velocity[k];}
                self.frame.tick=state.player.tick;self.frame.flags=(state.player.crouched?1:0)|(state.player.grounded?2:0);self.frame.view_offset_z=state.player.view_offset_z;self.frame.pitch=input.pitch;self.frame.yaw=input.yaw();
                BhWeaponReport held{};bh_weapon_report(core.get(),&held);self.frame.weapon=held.active;
                if(spectator){if(const auto target=room.spectated(steady_seconds)){self=*target;self.opacity=1;}}
                actors.push_back(self);
            }
            if(opt.camera){for(int k=0;k<3;k++)eye[k]=(*opt.camera)[k];camera_input.set_angles((*opt.camera)[3],(*opt.camera)[4]);}
            const bool local_scope=!playback&&!spectator&&!external_camera&&!opt.camera;
            if(local_scope&&simulation_active)scope.frame(frame_seconds);
            renderer->set_camera_fov(local_scope?scope.fov(preferences.at("fov").get<float>()):preferences.at("fov").get<float>());
            if(local_scope&&scope.scoped())renderer->set_viewmodel_visible(false);
            renderer->set_zone_state(display_run.track,display_run,!playback&&!spectator&&!practice.active&&!turn_admission.local_only&&display_run.recording_valid&&world_record_generation==run_generation&&known_world_record&&display_run.seconds<*known_world_record);renderer->set_flashlight(flashlight);
            audio.listener(eye,camera_input.yaw());
            if(focused&&captured&&!opt.frames){for(const auto &actor:actors)if(actor.id!="local-camera-target")audio.spatial_actor(actor,frame_seconds,actor.id.starts_with("ghost-"));if(audible_ghost)audio.spatial_actor(*audible_ghost,frame_seconds,true);if(spectated_actor&&!external_camera)audio.spatial_actor(*spectated_actor,frame_seconds,false);}
            renderer->set_room_actors(actors);
            renderer->draw(width,height,eye,camera_input,&state,(playback||opt.frames)?curr.tick*step_dt:std::chrono::duration<double>(now-started).count());
            if((!menu||!menu->visible())&&!opt.camera&&preferences.at("hud").get<bool>()){
                hud.overlay_begin(width,height,preferences.at("hudScale").get<float>());
                const native::HudGeometry geometry(width,height,preferences.at("hudScale").get<float>());
                const auto vp=renderer->camera(eye,camera_input.yaw(),camera_input.pitch,float(width)/std::max(height,1));
                auto tag=[&](const native_render::Actor &actor,const std::string &name,bool ghost){
                    if(name.empty()||actor.opacity<.05f||(ghost&&!preferences.value("ghostTag",true)))return;
                    float point[3]={actor.frame.position[0],actor.frame.position[1],actor.frame.position[2]+actor.frame.view_offset_z+20};
                    std::array<float,4> clip{};for(int row=0;row<4;row++)clip[row]=vp[row]*point[0]+vp[4+row]*point[1]+vp[8+row]*point[2]+vp[12+row];
                    if(clip[3]<=2||std::abs(clip[0])>clip[3]||std::abs(clip[1])>clip[3]||std::abs(clip[2])>clip[3])return;
                    float fraction=0;if(!bh_trace_camera(core.get(),eye,point,0,&fraction)||fraction<.98f)return;
                    hud.overlay_text((clip[0]/clip[3]*.5f+.5f)*geometry.width,(.5f-clip[1]/clip[3]*.5f)*geometry.height,name,13,ghost?std::array<float,4>{.55f,.85f,1,.85f}:std::array<float,4>{.94f,.91f,.86f,1},true);
                };
                for(const auto &actor:actors)if(actor.id!="local-camera-target")tag(actor,actor.name,actor.id.starts_with("ghost-"));
                if(audible_ghost)tag(*audible_ghost,ghost_info.value("player",std::string("Ghost")),true);
                hud.overlay_end(width,height);
            }
            if(Clock::now()<toast_until)shown_notice=toast_text;
            std::string gauntlet_line,gauntlet_delta;bool gauntlet_good=false;
            if(!gauntlet_id.empty()&&gauntlet_progress.is_object()){
                const bool timed=run_state.status==1;const double total=gauntlet_progress.at("before").get<double>()+(timed?run_state.seconds:0);
                char formatted[80];std::snprintf(formatted,sizeof(formatted),"%02u:%06.3f",unsigned(total)/60,std::fmod(total,60));
                gauntlet_line="Gauntlet "+std::to_string(gauntlet_progress.at("idx").get<unsigned>()+1)+"/"+std::to_string(gauntlet_progress.at("maps").get<unsigned>())+" | "+formatted;
                if(timed&&!gauntlet_progress.at("pbSplit").is_null()){const auto delta=run_state.seconds-gauntlet_progress.at("pbSplit").get<double>();std::snprintf(formatted,sizeof(formatted),"%+.3fs",delta);gauntlet_delta=formatted;gauntlet_good=delta<0;}
            }
            BhCmd shown{};bh_last_command(core.get(),&shown);BhWeaponReport weapon{};bh_weapon_report(core.get(),&weapon);
            if((!menu||!menu->visible())&&!opt.camera)hud.draw(width,height,state,display_run,shown,map_id,display_style,shown_notice,display_fps,
                preferences.at("hud").get<bool>(),preferences.at("crosshair").get<bool>(),playback,weapon,
                preferences.at("jumpStats").get<bool>()?feedback.ssj_line:std::string(),feedback.ssj_gain,
                preferences.at("strafeTrainer").get<bool>()&&!playback?feedback.strafe_reading:std::nullopt,
                preferences.at("strafeTrainerHints").get<bool>(),&hud_layout,preferences.at("hudScale").get<float>(),&practice,preferences.at("practiceKeepVelocity").get<bool>(),gauntlet_line,gauntlet_delta,gauntlet_good,leave_hold.progress(epoch_ms()));
            if((!menu||!menu->visible())&&!opt.camera){
                if(preferences.value("mouseDiagnostics",false)&&!playback){const auto &m=mouse_diagnostics.last;char label[220];std::snprintf(label,sizeof(label),"Mouse %.0f events/s | burst %llu | age %.2f/%.2f ms | pump max %.2f ms",m.events_per_second,static_cast<unsigned long long>(m.peak_burst),m.average_age_ms,m.max_age_ms,m.max_pump_ms);hud.overlay_begin(width,height,100);hud.overlay_rect(16,40,730,32,{.02f,.02f,.025f,.85f});hud.overlay_text(24,48,m.seconds?label:"Mouse diagnostics: move continuously for a sample",14,{1,1,1,1});hud.overlay_end(width,height);}
                if(playback&&!chat.active&&!video_capture&&!director_job)native::draw_replay_controls(hud,width,height,native::HudGeometry(width,height,100).scale,replay_controls,curr.tick,playback_info.value("totalTicks",0u),playback_info.at("settings").value("tickInterval",dt),playback_paused,playback_speed,replay_camera.mode);
                if(chat.active||preferences.at("hud").get<bool>())hud.draw_chat_overlay(width,height,chat.visible(epoch_ms()/1000.),chat.input,chat.composition,chat.suggestions,chat.active,chat.scroll_offset(),preferences.at("hudScale").get<float>(),&chat,chat.viewport(epoch_ms()/1000.));
                std::vector<std::string> panel;
                if((held_action("scoreboard")||show_scores)&&!chat.active){
                    for(auto player:room.scoreboard(steady_seconds)){
                        if(player.value("slot",256u)==room.self){player["seconds"]=run_state.seconds;player["style"]=active_style;player["track"]=active_track;}
                        char time[48];std::snprintf(time,sizeof(time),"%.3fs",player.value("seconds",0.));
                        std::string line=player.value("name",std::string("Player"))+"  "+player.value("style",std::string(""))+"  "+time;
                        if(player.value("track",0))line+="  B"+std::to_string(player.value("track",0));
                        if(player.contains("ping")&&player["ping"].is_number())line+="  "+std::to_string(player["ping"].get<int>())+"ms";
                        if(player.contains("spec")&&!player["spec"].is_null())line+="  SPECTATOR";panel.push_back(line);
                    }
                    if(panel.empty())panel.push_back("Solo | "+replay_player+" | "+active_style);
                    hud.draw_panel(width,height,room.id.empty()?"Players":"Players - "+room.id,panel,preferences.at("hudScale").get<float>());
                }else if(gun_menu.open&&!chat.active)hud.draw_panel(width,height,gun_menu.title(),gun_menu.rows(weapon_context()),preferences.at("hudScale").get<float>());
                else if(!room.vote.is_null()&&room.vote.contains("options")&&!chat.active){
                    unsigned number=0;for(const auto &option:room.vote.at("options")){std::string label=option.value("map",std::string());if(label.empty())label="Extend "+std::to_string(option.value("minutes",0))+" minutes";panel.push_back(std::to_string(++number)+". "+label);}
                    hud.draw_panel(width,height,"Map vote",panel,preferences.at("hudScale").get<float>());
                }
                const auto change=room.change_notice(epoch_ms());if(!change.empty())hud.draw_overlay(width,height,{change},"","",{},false,preferences.at("hudScale").get<float>());
            }
        }
        // Capture only the finished gameplay framebuffer, before any menu/backdrop layer.
        if(pending_vault_capture){const auto pending=*pending_vault_capture;pending_vault_capture.reset();if(renderer&&pending.second==map_id&&width>0&&height>0){try{run_vault.attach(pending.first,backbuffer_png(gl,width,height));refresh_replays();}catch(const std::exception&e){std::cerr<<"Local PB screenshot: "<<e.what()<<'\n';score_notice="Replay saved; optional screenshot could not be saved";}}}
        // Separate GTK windows and screenshot runs cannot show the SDL layer:
        // they get one bounded PNG of the still pose instead of a live scene.
        const bool backdrop_live=menu&&menu->supports_backdrop()&&opt.menu_smoke.empty();
        const bool backdrop_still=menu_reduced_motion||!backdrop_live;
        // An unfocused window holds the current shot rather than animating.
        const double backdrop_dt=focused?std::chrono::duration<double>(now-backdrop_clock).count():0;backdrop_clock=now;
        bool backdrop_drawn=false;
        if(backdrop&&!renderer){backdrop->poll(!download.valid());backdrop_drawn=backdrop->draw(width,height,backdrop_dt,backdrop_still);}
        if(!renderer&&!backdrop_drawn){gl.Viewport(0,0,width,height);gl.ClearColor(.03f,.04f,.06f,1);gl.Clear(GL_COLOR_BUFFER_BIT|GL_DEPTH_BUFFER_BIT);}
        // Tell the menu what it is drawn over: the home tour (once per map,
        // then fade cuts), or the paused gameplay map. "native" waits for the
        // frame to be presented; a PNG is read back from this frame first.
        std::string backdrop_call;bool backdrop_log=false;
        if(menu&&menu_ready&&width>0&&height>0)try {
            auto call=[](const std::string &source,const std::string &id){return "window.bunnyhopNativeBackdrop?.("+nlohmann::json(source).dump()+","+nlohmann::json(id).dump()+")";};
            auto png_source=[&]{backdrop_png=backbuffer_png(gl,width,height);return "data:image/png;base64,"+base64(backdrop_png);};
            if(renderer&&gameplay_backdrop_due&&menu->visible()) {
                gameplay_backdrop_due=false;backdrop_source=backdrop_live?"native":"png";backdrop_shown=map_id;
                backdrop_call=call(backdrop_live?std::string("native"):png_source(),map_id);backdrop_log=true;
            } else if(!renderer&&backdrop_drawn&&backdrop_shown!=backdrop->map()) {
                backdrop_source=backdrop_live?"native":"png";backdrop_shown=backdrop->map();backdrop_cut=false;
                backdrop_call=call(backdrop_live?std::string("native"):png_source(),backdrop_shown);backdrop_log=true;
            } else if(!renderer&&backdrop_drawn&&backdrop_live&&backdrop->cut(backdrop_still)!=backdrop_cut) {
                backdrop_cut=!backdrop_cut;backdrop_call=call(backdrop_cut?"cut":"native",backdrop_shown);
            } else if(!renderer&&backdrop&&backdrop->status()==MenuBackdrop::Status::failed&&backdrop_failed!=backdrop->map()) {
                backdrop_failed=backdrop->map();std::cerr<<"Menu backdrop "<<backdrop_failed<<": "<<backdrop->error()<<'\n';
                backdrop_call=call("none",backdrop_failed);
            }
        } catch(const std::exception &e) {std::cerr<<"Menu backdrop: "<<e.what()<<'\n';}
        if(menu&&menu_ready&&core&&!playback&&!spectator&&!room.id.empty()&&room.map==map_id&&now-room_time>=std::chrono::milliseconds(50)) {
            BhWeaponReport weapon{};bh_weapon_report(core.get(),&weapon);
            const auto tick=uint32_t(std::chrono::duration_cast<std::chrono::milliseconds>(now-started).count()/10);
            const nlohmann::json pose={{"generation",room.generation},{"id",room.id},{"map",map_id},
                {"sample",{{"tick",tick},{"x",curr.position[0]},{"y",curr.position[1]},{"z",curr.position[2]},
                    {"vx",curr.velocity[0]},{"vy",curr.velocity[1]},{"vz",curr.velocity[2]},{"yaw",input.yaw()},{"pitch",input.pitch},
                    {"flags",room_events|(curr.grounded?1:0)|(curr.crouched?2:0)}}},
                {"meta",{{"style",active_style},{"track",run_state.track},{"timer",run_state.status==2?3:run_state.status==1?2:run_state.in_start?1:0},
                    {"timerTicks",run_state.status?(run_state.status==2?run_state.end_tick:curr.tick)-run_state.start_tick:0}}},
                {"weapon",weapon.active},{"silenced",weapon.silencer!=0}};
            menu->evaluate_js("window.bunnyhopNativeMenu?.onRoomPose?.("+pose.dump()+")");room_events=0;room_time=now;
        }
        if(!opt.video_smoke.empty()){
            const auto result=video_state();const auto phase=result.value("state",std::string());
            if(video_smoke_stage==0&&phase=="capturing"&&result.value("frames",0)>=3){cancel_video();refresh_playback_pose();check_video_restored();video_smoke_stage=1;}
            else if(video_smoke_stage==1&&!video_encoder.busy()){check_video_restored();video_available.encoder="/bunnyhop-test-missing-encoder";native::VideoOptions options;options.to=100;request_video(options);video_smoke_stage=2;}
            else if(video_smoke_stage==2&&phase=="error"&&!video_encoder.busy()){check_video_restored();video_available.encoder=video_smoke_encoder;native::VideoOptions options;options.to=200;options.camera="auto";options.music="game-airstrafe";options.music_offset=12;
                // Smoke-only soundtrack. Regular exports keep the explicit No music default.
                preferences["musicPack"]="default";preferences["muted"]=false;preferences["muteMusic"]=false;preferences["musicVolume"]=1.;preferences["volume"]=.65;
                request_video(options);video_smoke_stage=3;}
            else if(video_smoke_stage==3&&phase=="completed"){check_video_restored();auto proof=result;proof["restoredTick"]=curr.tick;proof["restoredFreeCamera"]=true;proof["cancelRestored"]=true;proof["encoderFailureRestored"]=true;std::ofstream(std::filesystem::path(opt.video_smoke)/"result.json")<<proof.dump(2)<<'\n';running=false;}
            else if(video_smoke_stage==3&&(phase=="error"||phase=="canceled"))throw std::runtime_error("Video smoke failed: "+result.dump());
            else if(Clock::now()-video_smoke_started>std::chrono::minutes(3))throw std::runtime_error("Video smoke timed out");
        }
        ++frame; ++title_frames;if(simulation_active&&!playback)input.frame();
        audio.set_music_scene(bool(core)&&(!menu||!menu->visible()));
        audio.pump();  // advances the music playlist; decoding cannot run on the audio thread
        if(opt.frames&&renderer&&(curr.tick>=opt.frames||(playback&&playback_paused&&curr.tick>=playback_info.value("totalTicks",0u)))&&!opt.screenshot.empty()) renderer->screenshot(opt.screenshot,width,height);
        const GLenum gl_error=gl.GetError(); if(gl_error!=GL_NO_ERROR) throw std::runtime_error("OpenGL error "+std::to_string(gl_error));
        if(!SDL_GL_SwapWindow(window.get())) throw std::runtime_error(std::string("Swapping framebuffer failed: ")+SDL_GetError());
        // State first: the menu accepts a backdrop only for its current or
        // requested map, so it must already know a newly loaded map. Scripts
        // run in the order they are queued.
        if(menu&&menu_ready&&now-activity_time>=std::chrono::seconds(1)&&!opt.frames&&opt.runtime_smoke.empty()){menu->evaluate_js("window.bunnyhopNativeMenu?.onActivity?.("+activity.sample(activity_active).dump()+")");activity_time=now;}
        if(menu && menu_ready && (menu->visible()||!room.id.empty()) && (now-ui_time>=std::chrono::milliseconds(200) || !backdrop_call.empty() || (!opt.menu_smoke.empty() && (renderer||opt.menu_home_smoke) && !download.valid() && !smoke_requested))) {
            std::string progress;nlohmann::json progress_detail;{std::lock_guard lock(progress_mutex);progress=loading;progress_detail=load_progress;}
            // The game window, as the web reports its page: logical size plus pixel density.
            int window_w=0,window_h=0;SDL_GetWindowSize(window.get(),&window_w,&window_h);
            const nlohmann::json client_info={{"version",identity.value("version",std::string("local"))},{"build",identity.value("build",std::string("bunnyhop-native/local"))},
                {"gpu",gpu_renderer},{"viewport",{window_w,window_h}},{"dpr",std::round(SDL_GetWindowPixelDensity(window.get())*100)/100}};
            nlohmann::json state={{"engine","native"},{"renderer","opengl"},{"client",client_info},{"map",map_id},{"loading",progress},{"loadProgress",progress_detail},{"error",error},
                {"sensitivity",input.sensitivity},{"paused",!captured},{"recordingPath",record_path},
                {"player",{{"map",map_id},{"style",playback?playback_info.value("style",active_style):active_style},{"track",playback?playback_info.value("track",active_track):active_track},{"mode",playback?"replay":!room.id.empty()?"multiplayer":!gauntlet_id.empty()?"gauntlet":(practice.active||tutorial_practice())?"practice":"solo"},{"practice",practice.active||map_id==tutorial_map}}},
                {"practice",{{"available",practice_reason().empty()},{"unavailable",practice_reason().empty()?nlohmann::json(nullptr):nlohmann::json(practice_reason())},{"mode",practice.mode},{"active",practice.active},{"thirdPerson",third_person&&!playback&&!room.spectator_target},{"tool",practice.tool.empty()?nlohmann::json(nullptr):nlohmann::json(practice.tool)},{"noclip",practice.noclip},{"menuOpen",practice.menu_open},{"count",practice.checkpoints.size()},{"current",practice.number()},{"keepVelocity",preferences.at("practiceKeepVelocity")}}},
                {"gauntlet",{{"id",gauntlet_id.empty()?nlohmann::json(nullptr):nlohmann::json(gauntlet_id)},{"map",gauntlet_map.empty()?nlohmann::json(nullptr):nlohmann::json(gauntlet_map)}}},
                {"style",selected_style},{"track",active_track},{"settings",preferences},{"replays",replay_list},
                {"room",{{"id",room.id},{"map",room.map},{"spectating",spectator.has_value()},{"target",spectator?nlohmann::json(*spectator):nlohmann::json(nullptr)},{"raceFrozen",room_modes.frozen()}}},
                {"tutorial",tutorial?tutorial->stateJSON():nlohmann::json{{"active",false},{"lesson","jump"},{"completed",tutorial_completed}}},
                {"playback",{{"tickInterval",playback?playback_info.at("settings").value("tickInterval",dt):dt},{"active",playback},{"id",playback_id},{"tick",curr.tick},{"totalTicks",playback?playback_info.value("totalTicks",0u):0u},{"paused",playback_paused},{"speed",playback_speed},{"camera",replay_camera.mode},{"seconds",run_state.seconds}}},
                {"ghost",{{"enabled",ghost_enabled},{"id",ghost_id},{"name",ghost_info.is_object()?ghost_info.value("player",std::string("Ghost")):"Ghost"}}},
                {"runGeneration",run_generation},{"timer",{{"status",run_state.status},{"seconds",run_state.seconds},{"jumps",run_state.jumps},{"strafes",run_state.strafes},{"sync",run_state.sync_percent}}},
                {"videoExport",video_state()},{"music",audio.music_state()},{"audio",audio.status()},
                {"discord",{{"state",discord_allowed?discord.state:"disabled"},{"message",discord.message}}},
                {"backdrop",backdrop?backdrop->state(backdrop_source):nlohmann::json{{"status","idle"},{"map",""},{"renderer","native-bsp"},{"kind","tour"},{"shots",0},{"source",""},{"error",""}}}};
            state["ghosts"]=nlohmann::json::array();for(unsigned slot=0;slot<4;slot++){const auto &g=ghost_slots[slot];if(g.handle)state["ghosts"].push_back({{"slot",slot},{"id",g.id},{"name",g.info.value("player",std::string("Ghost"))},{"enabled",g.enabled},{"map",map_id},{"style",g.info.value("style",std::string("autohop"))},{"track",g.info.value("track",0u)}});}
            const auto &m=mouse_diagnostics.last;
            const int sdl_version=SDL_GetVersion();
            const nlohmann::json mouse_state={{"active",mouse_diagnostics.active},{"seconds",m.seconds},{"eventsPerSecond",m.events_per_second},{"events",m.events},{"peakBurst",m.peak_burst},{"averageAgeMs",m.average_age_ms},{"maxAgeMs",m.max_age_ms},{"maxPumpMs",m.max_pump_ms},{"relative",SDL_GetWindowRelativeMouseMode(window.get())},{"systemScaling",SDL_GetHintBoolean(SDL_HINT_MOUSE_RELATIVE_SYSTEM_SCALE,false)},{"sdl",std::to_string(SDL_VERSIONNUM_MAJOR(sdl_version))+"."+std::to_string(SDL_VERSIONNUM_MINOR(sdl_version))+"."+std::to_string(SDL_VERSIONNUM_MICRO(sdl_version))}};
            menu->evaluate_js("window.dispatchEvent(new CustomEvent('bunnyhop:mouse-diagnostics',{detail:"+mouse_state.dump()+"}))");
            const auto update_state=updater.state().dump();if(update_state!=last_update){menu->evaluate_js("window.dispatchEvent(new CustomEvent('bunnyhop:update',{detail:"+update_state+"}))");last_update=update_state;}
            {   // Settings -> Game data
                std::optional<std::string> picked;std::string pick_error;bool picking=false;
                {std::lock_guard lock(data_picker.m);picking=data_picker.open;if(data_picker.done){data_picker.done=false;picked=std::move(data_picker.result);data_picker.result.reset();pick_error=std::move(data_picker.error);data_picker.error.clear();}}
                if(picked)data_choice=data_location::choose(data_location::from_utf8(*picked),cache,default_root);else if(!pick_error.empty())data_notice="Folder picker: "+pick_error;
                nlohmann::json data_state={{"path",data_location::utf8(cache)},{"defaultPath",data_location::utf8(default_root)},{"isDefault",data_location::same(cache,default_root)},
                    {"configured",data_location::utf8(location.active)},{"unavailable",data_unavailable},{"pending",location.pending?nlohmann::json(data_location::utf8(*location.pending)):nlohmann::json(nullptr)},
                    {"picking",picking},{"notice",data_notice},{"choice",data_choice?nlohmann::json{{"path",data_location::utf8(data_choice->target)},{"problem",data_choice->problem}}:nlohmann::json(nullptr)}};
                const auto encoded_data=data_state.dump(-1,' ',false,nlohmann::json::error_handler_t::replace);
                if(encoded_data!=last_data_state){menu->evaluate_js("window.dispatchEvent(new CustomEvent('bunnyhop:data-folder',{detail:"+encoded_data+"}))");last_data_state=encoded_data;}
            }
            const auto encoded=state.dump();
            if(encoded!=last_ui) {menu->evaluate_js("window.bunnyhopNativeMenu?.onState("+encoded+")");last_ui=encoded;}
            ui_time=now;
        }
        if(!backdrop_call.empty()) {
            menu->evaluate_js(backdrop_call);
            if(backdrop_log)std::cout<<"Native menu backdrop: "<<backdrop_source<<" "<<backdrop_shown<<" (live="<<backdrop_live<<")"<<std::endl;
        }
        const bool smoke_backdrop=opt.menu_home_smoke
            ? !renderer && backdrop && ((backdrop->status()==MenuBackdrop::Status::ready && !backdrop_shown.empty() && backdrop_shown==backdrop->map()) || backdrop->status()==MenuBackdrop::Status::failed)
            : renderer && !map_id.empty() && backdrop_shown==map_id && !gameplay_backdrop_due;
        if(menu && menu_ready && smoke_backdrop && !download.valid() && !opt.menu_smoke.empty() && !smoke_requested) {
            smoke_requested=true;
            std::cout<<"Native menu smoke: checking "<<(opt.menu_home_smoke?"home":map_id)<<std::endl;
            // App-owned integration check: reads the same live account API as the menu; never submits a run.
            menu->evaluate_js("(()=>{const home="+std::string(opt.menu_home_smoke?"true":"false")+",expected="+nlohmann::json(map_id).dump()+R"JS(;
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
            })())JS");
        }
        if(!opt.menu_smoke.empty() && now-started>std::chrono::seconds(90)) throw std::runtime_error("Native menu smoke timed out (ready="+std::to_string(menu_ready)+", backdrop="+(backdrop?backdrop->state(backdrop_source).dump():std::string("none"))+", shown="+backdrop_shown+", requested="+std::to_string(smoke_requested)+", snapshot="+std::to_string(smoke_snapshot)+"): "+error);
        const double elapsed=std::chrono::duration<double>(now-title_time).count();
        if(elapsed>=.5) {
            display_fps=title_frames/elapsed;char title[320]; std::snprintf(title,sizeof(title),"%s | %s | %.0f FPS | %.1f u/s | %.2fs | %s | Esc menu | R restart",native::app_name,map_id.c_str(),title_frames/elapsed,std::hypot(curr.velocity[0],curr.velocity[1]),run_state.seconds,captured?"SDL raw input":"paused");
            SDL_SetWindowTitle(window.get(),title); title_time=now; title_frames=0;
        }
        if(opt.frames&&renderer&&(curr.tick>=opt.frames||(playback&&playback_paused&&curr.tick>=playback_info.value("totalTicks",0u)))) running=false;
        if(!core&&backdrop_drawn&&!backdrop_still&&focused&&!download.valid()) {
            // The live home tour runs at up to ~60 fps, like the web's.
            const double spent=std::chrono::duration<double>(Clock::now()-now).count();
            if(spent<1./62)SDL_DelayNS(uint64_t((1./62-spent)*1e9));
        } else if(!core||download.valid()||(!opt.frames&&(!focused||!captured))) SDL_Delay(10);
        else if(!opt.frames&&preferences.at("fpsLimit").get<int>()>0) {
            const double target=1./preferences.at("fpsLimit").get<int>();const double spent=std::chrono::duration<double>(Clock::now()-now).count();
            if(spent<target)SDL_DelayNS(uint64_t((target-spent)*1e9));
        }
    }
    save_window();
    if(core) bh_record_end(core.get());
    capture(false);
    std::cout << "Rendered " << frame << " frames; simulation tick " << curr.tick << "; position " << curr.position[0] << ' ' << curr.position[1] << ' ' << curr.position[2] << (renderer?"; exposure "+std::to_string(renderer->exposure()):std::string()) << '\n';
    return playback_failed||(!opt.menu_smoke.empty()&&!smoke_pass)?1:0;
}
}

int main(int argc,char **argv) {
    bool interactive_errors=true;
    // Scripted checks must also exit on failure without a modal alert. Inspect
    // flags before parsing so malformed smoke invocations cannot wait for input.
    for(int i=1;i<argc;++i)if(std::string(argv[i])=="--hidden"||std::string(argv[i])=="--menu-smoke"||std::string(argv[i])=="--menu-home-smoke"||std::string(argv[i])=="--runtime-smoke")interactive_errors=false;
    try {
        Options opt=options(argc,argv);
        if(opt.help) {
            std::cout << "Usage: bunnyhop-native [--map MAP.bsp | --online-map NAME] [--content-root DIR] [--sensitivity 2]\n"
                         "  [--menu-html PATH] [--no-menu] [--windowed] [--frames N] [--screenshot output.ppm] [--camera x,y,z,pitch,yaw] [--hidden]\n"
                         "  [--runtime-smoke OUTPUT_DIR --replay PATH] (offline lifecycle checks with --map; private data, no network)\n"
                         "  [--tutorial jump|strafe|speed|final] [--tutorial-demo] (tutorial map only)\n"
                         "  [--menu-smoke OUTPUT_PREFIX] (with --online-map; live API reads only, no scores)\n"
                         "  [--menu-home-smoke OUTPUT_PREFIX] (home menu over the real map tour backdrop; no gameplay or scores)\n"
                         "No map: open the map browser. WASD move, Space/wheel jump, Ctrl crouch, E use, R restart, Esc menu, F10 Settings, Alt+Enter fullscreen.\n"
                         "Frame-limited mode simulates one fixed tick per rendered frame; screenshot implies --frames 1.\n";
            return 0;
        }
        const int code=run(opt);
        if(relaunch_requested&&!native::relaunch(executable_path()))std::cerr<<"Bunnyhop native: could not restart; start the game again to move your data\n";
        return code;
    } catch(const std::exception &error) {
        std::cerr << "Bunnyhop native: " << error.what() << '\n';
        if(interactive_errors) SDL_ShowSimpleMessageBox(SDL_MESSAGEBOX_ERROR,native::app_name,error.what(),nullptr);
        return 1;
    }
}
