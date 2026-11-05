#pragma once
// !bright's quick menu over the game (web look-menu.ts): this map's Brightness and Fullbright (map_look.hpp). A pick
// changes the map's own values and keeps the menu open on them; 0, Esc or a click elsewhere closes it. Changes come
// back as a settings patch, which the host saves and the menu's prefs then follow, as for its own changes.
#include "hud_geometry.hpp"
#include "hud_text.hpp"
#include "map_look.hpp"
#include "menu_rows.hpp"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <array>
#include <cmath>
#include <optional>
#include <string>
#include <string_view>

namespace native {

class LookMenu {
public:
    enum Item : unsigned { darker = 1, brighter, fullbright, reset, everywhere };

    bool open() const { return open_; }

    const std::string &map() const { return map_; }

    // Opens for `map`; a second "!bright" closes it, as on the website.
    void toggle(std::string_view map, const nlohmann::json &settings) {
        if (open_ || map.empty()) {
            open_ = false;
            return;
        }
        map_ = std::string(map);
        open_ = true;
        refresh(settings);
    }

    void close() { open_ = false; }

    // The values it shows, read when the settings change (never per frame).
    void refresh(const nlohmann::json &settings) {
        if (!open_) return;
        const auto own = map_look_for(settings, map_);
        brightness_ = own.brightness.value_or(settings.value("graphicsBrightness", 1.));
        fullbright_ = own.fullbright.value_or(settings.value("graphicsFullbright", false));
        own_ = own.brightness || own.fullbright;
        brightness_label_.format("%d%%", int(std::lround(brightness_ * percent_per_unit)));
        footer_.assign(own_ ? "Set for " : "Changes here are for ");
        footer_.append(map_);
        footer_.append(" only.");
    }

    // A pick's settings patch; nothing for a row that is off ("Reset this map" while the map has nothing of its own).
    std::optional<nlohmann::json> pick(unsigned digit, const nlohmann::json &settings) const {
        if (!open_) return std::nullopt;
        if (digit == darker || digit == brighter)
            return brightness_patch(
                    brightness_ + (digit == darker ? -map_brightness_step : map_brightness_step), settings
            );
        if (digit == fullbright) return own_patch({std::nullopt, !fullbright_}, settings);
        if (!own_ || (digit != reset && digit != everywhere)) return std::nullopt;
        auto looks = current_looks(settings);
        looks.erase(map_);
        if (digit == reset) return nlohmann::json{{map_looks_key, looks}};
        // Use on all maps: this map's look becomes the global setting, and the map keeps nothing of its own.
        return nlohmann::json{
                {"graphicsBrightness", brightness_}, {"graphicsFullbright", fullbright_}, {map_looks_key, looks}
        };
    }

    std::optional<nlohmann::json> brightness_patch(double value, const nlohmann::json &settings) const {
        if (!open_) return std::nullopt;
        return own_patch({clamp_map_brightness(value), std::nullopt}, settings);
    }

    struct Key {
        bool handled = false;
        std::optional<nlohmann::json> patch;
    };

    // A digit while it is open: 1-5 pick, 0 closes. Other keys keep playing.
    Key key(std::string_view code, bool down, bool repeat, const nlohmann::json &settings) {
        if (!open_ || !down || repeat || code.size() != 6 || !code.starts_with("Digit")) return {};
        const unsigned digit = unsigned(code.back() - '0');
        if (digit == 0) {
            open_ = false;
            return {true, std::nullopt};
        }
        return {true, digit <= everywhere ? pick(digit, settings) : std::nullopt};
    }

    MenuRows rows(int width, int height, float percent) const {
        const HudGeometry geometry(width, height, percent);
        MenuRows out;
        out.width = panel_width;
        out.height = panel_height;
        out.left = geometry.width / 2 - panel_width / 2;
        out.top = geometry.height / 2 - panel_height / 2;
        for (unsigned digit = darker; digit <= everywhere; ++digit)
            out.add(digit, out.top + first_row + float(digit - 1) * row_height, row_height);
        out.add(0, out.top + close_top, row_height);
        return out;
    }

    // The brightness at a click on the bar, like the website's slider; nothing off the bar.
    std::optional<double> bar_value(int width, int height, float percent, float x, float y) const {
        constexpr float reach = 8;
        if (!open_) return std::nullopt;
        const auto layout = rows(width, height, percent);
        const float left = layout.left + text_left, middle = layout.top + bar_top + bar_height / 2;
        if (x < left - reach || x > left + bar_width + reach || std::abs(y - middle) > reach) return std::nullopt;
        const double share = std::clamp(double(x - left) / bar_width, 0., 1.);
        const double value = map_brightness_min + share * (map_brightness_max - map_brightness_min);
        return std::round(value / map_brightness_step) * map_brightness_step;
    }

