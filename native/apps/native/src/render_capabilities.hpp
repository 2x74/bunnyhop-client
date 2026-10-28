#pragma once
#include "nlohmann/json.hpp"
#include <algorithm>

namespace native {
inline void append_render_capabilities(nlohmann::json &capabilities) {
    if (!capabilities.is_array()) capabilities = nlohmann::json::array();
    for (const char *key :
         {"paint",
          "measure",
          "ghostPb",
          "ghostWr",
          "ghostCustom",
          "ghostTrail",
          "ghostRoute",
          "ghostRouteSource",
          "ghostRouteMode",
          "tagsPlayers",
          "tagsThroughWalls",
          "graphicsPotato",
          "graphicsAntialias",
          "graphicsAnisotropy",
          "graphicsFlashlight",
          "graphicsMenuBackground",
          "graphicsBrightness",
          "graphicsGamma",
          "graphicsVibrance",
          "graphicsFullbright",
          "graphicsResolutionScale",
          "graphicsAspect",
          "graphicsAspectFit",
          "graphicsPixelated",
          "graphicsMenuFps",
          "graphicsBloom",
          "graphicsMaterialResponse",
          "graphicsSkyExposure",
          "playerGlow.aura",
          "replay.compare",
          "loadout.livePreview",
          "loadout.inspect"}) {
        if (std::find(capabilities.begin(), capabilities.end(), key) == capabilities.end()) capabilities.push_back(key);
    }
}

inline nlohmann::json render_capabilities() {
    auto result = nlohmann::json::array();
    append_render_capabilities(result);
    return result;
}
}  // namespace native
