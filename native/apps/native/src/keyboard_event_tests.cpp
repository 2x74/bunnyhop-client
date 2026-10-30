// SDL event sequences exercise the production repeat/ownership gate and exact tick commands, without a window.
#include "input_timeline.hpp"
#include "settings.hpp"
#include "client_util.hpp"
#include <SDL3/SDL.h>
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <array>

namespace {
constexpr uint64_t origin_ns = 1'000'000'000;
constexpr uint64_t millisecond_ns = 1'000'000;
constexpr uint64_t tick_ns = 10 * millisecond_ns;

struct Keyboard {
    native::Input input;
    native::InputTimeline timeline;
    std::set<std::string> held;
    uint64_t boundary = origin_ns;
    unsigned presses = 0;

    Keyboard() {
        timeline.rebuild_binds(native::default_settings().at("binds"));
        timeline.queue().holdback_ms = 0;
    }

    void event(SDL_Event event, bool menu = false) {
        const bool down = event.type == SDL_EVENT_KEY_DOWN;
        const auto repeat =
                timeline.key_event(event.key.scancode, down, event.key.repeat, native::game_owns_keyboard(menu, true));
        if (!repeat) return;
        if (down && !*repeat) ++presses;
        const std::string code = native::key_code(event.key.scancode);
        if (code.empty()) return;
        timeline.key(held, code, down, false, event.key.timestamp, origin_ns + 50 * millisecond_ns);
    }

    BhCmd tick() {
        timeline.take_tick(input, boundary, tick_ns, false);
        input.held = timeline.held(held);
        return input.command();
    }
};

SDL_Event key(uint64_t milliseconds, SDL_Scancode scancode, bool down, bool repeat = false) {
    SDL_Event event{};
    event.type = down ? SDL_EVENT_KEY_DOWN : SDL_EVENT_KEY_UP;
    event.key.timestamp = origin_ns + milliseconds * millisecond_ns;
    event.key.scancode = scancode;
    event.key.down = down;
    event.key.repeat = repeat;
    return event;
}

void pinned_commands(const std::array<BhCmd, 4> &commands, const std::array<uint32_t, 4> &buttons) {
    for (size_t index = 0; index < commands.size(); ++index) {
        const auto &command = commands[index];
        assert(command.buttons == buttons[index]);
        const float side = buttons[index] == native::left ? -450 : buttons[index] == native::right ? 450 : 0;
        assert(command.side == side && command.forward == 0);
        assert(command.yaw == 0 && command.pitch == 0);
    }
}

void menu_repeat_does_not_poison_gameplay() {
    Keyboard keyboard;
    keyboard.event(key(1, SDL_SCANCODE_A, true));
    assert(keyboard.tick().buttons == native::left);
    keyboard.timeline.keyboard_focus_lost();
    keyboard.timeline.release(keyboard.input, keyboard.held);
    // WebView2 holds focus: raw events may leak to SDL; the release is lost.
    keyboard.event(key(11, SDL_SCANCODE_D, true), true);
    keyboard.event(key(12, SDL_SCANCODE_D, true, true), true);
    // SDL's stale state labels this real post-menu press as a repeat.
    keyboard.event(key(21, SDL_SCANCODE_D, true, true));
    keyboard.event(key(22, SDL_SCANCODE_D, true, true));
    keyboard.event(key(31, SDL_SCANCODE_D, false));
    const std::array<BhCmd, 4> commands{keyboard.tick(), keyboard.tick(), keyboard.tick(), keyboard.tick()};
    pinned_commands(commands, {0, native::right, 0, 0});
    assert(keyboard.presses == 2);
}

void captured_switches_keep_subframe_edges() {
    Keyboard keyboard;
    keyboard.event(key(2, SDL_SCANCODE_A, true));
    keyboard.event(key(12, SDL_SCANCODE_A, false));
    keyboard.event(key(12, SDL_SCANCODE_D, true));
    keyboard.event(key(22, SDL_SCANCODE_D, false));
    keyboard.event(key(23, SDL_SCANCODE_A, true));
    keyboard.event(key(31, SDL_SCANCODE_A, false));
    const std::array<BhCmd, 4> commands{keyboard.tick(), keyboard.tick(), keyboard.tick(), keyboard.tick()};
    pinned_commands(commands, {native::left, native::right, native::left, 0});
    assert(keyboard.presses == 3);
    keyboard.event(key(41, SDL_SCANCODE_D, true));
    keyboard.timeline.keyboard_focus_lost();
    keyboard.timeline.release(keyboard.input, keyboard.held);
    keyboard.event(key(42, SDL_SCANCODE_D, true, true));
    assert(keyboard.tick().buttons == native::right);
    keyboard.event(key(51, SDL_SCANCODE_D, false));
    assert(keyboard.tick().buttons == 0);
}

void focus_loss_releases_modifiers() {
    const std::array modifiers{
            SDL_SCANCODE_LCTRL,
            SDL_SCANCODE_RCTRL,
            SDL_SCANCODE_LSHIFT,
            SDL_SCANCODE_RSHIFT,
            SDL_SCANCODE_LALT,
            SDL_SCANCODE_RALT,
            SDL_SCANCODE_LGUI,
            SDL_SCANCODE_RGUI
    };
    for (const auto scancode : modifiers) {
        Keyboard keyboard;
        const std::string code = native::key_code(scancode);
        const uint32_t expected = code.empty() ? 0 : native::duck;
        const auto codes = code.empty() ? nlohmann::json::array() : nlohmann::json::array({code});
        keyboard.timeline.rebuild_binds({{"duck", codes}});
        keyboard.event(key(1, scancode, true));
        assert(keyboard.tick().buttons == expected);
        keyboard.timeline.keyboard_focus_lost();
        keyboard.timeline.release(keyboard.input, keyboard.held);
        assert(keyboard.tick().buttons == 0);
        keyboard.event(key(21, scancode, true, true), true);
        keyboard.event(key(22, scancode, false), true);
        keyboard.event(key(31, scancode, true, true));
        assert(keyboard.tick().buttons == 0);
        assert(keyboard.tick().buttons == expected);
        keyboard.event(key(41, scancode, false));
        assert(keyboard.tick().buttons == 0);
        assert(keyboard.presses == 2);
    }
}
}  // namespace

int main() {
    focus_loss_releases_modifiers();
    menu_repeat_does_not_poison_gameplay();
    captured_switches_keep_subframe_edges();
}
