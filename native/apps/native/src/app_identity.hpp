#pragma once
#include "app_icon.hpp"
#include <SDL3/SDL.h>
namespace native {
inline constexpr const char *app_name="bunnyhop.lol - Native";
inline constexpr const char *app_id="lol.bunnyhop.native";
inline SDL_Surface *load_app_icon(){
    return SDL_LoadPNG_IO(SDL_IOFromConstMem(app_icon_png,sizeof(app_icon_png)),true);
}
inline bool set_app_icon(SDL_Window *window){
    SDL_Surface *icon=load_app_icon();
    if(!icon)return false;
    const bool ok=SDL_SetWindowIcon(window,icon);
    SDL_DestroySurface(icon);
    return ok;
}
}
