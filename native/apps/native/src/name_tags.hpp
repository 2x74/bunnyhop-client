#pragma once
#include "graphics_settings.hpp"
#include "hud_text.hpp"
#include "hud_geometry.hpp"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <array>
#include <charconv>
#include <cmath>
#include <optional>
#include <string_view>

namespace native {
using NameColor = std::array<float, 4>;

inline NameColor name_color(std::string_view value, NameColor fallback = {.94f, .91f, .86f, 1}) {
    constexpr std::array<std::string_view, 6> names = {"rose", "peach", "sand", "lime", "aqua", "periwinkle"};
    constexpr std::array<std::string_view, 6> colors = {
            "#ffa8cb", "#ffab8f", "#d2c2a5", "#c4ee6a", "#6ff0f0", "#a8b8ff"
    };
    for (size_t i = 0; i < names.size(); ++i) {
        if (value == names[i]) value = colors[i];
    }
    if (value.size() != 7 || value[0] != '#') return fallback;
    unsigned rgb = 0;
    const auto parsed = std::from_chars(value.data() + 1, value.data() + 7, rgb, 16);
    if (parsed.ec != std::errc() || parsed.ptr != value.data() + 7) return fallback;
    return {float(rgb >> 16) / 255, float((rgb >> 8) & 255) / 255, float(rgb & 255) / 255, fallback[3]};
}

enum class NameEffect { plain, glow, paint, sparkle };
enum class NameMark : unsigned {
    owner,
    staff,
    verified,
    creator,
    booster,
    supporter,
    contributor,
    mapper,
    crown,
    gift,
    badge,
    moderator,
    twitch,
    tiktok,
    x
};

struct NameBadge {
    NameMark glyph = NameMark::badge;
    std::array<NameColor, 3> colors = {NameColor{1, 1, 1, 1}, NameColor{1, 1, 1, 1}, NameColor{1, 1, 1, 1}};
    unsigned color_count = 0;
    bool animated = false;
};

struct NameAppearance {
    NameColor color = {.94f, .91f, .86f, 1};
    NameColor second = {1, 1, 1, 1};
    NameEffect effect = NameEffect::plain;
    unsigned marks = 0;
    std::array<NameBadge, 16> badges;
    size_t badge_count = 0;
};

inline std::string json_text(const nlohmann::json &value, const char *key, size_t limit = 128) {
    const auto found = value.find(key);
    return found != value.end() && found->is_string() ? found->get<std::string>().substr(0, limit) : "";
}

inline bool json_flag(const nlohmann::json &value, const char *key) {
    const auto found = value.find(key);
    return found != value.end() && *found == true;
}

inline NameAppearance name_appearance(const nlohmann::json &value) {
    NameAppearance look;
    look.color = name_color(json_text(value, "nameColor"));
    look.second = name_color(
            json_text(value, "nameColor2"),
            {(look.color[0] + 1) / 2, (look.color[1] + 1) / 2, (look.color[2] + 1) / 2, 1}
    );
    const auto effect = json_text(value, "nameEffect");
    look.effect = effect == "glow"                           ? NameEffect::glow
                  : effect == "paint" || effect == "shimmer" ? NameEffect::paint
                  : effect == "sparkle"                      ? NameEffect::sparkle
                                                             : NameEffect::plain;
    const auto staff = json_text(value, "staff");
    const auto role = json_text(value, "role");
    const auto add = [&](NameMark mark) {
        look.marks |= 1u << unsigned(mark);
    };
    if (staff == "developer" || role == "owner")
        add(NameMark::owner);
    else if (!staff.empty() || role == "admin" || role == "moderator" || json_flag(value, "admin"))
        add(NameMark::staff);
    if (json_flag(value, "verified")) add(NameMark::verified);
    if (!json_text(value, "creator").empty()) add(NameMark::creator);
    if (json_flag(value, "booster")) add(NameMark::booster);
    if (json_flag(value, "supporter")) add(NameMark::supporter);
    const auto special = value.find("special");
    if (special != value.end() && special->is_array()) {
        for (const auto &badge : *special) {
            if (badge == "contributor") add(NameMark::contributor);
            if (badge == "mapper") add(NameMark::mapper);
        }
    }
    return look;
}

inline NameAppearance
host_name_appearance(const nlohmann::json &value, const nlohmann::json &marks, NameAppearance fallback = {}) {
    auto look = fallback;
    if (value.is_object()) {
        look.color = name_color(json_text(value, "color"));
        look.second = name_color(
                json_text(value, "color2"),
                {(look.color[0] + 1) / 2, (look.color[1] + 1) / 2, (look.color[2] + 1) / 2, 1}
        );
        const auto effect = json_text(value, "effect");
        look.effect = effect == "glow"      ? NameEffect::glow
                      : effect == "paint"   ? NameEffect::paint
                      : effect == "sparkle" ? NameEffect::sparkle
                                            : NameEffect::plain;
    }
    if (!marks.is_array()) return look;
    look.badge_count = 0;
    look.marks = 0;
    for (const auto &mark : marks) {
        if (!mark.is_object() || look.badge_count == look.badges.size()) continue;
        const auto id = json_text(mark, "id");
        const auto kind = json_text(mark, "kind");
        auto &badge = look.badges[look.badge_count++];
        badge = {};
        badge.glyph = id == "staff"               ? (kind == "developer"   ? NameMark::owner
                                                     : kind == "moderator" ? NameMark::moderator
                                                                           : NameMark::staff)
                      : id == "verified"          ? NameMark::verified
                      : id == "supporter"         ? NameMark::supporter
                      : id == "booster"           ? NameMark::booster
                      : id == "contributor"       ? NameMark::contributor
                      : id == "mapper"            ? NameMark::mapper
                      : id.starts_with("gifter-") ? NameMark::gift
                      : id == "creator"           ? (kind == "twitch"   ? NameMark::twitch
                                                     : kind == "tiktok" ? NameMark::tiktok
                                                     : kind == "x"      ? NameMark::x
                                                                        : NameMark::creator)
                                                  : NameMark::badge;
        look.marks |= 1u << unsigned(badge.glyph);
        badge.animated = json_flag(mark, "animated");
        const auto colors = mark.find("colors");
        if (colors == mark.end() || !colors->is_array()) continue;
        for (const auto &color : *colors) {
            if (badge.color_count == badge.colors.size()) break;
            if (color.is_string())
                badge.colors[badge.color_count++] = name_color(color.get<std::string>(), {1, 1, 1, 1});
        }
    }
    return look;
}

inline size_t name_badge_count(const NameAppearance &look) {
    if (look.badge_count) return look.badge_count;
    size_t count = 0;
    for (unsigned bit = 0; bit < 15; ++bit)
        count += bool(look.marks & (1u << bit));
    return count;
}

inline NameColor name_badge_color(const NameBadge &badge, double seconds) {
    if (!badge.color_count) return {1, 1, 1, 1};
    if (!badge.animated || badge.color_count == 1) return badge.colors[0];
    const double phase = std::fmod(std::max(0., seconds), 3.) / 3 * badge.color_count;
    const unsigned first = unsigned(phase);
    const auto &from = badge.colors[first];
    const auto &to = badge.colors[(first + 1) % badge.color_count];
    NameColor result = from;
    for (unsigned i = 0; i < 3; ++i)
        result[i] += (to[i] - from[i]) * float(phase - first);
    return result;
}

inline NameColor name_ink(const NameAppearance &look, float position, double seconds) {
    float blend = look.effect == NameEffect::paint ? position : 0;
    if (look.effect == NameEffect::sparkle) {
        const float shine = float(std::fmod(std::max(0., seconds), 4.0) / 2.5) - .2f;
        blend = std::max(0.f, 1.f - std::abs(position - shine) * 9);
    }
    NameColor result = look.color;
    for (size_t i = 0; i < 3; ++i) {
        const float target = look.effect == NameEffect::sparkle ? 1 : look.second[i];
        result[i] += (target - result[i]) * std::clamp(blend, 0.f, 1.f);
    }
    return result;
}

inline std::optional<std::array<float, 2>>
project_name_tag(const float *matrix, const float *point, float width, float height) {
    std::array<float, 4> clip{};
    for (unsigned row = 0; row < 4; ++row)
        clip[row] = matrix[row] * point[0] + matrix[4 + row] * point[1] + matrix[8 + row] * point[2] + matrix[12 + row];
    if (clip[3] <= 2 || std::abs(clip[0]) > clip[3] || std::abs(clip[1]) > clip[3] || std::abs(clip[2]) > clip[3])
        return std::nullopt;
    return std::array<float, 2>{(clip[0] / clip[3] * .5f + .5f) * width, (.5f - clip[1] / clip[3] * .5f) * height};
}

inline std::optional<std::array<float, 2>>
project_name_tag(const float *matrix, const float *point, const GraphicsView &view, int height, float scale) {
    auto screen = project_name_tag(matrix, point, float(view.output_width), float(view.output_height));
    if (screen) {
        (*screen)[0] = (view.x + (*screen)[0]) / scale;
        (*screen)[1] = (height - view.y - view.output_height + (*screen)[1]) / scale;
    }
    return screen;
}

// Line of sight from the camera to a point near a tag (player/tag.ts TagSight.clear): a hit within a few units
// of the point still counts, since heads touch ceilings.
template <class Core>
struct NameTagTrace {
    Core *core;
    const float *eye;

