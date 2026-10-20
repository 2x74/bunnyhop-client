#pragma once
#include "settings.hpp"
#include <SDL3/SDL.h>
#include <filesystem>
#include <string>
#include <vector>

namespace native {
inline std::filesystem::path resource(const std::string &name,const std::filesystem::path &fallback) {
    const auto base=std::filesystem::path(SDL_GetBasePath());
    for(const auto &root:{base/"resources",base/"../Resources",base/"../share/bunnyhop-native"}) {
        if(std::filesystem::exists(root/name))return std::filesystem::weakly_canonical(root/name);
    }
    return fallback;
}
inline std::string key_code(SDL_Scancode key) {
    if(key>=SDL_SCANCODE_A&&key<=SDL_SCANCODE_Z)return std::string("Key")+char('A'+key-SDL_SCANCODE_A);
    if(key>=SDL_SCANCODE_1&&key<=SDL_SCANCODE_9)return std::string("Digit")+char('1'+key-SDL_SCANCODE_1);
    if(key==SDL_SCANCODE_0)return "Digit0";
    if(key>=SDL_SCANCODE_F1&&key<=SDL_SCANCODE_F12)return "F"+std::to_string(key-SDL_SCANCODE_F1+1);
    switch(key) {
        case SDL_SCANCODE_SPACE:return "Space";case SDL_SCANCODE_LCTRL:return "ControlLeft";case SDL_SCANCODE_RCTRL:return "ControlRight";
        case SDL_SCANCODE_LSHIFT:return "ShiftLeft";case SDL_SCANCODE_RSHIFT:return "ShiftRight";case SDL_SCANCODE_LALT:return "AltLeft";case SDL_SCANCODE_RALT:return "AltRight";
        case SDL_SCANCODE_TAB:return "Tab";case SDL_SCANCODE_RETURN:return "Enter";case SDL_SCANCODE_BACKSPACE:return "Backspace";
        case SDL_SCANCODE_LEFT:return "ArrowLeft";case SDL_SCANCODE_RIGHT:return "ArrowRight";case SDL_SCANCODE_UP:return "ArrowUp";case SDL_SCANCODE_DOWN:return "ArrowDown";
        case SDL_SCANCODE_LEFTBRACKET:return "BracketLeft";case SDL_SCANCODE_RIGHTBRACKET:return "BracketRight";
        case SDL_SCANCODE_MINUS:return "Minus";case SDL_SCANCODE_EQUALS:return "Equal";case SDL_SCANCODE_COMMA:return "Comma";
        case SDL_SCANCODE_PERIOD:return "Period";case SDL_SCANCODE_SLASH:return "Slash";case SDL_SCANCODE_SEMICOLON:return "Semicolon";case SDL_SCANCODE_APOSTROPHE:return "Quote";
        default:return "";
    }
}
inline std::string mouse_code(unsigned button) {
    return "Mouse"+std::to_string(button==SDL_BUTTON_LEFT?1:button==SDL_BUTTON_RIGHT?2:button==SDL_BUTTON_MIDDLE?3:button);
}
inline std::vector<uint8_t> decode_base64(const std::string &encoded) {
    if(encoded.empty()||encoded.size()%4||encoded.size()>((8*1024*1024+2)/3)*4)throw std::runtime_error("Replay upload exceeds 8 MiB or has invalid encoding");
    auto digit=[](char c)->int {
        if(c>='A'&&c<='Z')return c-'A';if(c>='a'&&c<='z')return c-'a'+26;
        if(c>='0'&&c<='9')return c-'0'+52;if(c=='+')return 62;if(c=='/')return 63;return -1;
    };
    std::vector<uint8_t> out;out.reserve(encoded.size()/4*3);
    for(size_t i=0;i<encoded.size();i+=4) {
        const int a=digit(encoded[i]),b=digit(encoded[i+1]),c=digit(encoded[i+2]),d=digit(encoded[i+3]);
        const bool end=i+4==encoded.size(),pad2=encoded[i+2]=='=',pad1=encoded[i+3]=='=';
        if(a<0||b<0||(!pad2&&c<0)||(!pad1&&d<0)||((pad1||pad2)&&!end)||(pad2&&!pad1))throw std::runtime_error("Invalid replay base64");
        out.push_back(uint8_t((a<<2)|(b>>4)));
        if(!pad2)out.push_back(uint8_t((b<<4)|(c>>2)));
        if(!pad1)out.push_back(uint8_t((c<<6)|d));
    }
    if(out.size()>8*1024*1024)throw std::runtime_error("Replay exceeds 8 MiB");
    return out;
}
inline std::filesystem::path replay_file(const std::filesystem::path &directory,const std::string &id) {
    if(id.empty()||id.size()>256||id=="."||id==".."||id.find_first_of("/\\:\0",0,4)!=std::string::npos||
       !id.ends_with(".bhr"))throw std::runtime_error("Invalid local replay identifier");
    auto path=directory/id;
    if(std::filesystem::is_symlink(path)||!std::filesystem::is_regular_file(path)||std::filesystem::file_size(path)>8*1024*1024)
        throw std::runtime_error("Replay file is missing or invalid");
    return path;
}
}
