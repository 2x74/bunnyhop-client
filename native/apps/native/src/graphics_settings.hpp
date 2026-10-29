#pragma once
#include "nlohmann/json.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>

namespace native {
inline nlohmann::json default_graphics_settings() {
    return {{"ghostPb", true},
            {"ghostWr", true},
            {"ghostCustom", true},
            {"ghostTrail", true},
            {"ghostRoute", false},
            {"ghostRouteSource", "auto"},
            {"ghostRouteMode", "jumps"},
            {"tagsPlayers", true},
            {"tagsThroughWalls", false},
            {"graphicsPotato", false},
            {"graphicsAntialias", true},
            {"graphicsWaterReflections", true},
            {"graphicsAnisotropy", 8},
            {"graphicsFlashlight", false},
            {"graphicsMenuBackground", "live"},
            {"graphicsBrightness", 1.},
            {"graphicsGamma", 1.},
            {"graphicsVibrance", 1.},
            {"graphicsFullbright", false},
            {"graphicsResolutionScale", 1.},
            {"graphicsAspect", "native"},
            {"graphicsAspectFit", "stretch"},
            {"graphicsPixelated", false},
            {"graphicsMenuFps", 0},
            {"graphicsBloom", true},
            {"graphicsMaterialResponse", true},
            {"graphicsSkyExposure", 0.},
            {"paint", {{"color", "#ff4040"}, {"size", "medium"}}}};
}

inline nlohmann::json default_graphics_binds() {
    return {{"paint", nlohmann::json::array()},
            {"paintOnce", nlohmann::json::array()},
            {"clearPaint", nlohmann::json::array()},
            {"measurePoint", nlohmann::json::array()},
            {"clearMeasure", nlohmann::json::array()}};
}

inline void migrate_retired_models(nlohmann::json &settings) {
    for (const auto *key : {"playerModel", "ghostModel"}) {
        if (settings.contains(key) && settings.at(key) == "runner") settings[key] = "bunny";
    }
}

inline constexpr std::array<std::string_view, 14> paint_colors = {
        "#ff4040",
        "#ff8c32",
        "#ffd740",
        "#9aff40",
        "#30ce60",
        "#30d5c8",
        "#40dcff",
        "#4090ff",
        "#7650ff",
        "#bf50ff",
        "#ff50c0",
        "#ffffff",
        "#999999",
        "#202020"
};

inline void graphics_choice(const nlohmann::json &value, std::initializer_list<std::string_view> choices) {
    if (!value.is_string()) throw std::runtime_error("Graphics choice must be text");
    const auto &text = value.get_ref<const std::string &>();
    if (std::find(choices.begin(), choices.end(), text) == choices.end())
        throw std::runtime_error("Unsupported choice: " + text);
}

inline void graphics_number(const nlohmann::json &value, double low, double high, bool integer = false) {
    if (!value.is_number()) throw std::runtime_error("Graphics value must be a number");
    const double number = value.get<double>();
    if (!std::isfinite(number) || number < low || number > high || (integer && number != std::floor(number))) {
        throw std::runtime_error("Graphics value outside supported range");
    }
}

inline void apply_graphics_quality(nlohmann::json &settings, const std::string &quality) {
    settings["graphicsPotato"] = quality == "lowest" || quality == "low";
    settings["graphicsAntialias"] = quality == "high";
    settings["graphicsAnisotropy"] = quality == "high" ? 8 : quality == "medium" ? 4 : 1;
    settings["graphicsResolutionScale"] = quality == "lowest" ? .5 : 1.;
    settings["graphicsWaterReflections"] = quality == "high";
}

// settings.hpp calls this before scalar validation. Keys/defaults match settings-keys.ts owned by the menu.
inline bool patch_graphics_setting(nlohmann::json &out, const std::string &key, const nlohmann::json &value) {
    const auto defaults = default_graphics_settings();
    if (!defaults.contains(key)) return false;
    if (key == "paint") {
        if (!value.is_object() || value.size() > 2) throw std::runtime_error("Invalid paint settings");
        auto next = out.contains(key) ? out.at(key) : defaults.at(key);
        for (const auto &[field, entry] : value.items()) {
            if (field == "size")
                graphics_choice(entry, {"small", "medium", "large"});
            else if (field == "color") {
                if (!entry.is_string()
                    || std::find(paint_colors.begin(), paint_colors.end(), entry.get_ref<const std::string &>())
                               == paint_colors.end())
                    throw std::runtime_error("Unknown paint colour");
            } else
                throw std::runtime_error("Unknown paint setting");
            next[field] = entry;
        }
        out[key] = std::move(next);
        return true;
    }
    if (defaults.at(key).is_boolean()) {
        if (!value.is_boolean()) throw std::runtime_error("Graphics toggle must be true or false");
    } else if (key == "ghostRouteSource")
        graphics_choice(value, {"auto", "pb", "wr", "custom"});
    else if (key == "ghostRouteMode")
        graphics_choice(value, {"jumps", "path"});
    else if (key == "graphicsAspect")
        graphics_choice(value, {"native", "4:3", "5:4", "16:10", "16:9"});
    else if (key == "graphicsAspectFit")
        graphics_choice(value, {"stretch", "bars"});
    else if (key == "graphicsMenuBackground")
        graphics_choice(value, {"live", "still", "off"});
    else if (key == "graphicsAnisotropy" || key == "graphicsMenuFps") {
        if (!value.is_number()) throw std::runtime_error("Graphics choice must be numeric");
        const double number = value.get<double>();
        const bool valid = key == "graphicsMenuFps"
                                   ? (number == 0 || number == 30 || number == 60 || number == 120)
                                   : (number == 1 || number == 2 || number == 4 || number == 8 || number == 16);
        if (!valid) throw std::runtime_error("Unsupported graphics choice");
    } else {
        const double low = key == "graphicsSkyExposure"       ? -4
                           : key == "graphicsResolutionScale" ? .25
                           : key == "graphicsVibrance"        ? 0
                                                              : .5;
        const double high = key == "graphicsSkyExposure" ? 4 : key == "graphicsGamma" ? 2.5 : 2;
        graphics_number(value, low, high);
    }
    out[key] = value;
    return true;
}

inline void toggle_graphics_flashlight(nlohmann::json &settings, bool &enabled) {
    enabled = !enabled;
    settings["graphicsFlashlight"] = enabled;
}

struct GraphicsSettings {
    float resolution_scale = 1, aspect = 0, brightness = 1, gamma = 1, vibrance = 1, sky_exposure = 0;
    int samples = 0, anisotropy = 8, menu_fps = 0;
    bool bars = false, pixelated = false, fullbright = false, potato = false, source = true;
    bool bloom = true, material_response = true, flashlight = false, tags_players = true, tags_through_walls = false;
    enum class Background { live, still, off } background = Background::live;

