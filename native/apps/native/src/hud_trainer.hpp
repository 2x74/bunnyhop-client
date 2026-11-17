#pragma once
#include "movement_hud.hpp"
#include <cmath>
#include <numbers>
#include <vector>

namespace native {
// The strafe trainer drawn the way the website's is (hud/strafe-trainer.css): a rail from 0% to 200% pace with 100%
// in the middle, the pace under it and the cue beside the pace. Classic shows the on-pace band in the trainer's
// colour; detailed and minimal colour the whole rail by zone. Bar is a dark track filled from the edge opposite the
// turn and coloured by this tick's real gain, with the last jump's average under it. Arc is a thin half dial whose
// needle points at the Bar's average (or the pace); Gauge a filled half disc whose needle follows its own filter.
// Sizes are HUD units.
using HudPoint = std::array<float, 2>;

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
    static constexpr float bar_width = 247.5f;
    static constexpr float bar_track = 13.2f;
    static constexpr float bar_gap = 6;
    static constexpr uint32_t bar_track_top_rgb = 0x364043;
    static constexpr uint32_t bar_track_bottom_rgb = 0x1b2527;
    static constexpr float bar_track_alpha = 235.f / 255;
    static constexpr float bar_shadow_alpha = .6f;
    static constexpr float bar_tick_alpha = 170.f / 255;
    static constexpr uint32_t bar_neutral_rgb = 0xffffff;
};

// The Arc and Gauge dials in the website's SVG user units (hud/strafe-trainer.ts GAUGE_*, DISC_*): the pivot at the
// origin, y down, angles in degrees from straight up, positive to the right. Each dial is as wide as its 8.5em box.
struct GaugeLayout {
    static constexpr float box_width = 127.5f;
    static constexpr float units = box_width / 100;
    static constexpr float view_top = -51;
    static constexpr float view_height = 56;
    static constexpr float radius = 44;
    static constexpr float needle = 40;
    static constexpr float mark_inner = 36;
    static constexpr float mark_outer = 50;
    static constexpr float arc_width = 3;
    static constexpr float shade_extra = 2;
    static constexpr float mark_width = 2;
    static constexpr float needle_width = 2.4f;
    static constexpr float needle_shade_width = 4.4f;
    static constexpr float hub_radius = 3;
    static constexpr float hub_outline = 1;
    static constexpr float half_turn = 90;
    static constexpr float arc_alpha_shade = 0x88 / 255.f;
    static constexpr float needle_shade_alpha = 0xaa / 255.f;
    // The number sits .15em higher than under the rails.
    static constexpr float reading_lift = 2.25f;
    static constexpr float degrees_per_segment = 3;
    static constexpr int cap_segments = 8;
    static constexpr int hub_segments = 24;
    static constexpr double angle_step = .1;
};

// The Gauge's filled half disc (DISC_*): its face by angle, a green line at 100%, a dark wedge needle and a hub.
struct DiscLayout {
    static constexpr float view_top = -50;
    static constexpr float view_height = 57;
    static constexpr float radius = 48;
    static constexpr float hub = 6.2f;
    static constexpr float needle = 46.5f;
    static constexpr float needle_base = 6.2f;
    static constexpr float needle_tip = .4f;
    static constexpr float mark_width = .8f;
    static constexpr int face_segments = 90;
    static constexpr int tip_segments = 6;
    static constexpr uint32_t mark_rgb = 0x2ee02e;
    static constexpr uint32_t needle_rgb = 0x0c0c0e;
    // The face's outline and soft shadow (box-shadow 0 0 0 1px #0006, 0 1px 3px #0005), in HUD units.
    static constexpr float outline_width = 1;
    static constexpr float outline_alpha = .4f;
    static constexpr float shadow_drop = 1;
    static constexpr float shadow_blur = 3;
    static constexpr float shadow_alpha = 85.f / 255;
    // The number sits .1em higher than under the rails.
    static constexpr float reading_lift = 1.5f;
    // A light edge round the needle and hub, under the face: it shows only where they leave the face (the hub's lower
    // half, a needle lying along the base), so they stay readable over a dark map. One dial unit outside the shapes.
    static constexpr float edge_width = 1;
    static constexpr float edge_alpha = 0xa6 / 255.f;
};

