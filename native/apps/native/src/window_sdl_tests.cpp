#include "window_sdl.hpp"
#include <cassert>
#include <iostream>

namespace {

void window_size(SDL_Window* window, int& width, int& height) {
    SDL_SyncWindow(window);
    SDL_GetWindowSize(window, &width, &height);
}

// Borderless and back returns this session's windowed bounds, even when bounds
// are not remembered across launches.
void borderless_round_trip(SDL_Window* window, native::WindowController& controller) {
    auto settings = native::default_window_settings();
    settings["rememberWindowBounds"] = false;
    SDL_SetWindowSize(window, 820, 610);
    SDL_SyncWindow(window);
    controller.observe_bounds();

    auto borderless = settings;
    borderless["windowMode"] = "borderless";
    if (!controller.apply(borderless) || controller.mode() != "borderless") {
        std::cout << "Borderless unavailable for a hidden window here: " << controller.error() << '\n';
        return;
    }
    // Not windowed: the bounds to save are the last windowed ones.
    const auto kept = controller.saved_bounds();
    assert(kept && kept->width == 820 && kept->height == 610);

    assert(controller.apply(settings));
    assert(controller.mode() == "windowed");
    int width = 0, height = 0;
    window_size(window, width, height);
    assert(width == 820 && height == 610);
    assert(!(SDL_GetWindowFlags(window) & SDL_WINDOW_BORDERLESS));
    // Only Windows borderless re-fits itself.
    assert(!controller.refit());
}

// Launching into borderless with saved bounds: windowed later returns to them.
void launch_into_borderless() {
    auto* window = SDL_CreateWindow("Bunnyhop window launch test", 1280, 720, SDL_WINDOW_HIDDEN | SDL_WINDOW_RESIZABLE);
    assert(window);
    {
        native::WindowController controller(window);
        auto settings = native::default_window_settings();
        settings["windowMode"] = "borderless";
        const native::WindowBounds saved{40, 60, 900, 700, false};
        if (controller.apply(settings, true, saved) && controller.mode() == "borderless") {
            settings["windowMode"] = "windowed";
            assert(controller.apply(settings));
            int width = 0, height = 0;
            window_size(window, width, height);
            assert(width == 900 && height == 700);
        } else {
            std::cout << "Launch into borderless unavailable for a hidden window here\n";
        }
    }
    SDL_DestroyWindow(window);
}

}

int main(){if(!SDL_Init(SDL_INIT_VIDEO)){std::cout<<"SDL window test unavailable: "<<SDL_GetError()<<'\n';return 77;}auto* window=SDL_CreateWindow("Bunnyhop window settings test",800,600,SDL_WINDOW_HIDDEN|SDL_WINDOW_RESIZABLE);if(!window){std::cout<<"SDL hidden window unavailable: "<<SDL_GetError()<<'\n';SDL_Quit();return 77;}
 native::WindowController controller(window);auto settings=native::default_window_settings();assert(controller.mode()=="windowed");assert(controller.apply(settings));const auto bounds=controller.observe_bounds();if(bounds)assert(bounds->width==800&&bounds->height==600);
 auto invalid=settings;invalid["windowMode"]="invalid";assert(!controller.apply(invalid)&&controller.mode()=="windowed"&&!controller.error().empty());
 settings["alwaysOnTop"]=true;const bool topSupported=controller.apply(settings);if(topSupported)assert(SDL_GetWindowFlags(window)&SDL_WINDOW_ALWAYS_ON_TOP);else assert(controller.mode()=="windowed");settings["alwaysOnTop"]=false;assert(controller.apply(settings));
 if(!controller.center())assert(!controller.error().empty());const bool maximizeSupported=controller.maximize();if(maximizeSupported){SDL_SyncWindow(window);if(SDL_GetWindowFlags(window)&SDL_WINDOW_MAXIMIZED)assert(controller.maximize());}
 assert(!(SDL_GetWindowFlags(window)&SDL_WINDOW_FULLSCREEN));assert(!controller.focus_lost(settings));settings["minimizeOnFocusLoss"]=true;assert(!controller.focus_lost(settings));
 assert(controller.apply(settings,true,native::WindowBounds{100000,100000,800,600,false}));
 assert(controller.mode()=="windowed");
 borderless_round_trip(window, controller);
 SDL_HideWindow(window);SDL_DestroyWindow(window);
 launch_into_borderless();
 SDL_Quit();}
