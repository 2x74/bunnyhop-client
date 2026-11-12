#pragma once
// Voice chat on the HUD, drawn plainly: the talker list in the bottom left under the chat (yours on top while you
// talk), each row a speaker, the name and a small meter of the voice's level and bands, and the line that says why
// the key did nothing. The speaker mark also replaces the colour dot on a talking player's name tag. Only drawing
// lives here; who talks and how loud comes from voice::VoiceChat.
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
void meter(Hud &hud, float x, float y, float height, float level, const voice::Bands &bands) {
    const float band_width = (meter_width_px - band_gap_px * float(bands.size() - 1)) / float(bands.size());
    for (size_t i = 0; i < bands.size(); ++i) {
        const float bx = x + float(i) * (band_width + band_gap_px);
        hud.overlay_rect(bx, y, band_width, height, meter_track);
        const float filled = height * std::clamp(bands[i] * (.4f + .6f * level), 0.f, 1.f);
        hud.overlay_rect(bx, y + height - filled, band_width, filled, meter_ink);
    }
}

template <class Hud>
void draw(Hud &hud, int width, int height, float percent, std::span<const voice::HudRow> rows, std::string_view line) {
    if (rows.empty() && line.empty()) return;
    const HudGeometry geometry(width, height, percent);
    hud.overlay_begin(width, height, percent);
    float y = geometry.height - bottom_gap_px - row_height_px * float(rows.size()) - (line.empty() ? 0 : row_height_px);
    for (const auto &row : rows) {
        hud.overlay_rect(left_px, y, row_width_px, row_height_px - 2, row.self ? self_fill : row_fill);
        draw_speaker(hud, left_px + 6, y + 4, speaker_px, name_ink);
        hud.overlay_text(left_px + 22, y + 2, row.name, name_font_px, name_ink);
        meter(hud, left_px + row_width_px - meter_width_px - 6, y + 4, row_height_px - 10, row.level, row.bands);
        y += row_height_px;
    }
    if (!line.empty()) hud.overlay_text(left_px, y + 2, line, line_font_px, line_ink);
    hud.overlay_end(width, height);
}

}  // namespace native::voice_hud
