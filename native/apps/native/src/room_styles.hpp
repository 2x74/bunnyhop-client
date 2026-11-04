#pragma once
#include <algorithm>
#include <array>
#include <string_view>

namespace native {

// A style as rooms name it (web styles.ts STYLES), in the website's wire order (protocol.ts WIRE_STYLES: frozen, only
// appended to). Rooms relay every player's style, including ones a build can't play yet: those are shown and decoded,
// never selected.
struct WireStyle {
    std::string_view id;
    std::string_view name;
    std::string_view short_name;
    bool playable;
};

inline constexpr std::array<WireStyle, 11> wire_styles = {{
        {"autohop", "Normal", "NM", true},
        {"legit", "EZ Scroll", "EZ", true},
        {"wonly", "W-Only", "W", true},
        {"sideways", "Sideways", "SW", true},
        {"hsw", "Half-Sideways", "HSW", true},
        {"autostrafe", "Auto-strafe", "AS", true},
        {"scroll", "Legit Scroll", "SCR", true},
        {"lowgrav", "Low Gravity", "LG", true},
        {"segmented", "Segmented", "SEG", true},
        {"infinite", "Infinite", "INF", true},
        {"backwards", "Backwards", "BW", true},
}};

inline const WireStyle *wire_style_at(unsigned index) {
    return index < wire_styles.size() ? &wire_styles[index] : nullptr;
}

inline const WireStyle *wire_style(std::string_view id) {
    for (const auto &style : wire_styles)
        if (style.id == id) return &style;
    return nullptr;
}

// The display name; a style this build doesn't know reads as its id.
inline std::string_view wire_style_name(std::string_view id) {
    const auto *style = wire_style(id);
    return style ? style->name : id;
}

inline bool wire_style_playable(std::string_view id) {
    const auto *style = wire_style(id);
    return style && style->playable;
}

// The website's menu order (styles.ts STYLE_DEFS), which the style list and F3 follow: assisted styles last.
inline constexpr std::array<std::string_view, 11> menu_styles = {
        "autohop",
        "legit",
        "scroll",
        "wonly",
        "sideways",
        "hsw",
        "backwards",
        "lowgrav",
        "segmented",
        "infinite",
        "autostrafe",
};

// F3: the style after |id| in menu order. A style not in the list goes back to the first.
inline std::string_view next_menu_style(std::string_view id) {
    const auto at = std::find(menu_styles.begin(), menu_styles.end(), id);
    if (at == menu_styles.end()) return menu_styles.front();
    const auto next = at + 1;
    return next == menu_styles.end() ? menu_styles.front() : *next;
}

// The race picker's styles (web net/race.ts): every style but Segmented, since a race is decided by real time since GO
// and checkpoint loads rewind the run's clock.
inline constexpr std::array<std::string_view, 10> race_styles = {
        "autohop",
        "legit",
        "scroll",
        "wonly",
        "sideways",
        "hsw",
        "backwards",
        "lowgrav",
        "infinite",
        "autostrafe",
};

}  // namespace native