    bool operator()(const float *point) const {
        constexpr float near_hit_units = 10;
        float fraction = 0;
        if (!bh_trace_camera(core, eye, point, 0, &fraction)) return false;
        const float length = std::hypot(point[0] - eye[0], point[1] - eye[1], point[2] - eye[2]);
        return (1 - fraction) * length < near_hit_units;
    }
};

// Tag visibility as the website fades it (player/tag.ts TagSight, net/players.ts): occlusion checked ten times a
// second at the head and the chest and eased in and out, gone right next to the camera, and a distance fade.
struct NameTagSight {
    float alpha = -1;
    bool seen = true;
    double wait = 0;
};

class NameTagSights {
public:
    static constexpr double check_interval_seconds = .1;
    static constexpr float fade_in_per_second = 8;
    static constexpr float fade_out_per_second = 5;
    static constexpr float near_hidden_units = 90;
    static constexpr float near_ramp_units = 90;
    static constexpr float far_full_units = 2000;
    static constexpr float far_gone_units = 3000;
    static constexpr std::array<float, 2> sight_drops_units = {14, 42};

    // Once per drawn frame, before the tags.
    void begin(double seconds, const float *eye) {
        dt_ = last_ < 0 ? 0 : std::clamp(seconds - last_, 0., .1);
        last_ = seconds;
        for (int k = 0; k < 3; ++k)
            eye_[k] = eye[k];
    }

