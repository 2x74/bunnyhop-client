#pragma once
// Two small HUD elements the website has: the JHUD (layout id "jhud") and the speed against the race ghost (layout id
// "ghostSpeed"). Each keeps its text ready and changes it only when a new value comes in, so a frame only draws it.
#include "closest_pos.hpp"
#include "jhud.hpp"
#include "semantic_palette.hpp"
#include <array>
#include <cmath>
#include <cstdint>
#include <optional>
#include <string_view>

namespace native {

/** The last jump, up until the next one or for jhud_hold_seconds of game time: a slowed replay holds it longer too. */
class JhudReadout {
public:
    void configure(const JhudPrefs &prefs) {
        if (prefs == prefs_) return;
        prefs_ = prefs;
        rebuild();
    }

    void show(const JhudReport &report, uint32_t tick, double tick_interval) {
        report_ = report;
        until_tick_ = tick + uint32_t(std::ceil(jhud_hold_seconds / tick_interval));
        rebuild();
    }

    void clear() { report_.reset(); }

    void expire(uint32_t tick) {
        if (report_ && tick >= until_tick_) report_.reset();
    }

    bool shown() const { return report_ && (!prefs_.cutoff || report_->jump <= prefs_.cutoff); }

    const JhudLines &lines() const { return lines_; }

    const SemanticColor &color() const { return color_; }

private:
    void rebuild() {
        if (!report_) return;
        lines_ = jhud_lines(*report_, prefs_);
        color_ = prefs_.colors[size_t(jhud_band(*report_, prefs_.speed_colors))];
    }

    std::optional<JhudReport> report_;
    JhudPrefs prefs_;
    JhudLines lines_;
    SemanticColor color_{};
    uint32_t until_tick_ = 0;
};

/** The speed difference as whole units: the text is made only when that number changes. */
class GhostSpeedReadout {
public:
    void show(std::optional<double> speed_difference) {
        if (!speed_difference) {
            shown_.reset();
            return;
        }
        const int rounded = round_speed_diff(*speed_difference);
        if (shown_ == rounded) return;
        shown_ = rounded;
        text_ = speed_diff_text(rounded);
    }

    bool shown() const { return shown_.has_value(); }

    int value() const { return shown_.value_or(0); }

    std::string_view text() const { return text_.view(); }

private:
    std::optional<int> shown_;
    HudLabel<16> text_;
};

// The analyzer's arrow as solid rows, centred on `centre_x`, its point down or up.
template <class Hud>
void draw_jhud_arrow_rows(
        Hud &hud, float centre_x, float top, float widest, bool point_down, const std::array<float, 4> &color
) {
    constexpr int rows = 7;
    constexpr float row_height = 1.2f;
    for (int row = 0; row < rows; ++row) {
        const int from_point = point_down ? rows - 1 - row : row;
        const float width = widest * float(from_point + 1) / rows;
        hud.overlay_rect(centre_x - width / 2, top + float(row) * row_height, width, row_height, color);
    }
}

// In one character cell of the line beside it, with the shadow the text has.
template <class Hud>
void draw_jhud_arrow(
        Hud &hud, float cell_left, float top, float font_size, bool point_down, const SemanticColor &color
) {
    constexpr float text_middle_per_size = .65f;
    constexpr float half_arrow_height = 4.2f;
    constexpr float widest_of_cell = .9f;
    constexpr std::array<float, 4> shadow = {0, 0, 0, .85f};
    const float cell = hud.overlay_text_width("0", font_size);
    const float centre_x = cell_left + cell / 2;
    const float rows_top = top + font_size * text_middle_per_size - half_arrow_height;
    draw_jhud_arrow_rows(hud, centre_x + 1, rows_top + 1, cell * widest_of_cell, point_down, shadow);
    draw_jhud_arrow_rows(hud, centre_x, rows_top, cell * widest_of_cell, point_down, color);
}

// Two centred lines, the whole readout in one colour. The arrow takes the two cells it and its space do on the website.
template <class Hud>
void draw_jhud(Hud &hud, float x, float y, const JhudReadout &readout) {
    constexpr float font_size = 17;
    constexpr float line_gap = 21;
    constexpr float arrow_cells = 2;
    const auto &lines = readout.lines();
    const auto &color = readout.color();
    hud.overlay_text(x, y, lines.top.view(), font_size, color, true);
    if (lines.bottom.empty()) return;
    const float below = y + line_gap;
    if (lines.arrow == JhudArrow::none) {
        hud.overlay_text(x, below, lines.bottom.view(), font_size, color, true);
        return;
    }
    const float cell = hud.overlay_text_width("0", font_size);
    const float text_width = hud.overlay_text_width(lines.bottom.view(), font_size);
    const float left = x - (text_width + arrow_cells * cell) / 2;
    if (lines.arrow == JhudArrow::too_fast) {
        draw_jhud_arrow(hud, left, below, font_size, true, color);
        hud.overlay_text(left + arrow_cells * cell, below, lines.bottom.view(), font_size, color, false);
    } else {
        hud.overlay_text(left, below, lines.bottom.view(), font_size, color, false);
        draw_jhud_arrow(hud, left + text_width + cell, below, font_size, false, color);
    }
}

// "+42 u/s" beside the speed: the number in gain or loss colour, the unit small and fainter.
template <class Hud>
void draw_ghost_speed(Hud &hud, float x, float y, const GhostSpeedReadout &readout, const SemanticPalette &palette) {
    constexpr float number_size = 16;
    constexpr float unit_size = 11;
    constexpr float unit_lower = 4;
    constexpr float element_alpha = .85f;
    constexpr float unit_alpha = .6f;
    constexpr std::string_view unit = " u/s";
    SemanticColor color = readout.value() > 0   ? palette.gain
                          : readout.value() < 0 ? palette.loss
                                                : semantic_rgb(0xffffff);
    color[3] = element_alpha;
    SemanticColor unit_color = color;
    unit_color[3] = element_alpha * unit_alpha;
    const float number_width = hud.overlay_text_width(readout.text(), number_size);
    const float left = x - (number_width + hud.overlay_text_width(unit, unit_size)) / 2;
    hud.overlay_text(left, y, readout.text(), number_size, color, false);
    hud.overlay_text(left + number_width, y + unit_lower, unit, unit_size, unit_color, false);
}

}  // namespace native
