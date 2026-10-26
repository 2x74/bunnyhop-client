#include "window_sdl.hpp"
#include <cassert>
#include <iostream>
int main(){if(!SDL_Init(SDL_INIT_VIDEO)){std::cout<<"SDL window test unavailable: "<<SDL_GetError()<<'\n';return 77;}auto* window=SDL_CreateWindow("Bunnyhop window settings test",800,600,SDL_WINDOW_HIDDEN|SDL_WINDOW_RESIZABLE);if(!window){std::cout<<"SDL hidden window unavailable: "<<SDL_GetError()<<'\n';SDL_Quit();return 77;}
 native::WindowController controller(window);auto settings=native::default_window_settings();assert(controller.mode()=="windowed");assert(controller.apply(settings));const auto bounds=controller.observe_bounds();if(bounds)assert(bounds->width==800&&bounds->height==600);
 auto invalid=settings;invalid["windowMode"]="invalid";assert(!controller.apply(invalid)&&controller.mode()=="windowed"&&!controller.error().empty());
 settings["alwaysOnTop"]=true;const bool topSupported=controller.apply(settings);if(topSupported)assert(SDL_GetWindowFlags(window)&SDL_WINDOW_ALWAYS_ON_TOP);else assert(controller.mode()=="windowed");settings["alwaysOnTop"]=false;assert(controller.apply(settings));
 if(!controller.center())assert(!controller.error().empty());const bool maximizeSupported=controller.maximize();if(maximizeSupported){SDL_SyncWindow(window);if(SDL_GetWindowFlags(window)&SDL_WINDOW_MAXIMIZED)assert(controller.maximize());}
 assert(!(SDL_GetWindowFlags(window)&SDL_WINDOW_FULLSCREEN));assert(!controller.focus_lost(settings));settings["minimizeOnFocusLoss"]=true;assert(!controller.focus_lost(settings));
 assert(controller.apply(settings,true,native::WindowBounds{100000,100000,800,600,false}));assert(controller.mode()=="windowed");SDL_HideWindow(window);SDL_DestroyWindow(window);SDL_Quit();}
