#include "bunnyhop_native.h"
#include "native_input.hpp"
#include "native_math.hpp"
#include "menu_webview.hpp"
#include "online.hpp"
#include "renderer.hpp"
#include "hud.hpp"
#include "ssj.hpp"
#include "audio.hpp"
#include "client_util.hpp"
#include "room_state.hpp"
#include "room_modes.hpp"
#include "tutorial.hpp"
#include "discord_rpc.hpp"
#ifdef __APPLE__
#include <mach-o/dyld.h>
#endif
#include "../packaging/executable_identity.hpp"
#include "../packaging/assets_identity.hpp"
#include <SDL3/SDL.h>
#include <SDL3/SDL_opengl.h>
#include <algorithm>
#include <chrono>
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
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

namespace {
struct Options {
    std::string map, content_root, screenshot, online_map, menu_html = BUNNYHOP_MENU_HTML, menu_smoke;
    uint64_t frames = 0;
    double sensitivity = 2;
    bool hidden = false, help = false, no_menu = false, sensitivity_set=false;
    std::string style="autohop", replay,tutorial_lesson;bool tutorial_demo=false;
};
Options options(int argc, char **argv) {
    Options out;
    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        auto value = [&]() -> std::string { if (++i >= argc) throw std::runtime_error("Missing value for " + arg); return argv[i]; };
        if(arg=="--tutorial")out.tutorial_lesson=value();
        else if(arg=="--tutorial-demo")out.tutorial_demo=true;
        else if(arg=="--style") out.style=value();
        else if(arg=="--replay") out.replay=value();
        else if (arg == "--map") out.map = value();
        else if (arg == "--online-map") out.online_map = value();
        else if (arg == "--menu-html") out.menu_html = value();
        else if (arg == "--menu-smoke") out.menu_smoke = value();
        else if (arg == "--no-menu") out.no_menu = true;
        else if (arg == "--content-root") out.content_root = value();
        else if (arg == "--screenshot") out.screenshot = value();
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
    if(!out.tutorial_lesson.empty()&&out.tutorial_lesson!="jump"&&out.tutorial_lesson!="strafe"&&out.tutorial_lesson!="speed"&&out.tutorial_lesson!="final")throw std::runtime_error("Unknown tutorial lesson");
    if(!native::styles.contains(out.style))throw std::runtime_error("Unknown movement style");
    if (!out.screenshot.empty() && !out.frames) out.frames = 1;
    if (!out.map.empty() && !out.online_map.empty()) throw std::runtime_error("Choose --map or --online-map");
    if (!out.online_map.empty() && !native::valid_map_id(out.online_map)) throw std::runtime_error("Invalid online map name");
    if (out.map.empty() && out.online_map.empty() && (out.no_menu || out.frames) && !out.help)
        throw std::runtime_error("This mode needs --map or --online-map");
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
    WindowPtr window(SDL_CreateWindow("Bunnyhop Native",1280,720,flags),&SDL_DestroyWindow);
    if(!window) throw std::runtime_error(std::string("Creating SDL window failed: ")+SDL_GetError());
    SDL_GLContext context=SDL_GL_CreateContext(window.get());
    if(!context) throw std::runtime_error(std::string("Creating OpenGL 3.3 core context failed: ")+SDL_GetError());
    struct ContextCleanup { SDL_GLContext ctx; ~ContextCleanup(){SDL_GL_DestroyContext(ctx);} } context_cleanup{context};
    if (!SDL_GL_MakeCurrent(window.get(),context)) throw std::runtime_error(SDL_GetError());
    SDL_GL_SetSwapInterval(opt.frames?0:1);
    Gl gl; gl.load(); std::unique_ptr<Renderer> renderer;
    const auto assets=native::resource("native-assets",BUNNYHOP_NATIVE_ASSET_ROOT);
    const auto menu_path=opt.menu_html==BUNNYHOP_MENU_HTML?native::resource("menu.html",opt.menu_html):std::filesystem::path(opt.menu_html);
    const auto manifest_path=native::resource("native-manifest.json",BUNNYHOP_NATIVE_MANIFEST);
    NativeHud hud(gl,assets);
    // Resolved before the audio device so the custom sound/ and bgm/ folders
    // are known at the point the packs are first applied.
    char *pref_path=SDL_GetPrefPath("bunnyhop.lol","Bunnyhop Native");
    if(!pref_path) throw std::runtime_error("Cannot find the native client data directory");
    const std::filesystem::path cache(pref_path); SDL_free(pref_path);
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
    bool captured=false,focused=true,running=true,menu_ready=false,smoke_requested=false,smoke_pass=false,smoke_snapshot=false,resume_wanted=false;
    bool recording_ended=false;
    auto preferences=native::default_settings();
    try {preferences=native::load_settings(cache/"settings.json");}catch(const std::exception &e){std::cerr<<"Settings: "<<e.what()<<'\n';}
    if(opt.sensitivity_set)preferences["sensitivity"]=opt.sensitivity;
    std::string selected_style=opt.style,active_style=opt.style,outfit,packed_loadout;
    native::RoomState room;native::RoomModes room_modes;std::optional<unsigned> observed_spectator;
    auto epoch_ms=[](){return std::chrono::duration<double,std::milli>(std::chrono::system_clock::now().time_since_epoch()).count();};
    uint32_t room_events=8;auto room_time=std::chrono::steady_clock::now();
    uint32_t active_track=0,ghost_handle=0;
    std::string ghost_id,playback_id,pending_replay,pending_action,score_notice;
    nlohmann::json replay_list=nlohmann::json::array(),playback_info,ghost_info;
    bool playback=false,playback_paused=false,ghost_enabled=false,playback_failed=false;
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
    auto apply_preferences=[&]() {
        input.set_sensitivity(preferences.at("sensitivity").get<double>());
        input.vertical_sensitivity=preferences.at("verticalSensitivity").get<double>();input.separate_vertical=preferences.at("separateVertical").get<bool>();
        SDL_GL_SetSwapInterval(opt.frames?0:preferences.at("vsync").get<bool>()?1:0);
        audio.gain(preferences.at("muted").get<bool>()?0:preferences.at("volume").get<float>());
        audio.set_sfx_pack(preferences.at("sfxPack").get<std::string>()=="custom");
        audio.set_music_pack(preferences.at("musicPack").get<std::string>()=="custom");
        if(renderer){renderer->set_fov(preferences.at("fov").get<float>());renderer->set_viewmodel_visible(preferences.at("viewmodel").get<bool>());}
    };
    apply_preferences();
    std::string map_id,loading,error,record_path,last_ui;
    nlohmann::json identity={{"build","bunnyhop-native/local"},{"wasm",""}};
    if(std::filesystem::exists(manifest_path)) {
        try {
            const auto manifest=nlohmann::json::parse(read_text(manifest_path));
            const auto executable=executable_path();
            if(manifest.value("binarySha256",std::string())==file_hash(executable,manifest.value("binaryHashMode",std::string("sha256"))) &&
               manifest.value("menuSha256",std::string())==file_hash(menu_path)&&(!manifest.contains("assetsSha256")||manifest.at("assetsSha256")==native::assets_identity_hash(assets))) identity=manifest;
            else std::cerr<<"Native release manifest is stale; replays remain local. Rebuild with bun apps/native/build.ts\n";
        } catch(const std::exception &e) {std::cerr<<"Native release manifest: "<<e.what()<<"; replays remain local\n";}
    }
    // Jump stats (!ssj). Display only — it reads the same pre-state, command and
    // events the simulation already produced and never feeds anything back.
    native::SsjTracker ssj;
    const native::SsjFields ssj_fields;
    std::string ssj_line;
    bool ssj_good=false;
    // The reference samples the state from BEFORE the tick, so the zone and
    // noclip flags are carried from the previous one rather than read after.
    bool ssj_was_in_start=false,ssj_was_noclip=false;
    uint64_t run_generation=0;
    uint32_t beat_start=0,beat_upto=0,beat_hash=0x811c9dc5;
    bool beat_paused=false;
    auto beat_time=std::chrono::steady_clock::now();
    std::vector<BhZone> zones;
    std::mutex progress_mutex;
    std::atomic_bool cancel_download{false};
    std::future<native::DownloadedMap> download;
    struct CancelDownload { std::atomic_bool &flag; ~CancelDownload(){flag=true;} } cancel_on_exit{cancel_download};
    double accumulator=0;
    auto capture=[&](bool on) {
        input.clear();held_codes.clear();
        if (!SDL_SetWindowRelativeMouseMode(window.get(),on)) {
            captured=false; std::cerr << "Relative mouse mode failed: " << SDL_GetError() << '\n';
        } else captured=on;
    };
    auto show_menu=[&](bool on) {
        if(menu) menu->set_visible(on);
        if(on)audio.pause();
        resume_wanted=!on&&bool(core);
        if(resume_wanted) SDL_RaiseWindow(window.get());
        capture(resume_wanted && focused); accumulator=0; prev=curr;
    };
    auto run_event=[&](nlohmann::json event) {
        if(!menu || !menu_ready || opt.frames || !opt.menu_smoke.empty()) return;
        event["generation"]=run_generation;event["map"]=map_id;event["style"]=active_style;
        event["build"]=identity.value("build",std::string("bunnyhop-native/local"));
        event["wasm"]=identity.value("wasm",std::string());
        menu->evaluate_js("window.bunnyhopNativeMenu?.onRunEvent?.("+event.dump()+")");
    };
    auto begin_record=[&]() {
        recording_ended=false; record_path.clear();
        ++run_generation;beat_start=beat_upto=0;beat_hash=0x811c9dc5;beat_paused=false;
        run_event({{"type","reset"}});
        if(playback || room.spectator_target || map_id==tutorial_map || zones.empty() || opt.frames || !opt.menu_smoke.empty()) return;
        const auto stamp=std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
        record_path=(cache/"replays"/(map_id+"-"+std::to_string(stamp)+".bhr")).string();
        require(bh_record_identity(core.get(),identity.at("build").get<std::string>().c_str()),core.get(),"Setting native release identity");
        require(bh_record_begin(core.get(),"",active_style.c_str(),"native-player",100),core.get(),"Starting native recording");
        bh_record_loadout(core.get(),packed_loadout.c_str());
    };
    auto reset=[&]() {
        if(!core) return;
        bh_record_end(core.get());room_events|=8;
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
        if(tutorial&&tutorial->is_active()){
            tutorial->set_legit(active_style=="legit"||active_style=="scroll");tutorial->start(tutorial->lesson_index());
            const auto spawn=tutorial->spawn();require(bh_set_position(core.get(),spawn.position[0],spawn.position[1],spawn.position[2],spawn.yaw),core.get(),"Placing tutorial player");
            require(bh_set_velocity(core.get(),0,0,0),core.get(),"Stopping tutorial player");require(bh_state(core.get(),&curr),core.get(),"Reading tutorial restart");
            if(tutorial_demo)tutorial_demo_start=curr.tick;
        }
        if(renderer){renderer->reset_presentation();renderer->set_viewmodel_weapon(std::nullopt);renderer->set_cosmetics(outfit,packed_loadout);}
        audio.reset();prev=curr; accumulator=0; input.set_angles(curr.teleport_angles[0],curr.teleport_angles[1]); input.clear();
        begin_record();
    };
    auto apply_room_mode=[&](const native::RoomModeAction &action){
        if(action.stop_spectating&&menu&&menu_ready)menu->evaluate_js("window.bunnyhopNativeMenu?.onRoomCommand?.({t:'spec',target:null})");
        if(action.restart&&core){if(tutorial)tutorial->stop();tutorial_demo=false;if(!action.style.empty())selected_style=action.style;active_track=action.track;reset();show_menu(false);}
    };
    auto load_map=[&](const std::string &path,const std::string &content,const std::string &id,const nlohmann::json &detail) {
        CorePtr next(bh_create(),&bh_destroy); if(!next) throw std::runtime_error("Could not create native core");
        require(bh_load_map(next.get(),path.c_str(),content.empty()?nullptr:content.c_str()),next.get(),"Loading BSP map");
        require(bh_set_settings(next.get(),&settings),next.get(),"Applying settings");
        const auto next_zones=timer_zones(detail);
        BhRunOptions timing{}; bh_default_run_options(&timing);
        if(!next_zones.empty())require(bh_run_configure(next.get(),&timing,next_zones.data(),next_zones.size()),next.get(),"Configuring timer");
        std::unique_ptr<native::Tutorial> next_tutorial;
        if(id==tutorial_map){const auto metadata=nlohmann::json::parse(read_text(assets/"tutorial.json"));if(file_hash(path)!=metadata.at("bspSha256").get<std::string>())throw std::runtime_error("Tutorial BSP does not match bundled lessons; update the tutorial assets and map together");next_tutorial=std::make_unique<native::Tutorial>(metadata,selected_style=="legit"||selected_style=="scroll");next_tutorial->set_completed(tutorial_completed);}
        auto next_renderer=std::make_unique<Renderer>(gl,next.get(),assets);
        renderer.reset(); core=std::move(next); renderer=std::move(next_renderer);
        zones=next_zones;tutorial=std::move(next_tutorial);tutorial_demo=false; map_id=id; error.clear();playback=false;ghost_handle=0;ghost_enabled=false;ghost_id.clear(); reset();apply_preferences();renderer->set_cosmetics(outfit,packed_loadout);apply_room_mode(room_modes.map_loaded(map_id,room.spectator_target.has_value(),epoch_ms()));
    };
    auto request_map=[&](const std::string &id) {
        if(download.valid()) throw std::runtime_error("A map is already loading");
        if(!native::valid_map_id(id)) throw std::runtime_error("Invalid map name");
        error.clear(); show_menu(true);
        {std::lock_guard lock(progress_mutex); loading="Reading "+id;}
        download=std::async(std::launch::async,[&,id] {
            return native::download_map(id,cache,[&](const std::string &message) {std::lock_guard lock(progress_mutex);loading=message;},&cancel_download);
        });
    };
    CorePtr metadata_core(bh_create(),&bh_destroy);
    auto replay_metadata=[&](const std::filesystem::path &path) {
        size_t bytes=0;const char *json=bh_replay_header(metadata_core.get(),path.string().c_str(),&bytes);
        require(json!=nullptr,metadata_core.get(),"Reading replay header");
        return nlohmann::json::parse(json,json+bytes);
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
            replay_list.push_back({{"id",entry.path().filename().string()},{"name",info.value("player",std::string("Local run"))},
                {"map",info.at("map")},{"style",info.value("style",std::string("autohop"))},{"track",info.value("track",0)},
                {"seconds",(info.at("endTick").get<double>()-info.at("startTick").get<double>())*info.at("settings").value("tickInterval",.01)},
                {"recordedAt",info.value("recordedAt",0.)},{"bytes",entry.file_size()}});
        }catch(const std::exception &e){std::cerr<<"Skipping replay "<<entry.path().filename()<<": "<<e.what()<<'\n';}
    };
    auto open_replay=[&](const std::filesystem::path &path,const std::string &action) {
        if(!core)throw std::runtime_error("Load the replay map first");
        if(tutorial)tutorial->stop();tutorial_demo=false;renderer->reset_presentation();
        bh_record_end(core.get());++run_generation;run_event({{"type","reset"}});beat_start=0;audio.reset();
        if(action=="ghost") {
            if(ghost_handle)bh_ghost_free(core.get(),ghost_handle);
            ghost_handle=bh_ghost_load(core.get(),path.string().c_str());require(ghost_handle!=0,core.get(),"Loading ghost");
            size_t bytes=0;const auto raw=bh_ghost_info(core.get(),ghost_handle,&bytes);ghost_info=nlohmann::json::parse(raw,raw+bytes);
            ghost_id=path.filename().string();ghost_enabled=true;active_track=ghost_info.value("track",0u);selected_style=ghost_info.value("style",std::string("autohop"));
            reset();show_menu(false);
        } else {
            if(!bh_replay_load(core.get(),path.string().c_str())){const std::string failure=bh_last_error(core.get());reset();throw std::runtime_error("Loading native replay: "+failure);}
            size_t bytes=0;const auto raw=bh_replay_info(core.get(),&bytes);playback_info=nlohmann::json::parse(raw,raw+bytes);
            renderer->set_cosmetics(outfit,(playback_info.contains("packedLoadout")&&playback_info["packedLoadout"].is_string()?playback_info["packedLoadout"].get<std::string>():std::string()));
            playback=true;playback_paused=false;playback_speed=1;playback_id=path.filename().string();recording_ended=true;record_path.clear();
            BhCmd cmd{};bh_last_command(core.get(),&cmd);bh_state(core.get(),&curr);prev=curr;input.set_angles(cmd.pitch,cmd.yaw);
            accumulator=0;show_menu(false);
        }
    };
    auto request_replay=[&](const std::filesystem::path &path,const std::string &action) {
        const auto info=replay_metadata(path);const auto id=info.at("map").get<std::string>();
        if(!native::valid_map_id(id))throw std::runtime_error("Replay has invalid map name");
        if(map_id!=id||!core) {pending_replay=path.string();pending_action=action;request_map(id);}
        else open_replay(path,action);
    };
    start_tutorial=[&](const std::string &lesson,bool demo){
        if(!core||map_id!=tutorial_map||!tutorial)throw std::runtime_error("Load the tutorial map before starting a lesson");
        if(ghost_handle){bh_ghost_free(core.get(),ghost_handle);ghost_handle=0;}ghost_enabled=false;tutorial_demo=false;
        tutorial_stopped=false;tutorial_final_saved=false;tutorial->start(lesson);active_track=lesson=="final"?1:0;reset();
        std::array<std::string,4> labels{"Space","W","A","D"};const char *actions[]={"jump","forward","left","right"};for(int k=0;k<4;k++){const auto &bound=preferences.at("binds").at(actions[k]);if(!bound.empty()){labels[k]=bound[0];if(labels[k].rfind("Key",0)==0)labels[k].erase(0,3);}}
        tutorial->set_keys(labels);score_notice.clear();
        if(demo){const auto &meta=tutorial->lesson_data();const auto key=(active_style=="legit"||active_style=="scroll")&&meta.contains("nativeDemoLegit")?"nativeDemoLegit":"nativeDemo";if(!meta.contains(key))throw std::runtime_error("Tutorial demonstration is absent");const auto file=meta.at(key).get<std::string>();if(file.find_first_of("/\\")!=std::string::npos)throw std::runtime_error("Invalid bundled tutorial replay path");
            ghost_handle=bh_ghost_load(core.get(),(assets/"tutorial"/file).string().c_str());require(ghost_handle!=0,core.get(),"Loading native tutorial demonstration");size_t bytes=0;const auto *raw=bh_ghost_info(core.get(),ghost_handle,&bytes);require(raw!=nullptr,core.get(),"Reading tutorial demonstration");ghost_info=nlohmann::json::parse(raw,raw+bytes);ghost_enabled=true;tutorial_demo=true;tutorial_demo_start=curr.tick;ghost_id="tutorial-"+lesson;
        }
        std::cout<<"Native tutorial "<<lesson<<(demo?" demonstration":" lesson")<<"; ranked recording disabled\n";show_menu(false);
    };
    uint32_t last_slot=3,observed_slot=3;
    auto movement_bit=[](const std::string &action)->uint32_t {
        if(action=="forward")return native::forward;if(action=="back")return native::back;
        if(action=="left")return native::left;if(action=="right")return native::right;
        if(action=="jump")return native::jump;if(action=="duck")return native::duck;
        if(action=="use")return native::use;if(action=="attack")return native::attack;if(action=="attack2")return native::attack2;return 0;
    };
    auto act=[&](const std::string &action) {
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
        else if(action=="giveUsp"||action=="giveGlock")input.pulse|=(action=="giveUsp"?3u:2u)<<16;
        else if(action=="viewmodel"||action=="hideUi"||action=="mute") {
            const std::string key=action=="hideUi"?"hud":action=="mute"?"muted":"viewmodel";
            preferences[key]=!preferences[key].get<bool>();native::save_settings(cache/"settings.json",preferences);apply_preferences();
        }
    };
    auto handle_code=[&](const std::string &code,bool down,bool repeat=false,bool wheel=false) {
        if(code.empty())return;
        if(down)held_codes.insert(code);else held_codes.erase(code);
        input.held=0;
        for(auto binding=preferences["binds"].begin();binding!=preferences["binds"].end();++binding) {
            const auto bit=movement_bit(binding.key());bool matching=false,held=false;
            for(const auto &raw:binding.value()) {const auto key=raw.get<std::string>();matching|=key==code||(wheel&&key=="MouseWheel");held|=held_codes.contains(key);}
            if(bit){if(wheel&&matching&&down)input.pulse|=bit;else if(held)input.held|=bit;}
            else if(matching&&down&&!repeat)act(binding.key());
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
    if(!opt.replay.empty())request_replay(opt.replay,"play");
    using Clock=std::chrono::steady_clock;
    auto last=Clock::now(),title_time=last,ui_time=last,started=last; uint64_t frame=0,title_frames=0;
    // Discord Rich Presence / Join. Never from scripted or hidden runs, so a
    // smoke test can't show up on the developer's own profile.
    native::discord::Client discord;
    const bool discord_allowed=!opt.frames&&!opt.hidden&&opt.menu_smoke.empty();
    std::string presence_map;int64_t presence_started=0;auto presence_time=std::chrono::steady_clock::time_point{};
    discord.on_join=[&](const std::string &id){
        if(!menu||!menu_ready)return;
        show_menu(true);menu->evaluate_js("window.bunnyhopNativeMenu?.joinRoom?.("+nlohmann::json(id).dump()+")");
    };
    while(running) {
        SDL_Event event;
        while(SDL_PollEvent(&event)) {
            switch(event.type) {
                case SDL_EVENT_QUIT: running=false; break;
                case SDL_EVENT_WINDOW_FOCUS_LOST: focused=false; show_menu(true); break;
                case SDL_EVENT_WINDOW_FOCUS_GAINED: focused=true;if(resume_wanted&&(!menu||!menu->visible())) capture(true);break;
                case SDL_EVENT_KEY_DOWN:
                case SDL_EVENT_KEY_UP: {
                    const bool down=event.type==SDL_EVENT_KEY_DOWN;
                    if(down && !event.key.repeat) {
                        if(event.key.scancode==SDL_SCANCODE_F10) running=false;
                        else if(event.key.scancode==SDL_SCANCODE_ESCAPE) show_menu(captured);
                        else if(event.key.scancode==SDL_SCANCODE_T&&captured&&menu) {show_menu(true);menu->evaluate_js("window.bunnyhopNativeMenu?.open?.('room','chat')");}
                    }
                    if(captured&&!playback)handle_code(native::key_code(event.key.scancode),down,event.key.repeat);
                    break;
                }
                case SDL_EVENT_MOUSE_MOTION: if(captured&&focused&&!playback) input.motion_at(event.motion.timestamp,event.motion.xrel,event.motion.yrel); break;
                case SDL_EVENT_MOUSE_BUTTON_DOWN:
                case SDL_EVENT_MOUSE_BUTTON_UP: {
                    const bool down=event.type==SDL_EVENT_MOUSE_BUTTON_DOWN;
                    if(!captured&&down&&focused&&(!menu||!menu->visible())&&core) {capture(true);break;}
                    if(captured&&!playback)handle_code(native::mouse_code(event.button.button),down);
                    break;
                }
                case SDL_EVENT_MOUSE_WHEEL: if(captured&&!playback&&event.wheel.y!=0)handle_code(event.wheel.y>0?"MWheelUp":"MWheelDown",true,false,true); break;
                default: break;
            }
        }
        if(menu) for(const auto &raw:menu->drain_messages()) {
            try {
                if(raw.size()>12*1024*1024)throw std::runtime_error("Menu command too large");
                auto message=nlohmann::json::parse(raw);const auto type=message.at("type").get<std::string>();
                const size_t limit=type=="replayData"?12*1024*1024:(type=="roomSnapshot"||type=="roomEvent")?128*1024:16*1024;
                if(raw.size()>limit)throw std::runtime_error("Menu command exceeds its type limit");
                if(type=="ready") {menu_ready=true;run_event({{"type","reset"}});std::cout<<"Native menu ready: "<<raw<<'\n';}
                else if(type=="resume" && core && !download.valid()) show_menu(false);
                else if(type=="restart" && core && !download.valid()) {reset();show_menu(false);}
                else if(type=="selectMap") {
                    const auto style=message.value("style",selected_style);if(!native::styles.contains(style))throw std::runtime_error("Unknown style");
                    tutorial_stopped=false;selected_style=style;active_track=message.value("track",0u);if(active_track>64)throw std::runtime_error("Invalid track");
                    request_map(message.at("id").get<std::string>());
                }
                else if(type=="style") {const auto id=message.at("id").get<std::string>();if(!native::styles.contains(id))throw std::runtime_error("Unknown style");selected_style=id;active_track=0;reset();}
                else if(type=="settings") {auto changed=native::patch_settings(preferences,message.at("patch"));native::save_settings(cache/"settings.json",changed);preferences=std::move(changed);input.clear();held_codes.clear();apply_preferences();error.clear();}
                else if(type=="replays")refresh_replays();
                else if(type=="ghost")ghost_enabled=ghost_handle&&message.at("enabled").get<bool>();
                else if(type=="replay") {
                    const auto path=native::replay_file(cache/"replays",message.at("id").get<std::string>());const auto action=message.at("action").get<std::string>();
                    if(action=="play"||action=="ghost")request_replay(path,action);
                    else if(action=="export") {
                        const char *folder=SDL_GetUserFolder(SDL_FOLDER_DOWNLOADS);if(!folder)throw std::runtime_error("Downloads folder unavailable");
                        const auto dest=std::filesystem::path(folder)/path.filename();std::filesystem::copy_file(path,dest,std::filesystem::copy_options::none);score_notice="Replay exported to Downloads";
                    } else if(action=="delete") {
                        std::filesystem::create_directories(cache/"replays"/"trash");auto dest=cache/"replays"/"trash"/path.filename();
                        if(std::filesystem::exists(dest))throw std::runtime_error("Replay already exists in local trash");std::filesystem::rename(path,dest);refresh_replays();
                    } else throw std::runtime_error("Unknown replay action");
                }
                else if(type=="replayData") {
                    const auto bytes=native::decode_base64(message.at("replayBase64").get<std::string>());
                    char sha[65]{};bh_sha256(bytes.data(),bytes.size(),sha);
                    const auto path=cache/"replays"/(std::string("import-")+sha+".bhr");
                    if(!std::filesystem::exists(path)){std::ofstream out(path,std::ios::binary);out.write(reinterpret_cast<const char*>(bytes.data()),bytes.size());if(!out)throw std::runtime_error("Cannot save imported replay");}
                    const auto action=message.at("action").get<std::string>();if(action!="play"&&action!="ghost")throw std::runtime_error("Invalid replay import action");
                    request_replay(path,action);refresh_replays();
                }
                else if(type=="tutorial"){
                    const auto action=message.at("action").get<std::string>();if(action=="stop"){tutorial_stopped=true;pending_tutorial.clear();if(tutorial)tutorial->stop();if(tutorial_demo&&ghost_handle){bh_ghost_free(core.get(),ghost_handle);ghost_handle=0;ghost_enabled=false;}tutorial_demo=false;score_notice.clear();show_menu(true);}
                    else if(action=="start"||action=="demo"){const auto lesson=message.at("lesson").get<std::string>();if(lesson!="jump"&&lesson!="strafe"&&lesson!="speed"&&lesson!="final")throw std::runtime_error("Unknown tutorial lesson");if(map_id==tutorial_map&&core&&tutorial)start_tutorial(lesson,action=="demo");else{tutorial_stopped=false;pending_tutorial=lesson;pending_tutorial_demo=action=="demo";selected_style="autohop";active_track=0;request_map(tutorial_map);}}
                    else throw std::runtime_error("Unknown tutorial action");
                }
                else if(type=="replayControl"&&playback) {
                    const auto action=message.at("action").get<std::string>();
                    if(action=="pause")playback_paused=message.value("paused",!playback_paused);
                    else if(action=="speed") {const double value=message.at("speed").get<double>();if(!std::isfinite(value)||value<.1||value>4)throw std::runtime_error("Replay speed must be 0.1–4");playback_speed=value;}
                    else if(action=="seek") {const auto tick=message.at("tick").get<uint32_t>();if(tick>playback_info.at("totalTicks").get<uint32_t>())throw std::runtime_error("Replay tick outside run");BhSnapshot state{};if(!bh_replay_seek(core.get(),tick,&state)){const std::string failure=bh_last_error(core.get());reset();show_menu(true);throw std::runtime_error("Replay seek stopped: "+failure);}curr=prev=state.player;BhCmd view{};bh_last_command(core.get(),&view);input.set_angles(view.pitch,view.yaw);renderer->reset_presentation();audio.reset();accumulator=0;}
                    else if(action=="stop")reset();
                }
                else if(type=="sensitivity") {preferences=native::patch_settings(preferences,{{"sensitivity",message.at("value")}});native::save_settings(cache/"settings.json",preferences);apply_preferences();}
                else if(type=="cosmetics") {
                    outfit=message.value("outfit",std::string());packed_loadout=message.value("packedLoadout",std::string());
                    if(outfit.size()>64||packed_loadout.size()>200)throw std::runtime_error("Invalid cosmetic selection");
                    if(renderer)renderer->set_cosmetics(outfit,packed_loadout);
                }
                else if(type=="roomEvent") {
                    const auto next=room.event(message);apply_room_mode(room_modes.event(message,map_id,room.spectator_target.has_value(),epoch_ms()));if(room.id.empty())pending_room_map.clear();
                    if(!next.empty()&&native::valid_map_id(next)&&next!=map_id){if(download.valid())pending_room_map=next;else{active_track=0;request_map(next);}}
                }
                else if(type=="roomSnapshot")room.snapshot(message,std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch()).count());
                else if(type=="openAuth") menu->open_auth(message.at("url").get<std::string>());
                else if(type=="openExternal") native::open_external(message.at("url").get<std::string>());
                else if(type=="auth") menu->evaluate_js("window.bunnyhopNativeMenu?.onAuth("+message.dump()+")");
                else if(type=="menuError") {error=message.value("error",std::string("Menu failed"));std::cerr<<"Menu: "<<error<<'\n';}
                else if(type=="runService") {
                    score_notice=message.value("message",std::string());std::cout<<"Score service: "<<message.dump()<<'\n';
                }
                else if(type=="quit") running=false;
                else if(type=="smoke" && !opt.menu_smoke.empty()) {
                    message["engine"]="native";message["renderer"]="opengl";message["map"]=map_id;message["nativeTick"]=curr.tick;
                    std::ofstream(opt.menu_smoke+".json")<<message.dump(2)<<'\n';
                    smoke_pass=message.value("apiStatus",0)==200 && message.value("origin",std::string())=="https://bunnyhop.lol" && message.value("webglAttempts",1)==0 && message.value("controlsVisible",false) && message.value("uiMap",std::string())==map_id && bool(renderer);
                    std::cout<<"Native menu smoke: "<<message.dump()<<'\n';
                    int w=0,h=0;SDL_GetWindowSizeInPixels(window.get(),&w,&h);
                    if(renderer) renderer->screenshot(opt.menu_smoke+"-game.ppm",w,h);
                    smoke_snapshot=menu->screenshot(opt.menu_smoke+".png");
                    if(!smoke_snapshot) {smoke_pass=false;running=false;}
                }
                else if(type=="menuSnapshot" && smoke_snapshot) {smoke_pass=smoke_pass&&message.value("ok",false);running=false;}
            } catch(const std::exception &e) {error=e.what();std::cerr<<"Menu: "<<error<<'\n';}
        }
        if(download.valid() && download.wait_for(std::chrono::seconds(0))==std::future_status::ready) {
            try {auto result=download.get();load_map(result.bsp.string(),result.content_root.string(),result.id,result.detail);}
            catch(const std::exception &e) {error=e.what();std::cerr<<error<<'\n';if(!menu||opt.frames)throw;}
            {std::lock_guard lock(progress_mutex);loading.clear();}
            if(tutorial&&!tutorial_stopped&&error.empty()&&pending_replay.empty()){const auto lesson=pending_tutorial.empty()?"jump":pending_tutorial;try{start_tutorial(lesson,pending_tutorial_demo);}catch(const std::exception &e){error=e.what();}pending_tutorial.clear();pending_tutorial_demo=false;}
            if(!pending_replay.empty()&&error.empty()) {auto path=pending_replay,action=pending_action;pending_replay.clear();try{open_replay(path,action);}catch(const std::exception &e){error=e.what();}}
            if(!pending_room_map.empty()&&pending_room_map!=map_id){const auto next=pending_room_map;pending_room_map.clear();active_track=0;request_map(next);}
            else pending_room_map.clear();
            if(!menu && core && !opt.hidden) capture(true);
        }
        if(!running) break;
        const auto now=Clock::now();
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
                status.mode=playback?"replay":!room.id.empty()?"multiplayer":map_id==tutorial_map?"practice":"solo";
                status.map=map_id==tutorial_map?"the tutorial":map_id;
                const auto named=style_names.find(active_style);status.style=named==style_names.end()?active_style:named->second;
                status.started_at=presence_started;status.room=room.id;
                activity=native::discord::build_activity(status,settings,[](const std::string &text){
                    char hex[65]{};bh_sha256(reinterpret_cast<const uint8_t *>(text.data()),text.size(),hex);return std::string(hex);},unix_now);
            }
            discord.update(discord_allowed&&settings.enabled&&!settings.privacy,activity);
        }
        if(spectator!=observed_spectator){
            if(spectator){bh_record_end(core.get());recording_ended=true;record_path.clear();beat_start=0;++run_generation;run_event({{"type","reset"}});audio.reset();accumulator=0;input.clear();renderer->reset_presentation();show_menu(false);}
            else if(observed_spectator&&core&&!playback)reset();observed_spectator=spectator;
        }
        const bool simulation_active=core && !spectator && !room_modes.frozen() && !download.valid() && ((focused&&captured)||opt.frames)&&(!playback||!playback_paused);
        if(beat_start&&!simulation_active) beat_paused=true;
        if(simulation_active) accumulator+=(opt.frames?dt:std::clamp(std::chrono::duration<double>(now-last).count(),0.0,.25))*(playback?playback_speed:1);
        last=now;
        // Where simulated time has reached, on SDL's clock, so each tick below
        // can claim the mouse reports stamped inside it. accumulator is how far
        // behind the simulation currently is, so subtracting it from now gives
        // the instant the next tick starts from.
        const uint64_t wall_ns=SDL_GetTicksNS();
        const uint64_t behind_ns=uint64_t(std::max(0.0,accumulator)*1e9);
        uint64_t sim_ns=behind_ns<wall_ns?wall_ns-behind_ns:0;
        const uint64_t tick_ns=uint64_t(dt*1e9);
        // Not simulating means nothing will claim them on a schedule, so apply
        // them now and keep the pre-existing behaviour for paused states.
        if(!simulation_active) input.consume_all();
        while(accumulator>=dt) {
            // --frames is a deterministic mode with no wall clock to window
            // against, so a tick there takes whatever is waiting.
            if(opt.frames) input.consume_all();
            else {sim_ns+=tick_ns;input.consume_until(sim_ns);}
            prev=curr;const BhState tutorial_pre=curr;
            BhCmd cmd{};
            if(playback) {
                if(curr.tick>=playback_info.at("totalTicks").get<uint32_t>()){playback_paused=true;accumulator=0;break;}
                BhSnapshot state{};if(!bh_replay_step(core.get(),&state)){const std::string failure=bh_last_error(core.get());playback_failed=true;reset();error="Replay stopped: "+failure;std::cerr<<error<<'\n';show_menu(true);accumulator=0;if(opt.frames)running=false;break;}curr=state.player;bh_last_command(core.get(),&cmd);input.set_angles(cmd.pitch,cmd.yaw,5);
            } else {input.held=0;for(auto b=preferences["binds"].begin();b!=preferences["binds"].end();++b){const auto bit=movement_bit(b.key());if(bit)for(const auto &key:b.value())if(held_codes.contains(key.get<std::string>()))input.held|=bit;}cmd=input.command();const auto look=input.look_sample();require(bh_step_look(core.get(),&cmd,look?&*look:nullptr,&curr),core.get(),"Stepping simulation");input.events(curr);}
            renderer->simulation_tick();
            if(curr.events&native::teleported)room_events|=8;if(curr.events&2)room_events|=4;
            if(curr.events&(1u<<5)){const bool stab=cmd.buttons&native::attack2;room_events|=stab?32:16;if(!playback)bh_record_cosmetic(core.get(),stab?2:1);}
            if(playback){BhReplayEvents e{};if(bh_replay_events(core.get(),prev.tick,curr.tick,&e)){if(e.inspect_signal)renderer->inspect_press();renderer->inspect_held(e.inspect_held!=0);}}
            BhSnapshot state{};bh_snapshot(core.get(),&state);BhRunState timing{};bh_run_state(core.get(),&timing);BhWeaponReport weapon{};bh_weapon_report(core.get(),&weapon);BhAttackReport attack{};
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
                info.in_start=ssj_was_in_start;info.noclip=ssj_was_noclip;
                if(timing.status==1)info.time=timing.seconds;
                if(timing.update_flags&4){ssj.reset();ssj_line.clear();ssj_good=false;}  // restarted
                if(const auto report=ssj.tick(pre,ssj_cmd,info)) {
                    ssj_line=native::ssj_text(*report,ssj_fields);
                    ssj_good=report->gain&&*report->gain>=native::good_gain;
                }
                ssj_was_in_start=timing.in_start!=0;ssj_was_noclip=state.movement_mode==1;  // Mode::Noclip
            }
            BhSurfaceProbe surface{};surface.water_z=std::numeric_limits<float>::quiet_NaN();const bool surface_found=bh_surface_at(core.get(),curr.position[0],curr.position[1],curr.position[2],&surface)!=0;const double water_depth=surface_found?surface.water_z-curr.position[2]:std::numeric_limits<double>::quiet_NaN();
            static const std::array<const char*,6> surfaces={"concrete","metal","wood","grass","tile","water"};
            audio.tick(state,timing,weapon,bh_attack_report(core.get(),&attack)?&attack:nullptr,dt,surfaces[std::clamp(surface.surface,0,5)],water_depth);
            const uint32_t slot=weapon.active==weapon.primary?1:weapon.active==weapon.secondary?2:3;if(slot!=observed_slot){last_slot=observed_slot;observed_slot=slot;}
             if(curr.events&native::teleported) prev=curr;
            accumulator-=dt;
            BhRunState tick_run{};
            if(playback||!zones.empty())require(bh_run_state(core.get(),&tick_run),core.get(),"Reading native timer");
            if(tutorial&&tutorial->is_active()&&!playback){BhCmd filtered=cmd;bh_last_command(core.get(),&filtered);const auto result=tutorial->tick(tutorial_pre,curr,filtered,curr.events,dt);if(result.completed)save_tutorial();if(tick_run.status==2&&tutorial->lesson_id()=="final"&&!tutorial_final_saved){tutorial->finish(tick_run.seconds);save_tutorial();tutorial_final_saved=true;}if(result.next_lesson>=0&&result.next_lesson<4){const char *ids[]={"jump","strafe","speed","final"};start_tutorial(ids[result.next_lesson],false);accumulator=0;break;}}