// The face's colour stops by angle: saturated blue flat left, white straight up, saturated red flat right. The same in
// every colour-blind palette.
inline constexpr std::array<std::pair<float, uint32_t>, 5> disc_face_stops = {{
        {-90, 0x0a04f5},
        {-45, 0x706af8},
        {0, 0xffffff},
        {45, 0xec6670},
        {90, 0xe00204},
}};

inline NameColor disc_face_color(float degrees) {
    for (size_t i = 1; i < disc_face_stops.size(); ++i) {
        const auto [to_angle, to_rgb] = disc_face_stops[i];
        if (degrees > to_angle && i + 1 < disc_face_stops.size()) continue;
        const auto [from_angle, from_rgb] = disc_face_stops[i - 1];
        const float along = std::clamp((degrees - from_angle) / (to_angle - from_angle), 0.f, 1.f);
        const auto from = semantic_rgb(from_rgb), to = semantic_rgb(to_rgb);
        NameColor color{};
        for (size_t channel = 0; channel < 3; ++channel)
            color[channel] = from[channel] + (to[channel] - from[channel]) * along;
        color[3] = 1;
        return color;
    }
    return semantic_rgb(disc_face_stops.back().second);
}

// The Arc's value: the Bar's average, else the live pace.
inline std::optional<double> arc_value(const StrafeReading &reading) {
    return trainer_bar_value(reading);
}

// The Gauge's value: its own needle filter, else (previews) the pace. A resting needle with no live pace is nothing.
inline std::optional<double> gauge_value(const StrafeReading &reading) {
    const auto pace = reading.has_pace ? std::optional{reading.percent} : std::nullopt;
    if (!reading.gauge) return pace;
    return *reading.gauge > 0 || pace ? reading.gauge : std::nullopt;
}

inline bool trainer_is_dial(const TrainerAppearance &look) {
    return look.style == "arc" || look.style == "gauge";
}

inline std::optional<double> dial_value(const StrafeReading &reading, const TrainerAppearance &look) {
    return look.style == "gauge" ? gauge_value(reading) : arc_value(reading);
}

// The needle in degrees: nothing or 0% lies flat left, 100% stands up, 200% lies flat right. Kept to a tenth of a
// degree.
inline double gauge_angle(std::optional<double> value) {
    const double angle = value && *value > 0 ? (std::min(trainer_pace_max, *value) / trainer_pace_max * 2 - 1)
                                                       * GaugeLayout::half_turn
                                             : -GaugeLayout::half_turn;
    return std::round(angle / GaugeLayout::angle_step) * GaugeLayout::angle_step;
}

// The Arc's and Gauge's hint: the look's own value against the on-pace zone; with no live pace, the reading's.
inline std::optional<StrafeHint> gauge_hint(const StrafeReading &reading, double zone, std::optional<double> value) {
    if (!reading.has_pace || !value || reading.cue == TrainerCue::unsupported) return reading.hint;
    if (std::abs(*value - trainer_target_pace) <= zone) return std::nullopt;
    return *value < trainer_target_pace ? StrafeHint::strafe_more : StrafeHint::strafe_less;
}

inline float trainer_width(const TrainerAppearance &look) {
    if (trainer_is_dial(look)) return GaugeLayout::box_width;
    return look.style == "bar" ? TrainerLayout::bar_width : TrainerLayout::width;
}

inline float trainer_rail_height(const TrainerAppearance &look) {
    if (look.style == "gauge") return DiscLayout::view_height * GaugeLayout::units;
    if (look.style == "arc") return GaugeLayout::view_height * GaugeLayout::units;
    if (look.style == "bar") return TrainerLayout::bar_track * look.height;
    return (look.style == "detailed" ? TrainerLayout::detailed_rail : TrainerLayout::classic_rail) * look.height;
}

// Space above the rail for the marker: it reaches past the rail, and minimal's arrow sits over it.
inline float trainer_rail_top(const TrainerAppearance &look) {
    if (trainer_is_dial(look)) return 0;
    if (look.style == "bar") return TrainerLayout::bar_gap;
    if (look.style == "minimal") return TrainerLayout::minimal_marker_room;
    return look.style == "detailed" ? TrainerLayout::detailed_marker_reach : TrainerLayout::classic_marker_reach;
}

