#pragma once
#include <nlohmann/json.hpp>
#include <algorithm>
#include <cmath>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <set>
#include <stdexcept>
#include <string>
#include "window_settings.hpp"
#include "hud_geometry.hpp"
#if __has_include("graphics_settings.hpp")
#include "graphics_settings.hpp"
#endif
#include "announcer.hpp"
#include "atomic_replace.hpp"

namespace native {
using Json = nlohmann::json;
inline const std::set<std::string> styles = {
        "autohop", "legit", "scroll", "wonly", "sideways", "hsw", "lowgrav", "autostrafe"
};

// EZ Scroll ("legit") and Legit Scroll ("scroll"): every hop is a timed press, so
// perfect-hop feedback means something. With autohop every hop is perfect.
inline bool scroll_style(const std::string &style) {
    return style == "legit" || style == "scroll";
}

inline Json default_hud_layout_web() {
    const auto place = [](bool on, unsigned anchor, double x, double y, double scale = 1) {
        return Json{{"on", on}, {"a", anchor}, {"x", x}, {"y", y}, {"s", scale}};
    };
    return {{"speed", place(true, 7, 0, -.262)},
            {"timer", place(true, 7, 0, -.22)},
            {"split", place(true, 7, .072, -.222, .9)},
            {"track", place(true, 7, 0, -.31, .85)},
            {"stage", place(true, 7, 0, -.165)},
            {"stats", place(true, 7, 0, -.19)},
            {"sync", place(false, 7, 0, -.135)},
            {"keys", place(true, 4, 0, .115)},
            {"ghostKeys", place(false, 4, .085, .115, .8)},
            {"graph", place(false, 6, .015, -.03)},
            {"jumpStats", place(false, 4, 0, -.06)},
            {"startPre", place(false, 7, -.075, -.262)},
            {"strafeOffsets", place(false, 4, 0, -.13, .85)},
            {"firstJump", place(false, 4, 0, -.104, .85)},
            {"longJump", place(false, 4, 0, -.185)},
            {"map", place(true, 0, .012, .016)},
            {"pb", place(true, 2, -.012, .016)},
            {"fps", place(false, 0, .012, .045)},
            {"chat", place(true, 6, .012, -.2)},
            {"strafeTrainer", place(false, 1, 0, .22, 1.15)},
            {"ammo", place(true, 8, -.014, -.022)},
            {"spectators", place(true, 3, .012, -.06)},
            {"practice", place(true, 4, 0, .032)}};
}

// Revision of the default viewmodel framing (viewmodel/defaults.ts VIEWMODEL_REV): 3 is v0.0.29's wider framing, with
// the gloves, cuffs and some sleeve in view. The website's CS:S preset keeps the old one.
inline constexpr int viewmodel_revision = 3;

inline Json default_settings() {
    Json result = {
            {"sensitivity", 2.0},
            {"verticalSensitivity", 2.0},
            {"separateVertical", false},
            // Turn rates follow cl_yawspeed and cl_anglespeedkey and freeze for each recording.
            {"invertY", false},
            {"holdRestart", false},
            {"mouseDiagnostics", false},
            {"inputBackend", "auto"},
            // Hidden: false goes back to the per-frame proration comparator (also --legacy-input). See timed_input.hpp.
            {"timedInput", true},
            {"crosshairStyle", "cross"},
            {"crosshairColor", "#4dff6a"},
            {"crosshairSize", 6.0},
            {"crosshairGap", 4.0},
            {"crosshairThickness", 2.0},
            {"crosshairAlpha", 1.0},
            {"crosshairOutline", true},
            {"viewmodelFov", 64.0},
            {"viewmodelX", .5},
            {"viewmodelY", 1.5},
            {"viewmodelZ", 0.0},
            {"viewmodelRev", viewmodel_revision},
            {"viewmodelLeftHand", false},
            {"viewmodelBob", 1.0},
            {"viewmodelSway", 1.0},
            {"playerModel", "bunny"},
            {"ghostModel", "same"},
            {"showGhost", true},
            {"ghostOpacity", .55},
            {"ghostNearFade", true},
            {"ghostTag", true},
            {"othersAudio", true},
            {"ghostAudio", false},
            {"sfxVolume", .8},
            {"musicVolume", .5},
            {"uiVolume", .6},
            {"ambienceVolume", .7},
            {"muteSfx", false},
            {"muteUi", false},
            {"muteMusic", false},
            {"muteAmbience", false},
            {"muteInBackground", true},
            {"classicSounds", false},
            {"perfectTick", false},
            {"announcer", default_announcer()},
            {"footsteps", true},
            {"weaponSounds", true},
            {"wind", false},
            {"colorBlind", "off"},
            {"gainTicks", true},
            {"speedColors", true},
            {"perfectIndicator", true},
            {"speedGraph", false},
            {"keysOverlay", true},
            {"keysStyle", "keycaps"},
            {"yawSpeed", 210.0},
            {"angleSpeedKey", 2.0},
            // Source look: CS:S's auto exposure and bloom on maps with HDR lighting.
            {"capturePbScreenshots", false},
            {"showPlayerGlow", true},
            {"firstPersonGlow", true},
            {"waterQuality", "simple"},
            {"zonesVisible", true},
            {"effectsVisible", true},
            {"triggersVisible", false},
            {"clipsVisible", false},
            {"fov", 90.0},
            {"sourceLook", true},
            {"vsync", false},
            {"fpsLimit", 1000},
            {"limitQueuedFrames", true},
            {"volume", .8},
            {"muted", false},
            {"hudScale", 100.0},
            {"practiceKeepVelocity", true},
            {"hud", true},
            {"crosshair", true},
            {"viewmodel", true},
            {"jumpStats", false},
            // Jump stats: "sixth" (jump 6 only), "every" jump, or "interval" (every jumpStatsInterval jumps).
            {"jumpStatsMode", "sixth"},
            {"jumpStatsColors", true},
            {"jumpStatsInterval", 6},
            // Strafe trainer: smoothing is how many air ticks a reading averages (1 = every tick on its own).
            {"strafeTrainer", false},
            {"strafeTrainerSmoothing", 8},
            {"strafeTrainerHints", false},
            // HUD element positions, element id -> {x, y} in percent. Absent means the built-in place.
            {"hudLayout", Json::object()},
            {"hudLayoutWeb", default_hud_layout_web()},
            {"triggersStyle", "filled"},
            {"triggersThickness", 1.0},
            {"triggersOpacity", .16},
            {"triggersColorsTeleport", "#ff4040"},
            {"triggersColorsPush", "#3d8bff"},
            {"triggersColorsGravity", "#3ddc84"},
            {"triggersColorsOther", "#ffd23d"},
            {"triggersColorsClip", "#b35cff"},
            {"triggersColorsWall", "#b4bac4"},
            {"audioMusicMode", "always"},
            {"audioShuffle", true},
            {"audioPerfHud", true},
            {"hudHiddenKeeps", "speedKeys"},
            {"hudPlace", "off"},
            {"hudEdgeGlow", false},
            {"tagsPlayers", true},
            {"tagsThroughWalls", false},
            {"hudKeysOpacity", 1.0},
            {"hudKeysPressed", "#ffffff"},
            {"hudKeysIdle", "#9aa3b2"},
            {"hudKeysRowsWasd", true},
            {"hudKeysRowsActions", true},
            {"hudKeysRowsMouse", true},
            {"hudStrafeTrainerStyle", "classic"},
            {"hudStrafeTrainerFollow", false},
            {"hudStrafeTrainerZone", 10.0},
            {"hudStrafeTrainerHeight", 1.0},
            {"hudStrafeTrainerDimBelow", 0.0},
            {"hudStrafeTrainerColor", "#ffffff"},
            {"hudStrafeTrainerShowPace", true},
            {"hudStrafeTrainerSound", false},
            {"hudSsjChat", false},
            {"hudSsjFieldsSpeed", true},
            {"hudSsjFieldsDiff", true},
            {"hudSsjFieldsGain", true},
            {"hudSsjFieldsSync", true},
            {"hudSsjFieldsStrafes", true},
            {"hudSsjFieldsEff", false},
            {"hudSsjFieldsHeight", false},
            {"hudSsjFieldsTime", false},

            {"hudMovementFjtChat", false},
            {"hudMovementLj", false},
            {"hudMovementLjChat", true},
            {"nullBinds", false},
            {"autoRestartWhen", "off"},
            {"autoRestartAction", "restart"},
            {"sfxPack", "default"},
            {"musicPack", "default"},
            // Discord: presence on by default; privacy mode hides everything.
            {"discordRichPresence", true},
            {"discordShowMap", true},
            {"discordJoin", true},
            {"discordJoinLobbies", false},
            {"privacyMode", false},
            {"binds",
             {{"forward", {"KeyW"}},
              {"back", {"KeyS"}},
              {"left", {"KeyA"}},
              {"right", {"KeyD"}},
              {"jump", {"Space", "MouseWheel"}},
              {"duck", {"ControlLeft"}},
              {"use", {"KeyE"}},
              {"restart", {"KeyR"}},
              {"restartBonus", {"KeyB", "F4"}},
              {"restartMain", {"KeyM"}},
              {"cycleStyle", {"F3"}},
              {"attack", {"Mouse1"}},
              {"attack2", {"Mouse2"}},
              {"inspect", {"KeyF"}},
              {"viewmodel", {"KeyH"}},
              {"hideUi", {"F1"}},
              {"mute", {"KeyO"}},
              {"slot1", {"Digit1"}},
              {"slot2", {"Digit2"}},
              {"slot3", {"Digit3"}},
              {"lastWeapon", {"KeyQ"}},
              {"drop", {"KeyG"}},
              {"reload", Json::array()},
              {"giveUsp", {"Digit5"}},
              {"giveGlock", {"Digit6"}},
              {"practice", Json::array()},
              {"cpSave", {"KeyC"}},
              {"cpTeleport", {"KeyX"}},
              {"cpPrev", Json::array()},
              {"cpNext", Json::array()},
              {"mainMenu", Json::array()},
              {"noclip", {"KeyZ"}},
              {"chat", {"KeyY"}},
              {"commandChat", {"KeyU"}},
              {"scoreboard", {"Tab"}},
              {"spectatorNext", Json::array()},
              {"spectatorPrevious", Json::array()},
              {"spectatorMode", {"KeyN"}},
              {"setStart", {"Digit4"}},
              {"clearStart", Json::array()},
              {"nextWeapon", Json::array()},
              {"prevWeapon", Json::array()},
              {"gunMenu", {"Digit7"}},
              {"nextTrack", {"KeyP"}},
              {"keysOverlay", Json::array()},
              {"hudEditor", {"F2"}},
              {"thirdPerson", {"KeyT"}},
              {"flashlight", {"KeyL"}},
              {"showTriggers", {"Mouse3"}},
              {"showClips", Json::array()},
              {"turnLeft", {"ArrowLeft"}},
              {"turnRight", {"ArrowRight"}},
              {"turnFast", {"ArrowUp"}}}}
    };
    result.update(default_window_settings());
#if __has_include("graphics_settings.hpp")
    result.update(default_graphics_settings());
    result["binds"].update(default_graphics_binds());
#endif
    return result;
}

// Setting keys understood by the C++ HUD. Published with host state for menu capability gating.
inline Json hud_capabilities() {
    return Json::array(
            {"movementStats",
             "longjump",
             "triggerMenu",
             "hudLayout",
             "hudLayoutWeb",
             "audioPerfHud",
             "hudScale",
             "hudHiddenKeeps",
             "hudPlace",
             "hudEdgeGlow",
             "keysOverlay",
             "keysStyle",
             "hudKeysOpacity",
             "hudKeysPressed",
             "hudKeysIdle",
             "hudKeysRowsWasd",
             "hudKeysRowsActions",
             "hudKeysRowsMouse",
             "tagsPlayers",
             "tagsThroughWalls",
             "jumpStats",
             "hudSsjChat",
             "jumpStatsMode",
             "jumpStatsInterval",
             "jumpStatsColors",
             "hudSsjFieldsSpeed",
             "hudSsjFieldsDiff",
             "hudSsjFieldsGain",
             "hudSsjFieldsSync",
             "hudSsjFieldsStrafes",
             "hudSsjFieldsEff",
             "hudSsjFieldsHeight",
             "hudSsjFieldsTime",

             "strafeTrainer",
             "hudStrafeTrainerStyle",
             "hudStrafeTrainerFollow",
             "strafeTrainerSmoothing",
             "strafeTrainerHints",
             "hudStrafeTrainerZone",
             "hudStrafeTrainerHeight",
             "hudStrafeTrainerDimBelow",
             "hudStrafeTrainerColor",
             "hudStrafeTrainerShowPace",
             "hudStrafeTrainerSound",
             "hudMovementFjtChat",
             "hudMovementLj",
             "hudMovementLjChat",
             "nullBinds",
             "autoRestartWhen",
             "autoRestartAction"}
    );
}

// The HUD elements a layout may place. hud.hpp draws them; ui/hud-layout.ts lists them.
inline const std::set<std::string> hud_elements = {
        "crosshair",     "map",      "fps",           "timer",     "speed",     "runStats",   "status",  "jumpStats",
        "strafeTrainer", "splits",   "speedGraph",    "keys",      "health",    "notice",     "replay",  "split",
        "track",         "stage",    "stats",         "sync",      "ghostKeys", "graph",      "pb",      "chat",
        "ammo",          "startPre", "strafeOffsets", "firstJump", "longJump",  "spectators", "practice"
};

inline bool valid_bind_code(const std::string &code) {
    if (code.size() == 4 && code.starts_with("Key")) return code[3] >= 'A' && code[3] <= 'Z';
    if (code.size() == 6 && code.starts_with("Digit")) return code[5] >= '0' && code[5] <= '9';
    if (code.size() == 6 && code.starts_with("Mouse")) return code[5] >= '1' && code[5] <= '5';
    if (code.size() >= 2 && code.size() <= 3 && code[0] == 'F') {
        try {
            size_t n = 0;
            int f = std::stoi(code.substr(1), &n);
            return n == code.size() - 1 && f >= 1 && f <= 12 && f != 10;
        } catch (...) {
            return false;
        }
    }
    static const std::set<std::string> other = {
            "Space",      "ControlLeft", "ControlRight", "ShiftLeft",   "ShiftRight",   "AltLeft",  "AltRight",
            "Tab",        "Enter",       "Backspace",    "ArrowLeft",   "ArrowRight",   "ArrowUp",  "ArrowDown",
            "MouseWheel", "MWheelUp",    "MWheelDown",   "BracketLeft", "BracketRight", "Minus",    "Equal",
            "Comma",      "Period",      "Slash",        "Semicolon",   "Quote",        "Backquote"
    };
    return other.contains(code);
}

// A website layout change that moves an element (a preset, a layout code) replaces a v0.5.1 placement of that
// element. Showing or hiding one moves nothing, so placements made in v0.5.1 stay.
inline void drop_moved_legacy_places(Json &legacy, const Json &before, const Json &after) {
    for (const auto &[id, place] : after.items()) {
        const auto old = before.find(id);
        bool moved = old == before.end();
        for (const char *field : {"a", "x", "y", "s"})
            moved = moved || !old->contains(field) || old->at(field) != place.value(field, Json());
        if (!moved) continue;
        for (auto entry = legacy.begin(); entry != legacy.end();) {
            if (canonical_hud_id(entry.key()) == canonical_hud_id(id))
                entry = legacy.erase(entry);
            else
                ++entry;
        }
    }
}

// A patch is atomic. Invalid persisted input never silently changes half the controls.
inline Json patch_settings(const Json &current, const Json &patch, bool switch_layout = true) {
    if (!patch.is_object() || patch.size() > 256) throw std::runtime_error("Invalid settings object");
    Json out = current;
    const auto defaults = default_settings();
    for (auto it = patch.begin(); it != patch.end(); ++it) {
        const auto &key = it.key();
        const auto &v = it.value();
#if __has_include("graphics_settings.hpp")
        if (patch_graphics_setting(out, key, v)) continue;
#endif
        if (!defaults.contains(key)) throw std::runtime_error("Unknown setting: " + key);
        if (key == "announcer") {
            out[key] = patch_announcer(out.at(key), v);
            continue;
        } else if (key == "windowMode") {
            if (!v.is_string() || !valid_window_mode(v.get<std::string>()))
                throw std::runtime_error("Invalid window mode");
        } else if (key == "fullscreenMode") {
            const auto mode = read_fullscreen_mode(v);
            if (!mode) throw std::runtime_error("Invalid fullscreen mode");
            out[key] = fullscreen_mode_json(*mode);
            continue;
        } else if (key == "fullscreenScaling") {
            if (!v.is_string() || !valid_fullscreen_scaling(v.get<std::string>()))
                throw std::runtime_error("Invalid fullscreen scaling");
        } else if (defaults[key].is_boolean()) {
            if (!v.is_boolean()) throw std::runtime_error("Setting must be true or false: " + key);
        } else if (key == "binds") {
            if (!v.is_object() || v.size() > defaults["binds"].size()) throw std::runtime_error("Invalid key bindings");
            auto binds = out["binds"];
            for (auto b = v.begin(); b != v.end(); ++b) {
                if (!defaults["binds"].contains(b.key()) || !b.value().is_array() || b.value().size() > 4)
                    throw std::runtime_error("Invalid action binding");
                for (const auto &code : b.value())
                    if (!code.is_string() || !valid_bind_code(code.get<std::string>()))
                        throw std::runtime_error("Unsupported key or mouse button");
                binds[b.key()] = b.value();
            }
            out["binds"] = std::move(binds);
            continue;
        } else if (key == "hudLayout" || key == "hudLayoutWeb") {
            const bool web_schema = key == "hudLayoutWeb";
            // Replaces the whole layout: what isn't listed goes back to its built-in place.
            if (!v.is_object() || v.size() > hud_elements.size()) throw std::runtime_error("Invalid HUD layout");
            for (const auto &[id, place] : v.items()) {
                if (!hud_elements.contains(id) || !place.is_object() || place.empty()
                    || (web_schema && !defaults.at("hudLayoutWeb").contains(id)))
                    throw std::runtime_error("Invalid HUD layout entry");
                const bool anchored = web_schema || place.contains("a");
                if (web_schema
                    && (!place.contains("on") || !place.contains("a") || !place.contains("x") || !place.contains("y")
                        || !place.contains("s") || place.size() != 5))
                    throw std::runtime_error("Web HUD entries need on, a, x, y and s");
                const std::set<std::string> fields = anchored ? std::set<std::string>{"a", "x", "y", "s", "on"}
                                                              : std::set<std::string>{"x", "y", "scale", "visible"};
                for (const auto &[field, value] : place.items()) {
                    if (!fields.contains(field)) throw std::runtime_error("Unknown HUD layout field");
                    if (field == "on" || field == "visible") {
                        if (!value.is_boolean()) throw std::runtime_error("HUD visibility must be boolean");
                        continue;
                    }
                    if (!value.is_number() || !std::isfinite(value.get<double>()))
                        throw std::runtime_error("HUD layout must be finite");
                    const double number = value.get<double>();
                    if (field == "a" && (number != std::floor(number) || number < 0 || number > 8))
                        throw std::runtime_error("HUD anchor must be 0–8");
                    if ((field == "s" || field == "scale") && (number < .4 || number > 3))
                        throw std::runtime_error("HUD element scale must be .4–3");
                    if ((field == "x" || field == "y")
                        && (number < (anchored ? -2 : 0) || number > (anchored ? 2 : 100)))
                        throw std::runtime_error("HUD position is out of range");
                }
                if (place.contains("x") != place.contains("y") || (anchored && !place.contains("x"))
                    || (!place.contains("x") && !place.contains("visible") && !place.contains("scale")))
                    throw std::runtime_error("HUD position needs both axes");
            }
            if (web_schema && switch_layout && !patch.contains("hudLayout"))
                drop_moved_legacy_places(out["hudLayout"], current.at("hudLayoutWeb"), v);
        } else if (key == "triggersStyle" || key == "audioMusicMode") {
            const auto choices = key == "triggersStyle" ? std::set<std::string>{"filled", "outline", "bottom"}
                                                        : std::set<std::string>{"always", "menus", "off"};
            if (!v.is_string() || !choices.contains(v.get<std::string>()))
                throw std::runtime_error("Unknown setting choice: " + key);
        } else if (key == "hudHiddenKeeps" || key == "hudPlace" || key == "hudStrafeTrainerStyle"
                   || key == "autoRestartWhen" || key == "autoRestartAction") {
            const auto choices = key == "hudHiddenKeeps" ? std::set<std::string>{"speedKeys", "nothing"}
                                 : key == "hudPlace"     ? std::set<std::string>{"off", "place", "top"}
                                 : key == "hudStrafeTrainerStyle"
                                         ? std::set<std::string>{"classic", "detailed", "minimal"}
                                 : key == "autoRestartWhen" ? std::set<std::string>{"off", "pb", "wr", "ghost"}
                                                            : std::set<std::string>{"restart", "sound"};
            if (!v.is_string() || !choices.contains(v.get<std::string>()))
                throw std::runtime_error("Unknown setting choice: " + key);
        } else if (key == "hudKeysPressed" || key == "hudKeysIdle" || key == "hudStrafeTrainerColor"
                   || key.starts_with("triggersColors")) {
            if (!v.is_string()) throw std::runtime_error("Color must be #rrggbb");
            const auto color = v.get<std::string>();
            if (color.size() != 7 || color[0] != '#'
                || !std::all_of(color.begin() + 1, color.end(), [](unsigned char c) { return std::isxdigit(c); }))
                throw std::runtime_error("Color must be #rrggbb");
        } else if (key == "jumpStatsMode") {
            if (!v.is_string()) throw std::runtime_error("Setting must be text: " + key);
            const auto mode = v.get<std::string>();
            if (mode != "sixth" && mode != "every" && mode != "interval")
                throw std::runtime_error("Jump stats mode must be sixth, every or interval");
        } else if (key == "crosshairStyle" || key == "keysStyle" || key == "crosshairColor") {
            if (!v.is_string()) throw std::runtime_error("Setting must be text: " + key);
            const auto choice = v.get<std::string>();
            if (key == "crosshairStyle"
                && !std::set<std::string>{"cross", "cross-dot", "dot", "t", "circle", "none"}.contains(choice))
                throw std::runtime_error("Unknown crosshair style");
            if (key == "keysStyle" && !std::set<std::string>{"classic", "minimal", "keycaps"}.contains(choice))
                throw std::runtime_error("Unknown keys style");
            if (key == "crosshairColor"
                && (choice.size() != 7 || choice[0] != '#'
                    || !std::all_of(choice.begin() + 1, choice.end(), [](unsigned char c) {
                           return std::isxdigit(c);
                       })))
                throw std::runtime_error("Crosshair color must be #rrggbb");
        } else if (key == "playerModel" || key == "ghostModel") {
            if (!v.is_string() || (v != "bunny" && v != "runner" && !(key == "ghostModel" && v == "same")))
                throw std::runtime_error("Unknown player model");
        } else if (key == "colorBlind") {
            if (!v.is_string() || (v != "off" && v != "redGreen" && v != "blueYellow"))
                throw std::runtime_error("Unknown color-blind palette");
        } else if (key == "inputBackend") {
            if (!v.is_string() || (v != "auto" && v != "sdl" && v != "raw"))
                throw std::runtime_error("Invalid input backend");
        } else if (key == "waterQuality") {
            if (!v.is_string() || (v != "simple" && v != "refracted"))
                throw std::runtime_error("Water quality must be simple or refracted");
        } else if (defaults[key].is_string()) {
            // Audio pack choices. Only these two words are ever stored, so the
            // value can never become a path the client would then go looking
            // for: which folder "custom" means is decided by the client alone.
            if (!v.is_string()) throw std::runtime_error("Setting must be text: " + key);
            const auto choice = v.get<std::string>();
            if (choice != "default" && choice != "custom")
                throw std::runtime_error("Audio pack must be default or custom: " + key);
        } else {
            if (!v.is_number() || !std::isfinite(v.get<double>()))
                throw std::runtime_error("Setting must be finite: " + key);
            const auto n = v.get<double>();
            if ((key == "sensitivity" || key == "verticalSensitivity") && (n < .01 || n > 100))
                throw std::runtime_error("Sensitivity must be .01–100");
            if (key == "hudScale" && (n != std::floor(n) || n < 50 || n > 175))
                throw std::runtime_error("HUD scale must be 50–175%");
            if (key == "fov" && (n < 60 || n > 130)) throw std::runtime_error("FOV must be 60–130");
            if (key == "viewmodelFov" && (n < 30 || n > 100)) throw std::runtime_error("Viewmodel FOV must be 30–100");
            if ((key == "viewmodelX" || key == "viewmodelY" || key == "viewmodelZ") && (n < -10 || n > 10))
                throw std::runtime_error("Viewmodel offsets must be -10–10");
            if ((key == "viewmodelBob" || key == "viewmodelSway") && (n < 0 || n > 2))
                throw std::runtime_error("Bob must be 0–2");
            if ((key == "crosshairSize" || key == "crosshairGap") && (n < 0 || n > 40))
                throw std::runtime_error("Crosshair dimensions must be 0–40");
            if (key == "crosshairThickness" && (n < .5 || n > 10))
                throw std::runtime_error("Crosshair thickness must be .5–10");
            if ((key == "volume" || key == "sfxVolume" || key == "musicVolume" || key == "uiVolume"
                 || key == "ambienceVolume" || key == "crosshairAlpha" || key == "ghostOpacity")
                && (n < 0 || n > 1))
                throw std::runtime_error("Volume must be 0–1");
            if (key == "yawSpeed" && (n < 60 || n > 720)) throw std::runtime_error("Yaw speed must be 60–720");
            if (key == "angleSpeedKey" && (n < 1 || n > 4)) throw std::runtime_error("Turn multiplier must be 1–4");
            if (key == "triggersThickness" && (n < 1 || n > 6))
                throw std::runtime_error("Trigger thickness must be 1–6");
            if (key == "triggersOpacity" && (n < 0 || n > 1)) throw std::runtime_error("Trigger opacity must be 0–1");
            if (key == "hudKeysOpacity" && (n < .2 || n > 1)) throw std::runtime_error("Keys opacity must be .2–1");
            if (key == "hudStrafeTrainerZone" && (n != std::floor(n) || n < 2 || n > 30))
                throw std::runtime_error("Trainer zone must be a whole number 2–30");
            if (key == "hudStrafeTrainerHeight" && (n < .5 || n > 3))
                throw std::runtime_error("Trainer height must be .5–3");
            if (key == "hudStrafeTrainerDimBelow" && (n != std::floor(n) || n < 0 || n > 90))
                throw std::runtime_error("Trainer dim threshold must be a whole number 0–90");
            if (key == "strafeTrainerSmoothing" && (n != std::floor(n) || n < 1 || n > 50))
                throw std::runtime_error("Strafe trainer smoothing must be a whole number 1–50");
            if (key == "jumpStatsInterval" && (n != std::floor(n) || n < 2 || n > 50))
                throw std::runtime_error("Jump stats interval must be a whole number 2–50");
            if (key == "fpsLimit" && (n != std::floor(n) || (n != 0 && (n < 30 || n > 1000))))
                throw std::runtime_error("FPS limit must be 0 or 30–1000");
        }
        out[key] = v;
    }
    return out;
}

// The website's viewmodel framing migration (ui/settings.ts migrateViewmodel): a saved framing still equal to the
// default it was saved under is one the player never changed, so it moves to the current default. Any change of theirs
// stays. Either way the file is marked current, so picking the CS:S preset (the old default) later sticks.
inline void migrate_viewmodel(Json &saved) {
    if (!saved.is_object()) return;
    const auto revision = saved.find("viewmodelRev");
    if (revision != saved.end() && revision->is_number() && revision->get<double>() >= viewmodel_revision) return;
    const std::pair<const char *, double> previous[] = {
            {"viewmodelFov", 54}, {"viewmodelX", .6}, {"viewmodelY", 1.5}, {"viewmodelZ", -.9}
    };
    const bool unchanged = std::all_of(std::begin(previous), std::end(previous), [&](const auto &field) {
        return !saved.contains(field.first)
               || (saved[field.first].is_number() && saved[field.first].template get<double>() == field.second);
    });
    if (unchanged)
        for (const auto &field : previous)
            saved.erase(field.first);
    saved["viewmodelRev"] = viewmodel_revision;
}

// New installs start with VSync off and a 1000 FPS cap (lowest input latency; see display_defaults.hpp). A settings
// file from before that keeps what it had: VSync on and no cap were the defaults then.
inline void keep_saved_display(Json &saved) {
    if (!saved.is_object()) {
        return;
    }
    if (!saved.contains("vsync")) {
        saved["vsync"] = true;
    }
    if (!saved.contains("fpsLimit")) {
        saved["fpsLimit"] = 0;
    }
}

inline void backup_settings(const std::filesystem::path &file) {
    auto previous = file;
    previous += ".previous";
    std::filesystem::copy_file(file, previous, std::filesystem::copy_options::overwrite_existing);
}

inline Json load_settings(const std::filesystem::path &file) {
    auto out = default_settings();
    if (!std::filesystem::exists(file)) return out;
    Json saved;
    try {
        constexpr size_t settings_max_bytes = 64 * 1024;
        std::ifstream stream(file, std::ios::binary);
        std::string bytes(settings_max_bytes + 1, '\0');
        stream.read(bytes.data(), bytes.size());
        if (stream.bad() || (!stream.eof() && stream.fail())) throw std::runtime_error("Could not read settings");
        bytes.resize(static_cast<size_t>(stream.gcount()));
        if (bytes.size() > settings_max_bytes) throw std::runtime_error("Settings file is too large");
        saved = Json::parse(bytes);
        if (!saved.is_object()) throw std::runtime_error("Invalid settings object");
    } catch (...) {
        backup_settings(file);
        throw;
    }
    if (!saved.contains("clipsVisible") && saved.value("triggersVisible", Json(false)) == true)
        saved["clipsVisible"] = true;
    if (saved.contains("yawSpeedAlt") && saved["yawSpeedAlt"].is_number()) {
        const auto speed = saved.value("yawSpeed", Json(210.0));
        const double alternate = saved["yawSpeedAlt"].get<double>();
        if (speed.is_number() && std::isfinite(speed.get<double>()) && speed.get<double>() > 0) {
            if (!saved.contains("angleSpeedKey") && std::isfinite(alternate))
                saved["angleSpeedKey"] = std::clamp(alternate / speed.get<double>(), 1.0, 4.0);
            saved["yawSpeed"] = std::clamp(speed.get<double>(), 60.0, 720.0);
        }
        saved.erase("yawSpeedAlt");
    }
#if __has_include("graphics_settings.hpp")
    migrate_retired_models(saved);
#endif
    keep_saved_display(saved);
    migrate_viewmodel(saved);
    bool backed_up = false;
    for (auto entry = saved.begin(); entry != saved.end(); ++entry) {
        if (entry.key() == "binds" && entry->is_object()) {
            for (auto bind = entry->begin(); bind != entry->end(); ++bind) {
                try {
                    out = patch_settings(out, {{"binds", {{bind.key(), bind.value()}}}});
                } catch (const std::exception &error) {
                    if (!backed_up) backup_settings(file);
                    backed_up = true;
                    std::cerr << "Ignoring binding " << bind.key() << ": " << error.what() << '\n';
                }
            }
            continue;
        }
        try {
            out = patch_settings(out, {{entry.key(), entry.value()}}, false);
        } catch (const std::exception &error) {
            if (!backed_up) backup_settings(file);
            backed_up = true;
            std::cerr << "Ignoring setting " << entry.key() << ": " << error.what() << '\n';
        }
    }
    return out;
}

inline void save_settings(const std::filesystem::path &file, const Json &settings) {
    atomic_write_file(file, settings.dump(2) + '\n');
}
}  // namespace native
