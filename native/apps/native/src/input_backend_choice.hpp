#pragma once
#include <string_view>

namespace native {

enum class InputBackendChoice { automatic, sdl, raw };

inline InputBackendChoice input_backend_choice(std::string_view name) {
    if (name == "raw") return InputBackendChoice::raw;
    if (name == "sdl") return InputBackendChoice::sdl;
    return InputBackendChoice::automatic;
}

}  // namespace native
