#pragma once
#include "bunnyhop_native.h"
#include "audio_pack.hpp"
#include "movement_audio.hpp"
#include "music.hpp"
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
    // The mixer runs mono at this rate and SDL converts to whatever the device
    // wants, so anything a player supplies has to be brought here first.
    static constexpr int mixer_rate=22050;
    // Enough for a full replacement pack; past it the remaining files are
    // skipped rather than letting a folder of long files exhaust memory.
    static constexpr std::size_t max_custom_sfx_samples=16u<<20;  // 64 MB as float

    std::unordered_map<std::string,std::vector<std::vector<float>>> sounds;
    // The player's own sound/ folder. Kept beside the shipped bank rather than
    // replacing it: supplying one jump.wav should change the jump, not silence
    // the eighty cues the player did not supply.
    std::unordered_map<std::string,std::vector<std::vector<float>>> custom;
    const bool enabled_;
    bool use_custom_sfx=false;
    std::string sfx_status_text;
    std::array<Voice,48> voices{};
    SDL_AudioStream *stream=nullptr;
    float volume=.65f;
    size_t variant=0;
    MovementAudio movement;
    nlohmann::json mix,gun_sounds,ost;
    std::filesystem::path assets_root,data_root;
    Music music;
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

    // Which bank a cue plays from. The custom pack wins where it has the cue
    // and the shipped one answers everywhere else.
    const std::vector<std::vector<float>> *bank_for(const std::string &id) const {
        if(use_custom_sfx) {const auto found=custom.find(id);if(found!=custom.end()&&!found->second.empty())return &found->second;}
        const auto found=sounds.find(id);return found==sounds.end()?nullptr:&found->second;
    }

    // Voices hold raw pointers into whichever bank they came from, so the
    // looping wind has to be re-aimed whenever the banks change.
    void rebind_wind() {
        if(!stream)return;
        const auto *bank=bank_for("wind");
        SDL_LockAudioStream(stream);
        voices[0]=bank&&!bank->empty()?Voice{&bank->front(),0,0,true,1}:Voice{};
        SDL_UnlockAudioStream(stream);
    }

    void load_custom_sfx() {
        custom.clear();
        const auto cues=scan_sfx_pack(data_root/"sound");
        if(cues.empty()) {
            sfx_status_text="No sounds yet. Drop audio files into "+(data_root/"sound").string()+
                " named after the cue they replace, such as jump.wav.";
            return;
        }
        std::size_t budget=max_custom_sfx_samples,loaded=0,skipped=0;
        for(const auto &[id,files]:cues) for(const auto &file:files) {
            DecodedAudio decoded;std::string error;
            if(!decode_sfx_file(file,&decoded,&error)) {
                std::cerr<<"Custom sound "<<file.filename().string()<<' '<<error<<'\n';++skipped;continue;
            }
            auto mono=to_mono(decoded);
            // A rate of zero means raw float already at the mixer's rate.
            if(decoded.rate>0&&decoded.rate!=mixer_rate)mono=resample_mono(mono,decoded.rate,mixer_rate,budget);
            if(mono.empty()||mono.size()>budget) {++skipped;continue;}
            budget-=mono.size();
            custom[id].push_back(std::move(mono));
            ++loaded;
        }
        sfx_status_text=std::to_string(loaded)+(loaded==1?" sound":" sounds")+" loaded from your sound folder";
        if(skipped)sfx_status_text+=", "+std::to_string(skipped)+" skipped";
        sfx_status_text+=". Cues you have not supplied still use the bunnyhop.lol sounds.";
    }

    // Shipped tracks are those the audio manifest names and this build also
    // carries a file for. The manifest lists the whole OST whether or not the
    // package includes it, so a track with no file is simply not offered.
    std::vector<MusicTrack> shipped_music() const {
        std::vector<MusicTrack> tracks;
        if(!ost.is_array())return tracks;
        for(const auto &entry:ost) {
            if(!entry.is_object())continue;
            MusicTrack track;
            track.id=entry.value("id",std::string());
            if(track.id.empty()||track.id.find_first_of("/\\.")!=std::string::npos)continue;
            track.title=entry.value("title",track.id);
            for(const char *extension:{".ogg",".mp3",".flac",".wav"}) {
                std::error_code ec;
                const auto candidate=assets_root/"music"/(track.id+extension);
                if(std::filesystem::exists(candidate,ec)&&!ec) {track.file=candidate;break;}
            }
            if(!track.file.empty())tracks.push_back(std::move(track));
        }
        return tracks;
    }