    static GraphicsSettings read(const nlohmann::json &settings) {
        auto values = default_graphics_settings();
        for (const auto &[key, value] : settings.items())
            patch_graphics_setting(values, key, value);
        GraphicsSettings result;
        result.resolution_scale = values.at("graphicsResolutionScale");
        result.brightness = values.at("graphicsBrightness");
        result.gamma = values.at("graphicsGamma");
        result.vibrance = values.at("graphicsVibrance");
        result.samples = values.at("graphicsAntialias").get<bool>() ? 4 : 0;
        result.anisotropy = values.at("graphicsAnisotropy");
        result.menu_fps = values.at("graphicsMenuFps");
        result.bars = values.at("graphicsAspectFit") == "bars";
        result.pixelated = values.at("graphicsPixelated");
        result.fullbright = values.at("graphicsFullbright");
        result.potato = values.at("graphicsPotato");
        result.source = settings.value("sourceLook", true);
        result.bloom = values.at("graphicsBloom");
        result.material_response = values.at("graphicsMaterialResponse");
        result.flashlight = values.at("graphicsFlashlight");
        result.sky_exposure = values.at("graphicsSkyExposure");
        result.tags_players = values.at("tagsPlayers");
        result.tags_through_walls = values.at("tagsThroughWalls");
        const auto &aspect = values.at("graphicsAspect");
        result.aspect = aspect == "4:3"     ? 4.f / 3
                        : aspect == "5:4"   ? 1.25f
                        : aspect == "16:10" ? 1.6f
                        : aspect == "16:9"  ? 16.f / 9
                                            : 0;
        result.background = values.at("graphicsMenuBackground") == "off"     ? Background::off
                            : values.at("graphicsMenuBackground") == "still" ? Background::still
                                                                             : Background::live;
        return result;
    }

    bool target_needed() const {
        return samples > 0 || resolution_scale != 1 || aspect > 0 || brightness != 1 || gamma != 1 || vibrance != 1;
    }
};

struct GraphicsView {
    int width = 1, height = 1, x = 0, y = 0, output_width = 1, output_height = 1;
};

inline GraphicsView graphics_view(const GraphicsSettings &settings, int width, int height) {
    GraphicsView view;
    view.output_width = std::max(1, width);
    view.output_height = std::max(1, height);
    if (settings.aspect > 0 && settings.bars) {
        view.output_width = std::min(width, int(std::round(height * settings.aspect)));
        view.output_height = std::min(height, int(std::round(width / settings.aspect)));
        view.x = (width - view.output_width) / 2;
        view.y = (height - view.output_height) / 2;
    }
    const float source_width = settings.aspect > 0 ? view.output_height * settings.aspect : view.output_width;
    view.width = std::max(1, int(std::round(source_width * settings.resolution_scale)));
    view.height = std::max(1, int(std::round(view.output_height * settings.resolution_scale)));
    return view;
}

struct GraphicsMenuPacer {
    int limit = 0, game_limit = 500;

    void settings(const nlohmann::json &settings) {
        limit = settings.value("graphicsMenuFps", 0);
        game_limit = settings.value("fpsLimit", 500);
    }

    template <class Delay, class PreciseDelay>
    void
    frame(bool has_core,
          bool live_backdrop,
          bool focused,
          bool loading,
          bool scripted,
          bool captured,
          bool menu_visible,
          double spent,
          Delay delay,
          PreciseDelay precise_delay) const {
        if (pace(menu_visible, spent, delay)) return;
        constexpr double home_frame_seconds = 1. / 62;
        constexpr uint64_t idle_delay_ns = 10000000;
        if (!has_core && live_backdrop && focused && !loading) {
            if (spent < home_frame_seconds) delay(uint64_t((home_frame_seconds - spent) * 1e9));
        } else if (!has_core || loading || (!scripted && (!focused || !captured)))
            delay(idle_delay_ns);
        else if (!scripted && game_limit > 0) {
            const double target = 1. / game_limit;
            if (spent < target) precise_delay(uint64_t((target - spent) * 1e9));
        }
    }

    template <class Delay>
    bool pace(bool active, double spent, Delay delay) const {
        if (!active || !limit) return false;
        const double target = 1. / limit;
        if (spent < target) delay(uint64_t((target - spent) * 1e9));
        return true;
    }
};
}  // namespace native
