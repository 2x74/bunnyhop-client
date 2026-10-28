// Keyboard focus around the menu web view in each window mode (macOS): the
// menu takes it when shown and the game view gets it back when hidden.
#include "menu_webview.hpp"
#include "window_sdl.hpp"
#include <Cocoa/Cocoa.h>
#include <cassert>
#include <iostream>
#include <string>

namespace {

const char* kMenuHtml = "<!doctype html><html><body><button>Play</button></body></html>";

NSWindow* cocoa_window(SDL_Window* window) {
    const auto properties = SDL_GetWindowProperties(window);
    return (__bridge NSWindow*)SDL_GetPointerProperty(properties, SDL_PROP_WINDOW_COCOA_WINDOW_POINTER, nullptr);
}

void pump() {
    SDL_Event event;
    while (SDL_PollEvent(&event)) {
    }
}

void check_mode(const std::string& mode) {
    SDL_Window* window = SDL_CreateWindow("Bunnyhop menu focus test", 800, 600, SDL_WINDOW_HIDDEN | SDL_WINDOW_RESIZABLE);
    assert(window);
    native::WindowController controller(window);
    auto settings = native::default_window_settings();
    settings["windowMode"] = mode;
    if (!controller.apply(settings))
        std::cout << mode << " unavailable for a hidden window: " << controller.error() << '\n';
    {
        native::MenuWebView menu(window, kMenuHtml);
        assert(menu.available());
        NSWindow* cocoa = cocoa_window(window);
        NSView* game = cocoa.contentView;
        [cocoa makeFirstResponder:game];

        for (int round = 0; round < 3; ++round) {
            menu.set_visible(true);
            pump();
            assert(menu.visible());
            assert(menu.has_keyboard_focus());
            menu.set_visible(false);
            pump();
            assert(!menu.has_keyboard_focus());
            assert(cocoa.firstResponder == game);
        }

        // At launch the window itself is the first responder: closing the
        // menu still hands keys to the game view.
        [cocoa makeFirstResponder:nil];
        assert(cocoa.firstResponder == cocoa);
        menu.set_visible(true);
        assert(menu.has_keyboard_focus());
        menu.set_visible(false);
        assert(cocoa.firstResponder == game);
    }
    SDL_DestroyWindow(window);
}

}

int main() {
    @autoreleasepool {
        if (!SDL_Init(SDL_INIT_VIDEO)) {
            std::cout << "SDL video unavailable: " << SDL_GetError() << '\n';
            return 77;
        }
        for (const char* mode : {"windowed", "borderless", "fullscreen"})
            check_mode(mode);
        SDL_Quit();
    }
}
