#pragma once
#include "settings.hpp"
#include <SDL3/SDL.h>
#include <filesystem>
#include <iostream>
#include <string>
#include <string_view>
#include <vector>

namespace native {
// The name a native replay header carries: the signed-in account's display name, as the web stamps it (its
// localStorage "bunnyhop:name", sent by the menu), or "player" like the web when there is none. Display only: the
// server attributes runs by the authenticated account. Anything odd falls back rather than reaching the header.
inline std::string replay_player_name(std::string_view name) {
    if(name.empty()||name.size()>64)return "player";
    for(const unsigned char c:name)if(c<0x20||c==0x7f)return "player";
    return std::string(name);
}

// Hands a credits link to the system browser.
//
// The menu checks the URL before sending it, but that check is advice, not
// protection: it runs inside the webview, which is the thing being guarded
// against. This is the decision that counts.
//
// Parsed rather than searched, so a host is matched as a host and never as a
// substring: "https://github.com.evil.test/" and "https://evil.test/?=github.com"
// both fail here, as does "https://github.com@evil.test/".
inline bool open_external(const std::string &url) {
    static constexpr std::string_view allowed[]={"github.com","1998.lol","bunnyhop.lol","discord.gg"};
    static constexpr std::string_view scheme="https://";
    if(url.size()<scheme.size()+3||url.size()>2048||!url.starts_with(scheme))return false;
    // Control characters and spaces can be read differently by whatever the
    // desktop hands this to, so refuse them rather than try to normalise.
    for(const unsigned char c:url)if(c<=0x20||c==0x7f)return false;
    const auto authority_end=url.find_first_of("/?#",scheme.size());
    const auto authority=url.substr(scheme.size(),
        authority_end==std::string::npos?std::string::npos:authority_end-scheme.size());
    if(authority.empty()||authority.find('@')!=std::string::npos)return false;
    const auto host=authority.substr(0,authority.find(':'));
    bool permitted=false;
    for(const auto &candidate:allowed)
        if(host==candidate||(host.size()>candidate.size()+1&&host.ends_with(candidate)&&
           host[host.size()-candidate.size()-1]=='.')){permitted=true;break;}
    if(!permitted){std::cerr<<"Refused an external link outside the allowed sites\n";return false;}
    if(!SDL_OpenURL(url.c_str())){std::cerr<<"Could not open "<<url<<": "<<SDL_GetError()<<'\n';return false;}
    return true;
}
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
