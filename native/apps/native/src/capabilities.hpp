#pragma once
#include "render_capabilities.hpp"
#include "settings.hpp"
#include <array>
#include <string_view>

namespace native {
inline constexpr std::array<std::string_view, 23> web_hud_elements = {
    "speed",         "timer",    "split",         "track",     "stage",    "stats",      "sync",    "keys",
    "ghostKeys",     "graph",    "jumpStats",     "map",       "pb",       "fps",        "chat",    "ammo",
    "strafeTrainer", "startPre", "strafeOffsets", "firstJump", "longJump", "spectators", "practice"};
inline void append_capabilities(Json &result, const Json &entries) {
    for (const auto &entry : entries) {
        if (entry.is_string() && std::find(result.begin(), result.end(), entry) == result.end())
            result.push_back(entry);
    }
}

// Subsystems contribute here so state publication has one capability field.
inline const Json &native_capabilities() {
    static const Json capabilities = [] {
        Json result = hud_capabilities();
        for (const auto id : web_hud_elements)
            result.push_back("hud:" + std::string(id));
        append_render_capabilities(result);
        return result;
    }();
    return capabilities;
}
} // namespace native
