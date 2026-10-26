#include "menu_gamepad.hpp"
#include <cassert>
#include <iostream>
int main(){
 SDL_SetHint(SDL_HINT_JOYSTICK_ALLOW_BACKGROUND_EVENTS,"1");
 native::MenuGamepad menu;
 uint64_t now=1;
 auto initial=menu.sample(true,now);assert(initial&&(*initial)["connected"]==false);
 assert(!menu.sample(true,++now));
 SDL_VirtualJoystickDesc desc{};SDL_INIT_INTERFACE(&desc);desc.type=SDL_JOYSTICK_TYPE_GAMEPAD;
 desc.name="Menu controller fixture";desc.naxes=SDL_GAMEPAD_AXIS_COUNT;desc.nbuttons=SDL_GAMEPAD_BUTTON_COUNT;
 desc.axis_mask=(1u<<SDL_GAMEPAD_AXIS_COUNT)-1;desc.button_mask=(1u<<SDL_GAMEPAD_BUTTON_COUNT)-1;
 auto id=SDL_AttachVirtualJoystick(&desc);assert(id!=0);auto* joystick=SDL_OpenJoystick(id);assert(joystick);SDL_UpdateGamepads();
 now+=1000000001;auto connected=menu.sample(true,now);assert(connected&&(*connected)["connected"]==true);
 assert(SDL_SetJoystickVirtualButton(joystick,SDL_GAMEPAD_BUTTON_SOUTH,true));assert(SDL_SetJoystickVirtualButton(joystick,SDL_GAMEPAD_BUTTON_RIGHT_SHOULDER,true));assert(SDL_SetJoystickVirtualButton(joystick,SDL_GAMEPAD_BUTTON_DPAD_LEFT,true));
 assert(SDL_SetJoystickVirtualAxis(joystick,SDL_GAMEPAD_AXIS_LEFTX,-32768));assert(SDL_SetJoystickVirtualAxis(joystick,SDL_GAMEPAD_AXIS_LEFTY,32767));SDL_UpdateGamepads();
 auto pressed=menu.sample(true,++now);assert(pressed);assert((*pressed)["buttons"][0]==1);assert((*pressed)["buttons"][5]==1);assert((*pressed)["buttons"][14]==1);assert((*pressed)["buttons"][1]==0);assert((*pressed)["axes"][0]==-1);assert((*pressed)["axes"][1]==1);
 assert(!menu.sample(true,now+1));now+=16666667;assert(menu.sample(true,now));
 auto cleared=menu.sample(false,++now);assert(cleared&&(*cleared)["connected"]==false);for(auto v:(*cleared)["buttons"])assert(v==0);for(auto v:(*cleared)["axes"])assert(v==0);assert(!menu.sample(false,++now));
 auto resumed=menu.sample(true,++now);assert(resumed&&(*resumed)["buttons"][0]==1);
 assert(SDL_SetJoystickVirtualButton(joystick,SDL_GAMEPAD_BUTTON_SOUTH,false));SDL_UpdateGamepads();auto released=menu.sample(true,++now);assert(released&&(*released)["buttons"][0]==0);
 assert(SDL_DetachVirtualJoystick(id));SDL_UpdateGamepads();auto disconnected=menu.sample(true,++now);assert(disconnected&&(*disconnected)["connected"]==false);assert(!menu.sample(true,++now));SDL_CloseJoystick(joystick);
 // A replacement is discovered after the bounded scan interval.
 auto replacement=SDL_AttachVirtualJoystick(&desc);assert(replacement);SDL_UpdateGamepads();now+=1000000001;auto reconnected=menu.sample(true,now);assert(reconnected&&(*reconnected)["connected"]==true);assert(SDL_DetachVirtualJoystick(replacement));
 std::cout<<"Native menu controller mapping, repeat, focus reset and hotplug passed\n";
}
