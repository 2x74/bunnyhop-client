#pragma once
#include <optional>
#include <cstdint>
#include <string_view>

namespace native {
struct RestartNames {
    const char *targetname;
    const char *classname;
};

// apps/web/src/restart.ts MAP_FIXES: main and bonus names are independent.
inline std::optional<RestartNames> restart_names(std::string_view map, uint32_t track) {
    if (track != 0) {
        return std::nullopt;
    }
    if (map == "bhop_japan") {
        return RestartNames{"", "beginner"};
    }
    if (map == "bhop_shutdown") {
        return RestartNames{"asdf", ""};
    }
    return std::nullopt;
}
}  // namespace native
