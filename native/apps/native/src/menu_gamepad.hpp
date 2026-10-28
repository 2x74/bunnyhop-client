#pragma once
#include <SDL3/SDL.h>
#include <nlohmann/json.hpp>
#include <array>
#include <optional>

namespace native {
// SDL supplies menu input even when the platform WebView lacks navigator.getGamepads.
class MenuGamepad {
    SDL_Gamepad *pad = nullptr;
    uint64_t scan = 0, sent = 0;
    nlohmann::json previous;

public:
    MenuGamepad() { SDL_InitSubSystem(SDL_INIT_GAMEPAD); }

    ~MenuGamepad() {
        if (pad) SDL_CloseGamepad(pad);
        SDL_QuitSubSystem(SDL_INIT_GAMEPAD);
    }

    std::optional<nlohmann::json> sample(bool active, uint64_t now = SDL_GetTicksNS()) {
        if (pad && !SDL_GamepadConnected(pad)) {
            SDL_CloseGamepad(pad);
            pad = nullptr;
        }
        if (active && !pad && now >= scan) {
            int count = 0;
            auto ids = SDL_GetGamepads(&count);
            for (int i = 0; i < count && !pad; ++i)
                pad = SDL_OpenGamepad(ids[i]);
            SDL_free(ids);
            scan = now + 1000000000;
        }
        std::array<float, 17> buttons{};
        std::array<float, 4> axes{};
        if (active && pad) {
            constexpr SDL_GamepadButton mapping[] = {
                    SDL_GAMEPAD_BUTTON_SOUTH,
                    SDL_GAMEPAD_BUTTON_EAST,
                    SDL_GAMEPAD_BUTTON_WEST,
                    SDL_GAMEPAD_BUTTON_NORTH,
                    SDL_GAMEPAD_BUTTON_LEFT_SHOULDER,
                    SDL_GAMEPAD_BUTTON_RIGHT_SHOULDER,
                    SDL_GAMEPAD_BUTTON_INVALID,
                    SDL_GAMEPAD_BUTTON_INVALID,
                    SDL_GAMEPAD_BUTTON_BACK,
                    SDL_GAMEPAD_BUTTON_START,
                    SDL_GAMEPAD_BUTTON_LEFT_STICK,
                    SDL_GAMEPAD_BUTTON_RIGHT_STICK,
                    SDL_GAMEPAD_BUTTON_DPAD_UP,
                    SDL_GAMEPAD_BUTTON_DPAD_DOWN,
                    SDL_GAMEPAD_BUTTON_DPAD_LEFT,
                    SDL_GAMEPAD_BUTTON_DPAD_RIGHT,
                    SDL_GAMEPAD_BUTTON_GUIDE
            };
            for (size_t i = 0; i < buttons.size(); ++i)
                if (mapping[i] != SDL_GAMEPAD_BUTTON_INVALID)
                    buttons[i] = SDL_GetGamepadButton(pad, mapping[i]) ? 1.f : 0.f;
            buttons[6] = SDL_GetGamepadAxis(pad, SDL_GAMEPAD_AXIS_LEFT_TRIGGER) / 32767.f;
            buttons[7] = SDL_GetGamepadAxis(pad, SDL_GAMEPAD_AXIS_RIGHT_TRIGGER) / 32767.f;
            for (int i = 0; i < 4; ++i) {
                const auto v = SDL_GetGamepadAxis(pad, SDL_GamepadAxis(i));
                axes[i] = v / (v < 0 ? 32768.f : 32767.f);
            }
        }
        nlohmann::json state = {{"buttons", buttons}, {"axes", axes}, {"connected", active && pad != nullptr}};
        // Held directions need repeat ticks, but never at uncapped gameplay FPS.
        if (state == previous && (!active || !pad || now - sent < 16666667)) return std::nullopt;
        previous = state;
        sent = now;
        return state;
    }
};
}  // namespace native
