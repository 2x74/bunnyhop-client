#pragma once
#include <nlohmann/json.hpp>
#include <algorithm>
#include <cmath>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <set>
#include <stdexcept>
#include <string>
#include "window_settings.hpp"
#include "announcer.hpp"

namespace native {
using Json = nlohmann::json;
inline const std::set<std::string> styles={"autohop","legit","scroll","wonly","sideways","hsw","lowgrav","autostrafe"};
// EZ Scroll ("legit") and Legit Scroll ("scroll"): every hop is a timed press, so
// perfect-hop feedback means something. With autohop every hop is perfect.
inline bool scroll_style(const std::string &style){return style=="legit"||style=="scroll";}
inline Json default_settings() {
    Json result={{"sensitivity",2.0},{"verticalSensitivity",2.0},{"separateVertical",false},
        // Turnbinds (+left / +right): degrees per second, like cl_yawspeed. The alt speed is used while Turn modifier is held.
        // 210 is CS:S's cl_yawspeed, the web's fixed turn and the only speed the server ranks.
        {"invertY",false},{"holdRestart",false},{"mouseDiagnostics",false},
        // Hidden: false goes back to the per-frame proration comparator (also --legacy-input). See timed_input.hpp.
        {"timedInput",true},
        {"crosshairStyle","cross"},{"crosshairColor","#eee8db"},{"crosshairSize",6.0},{"crosshairGap",3.0},{"crosshairThickness",2.0},{"crosshairAlpha",1.0},{"crosshairOutline",true},
        {"viewmodelFov",54.0},{"viewmodelX",.6},{"viewmodelY",1.5},{"viewmodelZ",-.9},{"viewmodelLeftHand",false},{"viewmodelBob",1.0},{"viewmodelSway",1.0},
        {"playerModel","bunny"},{"ghostModel","same"},{"showGhost",true},{"ghostOpacity",.4},{"ghostNearFade",true},{"ghostTag",true},{"othersAudio",true},{"ghostAudio",true},
        {"sfxVolume",1.0},{"musicVolume",1.0},{"uiVolume",1.0},{"ambienceVolume",1.0},{"muteSfx",false},{"muteUi",false},{"muteMusic",false},{"muteAmbience",false},{"muteInBackground",true},{"classicSounds",false},{"perfectTick",false},{"announcer",default_announcer()},{"footsteps",true},{"weaponSounds",true},{"wind",true},
        {"colorBlind","off"},{"gainTicks",true},{"speedColors",true},{"perfectIndicator",true},{"speedGraph",false},{"keysOverlay",true},{"keysStyle","classic"},
        {"yawSpeed",210.0},{"yawSpeedAlt",210.0},
        // Source look: CS:S's auto exposure and bloom on maps with HDR lighting.
        {"capturePbScreenshots",false},{"showPlayerGlow",true},{"firstPersonGlow",true},{"waterQuality","simple"},{"zonesVisible",true},{"effectsVisible",true},{"triggersVisible",false},{"clipsVisible",false},{"fov",90.0},{"sourceLook",true},{"vsync",true},{"fpsLimit",0},{"volume",.65},{"muted",false},
        {"hudScale",100.0},{"practiceKeepVelocity",true},{"hud",true},{"crosshair",true},{"viewmodel",true},{"jumpStats",true},
        // Jump stats: "sixth" (jump 6 only), "every" jump, or "interval" (every jumpStatsInterval jumps).
        {"jumpStatsMode","sixth"},{"jumpStatsColors",true},{"jumpStatsInterval",6},
        // Strafe trainer: smoothing is how many air ticks a reading averages (1 = every tick on its own).
        {"strafeTrainer",false},{"strafeTrainerSmoothing",1},{"strafeTrainerHints",true},
        // HUD element positions, element id -> {x, y} in percent. Absent means the built-in place.
        {"hudLayout",Json::object()},
        {"sfxPack","default"},{"musicPack","default"},
        // Discord: presence on by default; privacy mode hides everything.
        {"discordRichPresence",true},{"discordShowMap",true},{"discordJoin",true},{"discordJoinLobbies",false},{"privacyMode",false},
        {"binds",{
            {"forward",{"KeyW"}},{"back",{"KeyS"}},{"left",{"KeyA"}},{"right",{"KeyD"}},
            {"jump",{"Space","MouseWheel"}},{"duck",{"ControlLeft","ControlRight"}},{"use",{"KeyE"}},
            {"restart",{"KeyR"}},{"restartBonus",{"KeyB","F4"}},{"restartMain",{"KeyM"}},
            {"cycleStyle",{"F3"}},{"attack",{"Mouse1"}},{"attack2",{"Mouse2"}},
            {"inspect",{"KeyF"}},{"viewmodel",{"KeyH"}},{"hideUi",{"F1"}},
            {"mute",{"KeyO"}},{"slot1",{"Digit1"}},{"slot2",{"Digit2"}},{"slot3",{"Digit3"}},
            {"lastWeapon",{"KeyQ"}},{"drop",{"KeyG"}},{"reload",Json::array()},
            {"giveUsp",{"Digit5"}},{"giveGlock",{"Digit6"}},
            {"practice",Json::array()},{"cpSave",{"KeyC"}},{"cpTeleport",{"KeyX"}},{"cpPrev",Json::array()},{"cpNext",Json::array()},{"mainMenu",Json::array()},{"noclip",{"Backquote"}},
            {"chat",{"KeyY"}},{"commandChat",{"KeyU"}},{"scoreboard",{"Tab"}},{"spectatorNext",Json::array()},{"spectatorPrevious",Json::array()},{"spectatorMode",{"KeyN"}},
            {"setStart",Json::array()},{"clearStart",Json::array()},{"nextWeapon",Json::array()},{"prevWeapon",Json::array()},
            {"gunMenu",Json::array()},{"nextTrack",Json::array()},{"keysOverlay",Json::array()},{"hudEditor",Json::array()},{"thirdPerson",Json::array()},{"flashlight",Json::array()},
            {"showTriggers",{"Mouse3"}},{"showClips",{"KeyT"}},
            {"turnLeft",{"ArrowLeft"}},{"turnRight",{"ArrowRight"}},{"turnFast",{"Mouse4"}}
        }}};
    result.update(default_window_settings());return result;
}
// The HUD elements a layout may place. hud.hpp draws them; ui/hud-layout.ts lists them.
inline const std::set<std::string> hud_elements={"crosshair","map","fps","timer","speed","runStats","status",
    "jumpStats","strafeTrainer","splits","speedGraph","keys","health","notice","replay"};
inline bool valid_bind_code(const std::string &code) {
    if(code.size()==4 && code.starts_with("Key")) return code[3]>='A'&&code[3]<='Z';
    if(code.size()==6 && code.starts_with("Digit")) return code[5]>='0'&&code[5]<='9';
    if(code.size()==6 && code.starts_with("Mouse")) return code[5]>='1'&&code[5]<='5';
    if(code.size()>=2 && code.size()<=3 && code[0]=='F') {
        try {size_t n=0;int f=std::stoi(code.substr(1),&n);return n==code.size()-1 && f>=1&&f<=12&&f!=10;}catch(...){return false;}
    }
    static const std::set<std::string> other={"Space","ControlLeft","ControlRight","ShiftLeft","ShiftRight",
        "AltLeft","AltRight","Tab","Enter","Backspace","ArrowLeft","ArrowRight","ArrowUp","ArrowDown",
        "MouseWheel","MWheelUp","MWheelDown","BracketLeft","BracketRight","Minus","Equal","Comma","Period","Slash","Semicolon","Quote","Backquote"};
    return other.contains(code);
}
// A patch is atomic. Invalid persisted input never silently changes half the controls.
inline Json patch_settings(const Json &current,const Json &patch) {
    if(!patch.is_object() || patch.size()>128) throw std::runtime_error("Invalid settings object");
    Json out=current;
    const auto defaults=default_settings();
    for(auto it=patch.begin();it!=patch.end();++it) {
        const auto &key=it.key(); const auto &v=it.value();
        if(!defaults.contains(key)) throw std::runtime_error("Unknown setting: "+key);
        if(key=="announcer"){out[key]=patch_announcer(out.at(key),v);continue;
        } else if(key=="windowMode") {
            if(!v.is_string()||!valid_window_mode(v.get<std::string>()))throw std::runtime_error("Invalid window mode");
        } else if(defaults[key].is_boolean()) {
            if(!v.is_boolean()) throw std::runtime_error("Setting must be true or false: "+key);
        } else if(key=="binds") {
            if(!v.is_object() || v.size()>defaults["binds"].size()) throw std::runtime_error("Invalid key bindings");
            auto binds=out["binds"];
            for(auto b=v.begin();b!=v.end();++b) {
                if(!defaults["binds"].contains(b.key()) || !b.value().is_array() || b.value().size()>4)
                    throw std::runtime_error("Invalid action binding");
                for(const auto &code:b.value()) if(!code.is_string() || !valid_bind_code(code.get<std::string>()))
                    throw std::runtime_error("Unsupported key or mouse button");
                binds[b.key()]=b.value();
            }
            out["binds"]=std::move(binds);continue;
        } else if(key=="hudLayout") {
            // Replaces the whole layout: what isn't listed goes back to its built-in place.
            if(!v.is_object()||v.size()>hud_elements.size()) throw std::runtime_error("Invalid HUD layout");
            for(auto e=v.begin();e!=v.end();++e) {
                if(!hud_elements.contains(e.key())||!e.value().is_object()||e.value().size()<2||e.value().size()>4) throw std::runtime_error("Invalid HUD layout entry");
                for(auto field=e.value().begin();field!=e.value().end();++field)if(field.key()!="x"&&field.key()!="y"&&field.key()!="visible"&&field.key()!="scale")throw std::runtime_error("Unknown HUD layout field");
                if(e.value().contains("visible")&&!e.value()["visible"].is_boolean())throw std::runtime_error("HUD visibility must be boolean");
                if(e.value().contains("scale")){const auto &z=e.value()["scale"];if(!z.is_number()||!std::isfinite(z.get<double>())||z.get<double>()<.5||z.get<double>()>3)throw std::runtime_error("HUD element scale must be .5–3");}
                for(const char *axis:{"x","y"}) {
                    if(!e.value().contains(axis)||!e.value()[axis].is_number()) throw std::runtime_error("Invalid HUD layout entry");
                    const double n=e.value()[axis].get<double>();
                    if(!std::isfinite(n)||n<0||n>100) throw std::runtime_error("HUD positions must be 0–100%");
                }
            }
        } else if(key=="jumpStatsMode") {
            if(!v.is_string()) throw std::runtime_error("Setting must be text: "+key);
            const auto mode=v.get<std::string>();
            if(mode!="sixth"&&mode!="every"&&mode!="interval") throw std::runtime_error("Jump stats mode must be sixth, every or interval");
        } else if(key=="crosshairStyle"||key=="keysStyle"||key=="crosshairColor") {
            if(!v.is_string())throw std::runtime_error("Setting must be text: "+key);
            const auto choice=v.get<std::string>();
            if(key=="crosshairStyle"&&!std::set<std::string>{"cross","cross-dot","dot","t","circle","none"}.contains(choice))throw std::runtime_error("Unknown crosshair style");
            if(key=="keysStyle"&&!std::set<std::string>{"classic","minimal","keycaps"}.contains(choice))throw std::runtime_error("Unknown keys style");
            if(key=="crosshairColor"&&(choice.size()!=7||choice[0]!='#'||!std::all_of(choice.begin()+1,choice.end(),[](unsigned char c){return std::isxdigit(c); })))throw std::runtime_error("Crosshair color must be #rrggbb");
        } else if(key=="playerModel"||key=="ghostModel"){
            if(!v.is_string()||(v!="bunny"&&v!="runner"&&!(key=="ghostModel"&&v=="same")))throw std::runtime_error("Unknown player model");
        } else if(key=="colorBlind"){
            if(!v.is_string()||(v!="off"&&v!="redGreen"&&v!="blueYellow"))throw std::runtime_error("Unknown color-blind palette");
        } else if(key=="waterQuality"){
            if(!v.is_string()||(v!="simple"&&v!="refracted"))throw std::runtime_error("Water quality must be simple or refracted");
        } else if(defaults[key].is_string()) {
            // Audio pack choices. Only these two words are ever stored, so the
            // value can never become a path the client would then go looking
            // for: which folder "custom" means is decided by the client alone.
            if(!v.is_string()) throw std::runtime_error("Setting must be text: "+key);
            const auto choice=v.get<std::string>();
            if(choice!="default"&&choice!="custom") throw std::runtime_error("Audio pack must be default or custom: "+key);
        } else {
            if(!v.is_number() || !std::isfinite(v.get<double>())) throw std::runtime_error("Setting must be finite: "+key);
            const auto n=v.get<double>();
            if((key=="sensitivity"||key=="verticalSensitivity") && (n<.01||n>100)) throw std::runtime_error("Sensitivity must be .01–100");
            if(key=="hudScale" && (n!=std::floor(n)||n<50||n>175)) throw std::runtime_error("HUD scale must be 50–175%");
            if(key=="fov" && (n<60||n>130)) throw std::runtime_error("FOV must be 60–130");
            if(key=="viewmodelFov"&&(n<30||n>100))throw std::runtime_error("Viewmodel FOV must be 30–100");
            if((key=="viewmodelX"||key=="viewmodelY"||key=="viewmodelZ")&&(n< -10||n>10))throw std::runtime_error("Viewmodel offsets must be -10–10");
            if((key=="viewmodelBob"||key=="viewmodelSway")&&(n<0||n>2))throw std::runtime_error("Bob must be 0–2");
            if((key=="crosshairSize"||key=="crosshairGap")&&(n<0||n>40))throw std::runtime_error("Crosshair dimensions must be 0–40");
            if(key=="crosshairThickness"&&(n<.5||n>10))throw std::runtime_error("Crosshair thickness must be .5–10");
            if((key=="volume"||key=="sfxVolume"||key=="musicVolume"||key=="uiVolume"||key=="ambienceVolume"||key=="crosshairAlpha"||key=="ghostOpacity") && (n<0||n>1)) throw std::runtime_error("Volume must be 0–1");
            if((key=="yawSpeed"||key=="yawSpeedAlt") && (n<.01||n>1000)) throw std::runtime_error("Yaw speed must be .01–1000");
            if(key=="strafeTrainerSmoothing" && (n!=std::floor(n) || n<1 || n>50)) throw std::runtime_error("Strafe trainer smoothing must be a whole number 1–50");
            if(key=="jumpStatsInterval" && (n!=std::floor(n) || n<2 || n>50)) throw std::runtime_error("Jump stats interval must be a whole number 2–50");
            if(key=="fpsLimit" && (n!=std::floor(n) || (n!=0 && (n<30||n>1000)))) throw std::runtime_error("FPS limit must be 0 or 30–1000");
        }
        out[key]=v;
    }
    return out;
}
inline Json load_settings(const std::filesystem::path &file) {
    auto out=default_settings();
    if(!std::filesystem::exists(file)) return out;
    if(std::filesystem::file_size(file)>16384) throw std::runtime_error("Settings file is too large");
    std::ifstream stream(file);Json saved;stream>>saved;
    // Before !showclips existed, "Trigger and clip overlays" drew both groups.
    // Keep clips on for anyone who had that toggle on.
    if(saved.is_object()&&!saved.contains("clipsVisible")&&saved.value("triggersVisible",Json(false))==true)saved["clipsVisible"]=true;
    return patch_settings(out,saved);
}
inline void save_settings(const std::filesystem::path &file,const Json &settings) {
    auto temp=file;temp+=".tmp";
    {std::ofstream out(temp,std::ios::binary|std::ios::trunc);out<<settings.dump(2)<<'\n';if(!out)throw std::runtime_error("Could not save settings");}
    // Windows rename cannot replace an existing destination. Keep a rollback copy until replacement succeeds.
    auto backup=file;backup+=".previous";
    std::error_code ec;
    if(std::filesystem::exists(file)) {std::filesystem::remove(backup,ec);std::filesystem::rename(file,backup);}
    try {std::filesystem::rename(temp,file);}catch(...) {if(std::filesystem::exists(backup))std::filesystem::rename(backup,file);throw;}
    std::filesystem::remove(backup,ec);
}
}
