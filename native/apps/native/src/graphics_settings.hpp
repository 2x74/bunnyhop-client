#pragma once
#include "nlohmann/json.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <stdexcept>
#include <string>
#include <string_view>

namespace native {
inline nlohmann::json default_graphics_settings() {
    return {{"graphics",
             {{"preset", "source"},
              {"quality", "high"},
              {"antialias", true},
              {"msaa", 4},
              {"anisotropy", 8},
              {"resolutionScale", 1.0},
              {"aspect", "native"},
              {"aspectFit", "stretch"},
              {"pixelated", false},
              {"brightness", 1.0},
              {"gamma", 1.0},
              {"vibrance", 1.0},
              {"fullbright", false},
              {"potato", false},
              {"menuBackground", "live"},
              {"waterReflections", false}}},
            {"ghost",
             {{"pb", true},
              {"wr", true},
              {"custom", true},
              {"trail", true},
              {"route", false},
              {"routeSource", "auto"},
              {"routeMode", "jumps"}}},
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
        if (settings.contains(key) && settings.at(key) == "runner") {
            settings[key] = "bunny";
        }
    }
}
inline constexpr std::array<std::string_view, 14> paint_colors = {"#ff4040", "#ff8c32", "#ffd740", "#9aff40", "#30ce60",
                                                                  "#30d5c8", "#40dcff", "#4090ff", "#7650ff", "#bf50ff",
                                                                  "#ff50c0", "#ffffff", "#999999", "#202020"};
inline void graphics_choice(const nlohmann::json &value, std::initializer_list<std::string_view> choices) {
    if (!value.is_string()) {
        throw std::runtime_error("Graphics choice must be text");
    }
    const auto &text = value.get_ref<const std::string &>();
    if (std::find(choices.begin(), choices.end(), text) == choices.end()) {
        throw std::runtime_error("Unsupported graphics choice: " + text);
    }
}
inline void graphics_number(const nlohmann::json &value, double low, double high, bool integer = false) {
    if (!value.is_number()) {
        throw std::runtime_error("Graphics value must be a number");
    }
    const double number = value.get<double>();
    if (!std::isfinite(number) || number < low || number > high || (integer && number != std::floor(number))) {
        throw std::runtime_error("Graphics value outside supported range");
    }
}
inline void apply_graphics_quality(nlohmann::json &graphics, const std::string &quality) {
    graphics["potato"] = quality == "lowest" || quality == "low";
    graphics["antialias"] = quality == "high";
    graphics["anisotropy"] = quality == "high" ? 8 : quality == "medium" ? 4 : 1;
    graphics["resolutionScale"] = quality == "lowest" ? .5 : 1.;
    graphics["waterReflections"] = false;
}
// Called by patch_settings before its generic scalar validation. Nested patches are atomic and reject unknown keys.
inline bool patch_graphics_setting(nlohmann::json &out, const std::string &key, const nlohmann::json &patch) {
    const auto defaults = default_graphics_settings();
    if (!defaults.contains(key)) {
        return false;
    }
    if (!patch.is_object() || patch.size() > defaults.at(key).size()) {
        throw std::runtime_error("Invalid graphics settings object");
    }
    auto next = out.contains(key) ? out.at(key) : defaults.at(key);
    for (const auto &[field, value] : patch.items()) {
        if (!defaults.at(key).contains(field)) {
            throw std::runtime_error("Unknown " + key + " setting: " + field);
        }
        if (defaults.at(key).at(field).is_boolean()) {
            if (!value.is_boolean()) {
                throw std::runtime_error("Graphics toggle must be true or false");
            }
            if (field == "waterReflections" && value.get<bool>()) {
                throw std::runtime_error("Water reflections are unavailable in the native renderer");
            }
        } else if (field == "quality") {
            graphics_choice(value, {"lowest", "low", "medium", "high", "custom"});
        } else if (field == "preset") {
            graphics_choice(value, {"source", "classic"});
        } else if (field == "aspect") {
            graphics_choice(value, {"native", "4:3", "5:4", "16:10", "16:9"});
        } else if (field == "aspectFit") {
            graphics_choice(value, {"stretch", "bars"});
        } else if (field == "menuBackground") {
            graphics_choice(value, {"live", "still", "off"});
        } else if (field == "routeSource") {
            graphics_choice(value, {"auto", "pb", "wr", "custom"});
        } else if (field == "routeMode") {
            graphics_choice(value, {"jumps", "path"});
        } else if (field == "size") {
            graphics_choice(value, {"small", "medium", "large"});
        } else if (field == "color") {
            if (!value.is_string() || std::find(paint_colors.begin(), paint_colors.end(),
                                                value.get_ref<const std::string &>()) == paint_colors.end()) {
                throw std::runtime_error("Unknown paint colour");
            }
        } else if (field == "msaa" || field == "anisotropy") {
            graphics_number(value, field == "msaa" ? 0 : 1, field == "msaa" ? 8 : 16, true);
            const int count = value.get<int>();
            if (count && (count & (count - 1))) {
                throw std::runtime_error("Sample count must be a power of two");
            }
        } else {
            const double low = field == "resolutionScale" ? .25 : field == "vibrance" ? 0 : .5;
            graphics_number(value, low, field == "gamma" ? 2.5 : 2);
        }
        next[field] = value;
    }
    if (key == "graphics" && patch.contains("quality") && patch.at("quality") != "custom") {
        apply_graphics_quality(next, patch.at("quality"));
        next.update(patch);
    }
    out[key] = std::move(next);
    return true;
}
struct GraphicsSettings {
    float resolution_scale = 1, aspect = 0, brightness = 1, gamma = 1, vibrance = 1;
    int samples = 0, anisotropy = 8;
    bool bars = false, pixelated = false, fullbright = false, potato = false, source = true;
    enum class Background { live, still, off } background = Background::live;
    static GraphicsSettings read(const nlohmann::json &settings) {
        GraphicsSettings result;
        auto validated = default_graphics_settings();
        if (settings.contains("graphics")) {
            patch_graphics_setting(validated, "graphics", settings.at("graphics"));
        }
        const auto &value = validated.at("graphics");
        result.resolution_scale = value.at("resolutionScale");
        result.brightness = value.at("brightness");
        result.gamma = value.at("gamma");
        result.vibrance = value.at("vibrance");
        result.samples = value.at("antialias").get<bool>() ? value.at("msaa").get<int>() : 0;
        result.anisotropy = value.at("anisotropy");
        result.bars = value.at("aspectFit") == "bars";
        result.pixelated = value.at("pixelated");
        result.fullbright = value.at("fullbright");
        result.potato = value.at("potato");
        result.source = value.at("preset") == "source";
        const auto &aspect = value.at("aspect");
        result.aspect = aspect == "4:3"     ? 4.f / 3
                        : aspect == "5:4"   ? 1.25f
                        : aspect == "16:10" ? 1.6f
                        : aspect == "16:9"  ? 16.f / 9
                                            : 0;
        result.background = value.at("menuBackground") == "off"     ? Background::off
                            : value.at("menuBackground") == "still" ? Background::still
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
inline nlohmann::json graphics_capabilities() {
    return {"ghost.sources",
            "ghost.trail",
            "ghost.route",
            "playerGlow.aura",
            "graphics.quality",
            "graphics.preset.source",
            "graphics.preset.classic",
            "graphics.antialias",
            "graphics.msaa",
            "graphics.anisotropy",
            "graphics.resolutionScale",
            "graphics.aspect",
            "graphics.aspectFit",
            "graphics.pixelated",
            "graphics.brightness",
            "graphics.gamma",
            "graphics.vibrance",
            "graphics.fullbright",
            "graphics.potato",
            "graphics.menuBackground",
            "paint",
            "measure",
            "replay.compare",
            "replay.freePath",
            "loadout.livePreview",
            "loadout.inspect"};
}
} // namespace native