public:
    Audio(const std::filesystem::path &assets,const std::filesystem::path &data,bool enabled=true)
        :enabled_(enabled),assets_root(assets),data_root(data) {
        if(!enabled)return;
        try {
            std::ifstream meta(assets/"audio.json");nlohmann::json manifest;meta>>manifest;
            mix=manifest.value("mix",nlohmann::json::object());gun_sounds=manifest.value("guns",nlohmann::json::object());
            ost=manifest.value("music",nlohmann::json::array());
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
            SDL_AudioSpec spec{SDL_AUDIO_F32,1,mixer_rate};
            stream=SDL_OpenAudioDeviceStream(SDL_AUDIO_DEVICE_DEFAULT_PLAYBACK,&spec,callback,this);
            if(!stream)throw std::runtime_error(SDL_GetError());
            rebind_wind();
            SDL_ResumeAudioStreamDevice(stream);
        }catch(const std::exception &e){std::cerr<<"Audio unavailable: "<<e.what()<<'\n';}
    }
    ~Audio(){if(stream)SDL_DestroyAudioStream(stream);}

    // "default" is the bunnyhop.lol pack, anything else is the player's own.
    void set_sfx_pack(bool custom_pack) {
        if(!enabled_)return;
        if(custom_pack==use_custom_sfx&&(!custom_pack||!custom.empty()))return;
        // Every voice points into one of the banks, so nothing may still be
        // playing while they are rebuilt.
        if(stream) {SDL_LockAudioStream(stream);for(auto &v:voices)v=Voice{};SDL_UnlockAudioStream(stream);}
        use_custom_sfx=custom_pack;
        if(custom_pack)load_custom_sfx();
        else {custom.clear();sfx_status_text.clear();}
        rebind_wind();
    }
    void set_music_pack(bool custom_pack) {
        if(!enabled_)return;
        if(custom_pack)
            music.set_playlist(scan_music_pack(data_root/"bgm"),
                "No music yet. Drop audio files into "+(data_root/"bgm").string()+" to hear them here.");
        else
            music.set_playlist(shipped_music(),"The bunnyhop.lol OST is not bundled with this build.");
    }
    // Called once a frame: music decoding cannot run on the audio thread.
    void pump() {if(enabled_)music.pump();}
    const std::string &sfx_status() const {return sfx_status_text;}
    const std::string &music_status() const {return music.status();}
    const std::string &music_title() const {return music.title();}
    void skip_track() {if(enabled_)music.skip();}

    void gain(float value){
        music.gain(value);
        if(!stream)return;
        SDL_LockAudioStream(stream);volume=std::clamp(value,0.f,1.f);SDL_UnlockAudioStream(stream);
    }
    void play(const std::string &id,float gain=1,double rate=1) {
        if(!stream)return;
        const auto *found=bank_for(id);if(!found||found->empty())return;
        SDL_LockAudioStream(stream);
        auto at=std::find_if(voices.begin()+1,voices.end(),[](const Voice &v){return !v.samples;});
        if(at==voices.end())at=voices.begin()+1+(variant%(voices.size()-1));
        const float level=mix.contains(id)?mix[id].value("gain",1.f):1.f;
        *at={&(*found)[variant++%found->size()],0,std::clamp(gain*level,0.f,1.f),false,std::clamp(rate,.25,4.)};
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