    void reset(unsigned slot) {
        if (slot < slots_.size()) slots_[slot] = {};
    }

    template <class Trace>
    float opacity(unsigned slot, const float *point, bool through_walls, Trace &trace) {
        const float distance = std::hypot(point[0] - eye_[0], point[1] - eye_[1], point[2] - eye_[2]);
        if (distance < near_hidden_units) return 0;
        const float near_fade = std::min(1.f, (distance - near_hidden_units) / near_ramp_units);
        const float far_fade = distance <= far_full_units ? 1
                               : distance >= far_gone_units
                                       ? 0
                                       : 1 - (distance - far_full_units) / (far_gone_units - far_full_units);
        return near_fade * far_fade * (through_walls ? 1 : seen(slot, point, trace));
    }

private:
    std::array<NameTagSight, 256> slots_{};
    float eye_[3] = {};
    double last_ = -1, dt_ = 0;

    template <class Trace>
    float seen(unsigned slot, const float *point, Trace &trace) {
        NameTagSight scratch;
        auto &sight = slot < slots_.size() ? slots_[slot] : scratch;
        sight.wait -= dt_;
        if (sight.wait <= 0 || sight.alpha < 0) {
            sight.wait = check_interval_seconds;
            sight.seen = false;
            for (const float drop : sight_drops_units) {
                const float below[] = {point[0], point[1], point[2] - drop};
                if (trace(below)) {
                    sight.seen = true;
                    break;
                }
            }
        }
        const float target = sight.seen ? 1.f : 0.f;
        if (sight.alpha < 0)
            sight.alpha = target;
        else if (target > sight.alpha)
            sight.alpha = std::min(target, sight.alpha + float(dt_) * fade_in_per_second);
        else
            sight.alpha = std::max(target, sight.alpha - float(dt_) * fade_out_per_second);
        return sight.alpha;
    }
};

// A room slot's accent (net/players.ts PALETTE): the dot on its tag and scoreboard row.
inline NameColor slot_color(unsigned slot) {
    constexpr std::array<uint32_t, 10> palette = {
            0xff7a59, 0x4fa8ff, 0x5ee08a, 0xffd84d, 0xc477ff, 0xff5d9e, 0x3fd0c9, 0xffa94d, 0x9aa3ff, 0xb6f06a
    };
    const uint32_t rgb = palette[slot % palette.size()];
    return {float(rgb >> 16) / 255, float((rgb >> 8) & 255) / 255, float(rgb & 255) / 255, 1};
}

// Ghost tags take the ghost's own colour, as on the website (player/colors.ts GHOST_CSS, or your ghost cosmetic).
inline constexpr float ghost_tag_alpha = .85f;

namespace name_tag_look {
constexpr NameColor pill = {.043f, .051f, .071f, .62f};
constexpr NameColor detail_ink = {.639f, .671f, .729f, 1};
constexpr float name_size = 13;
constexpr float detail_size = 12;
constexpr float pill_height = 22;
constexpr float dot_size = 7;
constexpr float badge_width = 18;
// Above the head: the website places the tag 76 units over the feet standing, 58 crouched.
constexpr float standing_height_units = 76;
constexpr float crouched_height_units = 58;
}  // namespace name_tag_look

inline NameAppearance faded_appearance(NameAppearance look, float opacity) {
    look.color[3] *= opacity;
    look.second[3] *= opacity;
    for (auto &badge : look.badges)
        for (auto &color : badge.colors)
            color[3] *= opacity;
    return look;
}

// One player's tag: a pill with their slot colour's dot, the name in its look and marks, then their time or style.
template <class Hud>
void draw_player_tag(
        Hud &hud,
        float x,
        float y,
        std::string_view name,
        std::string_view detail,
        const NameAppearance &look,
        NameColor dot,
        float opacity,
        double seconds
) {
    using namespace name_tag_look;
    const float name_width = hud.overlay_text_width(name, name_size) + float(name_badge_count(look)) * badge_width;
    const float detail_width = detail.empty() ? 0 : hud.overlay_text_width(detail, detail_size) + 10;
    const float width = dot_size + 10 + name_width + detail_width + 16;
    const float left = x - width / 2;
    hud.overlay_rect(left, y - 4, width, pill_height, {pill[0], pill[1], pill[2], pill[3] * opacity});
    dot[3] *= opacity;
    hud.overlay_rect(left + 8, y + 4, dot_size, dot_size, dot);
    const float name_x = left + 8 + dot_size + 6;
    hud.overlay_name(name_x, y, name, name_size, faded_appearance(look, opacity), seconds);
    if (!detail.empty())
        hud.overlay_text(
                name_x + name_width + 8,
                y + 1,
                detail,
                detail_size,
                {detail_ink[0], detail_ink[1], detail_ink[2], opacity}
        );
}

template <class Hud, class Actors, class Room, class Trace>
void draw_name_tags(
        Hud &hud,
        int width,
        int height,
        float percent,
        const float *matrix,
        const Actors &actors,
        const Room &room,
        NameTagSights &sights,
        bool players,
        bool ghosts,
        bool through_walls,
        Trace trace,
        double seconds,
        std::optional<GraphicsView> output = std::nullopt
) {
    using namespace name_tag_look;
    const HudGeometry geometry(width, height, percent);
    hud.overlay_begin(width, height, percent);
    HudLabel<48> detail;
    for (const auto &actor : actors) {
        const bool ghost = actor.id.starts_with("ghost-");
        // Slot 0's tag also shows its time and delta (draw_ghost_name_tag).
        if (actor.id == "local-camera-target" || actor.id == "ghost-0" || actor.name.empty() || actor.opacity < .05f
            || (ghost ? !ghosts : !players))
            continue;
        unsigned slot = 256;
        std::from_chars(actor.id.data(), actor.id.data() + actor.id.size(), slot);
        if (actor.snapped) sights.reset(slot);
        const bool crouched = actor.frame.flags & 1;
        const float point[] = {
                actor.frame.position[0],
                actor.frame.position[1],
                actor.frame.position[2] + (crouched ? crouched_height_units : standing_height_units)
        };
        const auto view = output.value_or(graphics_view(GraphicsSettings{}, width, height));
        const auto screen = project_name_tag(matrix, point, view, height, geometry.scale);
        if (!screen) continue;
        if (ghost) {
            if (!through_walls && !trace(point)) continue;
            NameAppearance look;
            look.color = {actor.tint[0], actor.tint[1], actor.tint[2], ghost_tag_alpha};
            hud.overlay_name((*screen)[0], (*screen)[1], actor.name, name_size, look, seconds, true);
            continue;
        }
        const float opacity = sights.opacity(slot, point, through_walls, trace);
        if (opacity <= .01f) continue;
        room.tag_detail(slot, seconds, detail);
        draw_player_tag(
                hud,
                (*screen)[0],
                (*screen)[1],
                actor.name,
                detail.view(),
                room.appearance(slot),
                slot_color(slot),
                opacity,
                seconds
        );
    }
    hud.overlay_end(width, height);
}

template <class Hud, class Actor, class Trace>
void draw_ghost_name_tag(
        Hud &hud,
        int width,
        int height,
        float percent,
        const float *matrix,
        const Actor &actor,
        std::string_view name,
        std::optional<double> seconds,
        std::string_view delta,
        bool through_walls,
        Trace trace,
        std::optional<GraphicsView> output = std::nullopt
) {
    if (actor.opacity < .05f) return;
    const float point[] = {
            actor.frame.position[0], actor.frame.position[1], actor.frame.position[2] + actor.frame.view_offset_z + 20
    };
    const HudGeometry geometry(width, height, percent);
    const auto view = output.value_or(graphics_view(GraphicsSettings{}, width, height));
    const auto screen = project_name_tag(matrix, point, view, height, geometry.scale);
    if (!screen || (!through_walls && !trace(point))) return;
    hud.overlay_begin(width, height, percent);
    const NameColor tint = {actor.tint[0], actor.tint[1], actor.tint[2], ghost_tag_alpha};
    hud.overlay_text((*screen)[0], (*screen)[1], name, 13, tint, true);
    HudLabel<128> label;
    if (seconds) label.format("%.3fs", *seconds);
    if (!delta.empty()) {
        label.append(" | ");
        label.append(delta);
    }
    hud.overlay_text((*screen)[0], (*screen)[1] + 20, label.view(), 11, tint, true);
    hud.overlay_end(width, height);
}

}  // namespace native
