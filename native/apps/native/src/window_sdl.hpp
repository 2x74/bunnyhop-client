#pragma once
#include "window_settings.hpp"
#include <SDL3/SDL.h>
#include <string>
namespace native {
// SDL window operations stay on the event/context thread. Preferences are only
// committed after apply() succeeds; failure rolls back the prior native mode.
class WindowController {
 SDL_Window* window_;std::optional<WindowBounds> normal_;std::string desired_="windowed",error_;
 static std::vector<WindowArea> areas(){std::vector<WindowArea> out;int count=0;auto* displays=SDL_GetDisplays(&count);for(int i=0;displays&&i<count;i++){SDL_Rect r{};if(SDL_GetDisplayUsableBounds(displays[i],&r))out.push_back({r.x,r.y,r.w,r.h});}SDL_free(displays);return out;}
 bool set_mode(const std::string& mode){
  if(mode=="windowed")return SDL_SetWindowFullscreen(window_,false)&&SDL_SetWindowFullscreenMode(window_,nullptr)&&SDL_SetWindowBordered(window_,true);
  if(mode=="borderless"){
#ifdef _WIN32
   // A borderless window over the display, not SDL desktop fullscreen: Windows'
   // fullscreen optimizations turn a GL window covering exactly the screen into
   // exclusive-style presentation (alt-tab flicker, black capture). One extra row
   // keeps it a normal composited window.
   if(!SDL_SetWindowFullscreen(window_,false)||!SDL_SetWindowFullscreenMode(window_,nullptr))return false;
   SDL_RestoreWindow(window_);SDL_Rect r{};if(!SDL_GetDisplayBounds(SDL_GetDisplayForWindow(window_),&r))return false;
   return SDL_SetWindowBordered(window_,false)&&SDL_SetWindowSize(window_,r.w,r.h+1)&&SDL_SetWindowPosition(window_,r.x,r.y);
#else
   return SDL_SetWindowFullscreenMode(window_,nullptr)&&SDL_SetWindowFullscreen(window_,true);
#endif
  }
  SDL_SetWindowBordered(window_,true);const auto* desktop=SDL_GetDesktopDisplayMode(SDL_GetDisplayForWindow(window_));if(!desktop){error_=SDL_GetError();return false;}const auto modeCopy=*desktop;return SDL_SetWindowFullscreenMode(window_,&modeCopy)&&SDL_SetWindowFullscreen(window_,true);
 }
 bool restore_bounds(WindowBounds b,bool requirePosition=false){b=clamp_window_bounds(b,areas());if(!SDL_RestoreWindow(window_)||!SDL_SetWindowSize(window_,b.width,b.height))return false;
  // Some compositors (notably Wayland) own placement: failure to position does
  // not make a valid resize/fullscreen change fail. Keep size restoration useful.
  if(!SDL_SetWindowPosition(window_,b.x,b.y)&&requirePosition)return false;normal_=b;if(b.maximized)return SDL_MaximizeWindow(window_);return true;
 }
public:
 explicit WindowController(SDL_Window* window):window_(window){observe_bounds();desired_=mode();}
 const std::string& error()const{return error_;}
 std::string mode()const{const auto flags=SDL_GetWindowFlags(window_);if(!(flags&SDL_WINDOW_FULLSCREEN))return flags&SDL_WINDOW_BORDERLESS?"borderless":"windowed";return SDL_GetWindowFullscreenMode(window_)?"fullscreen":"borderless";}
 bool apply(const WindowJson& settings,bool restore=false,const std::optional<WindowBounds>& saved=std::nullopt){
  const auto requested=settings.value("windowMode",std::string("windowed"));if(!valid_window_mode(requested)){error_="Invalid window mode";return false;}
  error_.clear();const auto old=mode();const bool oldTop=bool(SDL_GetWindowFlags(window_)&SDL_WINDOW_ALWAYS_ON_TOP);if(old=="windowed")observe_bounds();const auto oldNormal=normal_;
  const bool changed=old!=requested;bool ok=true;if(changed)ok=set_mode(requested);if(ok&&changed)ok=SDL_SyncWindow(window_);
  if(ok)ok=SDL_SetWindowAlwaysOnTop(window_,settings.value("alwaysOnTop",false));
  if(ok&&requested=="windowed"&&(changed||restore)&&settings.value("rememberWindowBounds",true)){const auto bounds=restore&&saved?saved:normal_;if(bounds)ok=restore_bounds(*bounds);}
  if(!ok){error_=SDL_GetError();if(error_.empty())error_="The window manager rejected this display mode";set_mode(old);SDL_SetWindowAlwaysOnTop(window_,oldTop);normal_=oldNormal;if(old=="windowed"&&oldNormal)restore_bounds(*oldNormal);desired_=old;return false;}
  desired_=requested;return true;
 }
 std::optional<WindowBounds> observe_bounds(){const auto flags=SDL_GetWindowFlags(window_);if(desired_!="windowed"||flags&(SDL_WINDOW_FULLSCREEN|SDL_WINDOW_MINIMIZED))return std::nullopt;
  if(flags&SDL_WINDOW_MAXIMIZED){if(normal_){auto b=*normal_;b.maximized=true;return b;}return std::nullopt;}
  WindowBounds b;if(!SDL_GetWindowPosition(window_,&b.x,&b.y)||!SDL_GetWindowSize(window_,&b.width,&b.height))return std::nullopt;if(b.width<240||b.height<240)return std::nullopt;normal_=b;return b;
 }
 bool center(){error_.clear();if(mode()!="windowed"){error_="Centering is available in windowed mode";return false;}WindowBounds b;if(!SDL_GetWindowSize(window_,&b.width,&b.height)){error_=SDL_GetError();return false;}const auto display=SDL_GetDisplayForWindow(window_);SDL_Rect area{};if(!SDL_GetDisplayUsableBounds(display,&area)){error_=SDL_GetError();return false;}b.width=std::min(b.width,area.w);b.height=std::min(b.height,area.h);b.x=area.x+(area.w-b.width)/2;b.y=area.y+(area.h-b.height)/2;const bool ok=restore_bounds(b,true);if(!ok)error_=SDL_GetError();return ok;}
 bool minimize(){error_.clear();const bool ok=SDL_MinimizeWindow(window_);if(!ok)error_=SDL_GetError();return ok;}
 bool maximize(){error_.clear();if(mode()!="windowed"){error_="Maximize is available in windowed mode";return false;}const bool maximized=bool(SDL_GetWindowFlags(window_)&SDL_WINDOW_MAXIMIZED);if(!maximized)observe_bounds();const bool ok=maximized?SDL_RestoreWindow(window_):SDL_MaximizeWindow(window_);if(!ok)error_=SDL_GetError();return ok;}
 bool focus_lost(const WindowJson& settings){if(!settings.value("minimizeOnFocusLoss",false)||mode()=="windowed")return false;return SDL_MinimizeWindow(window_);}
};
}
