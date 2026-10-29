#pragma once
#include "hud_geometry.hpp"
#include "settings.hpp"
#include <optional>

namespace native {
using HudLayoutPlaces = std::array<std::optional<HudPlace>, hud_ids.size()>;

// The website's layout comes with every element placed for the website's HUD. An entry still at that default
// leaves the element at the native HUD's own place; one the player moved (an editor, a preset, a layout code)
// is drawn where they put it.
inline bool web_place_moved(const Json &entry, const Json &fallback) {
    constexpr double same_place_tolerance = 1e-6;
    for (const char *field : {"a", "x", "y"}) {
        const double value = entry.value(field, 0.);
        if (std::abs(value - fallback.value(field, 0.)) > same_place_tolerance) return true;
    }
    return false;
}

inline HudPlace web_hud_place(const Json &entry, const Json &defaults, std::string_view id) {
    HudPlace place;
    place.anchored = true;
    place.anchor = entry.value("a", 0u);
    place.x = entry.value("x", 0.f);
    place.y = entry.value("y", 0.f);
    place.visible = entry.value("on", true);
    place.scale = entry.value("s", 1.f);
    const auto fallback = defaults.find(std::string(id));
    place.placed = fallback == defaults.end() || web_place_moved(entry, *fallback);
    // The website's defaults shrink a few elements to suit its own column; at the native place 1 is that size.
    if (!place.placed) place.scale /= std::max(.1f, fallback->value("s", 1.f));
    return place;
}

// hudLayout: v0.5.1's percent places ({x, y} is the element's own point) and anchored entries an older menu wrote.
// It wins over hudLayoutWeb, so a placement made in v0.5.1 stays where it was.
inline void merge_legacy_place(std::optional<HudPlace> &slot, const Json &entry) {
    HudPlace place = slot.value_or(HudPlace{false, false, 0, 0, 0, 1, false});
    const bool anchored = entry.contains("a");
    if (entry.contains("x") && entry.contains("y")) {
        place.anchored = anchored;
        place.anchor = entry.value("a", 0u);
        place.x = entry.at("x");
        place.y = entry.at("y");
        place.placed = true;
    }
    place.visible = entry.value(anchored ? "on" : "visible", slot ? place.visible : true);
    place.scale = entry.value(anchored ? "s" : "scale", place.scale);
    slot = place;
}

inline HudLayoutPlaces read_hud_layout(const Json &settings) {
    static const Json web_defaults = default_hud_layout_web();
    HudLayoutPlaces layout;
    for (const auto &[id, entry] : settings.at("hudLayoutWeb").items())
        layout[hud_index(id)] = web_hud_place(entry, web_defaults, id);
    for (const auto &[id, entry] : settings.at("hudLayout").items())
        merge_legacy_place(layout[hud_index(id)], entry);
    return layout;
}

// v0.5.1's key overlay label for a bind: the key's own name, short.
inline std::string hud_key_label(std::string_view code) {
    if (code.empty()) return "-";
    if (code.starts_with("Key")) return std::string(code.substr(3));
    if (code.starts_with("Digit")) return std::string(code.substr(5));
    if (code.starts_with("Control")) return "CTRL";
    if (code.starts_with("Shift")) return "SHIFT";
    if (code.starts_with("Alt")) return "ALT";
    if (code == "Space") return "SPACE";
    if (code == "MouseWheel" || code == "MWheelUp" || code == "MWheelDown") return "WHEEL";
    if (code.starts_with("Mouse")) return "M" + std::string(code.substr(5));
    if (code.starts_with("Arrow")) return std::string(code.substr(5));
    return std::string(code);
}

// Elements whose point is their horizontal centre; the others start at their left edge.
inline bool hud_centred(std::string_view id) {
    id = canonical_hud_id(id);
    return id != "map" && id != "fps" && id != "pb" && id != "keys" && id != "health" && id != "speedGraph"
           && id != "spectators" && id != "chat";
}
}  // namespace native
