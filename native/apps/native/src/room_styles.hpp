#pragma once
#include <array>
#include <string_view>

namespace native {

// A style as rooms name it (web styles.ts STYLES), in the website's wire order (protocol.ts WIRE_STYLES: frozen, only
// appended to). Rooms relay every player's style, including ones this build can't play yet: those are shown and
// decoded, never selected.
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
        {"backwards", "Backwards", "BW", false},
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

}  // namespace native
