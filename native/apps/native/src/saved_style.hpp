#pragma once
#include "json_fields.hpp"
#include "settings.hpp"
#include <nlohmann/json.hpp>
#include <optional>
#include <string>

namespace native {

// The style the player last picked (the website keeps it in localStorage as bunnyhop:style), in style.json beside
// settings.json. Only a style this build knows is used; anything else starts on the default.
inline std::optional<std::string> read_saved_style(const nlohmann::json &saved) {
    const auto style = json_value(saved, "style", std::string());
    if (!styles.contains(style)) return std::nullopt;
    return style;
}

inline nlohmann::json saved_style_json(const std::string &style) {
    return {{"style", style}};
}

}  // namespace native
