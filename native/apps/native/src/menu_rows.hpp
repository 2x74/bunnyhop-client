#pragma once
// Where a numbered menu's panel and rows are, in HUD units. A menu a chat line opened keeps the cursor out, and its
// rows take clicks as their digits do (web net/hud.ts NumberMenu); the row under the cursor is lit.
#include "name_tags.hpp"
#include <array>
#include <cstddef>
#include <optional>

namespace native {

struct MenuRow {
    unsigned digit = 0;
    float top = 0;
    float height = 0;
};

struct MenuRows {
    float left = 0;
    float top = 0;
    float width = 0;
    float height = 0;
    std::array<MenuRow, 12> rows{};
    size_t count = 0;

    void add(unsigned digit, float row_top, float row_height) {
        if (count < rows.size()) rows[count++] = {digit, row_top, row_height};
    }

    bool contains(float x, float y) const { return x >= left && x < left + width && y >= top && y < top + height; }

    // The digit of the row at (x, y), or nothing outside the rows.
    std::optional<unsigned> digit_at(float x, float y) const {
        if (x < left || x >= left + width) return std::nullopt;
        for (size_t i = 0; i < count; ++i)
            if (y >= rows[i].top && y < rows[i].top + rows[i].height) return rows[i].digit;
        return std::nullopt;
    }

    std::optional<unsigned> hovered(std::optional<std::array<float, 2>> pointer) const {
        return pointer ? digit_at((*pointer)[0], (*pointer)[1]) : std::nullopt;
    }
};

// The light behind the row under the cursor.
template <class Hud>
void draw_menu_hover(Hud &hud, const MenuRows &rows, std::optional<unsigned> hover) {
    constexpr float inset = 6;
    constexpr NameColor hover_wash = {1, 1, 1, .07f};
    if (!hover) return;
    for (size_t i = 0; i < rows.count; ++i) {
        const auto &row = rows.rows[i];
        if (row.digit == *hover)
            hud.overlay_rect(rows.left + inset, row.top, rows.width - inset * 2, row.height, hover_wash);
    }
}

}  // namespace native
