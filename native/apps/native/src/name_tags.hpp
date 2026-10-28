#pragma once
#include "graphics_settings.hpp"
#include "hud_text.hpp"
#include "hud_geometry.hpp"
#include <nlohmann/json.hpp>
#include <array>
#include <charconv>
#include <cmath>
#include <optional>
#include <string_view>

namespace native {
using NameColor = std::array<float, 4>;
inline NameColor name_color(std::string_view value, NameColor fallback = {.94f, .91f, .86f, 1}) {
    constexpr std::array<std::string_view, 6> names = {"rose", "peach", "sand", "lime", "aqua", "periwinkle"};
    constexpr std::array<std::string_view, 6> colors = {"#ffa8cb", "#ffab8f", "#d2c2a5",
                                                        "#c4ee6a", "#6ff0f0", "#a8b8ff"};
    for (size_t i = 0; i < names.size(); ++i) {
        if (value == names[i])
            value = colors[i];
    }
    if (value.size() != 7 || value[0] != '#')
        return fallback;
    unsigned rgb = 0;
    const auto parsed = std::from_chars(value.data() + 1, value.data() + 7, rgb, 16);
    if (parsed.ec != std::errc() || parsed.ptr != value.data() + 7)
        return fallback;
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
    look.second = name_color(json_text(value, "nameColor2"),
                             {(look.color[0] + 1) / 2, (look.color[1] + 1) / 2, (look.color[2] + 1) / 2, 1});
    const auto effect = json_text(value, "nameEffect");
    look.effect = effect == "glow"                           ? NameEffect::glow
                  : effect == "paint" || effect == "shimmer" ? NameEffect::paint
                  : effect == "sparkle"                      ? NameEffect::sparkle
                                                             : NameEffect::plain;
    const auto staff = json_text(value, "staff");
    const auto role = json_text(value, "role");
    const auto add = [&](NameMark mark) { look.marks |= 1u << unsigned(mark); };
    if (staff == "developer" || role == "owner")
        add(NameMark::owner);
    else if (!staff.empty() || role == "admin" || role == "moderator" || json_flag(value, "admin"))
        add(NameMark::staff);
    if (json_flag(value, "verified"))
        add(NameMark::verified);
    if (!json_text(value, "creator").empty())
        add(NameMark::creator);
    if (json_flag(value, "booster"))
        add(NameMark::booster);
    if (json_flag(value, "supporter"))
        add(NameMark::supporter);
    const auto special = value.find("special");
    if (special != value.end() && special->is_array()) {
        for (const auto &badge : *special) {
            if (badge == "contributor")
                add(NameMark::contributor);
            if (badge == "mapper")
                add(NameMark::mapper);
        }
    }
    return look;
}

inline NameAppearance host_name_appearance(const nlohmann::json &value, const nlohmann::json &marks,
                                           NameAppearance fallback = {}) {
    auto look = fallback;
    if (value.is_object()) {
        look.color = name_color(json_text(value, "color"));
        look.second = name_color(json_text(value, "color2"),
                                 {(look.color[0] + 1) / 2, (look.color[1] + 1) / 2, (look.color[2] + 1) / 2, 1});
        const auto effect = json_text(value, "effect");
        look.effect = effect == "glow"      ? NameEffect::glow
                      : effect == "paint"   ? NameEffect::paint
                      : effect == "sparkle" ? NameEffect::sparkle
                                            : NameEffect::plain;
    }
    if (!marks.is_array())
        return look;
    look.badge_count = 0;
    look.marks = 0;
    for (const auto &mark : marks) {
        if (!mark.is_object() || look.badge_count == look.badges.size())
            continue;
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
        if (colors == mark.end() || !colors->is_array())
            continue;
        for (const auto &color : *colors) {
            if (badge.color_count == badge.colors.size())
                break;
            if (color.is_string())
                badge.colors[badge.color_count++] = name_color(color.get<std::string>(), {1, 1, 1, 1});
        }
    }
    return look;
}

inline size_t name_badge_count(const NameAppearance &look) {
    if (look.badge_count)
        return look.badge_count;
    size_t count = 0;
    for (unsigned bit = 0; bit < 15; ++bit)
        count += bool(look.marks & (1u << bit));
    return count;
}

inline NameColor name_badge_color(const NameBadge &badge, double seconds) {
    if (!badge.color_count)
        return {1, 1, 1, 1};
    if (!badge.animated || badge.color_count == 1)
        return badge.colors[0];
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

inline std::optional<std::array<float, 2>> project_name_tag(const float *matrix, const float *point, float width,
                                                            float height) {
    std::array<float, 4> clip{};
    for (unsigned row = 0; row < 4; ++row)
        clip[row] = matrix[row] * point[0] + matrix[4 + row] * point[1] + matrix[8 + row] * point[2] + matrix[12 + row];
    if (clip[3] <= 2 || std::abs(clip[0]) > clip[3] || std::abs(clip[1]) > clip[3] || std::abs(clip[2]) > clip[3])
        return std::nullopt;
    return std::array<float, 2>{(clip[0] / clip[3] * .5f + .5f) * width, (.5f - clip[1] / clip[3] * .5f) * height};
}

inline std::optional<std::array<float, 2>> project_name_tag(
    const float *matrix, const float *point, const GraphicsView &view, int height, float scale) {
    auto screen = project_name_tag(matrix, point, float(view.output_width), float(view.output_height));
    if (screen) {
        (*screen)[0] = (view.x + (*screen)[0]) / scale;
        (*screen)[1] = (height - view.y - view.output_height + (*screen)[1]) / scale;
    }
    return screen;
}

template <class Core> struct NameTagTrace {
    Core *core;
    const float *eye;
    bool operator()(const float *point) const {
        float fraction = 0;
        return bh_trace_camera(core, eye, point, 0, &fraction) && fraction >= .98f;
    }
};

template <class Hud, class Actors, class Room, class Trace>
void draw_name_tags(Hud &hud, int width, int height, float percent, const float *matrix, const Actors &actors,
                    const Room &room, bool players, bool ghosts, bool through_walls, Trace trace, double seconds,
                    std::optional<GraphicsView> output = std::nullopt) {
    const HudGeometry geometry(width, height, percent);
    hud.overlay_begin(width, height, percent);
    for (const auto &actor : actors) {
        const bool ghost = actor.id.starts_with("ghost-");
        if (actor.id == "local-camera-target" || actor.name.empty() || actor.opacity < .05f ||
            (ghost ? !ghosts : !players))
            continue;
        const float point[] = {actor.frame.position[0], actor.frame.position[1],
                               actor.frame.position[2] + actor.frame.view_offset_z + 20};
        const auto view = output.value_or(graphics_view(GraphicsSettings{}, width, height));
        const auto screen = project_name_tag(matrix, point, view, height, geometry.scale);
        if (!screen || (!through_walls && !trace(point)))
            continue;
        unsigned slot = 256;
        std::from_chars(actor.id.data(), actor.id.data() + actor.id.size(), slot);
        auto look = room.appearance(slot);
        if (ghost)
            look.color = {.55f, .85f, 1, .85f};
        hud.overlay_name((*screen)[0], (*screen)[1], actor.name, 13, look, seconds, true);
    }
    hud.overlay_end(width, height);
}
template <class Hud, class Actor, class Trace>
void draw_ghost_name_tag(Hud &hud, int width, int height, float percent, const float *matrix, const Actor &actor,
                         std::string_view name, std::optional<double> seconds, std::string_view delta,
                         bool through_walls, Trace trace, std::optional<GraphicsView> output = std::nullopt) {
    if (actor.opacity < .05f)
        return;
    const float point[] = {actor.frame.position[0], actor.frame.position[1],
                           actor.frame.position[2] + actor.frame.view_offset_z + 20};
    const HudGeometry geometry(width, height, percent);
    const auto view = output.value_or(graphics_view(GraphicsSettings{}, width, height));
    const auto screen = project_name_tag(matrix, point, view, height, geometry.scale);
    if (!screen || (!through_walls && !trace(point)))
        return;
    hud.overlay_begin(width, height, percent);
    constexpr NameColor blue = {.55f, .85f, 1, .85f};
    hud.overlay_text((*screen)[0], (*screen)[1], name, 13, blue, true);
    HudLabel<128> label;
    if (seconds)
        label.format("%.3fs", *seconds);
    if (!delta.empty()) {
        label.append(" | ");
        label.append(delta);
    }
    hud.overlay_text((*screen)[0], (*screen)[1] + 20, label.view(), 11, blue, true);
    hud.overlay_end(width, height);
}

} // namespace native
