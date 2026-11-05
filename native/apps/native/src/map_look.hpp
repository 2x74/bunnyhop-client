#pragma once
// Brightness and Fullbright per map, as the website keeps them (web map-look.ts): the `mapLooks` setting maps a map's
// name to what was set for it alone ({"brightness": 1.3} or {"fullbright": true}), and anything a map doesn't set
// follows Settings → Graphics. !bright, !fb and the pause menu's On screen tab change them. The look applies to play
// and replays on that map; the home screen and video exports keep the global values.
#include <nlohmann/json.hpp>
#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <optional>
#include <string>
#include <string_view>

namespace native {

inline constexpr std::string_view map_looks_key = "mapLooks";
// Settings → Graphics → Brightness's range and step (web VIDEO_LIMITS.brightness, map-look.ts BRIGHTNESS_STEP).
inline constexpr double map_brightness_min = .5;
inline constexpr double map_brightness_max = 2;
inline constexpr double map_brightness_step = .05;
// The menu keeps the 200 most recently changed maps (MAP_LOOK_CAP). The host's own changes can add one before the
// menu trims, so it holds a few more and never more than this.
inline constexpr size_t map_looks_host_cap = 256;

struct MapLook {
    std::optional<double> brightness;
    std::optional<bool> fullbright;
};

// The website's map name rule (map-look.ts validMapName).
inline bool valid_look_map_name(std::string_view name) {
    constexpr size_t name_max_bytes = 64;
    constexpr std::array<std::string_view, 3> reserved = {"__proto__", "constructor", "prototype"};
    if (name.empty() || name.size() > name_max_bytes) return false;
    if (std::find(reserved.begin(), reserved.end(), name) != reserved.end()) return false;
    return std::all_of(name.begin(), name.end(), [](unsigned char c) {
        return std::isalnum(c) || c == '_' || c == '.' || c == '+' || c == '-';
    });
}

// Inside the slider's range, to the hundredth so steps don't drift (map-look.ts clampBrightness).
inline double clamp_map_brightness(double value) {
    constexpr double hundredths = 100;
    return std::round(std::clamp(value, map_brightness_min, map_brightness_max) * hundredths) / hundredths;
}

inline MapLook read_map_look(const nlohmann::json &entry) {
    MapLook look;
    if (!entry.is_object()) return look;
    const auto brightness = entry.find("brightness");
    if (brightness != entry.end() && brightness->is_number() && std::isfinite(brightness->get<double>()))
        look.brightness = clamp_map_brightness(brightness->get<double>());
    const auto fullbright = entry.find("fullbright");
    if (fullbright != entry.end() && fullbright->is_boolean()) look.fullbright = fullbright->get<bool>();
    return look;
}

inline nlohmann::json map_look_json(const MapLook &look) {
    auto entry = nlohmann::json::object();
    if (look.brightness) entry["brightness"] = *look.brightness;
    if (look.fullbright) entry["fullbright"] = *look.fullbright;
    return entry;
}

// Saved or sent overrides, cleaned like the website's sanitizeMapLooks: valid names and values only. Never throws: a
// bad entry is dropped and the rest are kept.
inline nlohmann::json clean_map_looks(const nlohmann::json &raw) {
    auto out = nlohmann::json::object();
    if (!raw.is_object()) return out;
    for (const auto &[name, entry] : raw.items()) {
        if (out.size() == map_looks_host_cap) break;
        if (!valid_look_map_name(name)) continue;
        const auto cleaned = map_look_json(read_map_look(entry));
        if (!cleaned.empty()) out[name] = cleaned;
    }
    return out;
}

// What `map` has set for itself in `settings` (nothing for an empty name: the home screen).
inline MapLook map_look_for(const nlohmann::json &settings, std::string_view map) {
    if (map.empty()) return {};
    const auto looks = settings.find(map_looks_key);
    if (looks == settings.end() || !looks->is_object()) return {};
    const auto entry = looks->find(std::string(map));
    return entry == looks->end() ? MapLook{} : read_map_look(*entry);
}

}  // namespace native