            // Finish the recording on the exact native tick, before any further catch-up steps.
            if(!playback&&tick_run.status==2&&!recording_ended) {accumulator=0;break;}
        }
        BhRunState run_state{};
        if(core) {
            if(playback||!zones.empty())require(bh_run_state(core.get(),&run_state),core.get(),"Reading native timer");
            if(!playback&&run_state.status==1&&run_state.recording) {
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
            if(!playback&&run_state.status==2 && !recording_ended) {
                recording_ended=true;
                if(!record_path.empty()) {
                    try {
                        require(bh_record_end(core.get()),core.get(),"Finishing native recording");
                        require(bh_record_write_bhr(core.get(),record_path.c_str()),core.get(),"Writing native replay");
                        refresh_replays();
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
        if(renderer) {
            const float blend=(opt.frames||!simulation_active)?1.0f:float(accumulator/dt); float eye[3];
            for(int i=0;i<3;++i) eye[i]=prev.position[i]+(curr.position[i]-prev.position[i])*blend;
            eye[2]+=prev.view_offset_z+(curr.view_offset_z-prev.view_offset_z)*blend;
            BhSnapshot state{};bh_snapshot(core.get(),&state);
            if(ghost_enabled&&ghost_handle&&!playback&&!spectator) {
                BhGhostFrame ghost{};const uint32_t tick=ghost_info.value("startTick",0u)+(tutorial_demo?curr.tick-tutorial_demo_start:run_state.status?curr.tick-run_state.start_tick:0);
                if(bh_ghost_frame(core.get(),ghost_handle,tick,&ghost))renderer->set_replay_actor(ghost,tutorial_demo?"outfit-cream":outfit,(ghost_info.contains("packedLoadout")&&ghost_info["packedLoadout"].is_string()?ghost_info["packedLoadout"].get<std::string>():std::string()),.4f);
                else{renderer->set_replay_actor(nullptr,0,0);if(tutorial_demo){ghost_enabled=false;tutorial_demo=false;}}
            } else renderer->set_replay_actor(nullptr,0,0);
            const double steady_seconds=std::chrono::duration<double>(now.time_since_epoch()).count();auto actors=room.actors(steady_seconds);auto camera_input=input;camera_input.consume_all();std::string shown_notice=tutorial&&tutorial->is_active()&&!playback?tutorial->notice():score_notice;
            const auto race_notice=room_modes.notice(epoch_ms());if(!race_notice.empty())shown_notice=race_notice;
            renderer->set_viewmodel_weapon(std::nullopt);renderer->set_viewmodel_visible(preferences.at("viewmodel").get<bool>());
            if(spectator){const auto target=room.spectated(steady_seconds);if(target){for(int k=0;k<3;k++){eye[k]=target->frame.position[k];state.player.position[k]=target->frame.position[k];state.player.velocity[k]=target->frame.velocity[k];}eye[2]+=target->frame.view_offset_z;state.player.tick=target->frame.tick;state.player.grounded=!!(target->frame.flags&2);state.player.crouched=!!(target->frame.flags&1);camera_input.set_angles(target->frame.pitch,target->frame.yaw);renderer->set_cosmetics(target->outfit,target->loadout);renderer->set_viewmodel_weapon(target->frame.weapon);shown_notice="Spectating "+target->name+" - Esc for Room controls";actors.erase(std::remove_if(actors.begin(),actors.end(),[&](const auto &a){return a.id==target->id;}),actors.end());}else{renderer->set_viewmodel_visible(false);shown_notice="Waiting for spectator target";}}
            renderer->set_room_actors(actors);
            renderer->draw(width,height,eye,camera_input,&state,(playback||opt.frames)?curr.tick*dt:std::chrono::duration<double>(now-started).count());
            BhCmd shown{};bh_last_command(core.get(),&shown);BhWeaponReport weapon{};bh_weapon_report(core.get(),&weapon);
            if(!menu||!menu->visible())hud.draw(width,height,state,run_state,shown,map_id,playback?playback_info.value("style",active_style):active_style,shown_notice,display_fps,
                preferences.at("hud").get<bool>(),preferences.at("crosshair").get<bool>(),playback,weapon,
                preferences.at("jumpStats").get<bool>()?ssj_line:std::string(),ssj_good);
        } else {gl.Viewport(0,0,width,height);gl.ClearColor(.03f,.04f,.06f,1);gl.Clear(GL_COLOR_BUFFER_BIT);}
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
        ++frame; ++title_frames;if(simulation_active&&!playback)input.frame();
        audio.pump();  // advances the music playlist; decoding cannot run on the audio thread
        if(opt.frames&&renderer&&(curr.tick>=opt.frames||(playback&&playback_paused&&curr.tick>=playback_info.value("totalTicks",0u)))&&!opt.screenshot.empty()) renderer->screenshot(opt.screenshot,width,height);
        const GLenum gl_error=gl.GetError(); if(gl_error!=GL_NO_ERROR) throw std::runtime_error("OpenGL error "+std::to_string(gl_error));
        if(!SDL_GL_SwapWindow(window.get())) throw std::runtime_error(std::string("Swapping framebuffer failed: ")+SDL_GetError());
        if(menu && menu_ready && (menu->visible()||!room.id.empty()) && (now-ui_time>=std::chrono::milliseconds(200) || (!opt.menu_smoke.empty() && renderer && !download.valid() && !smoke_requested))) {
            std::string progress;{std::lock_guard lock(progress_mutex);progress=loading;}
            const nlohmann::json state={{"engine","native"},{"renderer","opengl"},{"map",map_id},{"loading",progress},{"error",error},
                {"sensitivity",input.sensitivity},{"paused",!captured},{"recordingPath",record_path},
                {"style",selected_style},{"track",active_track},{"settings",preferences},{"replays",replay_list},
                {"room",{{"id",room.id},{"map",room.map},{"spectating",spectator.has_value()},{"target",spectator?nlohmann::json(*spectator):nlohmann::json(nullptr)},{"raceFrozen",room_modes.frozen()}}},
                {"tutorial",tutorial?tutorial->stateJSON():nlohmann::json{{"active",false},{"lesson","jump"},{"completed",tutorial_completed}}},
                {"playback",{{"active",playback},{"id",playback_id},{"tick",curr.tick},{"totalTicks",playback?playback_info.value("totalTicks",0u):0u},{"paused",playback_paused},{"speed",playback_speed}}},
                {"ghost",{{"enabled",ghost_enabled},{"id",ghost_id},{"name",ghost_info.is_object()?ghost_info.value("player",std::string("Ghost")):"Ghost"}}},
                {"timer",{{"status",run_state.status},{"seconds",run_state.seconds},{"jumps",run_state.jumps},{"strafes",run_state.strafes},{"sync",run_state.sync_percent}}},
                {"discord",{{"state",discord_allowed?discord.state:"disabled"},{"message",discord.message}}}};
            const auto encoded=state.dump();
            if(encoded!=last_ui) {menu->evaluate_js("window.bunnyhopNativeMenu?.onState("+encoded+")");last_ui=encoded;}
            ui_time=now;
        }
        if(menu && menu_ready && renderer && !download.valid() && !opt.menu_smoke.empty() && !smoke_requested) {
            smoke_requested=true;
            // App-owned integration check: reads the same live account API as the menu; never submits a run.
            menu->evaluate_js("(()=>{const expected="+nlohmann::json(map_id).dump()+R"JS(;
                const post=value=>window.webkit.messageHandlers.bunnyhop.postMessage(JSON.stringify({type:'smoke',...value}));
                let attempts=0;
                const check=()=>{
                    const uiMap=document.querySelector('.native-current h2')?.textContent;
                    const buttons=[...document.querySelectorAll('.native-home-actions button')];
                    const controlsVisible=buttons.length>=5 && buttons.every(button=>{
                        const style=getComputedStyle(button),rect=button.getBoundingClientRect();
                        return !button.disabled && style.visibility==='visible' && Number(style.opacity)>.95 && rect.width>0 && rect.height>0;
                    });
                    if(uiMap!==expected || !controlsVisible || document.getElementById('native-status')?.textContent) {
                        if(++attempts<100) {setTimeout(check,100);return;}
                        post({error:'Loaded-map controls did not become ready',uiMap,controlsVisible});return;
                    }
                    fetch('/api/me',{credentials:'include'}).then(r=>post({apiStatus:r.status,origin:location.origin,
                        canvasCount:document.querySelectorAll('canvas').length,webglAttempts:window.__nativeMenuGraphics?.attempts,
                        uiMap,controlsVisible})).catch(e=>post({error:String(e)}));
                };
                setTimeout(check,300);
            })())JS");
        }
        if(!opt.menu_smoke.empty() && now-started>std::chrono::seconds(90)) throw std::runtime_error("Native menu smoke timed out: "+error);
        const double elapsed=std::chrono::duration<double>(now-title_time).count();
        if(elapsed>=.5) {
            display_fps=title_frames/elapsed;char title[320]; std::snprintf(title,sizeof(title),"Bunnyhop native | %s | %.0f FPS | %.1f u/s | %.2fs | %s | Esc menu | R restart",map_id.c_str(),title_frames/elapsed,std::hypot(curr.velocity[0],curr.velocity[1]),run_state.seconds,captured?"SDL raw input":"paused");
            SDL_SetWindowTitle(window.get(),title); title_time=now; title_frames=0;
        }
        if(opt.frames&&renderer&&(curr.tick>=opt.frames||(playback&&playback_paused&&curr.tick>=playback_info.value("totalTicks",0u)))) running=false;
        if(!core||download.valid()||(!opt.frames&&(!focused||!captured))) SDL_Delay(10);
        else if(!opt.frames&&preferences.at("fpsLimit").get<int>()>0) {
            const double target=1./preferences.at("fpsLimit").get<int>();const double spent=std::chrono::duration<double>(Clock::now()-now).count();
            if(spent<target)SDL_DelayNS(uint64_t((target-spent)*1e9));
        }
    }
    if(core) bh_record_end(core.get());
    capture(false);
    std::cout << "Rendered " << frame << " frames; simulation tick " << curr.tick << "; position " << curr.position[0] << ' ' << curr.position[1] << ' ' << curr.position[2] << '\n';
    return playback_failed||(!opt.menu_smoke.empty()&&!smoke_pass)?1:0;
}
}

int main(int argc,char **argv) {
    bool hidden=false;
    try {
        Options opt=options(argc,argv); hidden=opt.hidden;
        if(opt.help) {
            std::cout << "Usage: bunnyhop-native [--map MAP.bsp | --online-map NAME] [--content-root DIR] [--sensitivity 2]\n"
                         "  [--menu-html PATH] [--no-menu] [--frames N] [--screenshot output.ppm] [--hidden]\n"
                         "  [--tutorial jump|strafe|speed|final] [--tutorial-demo] (tutorial map only)\n"
                         "  [--menu-smoke OUTPUT_PREFIX] (live API reads only; never records/submits a run)\n"
                         "No map: open the map browser. WASD move, Space/wheel jump, Ctrl crouch, E use, R restart, Esc menu, F10 quit.\n"
                         "Frame-limited mode simulates one fixed tick per rendered frame; screenshot implies --frames 1.\n";
            return 0;
        }
        return run(opt);
    } catch(const std::exception &error) {
        std::cerr << "Bunnyhop native: " << error.what() << '\n';
        if(!hidden) SDL_ShowSimpleMessageBox(SDL_MESSAGEBOX_ERROR,"Bunnyhop native",error.what(),nullptr);
        return 1;
    }
}
