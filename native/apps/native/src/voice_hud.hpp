#pragma once
// Voice chat on the HUD, drawn plainly: the talker list (yours on top while you talk) in the website's "voice" HUD
// element, bottom left unless the player moved it, lifted above the key row or the chat where it would overlap them,
// each row a speaker, the name and a small meter of the voice's level and bands, and the line that says why the key
// did nothing. The speaker mark also replaces the colour
// dot on a talking player's name tag. Only drawing lives here; who talks and how loud comes from voice::VoiceChat.
#include "hud_geometry.hpp"
#include "name_tags.hpp"
#include "voice_chat.hpp"
#include <algorithm>
#include <array>
#include <span>
#include <string_view>

namespace native::voice_hud {

using Color = std::array<float, 4>;

constexpr float left_px = 16;
constexpr float bottom_gap_px = 16;
constexpr float row_height_px = 20;
constexpr float row_width_px = 230;
constexpr float speaker_px = 10;
constexpr float name_font_px = 13;
constexpr float line_font_px = 13;
constexpr float meter_width_px = 48;
constexpr float band_gap_px = 1;
constexpr Color row_fill{.02f, .02f, .035f, .7f};
constexpr Color self_fill{.10f, .08f, .03f, .78f};
constexpr Color name_ink{.94f, .91f, .86f, 1};
constexpr Color meter_ink{1, .71f, .24f, 1};
constexpr Color meter_track{1, 1, 1, .12f};
constexpr Color line_ink{1, .71f, .24f, 1};

// The voice's level and its bands as a strip of bars.
template <class Hud>
void meter(Hud &hud, float x, float y, float height, float level, const voice::Bands &bands, float scale = 1) {
    const float gap = band_gap_px * scale;
    const float band_width = (meter_width_px * scale - gap * float(bands.size() - 1)) / float(bands.size());
    for (size_t i = 0; i < bands.size(); ++i) {
        const float bx = x + float(i) * (band_width + gap);
        hud.overlay_rect(bx, y, band_width, height, meter_track);
        const float filled = height * std::clamp(bands[i] * (.4f + .6f * level), 0.f, 1.f);
        hud.overlay_rect(bx, y + height - filled, band_width, filled, meter_ink);
    }
}

// Where the list's top goes when it grows up from `bottom` (HUD units): moved up past each box (in pixels: the key
// row, the chat) it would overlap at `left`, so the list never covers what the native HUD draws there.
inline float list_top(
        const HudGeometry &geometry,
        float left,
        float bottom,
        float list_width,
        float list_height,
        std::span<const HudRect> avoid
) {
    for (bool moved = true; moved;) {
        moved = false;
        for (const auto &box : avoid) {
            if (box.width <= 0 || box.height <= 0) continue;
            const float x = box.x / geometry.scale, y = box.y / geometry.scale;
            const float w = box.width / geometry.scale, h = box.height / geometry.scale;
            const bool across = x < left + list_width && x + w > left;
            if (across && y < bottom && y + h > bottom - list_height) {
                bottom = y - bottom_gap_px / 2;
                moved = true;
            }
        }
    }
    return bottom - list_height;
}

template <class Hud>
void draw(
        Hud &hud,
        int width,
        int height,
        float percent,
        std::span<const voice::HudRow> rows,
        std::string_view line,
        std::span<const HudRect> avoid = {}
) {
    if (rows.empty() && line.empty()) return;
    const HudGeometry geometry(width, height, percent);
    hud.overlay_begin(width, height, percent);
    const float box_height = hud_element_size("voice")[1];
    const auto place = hud.voice_list_place(left_px, geometry.height - bottom_gap_px - box_height);
    if (!place) {
        hud.overlay_end(width, height);
        return;
    }
    const auto [left, box_top, s] = *place;
    const float row = row_height_px * s, list = row * float(rows.size() + (line.empty() ? 0 : 1));
    // In the lower half the list grows up from the box's bottom, as the website's does; higher up, down from its top.
    const bool grows_up = box_top + box_height * s / 2 > geometry.height / 2;
    float y = grows_up ? list_top(geometry, left, box_top + box_height * s, row_width_px * s, list, avoid) : box_top;
    for (const auto &talker : rows) {
        hud.overlay_rect(left, y, row_width_px * s, row - 2 * s, talker.self ? self_fill : row_fill);
        draw_speaker(hud, left + 6 * s, y + 4 * s, speaker_px * s, name_ink);
        hud.overlay_text(left + 22 * s, y + 2 * s, talker.name, name_font_px * s, name_ink);
        const float meter_left = left + (row_width_px - meter_width_px - 6) * s;
        meter(hud, meter_left, y + 4 * s, row - 10 * s, talker.level, talker.bands, s);
        y += row;
    }
    if (!line.empty()) hud.overlay_text(left, y + 2 * s, line, line_font_px * s, line_ink);
    hud.overlay_end(width, height);
}

}  // namespace native::voice_hud
