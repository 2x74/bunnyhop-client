#pragma once
#include "semantic_palette.hpp"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <array>
#include <map>
#include <optional>
#include <string>

namespace native {

// The part of the player's Custom CSS the native HUD can draw: the documented
// colour variables and, per HUD element, a text colour and an opacity. The
// menu resolves the CSS (custom-css-hud.ts) and sends plain RGBA values; this
// is parsed once when they change, never per frame.
using HudColor = std::array<float, 4>;

struct HudElementStyle {
    std::optional<HudColor> color;
    float opacity = 1;
};

struct HudTheme {
    std::optional<HudColor> text;       // --cream
    std::optional<HudColor> secondary;  // --cream-2
    std::optional<HudColor> accent;     // --amber
    std::optional<HudColor> gain;       // --gain
    std::optional<HudColor> loss;       // --loss
    std::optional<HudColor> sync;       // --sync-ok
    std::map<std::string, HudElementStyle> elements;

    // Speed and gain colours on top of the colour-blind palette.
    void apply(SemanticPalette& palette) const {
        if (gain)
            palette.gain = *gain;
        if (loss)
            palette.loss = *loss;
        if (sync)
            palette.sync = *sync;
    }

    const HudElementStyle* element(const std::string& id) const {
        const auto found = elements.find(id);
        return found == elements.end() ? nullptr : &found->second;
    }
};

// The native element ids a theme may style (hud.hpp `at(...)` names).
inline bool hud_theme_element(const std::string& id) {
    static const char* const ids[] = {"map", "fps", "timer", "speed", "runStats", "jumpStats", "strafeTrainer",
                                      "status", "keys", "health", "splits", "speedGraph"};
    for (const char* known : ids) {
        if (id == known)
            return true;
    }
    return false;
}

// [r, g, b, a] with each part in 0..1.
inline std::optional<HudColor> parse_hud_color(const nlohmann::json& value) {
    if (!value.is_array() || value.size() != 4)
        return std::nullopt;
    HudColor color{};
    for (std::size_t i = 0; i < 4; ++i) {
        if (!value[i].is_number())
            return std::nullopt;
        const double part = value[i].get<double>();
        if (!(part >= 0 && part <= 1))
            return std::nullopt;
        color[i] = float(part);
    }
    return color;
}

// {colors: {text, secondary, accent, gain, loss, sync}, elements: {id: {color?, opacity?}}}.
// Unknown or malformed entries are ignored; an empty object is the default HUD.
inline HudTheme parse_hud_theme(const nlohmann::json& value) {
    HudTheme theme;
    if (!value.is_object())
        return theme;
    const auto colors = value.value("colors", nlohmann::json::object());
    if (colors.is_object()) {
        const auto read = [&](const char* key) {
            return colors.contains(key) ? parse_hud_color(colors[key]) : std::nullopt;
        };
        theme.text = read("text");
        theme.secondary = read("secondary");
        theme.accent = read("accent");
        theme.gain = read("gain");
        theme.loss = read("loss");
        theme.sync = read("sync");
    }
    const auto elements = value.value("elements", nlohmann::json::object());
    if (!elements.is_object())
        return theme;
    for (const auto& [id, style] : elements.items()) {
        if (!hud_theme_element(id) || !style.is_object())
            continue;
        HudElementStyle parsed;
        if (style.contains("color"))
            parsed.color = parse_hud_color(style["color"]);
        if (style.contains("opacity") && style["opacity"].is_number())
            parsed.opacity = std::clamp(style["opacity"].get<float>(), 0.f, 1.f);
        theme.elements[id] = parsed;
    }
    return theme;
}

}
