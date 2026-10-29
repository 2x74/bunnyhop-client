#pragma once
#include "movement_hud.hpp"

namespace native {
// The strafe trainer drawn the way the website's is (hud/strafe-trainer.css): a rail from 0% to 200% pace with 100%
// in the middle, the pace under it and the cue beside the pace. Classic shows the on-pace band in the trainer's
// colour; detailed and minimal colour the whole rail by zone. Sizes are HUD units.
struct TrainerLayout {
    static constexpr float width = 240;
    static constexpr float classic_rail = 3;
    static constexpr float detailed_rail = 10;
    static constexpr float classic_gap = 5;
    static constexpr float detailed_gap = 6;
    static constexpr float minimal_marker_room = 12;
    static constexpr float classic_marker_reach = 4;
    static constexpr float detailed_marker_reach = 3;
    static constexpr float pace_size = 13;
    static constexpr float cue_size = 10;
    static constexpr float cue_left = 35;
    static constexpr float text_height_per_size = 1.3f;
    static constexpr float dimmed_alpha = .3f;
    static constexpr float classic_rail_alpha = .2f;
    static constexpr float classic_band_alpha = .65f;
    static constexpr float cue_alpha = .58f;
    static constexpr float bad_zone_alpha = .7f;
    static constexpr float detailed_alpha = .85f;
    static constexpr float shadow_alpha = .45f;
};

inline float trainer_rail_height(const TrainerAppearance &look) {
    return (look.style == "detailed" ? TrainerLayout::detailed_rail : TrainerLayout::classic_rail) * look.height;
}

// Space above the rail for the marker: it reaches past the rail, and minimal's arrow sits over it.
inline float trainer_rail_top(const TrainerAppearance &look) {
    if (look.style == "minimal") return TrainerLayout::minimal_marker_room;
    return look.style == "detailed" ? TrainerLayout::detailed_marker_reach : TrainerLayout::classic_marker_reach;
}

inline float trainer_height(const TrainerAppearance &look) {
    const float gap = look.style == "detailed" ? TrainerLayout::detailed_gap : TrainerLayout::classic_gap;
    const float reading = TrainerLayout::pace_size * TrainerLayout::text_height_per_size;
    return trainer_rail_top(look) + trainer_rail_height(look) + gap + reading;
}

inline NameColor with_alpha(NameColor color, float alpha) {
    color[3] *= alpha;
    return color;
}

// A bar whose left and / or right end is round, like the website's pill-shaped rail: the end's rows are cut to the
// circle, one HUD unit at a time.
template <class Hud>
void draw_rounded_rect(
        Hud &hud, float x, float y, float width, float height, NameColor color, bool round_left, bool round_right
) {
    const float radius = std::min(height, width) / 2;
    const float inner_left = round_left ? x + radius : x, inner_right = round_right ? x + width - radius : x + width;
    hud.overlay_rect(inner_left, y, inner_right - inner_left, height, color);
    const int rows = std::max(1, int(std::ceil(height)));
    for (int row = 0; row < rows; ++row) {
        const float row_height = std::min(1.f, height - float(row));
        const float from_middle = std::abs(float(row) + row_height / 2 - height / 2);
        const float reach = std::sqrt(std::max(0.f, radius * radius - from_middle * from_middle));
        if (round_left) hud.overlay_rect(inner_left - reach, y + float(row), reach, row_height, color);
        if (round_right) hud.overlay_rect(inner_right, y + float(row), reach, row_height, color);
    }
}

// Detailed and minimal: red at the ends, amber, then green around 100%. Detailed's rail has round ends.
template <class Hud>
void draw_trainer_zones(
        Hud &hud,
        float left,
        float top,
        float rail,
        const TrainerAppearance &look,
        const SemanticPalette &palette,
        float alpha
) {
    const float width = TrainerLayout::width;
    const float good = float(look.zone / trainer_pace_max) * width;
    const double near_pace = std::min(trainer_target_pace, double(look.zone) * trainer_ok_span);
    const float near = float(near_pace / trainer_pace_max) * width;
    const float middle = left + width / 2;
    const NameColor bad_color = with_alpha(palette.trainer[2], TrainerLayout::bad_zone_alpha * alpha);
    const NameColor near_color = with_alpha(palette.trainer[1], alpha);
    const bool round = look.style == "detailed";
    draw_rounded_rect(hud, left, top, width / 2 - near, rail, bad_color, round, false);
    hud.overlay_rect(middle - near, top, near - good, rail, near_color);
    hud.overlay_rect(middle - good, top, 2 * good, rail, with_alpha(palette.trainer[0], alpha));
    hud.overlay_rect(middle + good, top, near - good, rail, near_color);
    draw_rounded_rect(hud, middle + near, top, width / 2 - near, rail, bad_color, false, round);
}

template <class Hud>
void draw_trainer_rail(
        Hud &hud,
        float x,
        float top,
        const TrainerAppearance &look,
        const SemanticPalette &palette,
        NameColor ink,
        float alpha
) {
    const float left = x - TrainerLayout::width / 2;
    const float rail = trainer_rail_height(look);
    const NameColor shadow = {0, 0, 0, TrainerLayout::shadow_alpha * alpha};
    draw_rounded_rect(
            hud, left, top + 1, TrainerLayout::width, rail, shadow, look.style == "detailed", look.style == "detailed"
    );
    if (look.style == "classic") {
        const float good = float(look.zone / trainer_pace_max) * TrainerLayout::width;
        hud.overlay_rect(left, top, TrainerLayout::width, rail, with_alpha(ink, TrainerLayout::classic_rail_alpha));
        hud.overlay_rect(x - good, top, 2 * good, rail, with_alpha(ink, TrainerLayout::classic_band_alpha));
        hud.overlay_rect(x - .5f, top - 2, 1, rail + 4, ink);
        return;
    }
    const float zone_alpha = look.style == "detailed" ? TrainerLayout::detailed_alpha * alpha : alpha;
    draw_trainer_zones(hud, left, top, rail, look, palette, zone_alpha);
    if (look.style == "detailed") hud.overlay_rect(x - .5f, top, 1, rail, {0, 0, 0, .4f * alpha});
}

template <class Hud>
void draw_trainer_marker(Hud &hud, float x, float top, const TrainerAppearance &look, NameColor ink, float alpha) {
    const float rail = trainer_rail_height(look);
    const NameColor outline = {0, 0, 0, .67f * alpha};
    if (look.style == "minimal") {
        // A small arrow over the rail, pointing at it.
        constexpr int arrow_rows = 7;
        constexpr float arrow_half_width = 5;
        for (int row = 0; row < arrow_rows; ++row) {
            const float half = arrow_half_width * (1 - float(row) / arrow_rows);
            hud.overlay_rect(x - half, top - 2 - float(arrow_rows - row), 2 * half, 1, ink);
        }
        return;
    }
    if (look.style == "detailed") {
        const float reach = TrainerLayout::detailed_marker_reach;
        hud.overlay_rect(x - 2.5f, top - reach - 1, 5, rail + 2 * reach + 2, outline);
        hud.overlay_rect(x - 1.5f, top - reach, 3, rail + 2 * reach, ink);
        return;
    }
    const float reach = TrainerLayout::classic_marker_reach;
    hud.overlay_rect(x - 1, top - reach, 2, rail + 2 * reach, ink);
}

// (x, y) is the trainer's top centre.
template <class Hud>
void draw_trainer(
        Hud &hud,
        float x,
        float y,
        const StrafeReading &reading,
        const TrainerAppearance &look,
        bool hints,
        const SemanticPalette &palette
) {
    const double pace = std::floor(reading.percent + .5);
    const bool dimmed = look.dim_below > 0 && (!reading.has_pace || pace < look.dim_below);
    const float alpha = dimmed ? TrainerLayout::dimmed_alpha : 1;
    const NameColor ink = with_alpha(look.color, alpha);
    const float top = y + trainer_rail_top(look);
    draw_trainer_rail(hud, x, top, look, palette, ink, alpha);
    if (reading.has_pace) {
        const float position = float(trainer_position(pace, reading.side, look.follow) - .5);
        draw_trainer_marker(hud, x + position * TrainerLayout::width, top, look, ink, alpha);
    }
    const float gap = look.style == "detailed" ? TrainerLayout::detailed_gap : TrainerLayout::classic_gap;
    const float reading_top = top + trainer_rail_height(look) + gap;
    if (look.show_pace)
        hud.overlay_text(x, reading_top, trainer_text(reading).view(), TrainerLayout::pace_size, ink, true);
    const bool unsupported = reading.hint == StrafeHint::unsupported;
    if ((hints || unsupported) && reading.hint)
        hud.overlay_text(
                x + TrainerLayout::cue_left,
                reading_top + 2,
                strafe_hint_text(*reading.hint),
                TrainerLayout::cue_size,
                with_alpha(ink, TrainerLayout::cue_alpha)
        );
}
}  // namespace native
