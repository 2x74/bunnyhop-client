#pragma once
#include "bunnyhop_native.h"
#include "movement_audio.hpp"
#include <SDL3/SDL.h>
#include <nlohmann/json.hpp>
#include <array>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits>
#include <unordered_map>
#include <vector>

namespace native {
class Audio {
    struct Voice {const std::vector<float> *samples=nullptr;double cursor=0;float gain=0;bool loop=false;double rate=1;};
    std::unordered_map<std::string,std::vector<std::vector<float>>> sounds;
    std::array<Voice,48> voices{};
    SDL_AudioStream *stream=nullptr;
    float volume=.65f;
    size_t variant=0;
    MovementAudio movement;
    nlohmann::json mix,gun_sounds;
    static void SDLCALL callback(void *data,SDL_AudioStream *stream,int needed,int) {
        auto &self=*static_cast<Audio*>(data);
        std::array<float,1024> output{};
        while(needed>0) {
            const auto count=std::min(size_t((needed+3)/4),output.size());std::fill(output.begin(),output.end(),0);
            for(auto &v:self.voices) if(v.samples)for(size_t i=0;i<count;++i) {
                if(v.cursor>=v.samples->size()) {if(v.loop)v.cursor=std::fmod(v.cursor,double(v.samples->size()));else {v.samples=nullptr;break;}}
                const auto at=size_t(v.cursor),next=at+1<v.samples->size()?at+1:v.loop?0:at;
                const float a=(*v.samples)[at],b=(*v.samples)[next];
                output[i]+=(a+(b-a)*float(v.cursor-at))*v.gain*self.volume;v.cursor+=v.rate;
            }
            for(size_t i=0;i<count;++i)output[i]=std::clamp(output[i],-.98f,.98f);
            SDL_PutAudioStreamData(stream,output.data(),int(count*sizeof(float)));needed-=int(count*sizeof(float));
        }
    }
public:
    explicit Audio(const std::filesystem::path &assets,bool enabled=true) {
        if(!enabled)return;
        try {
            std::ifstream meta(assets/"audio.json");nlohmann::json manifest;meta>>manifest;
            mix=manifest.value("mix",nlohmann::json::object());gun_sounds=manifest.value("guns",nlohmann::json::object());
            for(auto it=manifest["sfx"].begin();it!=manifest["sfx"].end();++it) {
                const unsigned n=std::min(it.value().value("variants",0u),32u);
                for(unsigned i=1;i<=n;++i) {
                    const auto file=assets/"audio"/(it.key()+"-"+std::to_string(i)+".f32");
                    std::ifstream f(file,std::ios::binary|std::ios::ate);const auto size=f.tellg();
                    if(!f||size<=0||size>32*1024*1024||size%4)continue;
                    std::vector<float> samples(size_t(size)/4);f.seekg(0);f.read(reinterpret_cast<char*>(samples.data()),size);
                    if(f)sounds[it.key()].push_back(std::move(samples));
                }
            }
            if(!SDL_InitSubSystem(SDL_INIT_AUDIO))throw std::runtime_error(SDL_GetError());
            SDL_AudioSpec spec{SDL_AUDIO_F32,1,22050};
            stream=SDL_OpenAudioDeviceStream(SDL_AUDIO_DEVICE_DEFAULT_PLAYBACK,&spec,callback,this);
            if(!stream)throw std::runtime_error(SDL_GetError());
            if(auto wind=sounds.find("wind");wind!=sounds.end()&&!wind->second.empty())voices[0]={&wind->second.front(),0,0,true};
            SDL_ResumeAudioStreamDevice(stream);
        }catch(const std::exception &e){std::cerr<<"Audio unavailable: "<<e.what()<<'\n';}
    }
    ~Audio(){if(stream)SDL_DestroyAudioStream(stream);}
    void gain(float value){if(!stream)return;SDL_LockAudioStream(stream);volume=std::clamp(value,0.f,1.f);SDL_UnlockAudioStream(stream);}
    void play(const std::string &id,float gain=1,double rate=1) {
        if(!stream)return;
        const auto found=sounds.find(id);if(found==sounds.end()||found->second.empty())return;
        SDL_LockAudioStream(stream);
        auto at=std::find_if(voices.begin()+1,voices.end(),[](const Voice &v){return !v.samples;});
        if(at==voices.end())at=voices.begin()+1+(variant%(voices.size()-1));
        const float level=mix.contains(id)?mix[id].value("gain",1.f):1.f;
        *at={&found->second[variant++%found->second.size()],0,std::clamp(gain*level,0.f,1.f),false,std::clamp(rate,.25,4.)};
        SDL_UnlockAudioStream(stream);
    }
    void reset() {movement.reset();if(!stream)return;SDL_LockAudioStream(stream);for(auto &v:voices)if(!v.loop)v.samples=nullptr;voices[0].gain=0;SDL_UnlockAudioStream(stream);}
    void pause() {if(!stream)return;SDL_LockAudioStream(stream);voices[0].gain=0;SDL_UnlockAudioStream(stream);}
    void tick(const BhSnapshot &s,const BhRunState &run,const BhWeaponReport &weapon,const BhAttackReport *attack,double dt,const std::string &surface="concrete",double water_depth=std::numeric_limits<double>::quiet_NaN()) {
        if(!stream)return;
        const auto &p=s.player;const double speed=std::hypot(p.velocity[0],p.velocity[1]);
        movement.tick(p,dt,water_depth,surface,[&](const std::string &id,double gain,double rate){play(id,float(gain),rate);});
        const nlohmann::json *sounds_for_gun=nullptr;
        if(gun_sounds.is_array()&&weapon.active<gun_sounds.size()&&gun_sounds[weapon.active].is_object())sounds_for_gun=&gun_sounds[weapon.active];
        else if(gun_sounds.is_object()&&gun_sounds.contains(std::to_string(weapon.active)))sounds_for_gun=&gun_sounds[std::to_string(weapon.active)];
        auto gun=[&](const std::string &kind,const std::string &fallback){
            return sounds_for_gun?sounds_for_gun->value(kind,fallback):fallback;
        };
        if(run.update_flags&1)play("start_beep",.65);if(run.update_flags&16)play("split",.7);if(run.update_flags&2)play("finish",.85);
        if(weapon.flags&1)play(weapon.active==1?"carrot_draw":gun("draw","gun_draw"));
        if(weapon.flags&2)play(gun("pickup","gun_pickup"));
        if(weapon.flags&4)play(gun("magOut","gun_mag_out"));
        if(weapon.flags&8)play(gun("slide","gun_slide"));
        if(weapon.flags&16)play(gun("dry","gun_dry"));
        if(weapon.flags&128)play(gun("mode","gun_mode"));
        if(attack)play(attack->weapon==1?(attack->mode==2?"carrot_stab":"carrot_swing"):gun(weapon.silencer?"silenced":"fire",gun("fire","shot_pistol")),1,
            attack->weapon==1||!sounds_for_gun?1:sounds_for_gun->value("fireRate",1.));
        SDL_LockAudioStream(stream);
        voices[0].gain=float(std::pow(std::clamp((speed-270)/1000,0.,1.),1.25)*(p.grounded?.16:.3));
        SDL_UnlockAudioStream(stream);
    }
};
}
