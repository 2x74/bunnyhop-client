#pragma once
#include <array>
#include <cstdint>
#include <string_view>

namespace native {
// A supporter's name font (web supporter-looks.ts NAME_FONTS). The room, chat lines and the menu's name looks carry
// the id; anything else, or no id, is the default font.
enum class NameFont : uint8_t { none, grotesk, round, pixel, mono, serif, wide, marker, block, script };

inline constexpr std::array<std::string_view, 9> name_font_ids = {
        "grotesk", "round", "pixel", "mono", "serif", "wide", "marker", "block", "script"
};

constexpr NameFont name_font_of(std::string_view id) {
    for (size_t i = 0; i < name_font_ids.size(); ++i) {
        if (name_font_ids[i] == id) return NameFont(i + 1);
    }
    return NameFont::none;
}
}  // namespace native