inline float trainer_reading_gap(const TrainerAppearance &look) {
    if (look.style == "gauge") return -DiscLayout::reading_lift;
    if (look.style == "arc") return -GaugeLayout::reading_lift;
    if (look.style == "bar") return TrainerLayout::bar_gap;
    return look.style == "detailed" ? TrainerLayout::detailed_gap : TrainerLayout::classic_gap;
}

inline float trainer_height(const TrainerAppearance &look) {
    const float reading = TrainerLayout::pace_size * TrainerLayout::text_height_per_size;
    return trainer_rail_top(look) + trainer_rail_height(look) + trainer_reading_gap(look) + reading;
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
    const float near_width = float(near_pace / trainer_pace_max) * width;
    const float middle = left + width / 2;
    const NameColor bad_color = with_alpha(palette.trainer[2], TrainerLayout::bad_zone_alpha * alpha);
    const NameColor near_color = with_alpha(palette.trainer[1], alpha);
    const bool round = look.style == "detailed";
    draw_rounded_rect(hud, left, top, width / 2 - near_width, rail, bad_color, round, false);
    hud.overlay_rect(middle - near_width, top, near_width - good, rail, near_color);
    hud.overlay_rect(middle - good, top, 2 * good, rail, with_alpha(palette.trainer[0], alpha));
    hud.overlay_rect(middle + good, top, near_width - good, rail, near_color);
    draw_rounded_rect(hud, middle + near_width, top, width / 2 - near_width, rail, bad_color, false, round);
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

// The trainer's own colour is for the number and hints. The fill's white stays white under any of them.
inline NameColor trainer_bar_color(TrainerBarBand band, const SemanticPalette &palette) {
    switch (band) {
        case TrainerBarBand::perfect:
            return palette.trainer[3];
        case TrainerBarBand::good:
            return palette.trainer[0];
        case TrainerBarBand::ok:
            return palette.trainer[1];
        case TrainerBarBand::high:
            return palette.trainer[2];
        case TrainerBarBand::low:
            break;
    }
    return semantic_rgb(TrainerLayout::bar_neutral_rgb);
}

// The track, one row at a time: its ends are round, it has a vertical gradient, and the fill is clipped to the same
// ends. The centre tick goes over the fill.
template <class Hud>
void draw_trainer_bar(
        Hud &hud,
        float x,
        float top,
        const TrainerBarView &view,
        const TrainerAppearance &look,
        const SemanticPalette &palette,
        float alpha
) {
    const float width = TrainerLayout::bar_width;
    const float height = trainer_rail_height(look);
    const float left = x - width / 2;
    const float radius = height / 2;
    const NameColor shadow = {0, 0, 0, TrainerLayout::bar_shadow_alpha * alpha};
    draw_rounded_rect(hud, left, top + 1, width, height, shadow, true, true);
    const auto top_color = semantic_rgb(TrainerLayout::bar_track_top_rgb);
    const auto bottom_color = semantic_rgb(TrainerLayout::bar_track_bottom_rgb);
    const float fill_width = float(view.fill) * width;
    const float fill_left = view.from_left ? left : left + width - fill_width;
    const NameColor fill_color = view.band ? with_alpha(trainer_bar_color(*view.band, palette), alpha) : NameColor{};
    const int rows = std::max(1, int(std::ceil(height)));
    for (int row = 0; row < rows; ++row) {
        const float row_height = std::min(1.f, height - float(row));
        const float row_top = top + float(row);
        const float from_middle = std::abs(float(row) + row_height / 2 - radius);
        const float inset = radius - std::sqrt(std::max(0.f, radius * radius - from_middle * from_middle));
        const float along = (float(row) + row_height / 2) / height;
        NameColor track = {0, 0, 0, TrainerLayout::bar_track_alpha * alpha};
        for (int channel = 0; channel < 3; ++channel)
            track[size_t(channel)] = top_color[size_t(channel)] * (1 - along) + bottom_color[size_t(channel)] * along;
        hud.overlay_rect(left + inset, row_top, width - 2 * inset, row_height, track);
        const float from = std::max(fill_left, left + inset);
        const float to = std::min(fill_left + fill_width, left + width - inset);
        if (view.band && to > from) hud.overlay_rect(from, row_top, to - from, row_height, fill_color);
    }
    hud.overlay_rect(x - .5f, top, 1, height, {0, 0, 0, TrainerLayout::bar_tick_alpha * alpha});
}

// Draws the dial's shapes in its own units around a pivot, with a pixel-wide soft edge in place of antialiasing.
template <class Hud>
class GaugePainter {
    Hud &hud_;
    HudPoint pivot_;
    float feather_;

    HudPoint at(float radius, float degrees) const {
        const float radians = degrees * float(std::numbers::pi / 180);
        return {pivot_[0] + radius * std::sin(radians) * GaugeLayout::units,
                pivot_[1] - radius * std::cos(radians) * GaugeLayout::units};
    }

    static NameColor clear(NameColor color) {
        color[3] = 0;
        return color;
    }

public:
    GaugePainter(Hud &hud, HudPoint pivot) : hud_(hud), pivot_(pivot), feather_(hud.overlay_pixel()) {}

    // A band along radius `radius`, `width` wide, from `from` to `to` degrees, with square ends.
    void arc(float radius, float from, float to, float width, NameColor color) {
        if (to <= from || color[3] <= 0) return;
        const int segments = std::max(1, int(std::ceil((to - from) / GaugeLayout::degrees_per_segment)));
        const float soft = feather_ / GaugeLayout::units;
        const float inset = std::min(soft / 2, width / 2);
        const float inner = radius - width / 2 + inset, outer = radius + width / 2 - inset;
        for (int i = 0; i < segments; ++i) {
            const float a = from + (to - from) * float(i) / float(segments);
            const float b = from + (to - from) * float(i + 1) / float(segments);
            hud_.overlay_quad({at(inner, a), at(outer, a), at(outer, b), at(inner, b)}, {color, color, color, color});
            hud_.overlay_quad(
                    {at(outer, a), at(outer + soft, a), at(outer + soft, b), at(outer, b)},
                    {color, clear(color), clear(color), color}
            );
            hud_.overlay_quad(
                    {at(inner - soft, a), at(inner, a), at(inner, b), at(inner - soft, b)},
                    {clear(color), color, color, clear(color)}
            );
        }
    }

    // A convex outline (points in order) pushed `distance` HUD units outwards: each corner moves along the mean of
    // its two edges' outward normals, so every edge moves out by that distance.
    static std::vector<HudPoint> grown(const std::vector<HudPoint> &points, float distance) {
        const size_t count = points.size();
        HudPoint centre{};
        for (const auto &p : points) {
            centre[0] += p[0] / float(count);
            centre[1] += p[1] / float(count);
        }
        std::vector<HudPoint> normals(count), out(count);
        for (size_t i = 0; i < count; ++i) {
            const auto &a = points[i], &b = points[(i + 1) % count];
            HudPoint normal = {b[1] - a[1], a[0] - b[0]};
            const float length = std::max(1e-6f, std::hypot(normal[0], normal[1]));
            normal = {normal[0] / length, normal[1] / length};
            const float outward =
                    normal[0] * ((a[0] + b[0]) / 2 - centre[0]) + normal[1] * ((a[1] + b[1]) / 2 - centre[1]);
            normals[i] = outward < 0 ? HudPoint{-normal[0], -normal[1]} : normal;
        }
        for (size_t i = 0; i < count; ++i) {
            const auto &before = normals[(i + count - 1) % count], &after = normals[i];
            HudPoint mean = {before[0] + after[0], before[1] + after[1]};
            const float length = std::max(1e-6f, std::hypot(mean[0], mean[1]));
            mean = {mean[0] / length, mean[1] / length};
            const float reach = distance / std::max(.3f, mean[0] * after[0] + mean[1] * after[1]);
            out[i] = {points[i][0] + mean[0] * reach, points[i][1] + mean[1] * reach};
        }
        return out;
    }

    // A filled convex outline (points in order) with a soft rim.
    void convex(const std::vector<HudPoint> &points, NameColor color) {
        const size_t count = points.size();
        HudPoint centre{};
        for (const auto &p : points) {
            centre[0] += p[0] / float(count);
            centre[1] += p[1] / float(count);
        }
        const auto rim = grown(points, feather_);
        for (size_t i = 0; i < count; ++i) {
            const size_t next = (i + 1) % count;
            hud_.overlay_quad({centre, points[i], points[next], points[next]}, {color, color, color, color});
            hud_.overlay_quad({points[i], rim[i], rim[next], points[next]}, {color, clear(color), clear(color), color});
        }
    }

    // A disc's outline, `segments` corners on `radius` dial units.
    std::vector<HudPoint> circle(float radius, int segments) const {
        std::vector<HudPoint> outline;
        for (int i = 0; i < segments; ++i)
            outline.push_back(at(radius, 360.f * float(i) / float(segments)));
        return outline;
    }

    // A line from radius `from` to radius `to` at `degrees`, `width` wide, with square or round ends.
    void line(float from, float to, float degrees, float width, NameColor color, bool round) {
        const float half = width / 2;
        std::vector<HudPoint> outline;
        const int caps = round ? GaugeLayout::cap_segments : 1;
        for (int i = 0; i <= caps; ++i) {
            const float turn = round ? 180 * float(i) / float(caps) : 180 * float(i);
            outline.push_back(cap_point(to, degrees, half, -90 + turn));
        }
        for (int i = 0; i <= caps; ++i) {
            const float turn = round ? 180 * float(i) / float(caps) : 180 * float(i);
            outline.push_back(cap_point(from, degrees, half, 90 + turn));
        }
        convex(outline, color);
    }

    // A point given in dial units around the pivot, turned `degrees` about it.
    HudPoint turned(float x, float y, float degrees) const {
        const float radians = degrees * float(std::numbers::pi / 180);
        const float c = std::cos(radians), s = std::sin(radians);
        return {pivot_[0] + (x * c - y * s) * GaugeLayout::units, pivot_[1] + (x * s + y * c) * GaugeLayout::units};
    }

    // The half disc from -90 to 90 degrees, coloured by angle (`color_at`), with square ends on the base line.
    template <class ColorAt>
    void half_disc(float radius, int segments, ColorAt &&color_at) {
        for (int i = 0; i < segments; ++i) {
            const float a = -90 + 180.f * float(i) / float(segments), b = -90 + 180.f * float(i + 1) / float(segments);
            const auto ca = color_at(a), cb = color_at(b);
            NameColor middle{};
            for (size_t channel = 0; channel < 4; ++channel)
                middle[channel] = (ca[channel] + cb[channel]) / 2;
            hud_.overlay_quad({pivot_, at(radius, a), at(radius, b), at(radius, b)}, {middle, ca, cb, cb});
        }
    }

    // A band fading from `color` at `from` units out to clear at `to` units, round the rim and under the base line.
    void soft_rim(float radius, float from, float to, NameColor color, float drop) {
        const float inner = radius + from / GaugeLayout::units, outer = radius + to / GaugeLayout::units;
        const HudPoint down = {0, drop};
        const auto shift = [&](HudPoint p) {
            return HudPoint{p[0] + down[0], p[1] + down[1]};
        };
        const int segments = int(std::ceil(180 / GaugeLayout::degrees_per_segment));
        for (int i = 0; i < segments; ++i) {
            const float a = -90 + 180.f * float(i) / float(segments), b = -90 + 180.f * float(i + 1) / float(segments);
            hud_.overlay_quad(
                    {shift(at(inner, a)), shift(at(outer, a)), shift(at(outer, b)), shift(at(inner, b))},
                    {color, clear(color), clear(color), color}
            );
        }
        const float base_from = pivot_[1] + from + drop, base_to = pivot_[1] + to + drop;
        const float left = pivot_[0] - outer * GaugeLayout::units, right = pivot_[0] + outer * GaugeLayout::units;
        hud_.overlay_quad(
                {HudPoint{left, base_from},
                 HudPoint{right, base_from},
                 HudPoint{right, base_to},
                 HudPoint{left, base_to}},
                {color, color, clear(color), clear(color)}
        );
    }

    void disc(float radius, NameColor color) { convex(circle(radius, GaugeLayout::hub_segments), color); }

private:
    // A point `half` from the line's end at radius `along`, `turn` degrees round from the line's direction.
    HudPoint cap_point(float along, float degrees, float half, float turn) const {
        const auto end = at(along, degrees);
        const float direction = (degrees + turn) * float(std::numbers::pi / 180);
        return {end[0] + half * std::sin(direction) * GaugeLayout::units,
                end[1] - half * std::cos(direction) * GaugeLayout::units};
    }
};

// The Arc look: shade, red, amber and green arcs on one radius, the centre mark, the needle and its hub.
template <class Hud>
void draw_trainer_arc(
        Hud &hud,
        float x,
        float top,
        std::optional<double> value,
        const TrainerAppearance &look,
        const SemanticPalette &palette,
        NameColor ink,
        float alpha
) {
    GaugePainter<Hud> paint(hud, {x, top - GaugeLayout::view_top * GaugeLayout::units});
    const float stroke = GaugeLayout::arc_width * look.height, end = GaugeLayout::half_turn;
    const float good = float(std::min(trainer_target_pace, double(look.zone)) / trainer_target_pace) * end;
    const float ok =
            float(std::min(trainer_target_pace, double(look.zone) * trainer_ok_span) / trainer_target_pace) * end;
    const float r = GaugeLayout::radius;
    paint.arc(r, -end, end, stroke + GaugeLayout::shade_extra, {0, 0, 0, GaugeLayout::arc_alpha_shade * alpha});
    paint.arc(r, -end, end, stroke, with_alpha(palette.trainer[2], TrainerLayout::bad_zone_alpha * alpha));
    paint.arc(r, -ok, ok, stroke, with_alpha(palette.trainer[1], alpha));
    paint.arc(r, -good, good, stroke, with_alpha(palette.trainer[0], alpha));
    paint.line(GaugeLayout::mark_inner, GaugeLayout::mark_outer, 0, GaugeLayout::mark_width, ink, false);
    const float angle = float(gauge_angle(value));
    const NameColor shade = {0, 0, 0, GaugeLayout::needle_shade_alpha * alpha};
    paint.line(0, GaugeLayout::needle, angle, GaugeLayout::needle_shade_width, shade, true);
    paint.line(0, GaugeLayout::needle, angle, GaugeLayout::needle_width, ink, true);
    paint.disc(GaugeLayout::hub_radius, ink);
    const float ring = GaugeLayout::hub_outline;
    paint.arc(GaugeLayout::hub_radius, -180, 180, ring, shade);
}

// The Gauge's needle: a wedge `base` dial units half-wide at the pivot narrowing to a round tip, pointing straight up.
inline std::vector<HudPoint> disc_needle_outline(float base) {
    const float tip_centre = -(DiscLayout::needle - DiscLayout::needle_tip);
    std::vector<HudPoint> outline = {{-base, 0}};
    for (int i = 0; i <= DiscLayout::tip_segments; ++i) {
        const float turn = float(std::numbers::pi) * float(i) / float(DiscLayout::tip_segments);
        outline.push_back(
                {-DiscLayout::needle_tip * std::cos(turn), tip_centre - DiscLayout::needle_tip * std::sin(turn)}
        );
    }
    outline.push_back({base, 0});
    return outline;
}

// The Gauge look: a light edge, the shadowed face, the green 100% line, the needle and the hub that covers its base.
// The trainer's colour is only for the number and hints; height widens the needle's base.
template <class Hud>
void draw_trainer_disc(
        Hud &hud, float x, float top, std::optional<double> value, const TrainerAppearance &look, float alpha
) {
    GaugePainter<Hud> paint(hud, {x, top - DiscLayout::view_top * GaugeLayout::units});
    const auto faded = [alpha](NameColor color) {
        return with_alpha(color, alpha);
    };
    const float angle = float(gauge_angle(value));
    std::vector<HudPoint> needle;
    for (const auto &point : disc_needle_outline(DiscLayout::needle_base * look.height))
        needle.push_back(paint.turned(point[0], point[1], angle));
    const auto hub = paint.circle(DiscLayout::hub, GaugeLayout::hub_segments);
    const float edge = DiscLayout::edge_width * GaugeLayout::units;
    const NameColor light = {1, 1, 1, DiscLayout::edge_alpha * alpha};
    paint.convex(GaugePainter<Hud>::grown(needle, edge), light);
    paint.convex(GaugePainter<Hud>::grown(hub, edge), light);
    paint.soft_rim(
            DiscLayout::radius,
            0,
            DiscLayout::shadow_blur,
            {0, 0, 0, DiscLayout::shadow_alpha * alpha},
            DiscLayout::shadow_drop
    );
    paint.half_disc(DiscLayout::radius, DiscLayout::face_segments, [&](float degrees) {
        return faded(disc_face_color(degrees));
    });
    paint.soft_rim(DiscLayout::radius, 0, DiscLayout::outline_width, {0, 0, 0, DiscLayout::outline_alpha * alpha}, 0);
    paint.line(0, DiscLayout::radius, 0, DiscLayout::mark_width, faded(semantic_rgb(DiscLayout::mark_rgb)), false);
    const auto dark = faded(semantic_rgb(DiscLayout::needle_rgb));
    paint.convex(needle, dark);
    paint.convex(hub, dark);
}

// The number under the trainer, formatted again only when the digits it shows change: the Bar's fill changes nearly
// every tick and its number only once per jump.
class TrainerNumberText {
    std::optional<int> shown_;
    bool formatted_ = false;
    HudLabel<32> text_;

public:
    std::string_view view(std::optional<double> percent) {
        const std::optional<int> shown = percent ? std::optional{int(std::floor(*percent + .5))} : std::optional<int>{};
        if (!formatted_ || shown != shown_) {
            text_ = trainer_pace_text(percent);
            shown_ = shown;
            formatted_ = true;
        }
        return text_.view();
    }
};

// (x, y) is the trainer's top centre.
template <class Hud>
void draw_trainer(
        Hud &hud,
        float x,
        float y,
        const StrafeReading &reading,
        const TrainerAppearance &look,
        bool hints,
        const SemanticPalette &palette,
        TrainerNumberText &number
) {
    const bool bar = look.style == "bar", gauge = trainer_is_dial(look);
    const auto gauge_reading = gauge ? dial_value(reading, look) : std::nullopt;
    const bool has_pace = gauge ? gauge_reading.has_value() : reading.has_pace;
    const double pace = std::floor((gauge && gauge_reading ? *gauge_reading : reading.percent) + .5);
    const bool dimmed = look.dim_below > 0 && (!has_pace || pace < look.dim_below);
    const float alpha = dimmed ? TrainerLayout::dimmed_alpha : 1;
    const NameColor ink = with_alpha(look.color, alpha);
    const float top = y + trainer_rail_top(look);
    if (bar)
        draw_trainer_bar(hud, x, top, trainer_bar_view(reading), look, palette, alpha);
    else if (look.style == "gauge")
        draw_trainer_disc(hud, x, top, gauge_reading, look, alpha);
    else if (gauge)
        draw_trainer_arc(hud, x, top, gauge_reading, look, palette, ink, alpha);
    else
        draw_trainer_rail(hud, x, top, look, palette, ink, alpha);
    if (!bar && !gauge && reading.has_pace) {
        const float position = float(trainer_position(pace, reading.side, look.follow) - .5);
        draw_trainer_marker(hud, x + position * TrainerLayout::width, top, look, ink, alpha);
    }
    const float reading_top = top + trainer_rail_height(look) + trainer_reading_gap(look);
    if (look.show_pace) {
        const std::optional<double> shown = bar                ? reading.last_jump
                                            : gauge            ? gauge_reading
                                            : reading.has_pace ? std::optional{reading.percent}
                                                               : std::nullopt;
        hud.overlay_text(x, reading_top, number.view(shown), TrainerLayout::pace_size, ink, true);
    }
    const auto hint = bar     ? trainer_bar_hint(reading)
                      : gauge ? gauge_hint(reading, look.zone, gauge_reading)
                              : reading.hint;
    const bool unsupported = hint == StrafeHint::unsupported;
    if ((hints || unsupported) && hint)
        hud.overlay_text(
                x + TrainerLayout::cue_left,
                reading_top + 2,
                strafe_hint_text(*hint),
                TrainerLayout::cue_size,
                with_alpha(ink, TrainerLayout::cue_alpha)
        );
}

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
    TrainerNumberText number;
    draw_trainer(hud, x, y, reading, look, hints, palette, number);
}
}  // namespace native
