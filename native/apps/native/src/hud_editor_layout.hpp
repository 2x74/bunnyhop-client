#pragma once
#include "hud_layout.hpp"
#include "hud_layout_code.hpp"
#include <cmath>
#include <optional>
#include <string_view>

namespace native {
// What the HUD layout editor can move. Website elements are stored in hudLayoutWeb, so a layout code from the
// website lands in the same places; the native-only ones are anchored entries in hudLayout.
struct HudEditorElement {
    std::string_view id;
    std::string_view label;
    bool web;
};

inline constexpr std::array<HudEditorElement, 28> hud_editor_elements = {{
        {"map", "Map / style", true},
        {"fps", "FPS", true},
        {"pb", "Personal best", true},
        {"timer", "Timer", true},
        {"status", "Run status", false},
        {"speed", "Speed", true},
        {"stats", "Run stats", true},
        {"jumpStats", "Jump stats", true},
        {"strafeTrainer", "Strafe trainer", true},
        {"split", "Split vs PB", true},
        {"keys", "Keys", true},
        {"ammo", "Health / ammo", true},
        {"graph", "Speed graph", true},
        {"chat", "Chat", true},
        {"spectators", "Spectators", true},
        {"notice", "Notices", false},
        {"replay", "Replay banner", false},
        {"track", "Bonus / track", true},
        {"stage", "Stage / CP", true},
        {"sync", "Sync bar", true},
        {"startPre", "Start Pre", true},
        {"strafeOffsets", "Strafe offsets", true},
        {"firstJump", "First jump tick", true},
        {"longJump", "Longjump stats", true},
        {"ghostKeys", "Ghost keys", true},
        {"practice", "Practice", true},
        {"jhud", "JHUD", true},
        {"ghostSpeed", "Speed vs ghost", true},
}};

// Website elements whose switch is also a setting of its own (the menu keeps the two in step the same way).
inline const char *hud_element_setting(std::string_view id) {
    if (id == "keys") return "keysOverlay";
    if (id == "graph") return "speedGraph";
    if (id == "jumpStats") return "jumpStats";
    if (id == "strafeTrainer") return "strafeTrainer";
    return nullptr;
}

// The website's placeFromRect (hud/layout.ts): the 9-grid cell holding the box's centre is the anchor, and the
// matching point of the box is stored as an offset from that screen point, in fractions of the screen.
inline Json hud_place_from_box(const HudRect &box, float screen_width, float screen_height, bool on, double scale) {
    constexpr double fraction_digits = 10000;
    const float centre_x = box.x + box.width / 2, centre_y = box.y + box.height / 2;
    const int column = centre_x < screen_width / 3 ? 0 : centre_x < 2 * screen_width / 3 ? 1 : 2;
    const int row = centre_y < screen_height / 3 ? 0 : centre_y < 2 * screen_height / 3 ? 1 : 2;
    const double point_x = box.x + column / 2. * box.width, point_y = box.y + row / 2. * box.height;
    const auto round = [](double value) {
        return std::round(value * fraction_digits) / fraction_digits;
    };
    return {{"on", on},
            {"a", row * 3 + column},
            {"x", round((point_x - column / 2. * screen_width) / screen_width)},
            {"y", round((point_y - row / 2. * screen_height) / screen_height)},
            {"s", std::round(std::clamp(scale, .4, 3.) * 100) / 100}};
}

// The website editor's snapping (hud/editor.ts): the box's centre to the screen's centre lines when within `snap`,
// otherwise its anchor-side edge to a `grid` measured from its anchor point. Sizes are pixels.
struct HudSnap {
    HudRect box;
    bool vertical_guide = false;
    bool horizontal_guide = false;
};

inline float snap_axis(float start, float size, float screen, float grid, float snap, bool &guide) {
    const float centre = start + size / 2;
    if (std::abs(centre - screen / 2) < snap) {
        guide = true;
        return screen / 2 - size / 2;
    }
    const int cell = centre < screen / 3 ? 0 : centre < 2 * screen / 3 ? 1 : 2;
    const float point = start + cell / 2.f * size - cell / 2.f * screen;
    return start + std::round(point / grid) * grid - point;
}

inline HudSnap snap_box(HudRect box, float screen_width, float screen_height, float grid, float snap) {
    HudSnap result{box};
    result.box.x = snap_axis(box.x, box.width, screen_width, grid, snap, result.vertical_guide);
    result.box.y = snap_axis(box.y, box.height, screen_height, grid, snap, result.horizontal_guide);
    return result;
}

// Native presets, tuned for the native HUD's element sizes, as a settings patch. Classic centred is the built-in
// layout (v0.5.1's places): the website's default entries, which hud_layout.hpp reads as "at the native place".
inline Json hud_preset(std::string_view id, const Json &settings = default_settings()) {
    auto layout = default_hud_layout_web();
    Json native = Json::object();
    const auto set = [&](const char *element, unsigned anchor, double x, double y, double scale = 1) {
        layout[element] = {{"on", layout[element].value("on", true)}, {"a", anchor}, {"x", x}, {"y", y}, {"s", scale}};
    };
    // The run status has no website entry; it is placed with the native layout.
    const auto status = [&](unsigned anchor, double x, double y) {
        native["status"] = {{"on", true}, {"a", anchor}, {"x", x}, {"y", y}, {"s", 1}};
    };
    if (id == "minimal") {
        // One small column under the crosshair, with what sits beside the timer and speed beside them here too.
        set("speed", 4, 0, .09, .85);
        set("startPre", 4, -.1, .09, .85);
        set("timer", 4, 0, .135, .8);
        set("stage", 4, -.1, .135, .85);
        status(4, .1, .135);
        set("ghostSpeed", 4, .1, .09, .85);
        set("split", 4, 0, .195, .8);
        set("jumpStats", 4, 0, .27, .9);
        set("jhud", 4, 0, -.06, .85);
        set("stats", 7, 0, -.06, .9);
        set("sync", 7, 0, -.035);
        set("strafeTrainer", 1, 0, .2);
        for (const char *hidden : {"keys", "map", "pb"})
            layout[hidden]["on"] = false;
    } else if (id == "streamer") {
        set("speed", 7, 0, -.15, 1.25);
        set("ghostSpeed", 7, .12, -.15, 1.05);
        set("timer", 7, 0, -.075, 1.2);
        set("stats", 7, 0, -.02);
        set("sync", 7, 0, -.045);
        set("split", 1, 0, .12);
        set("keys", 6, .02, -.04, 1.25);
        set("graph", 8, -.02, -.04, 1.2);
        set("ammo", 8, -.02, -.17, 1.1);
        set("jumpStats", 5, -.02, 0, 1.1);
        set("map", 0, .012, .016, 1.1);
        set("fps", 2, -.012, .02);
        set("pb", 2, -.012, .05, 1.2);
        set("chat", 3, .015, .12);
        set("spectators", 3, .015, -.14);
        status(7, 0, -.21);
        for (const char *shown : {"keys", "graph", "fps", "sync"})
            layout[shown]["on"] = true;
    }
    layout["strafeTrainer"]["on"] = strafe_trainer_enabled(settings);
    // Like the website's personal elements, these keep their switch: a preset doesn't turn them off behind your back.
    const auto &current = settings.at("hudLayoutWeb");
    for (const char *personal : {"jhud", "ghostSpeed"}) {
        if (current.contains(personal)) layout[personal]["on"] = current.at(personal).value("on", false);
    }
    return {{"hudLayoutWeb", std::move(layout)}, {"hudLayout", std::move(native)}};
}

inline constexpr std::array<std::string_view, 3> hud_preset_ids = {"classic", "minimal", "streamer"};
inline constexpr std::array<std::string_view, 3> hud_preset_labels = {"Classic centred", "Minimal", "Streamer"};

// Whether the layout is exactly preset `id` (the editor marks it).
inline bool hud_layout_is_preset(const Json &settings, std::string_view id) {
    const auto preset = hud_preset(id, settings);
    return settings.at("hudLayoutWeb") == preset.at("hudLayoutWeb")
           && settings.at("hudLayout") == preset.at("hudLayout");
}
}  // namespace native