    // `pointer`: the cursor in HUD units while a chat line holds it out, for the row it is on.
    template <class Hud>
    void draw(
            Hud &hud, int width, int height, float percent, std::optional<std::array<float, 2>> pointer = std::nullopt
    ) const {
        if (!open_) return;
        const auto layout = rows(width, height, percent);
        hud.overlay_begin(width, height, percent);
        hud.overlay_rect(layout.left, layout.top, layout.width, layout.height, {.025f, .027f, .04f, .96f});
        draw_menu_hover(hud, layout, layout.hovered(pointer));
        hud.overlay_text(layout.left + text_left, layout.top + 16, "Brightness", 20, amber);
        draw_bar(hud, layout);
        draw_items(hud, layout);
        hud.overlay_text(layout.left + text_left, layout.top + footer_top, footer_.view(), 12, dim);
        hud.overlay_text(layout.left + text_left, layout.rows[layout.count - 1].top + text_inset, "0. Close", 13, dim);
        hud.overlay_end(width, height);
    }

private:
    static constexpr double percent_per_unit = 100;
    static constexpr float panel_width = 440, panel_height = 296, text_left = 18, text_inset = 6;
    static constexpr float bar_top = 56, bar_width = 330, bar_height = 6;
    static constexpr float first_row = 78, row_height = 28, footer_top = 228, close_top = 252;
    static constexpr NameColor cream = {.94f, .91f, .86f, 1};
    static constexpr NameColor dim = {.63f, .65f, .70f, 1};
    static constexpr NameColor amber = {1, .71f, .24f, 1};
    // A row that does nothing yet (web .mm-item.off).
    static constexpr NameColor off_ink = {.94f, .91f, .86f, .4f};

    bool open_ = false;
    std::string map_;
    double brightness_ = 1;
    bool fullbright_ = false;
    bool own_ = false;
    HudLabel<16> brightness_label_;
    HudLabel<128> footer_;

    nlohmann::json current_looks(const nlohmann::json &settings) const {
        const auto looks = settings.find(map_looks_key);
        return looks != settings.end() && looks->is_object() ? *looks : nlohmann::json::object();
    }

    // The map's own values with `change` written over them.
    nlohmann::json own_patch(MapLook change, const nlohmann::json &settings) const {
        auto looks = current_looks(settings);
        auto look = looks.contains(map_) ? read_map_look(looks.at(map_)) : MapLook{};
        if (change.brightness) look.brightness = change.brightness;
        if (change.fullbright) look.fullbright = change.fullbright;
        looks[map_] = map_look_json(look);
        return nlohmann::json{{map_looks_key, looks}};
    }

    template <class Hud>
    void draw_bar(Hud &hud, const MenuRows &layout) const {
        const float x = layout.left + text_left, y = layout.top + bar_top;
        const float share = float((brightness_ - map_brightness_min) / (map_brightness_max - map_brightness_min));
        hud.overlay_rect(x, y, bar_width, bar_height, {1, 1, 1, .12f});
        hud.overlay_rect(x, y, bar_width * std::clamp(share, 0.f, 1.f), bar_height, amber);
        hud.overlay_text(x + bar_width + 16, y - 6, brightness_label_.view(), 14, cream);
    }

    template <class Hud>
    void draw_items(Hud &hud, const MenuRows &layout) const {
        constexpr std::array<std::string_view, 5> labels = {
                "1. Darker", "2. Brighter", "3. Fullbright", "4. Reset this map", "5. Use on all maps"
        };
        for (unsigned digit = darker; digit <= everywhere; ++digit) {
            const float y = layout.rows[digit - 1].top + text_inset;
            const bool off = !own_ && (digit == reset || digit == everywhere);
            const NameColor ink = off ? off_ink : digit == everywhere ? dim : cream;
            hud.overlay_text(layout.left + text_left, y, labels[digit - 1], 14, ink);
            if (digit == fullbright)
                hud.overlay_text(
                        layout.left + text_left + 150, y, fullbright_ ? "on" : "off", 14, fullbright_ ? amber : dim
                );
        }
    }
};

}  // namespace native
