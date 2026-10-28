#include "app_identity.hpp"
#include <iostream>

int main() {
    if (!SDL_SetAppMetadata(native::app_name, nullptr, native::app_id) || !SDL_Init(SDL_INIT_VIDEO)) return 1;
    SDL_Surface *icon = native::load_app_icon();
    if (!icon || icon->w != 512 || icon->h != 512) {
        std::cerr << SDL_GetError() << '\n';
        return 2;
    }
    SDL_DestroySurface(icon);
    SDL_Window *window = SDL_CreateWindow(native::app_name, 64, 64, SDL_WINDOW_HIDDEN);
    if (!window) {
        std::cerr << SDL_GetError() << '\n';
        return 3;
    }
    // The headless dummy driver has no window-icon operation. Exercise decoding
    // and naming there; desktop runs also require the real icon setter to work.
    const bool dummy = SDL_strcmp(SDL_GetCurrentVideoDriver(), "dummy") == 0;
    if (!dummy && !native::set_app_icon(window)) {
        std::cerr << SDL_GetError() << '\n';
        return 3;
    }
    if (SDL_strcmp(SDL_GetWindowTitle(window), native::app_name) != 0) return 4;
    if (SDL_strcmp(SDL_GetAppMetadataProperty(SDL_PROP_APP_METADATA_NAME_STRING), native::app_name) != 0
        || SDL_strcmp(SDL_GetAppMetadataProperty(SDL_PROP_APP_METADATA_IDENTIFIER_STRING), native::app_id) != 0)
        return 5;
    SDL_DestroyWindow(window);
    SDL_Quit();
    std::cout << "Official embedded 512x512 PNG decoded; SDL app metadata and window name applied; window icon "
              << (dummy ? "not supported by dummy driver" : "applied") << '\n';
}
