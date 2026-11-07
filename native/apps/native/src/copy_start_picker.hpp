#pragma once
#include "hud_scoreboard.hpp"
#include "menu_rows.hpp"
#include <array>
#include <optional>
#include <string_view>

namespace native {
class CopyStartPicker {
    static constexpr size_t page_size = 8, maximum_choices = 65;
    std::array<unsigned, maximum_choices> slots_{};
    std::array<HudLabel<128>, maximum_choices> names_;
    size_t count_ = 0, page_ = 0;
    bool open_ = false;

public:
    bool open() const { return open_; }

    void close() { open_ = false; }

    void show(const HudScoreboard &board) {
        count_ = 1;
        page_ = 0;
        names_[0].assign("World record");
        slots_[0] = 256;
        for (size_t i = 0; i < board.count && count_ < maximum_choices; ++i) {
            if (board.rows[i].you) continue;
            names_[count_].assign(board.rows[i].name);
            slots_[count_++] = board.rows[i].slot;
        }
        open_ = true;
    }

    struct Pick {
        bool handled = false, chosen = false;
        std::optional<unsigned> slot;
    };

    Pick key(std::string_view code, bool down, bool repeat) {
        if (!open_ || !down || repeat || code.size() != 6 || !code.starts_with("Digit")) return {};
        const auto digit = unsigned(code.back() - '0');
        Pick pick{true, false, {}};
        if (!digit)
            close();
        else if (digit == 9 && count_ > page_size)
            page_ = (page_ + 1) % ((count_ + page_size - 1) / page_size);
        else if (digit <= page_size && page_ * page_size + digit - 1 < count_) {
            const auto slot = slots_[page_ * page_size + digit - 1];
            pick.chosen = true;
            if (slot != 256) pick.slot = slot;
            close();
        }
        return pick;
    }

    MenuRows rows(int width, int height, float percent) const {
        constexpr float panel_width = 440, first_row = 52, row_height = 28, footer_height = 30;
        const auto shown = std::min(page_size, count_ - page_ * page_size);
        const HudGeometry geometry(width, height, percent);
        MenuRows rows;
        rows.width = panel_width;
        rows.height = first_row + float(shown + (count_ > page_size ? 1 : 0)) * row_height + footer_height;
        rows.left = geometry.width / 2 - panel_width / 2;
        rows.top = geometry.height / 2 - rows.height / 2;
        for (size_t i = 0; i < shown; ++i)
            rows.add(unsigned(i + 1), rows.top + first_row + float(i) * row_height, row_height);
        if (count_ > page_size) rows.add(9, rows.top + first_row + float(shown) * row_height, row_height);
        rows.add(0, rows.top + rows.height - footer_height, footer_height);
        return rows;
    }

    template <class Hud>
    void draw(Hud &hud, int width, int height, float percent, std::optional<std::array<float, 2>> pointer) const {
        if (!open_) return;
        constexpr NameColor cream = {.94f, .91f, .86f, 1}, dim = {.63f, .65f, .70f, 1}, amber = {1, .71f, .24f, 1};
        const auto layout = rows(width, height, percent);
        hud.overlay_begin(width, height, percent);
        hud.overlay_rect(layout.left, layout.top, layout.width, layout.height, {.025f, .027f, .04f, .96f});
        draw_menu_hover(hud, layout, layout.hovered(pointer));
        hud.overlay_text(layout.left + 18, layout.top + 16, "Copy start", 20, amber);
        HudLabel<160> label;
        for (size_t i = 0; i < layout.count; ++i) {
            const auto &row = layout.rows[i];
            if (!row.digit)
                label.assign("0. Close");
            else if (row.digit == 9)
                label.assign("9. More");
            else {
                const auto name = names_[page_ * page_size + row.digit - 1].view();
                label.format("%u. %.*s", row.digit, int(name.size()), name.data());
            }
            hud.overlay_text(layout.left + 18, row.top + 6, label.view(), row.digit ? 14 : 12, row.digit ? cream : dim);
        }
        hud.overlay_end(width, height);
    }
};
}  // namespace native
