#pragma once
#include "settings.hpp"
#include "bunnyhop_native.h"
#include "audio_pack.hpp"
#include "movement_audio.hpp"
#include "announcer.hpp"
#include "impact_audio.hpp"
#include "music.hpp"
#include "spatial_audio.hpp"
#include "render_shaders.hpp"
#include <SDL3/SDL.h>
#include <nlohmann/json.hpp>
#include <array>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <future>
#include <functional>
#include <iostream>
#include <limits>
#include <unordered_map>
#include <vector>

namespace native {
enum class AudioMode { disabled, live, offline };
class Audio {
    struct Voice {const std::vector<float> *samples=nullptr;double cursor=0;float gain=0;bool loop=false;double rate=1;int bus=0;float pan=0;std::string id;float cutoff=0,filtered=0;};
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
    using Bank=std::unordered_map<std::string,std::vector<std::vector<float>>>;
    Bank classic_bank;bool classic_wanted=false,classic_reload=false;std::string classic_status;
    nlohmann::json classic_map=nlohmann::json::object();
    std::function<void()> classic_loader;
    struct ClassicLoaded {Bank bank;std::string error;};std::future<ClassicLoaded> classic_loading;
    ClassicLoaded load_classic(const nlohmann::json &mapping,const std::function<void()> &fetch){
        ClassicLoaded result;try{if(fetch)fetch();}catch(const std::exception &e){result.error=e.what();}
        size_t budget=max_custom_sfx_samples;
        for(const auto &[id,paths]:mapping.items())for(const auto &path:paths){
            const auto rel=std::filesystem::path(path.get<std::string>());if(rel.is_absolute()||path.get<std::string>().find("..")!=std::string::npos)continue;
            const auto file=data_root/"classic"/rel;if(!std::filesystem::is_regular_file(file))continue;DecodedAudio decoded;std::string error;
            if(!decode_sfx_file(file,&decoded,&error,budget,true))continue;auto mono=to_mono(decoded);if(decoded.rate!=mixer_rate)mono=resample_mono(mono,decoded.rate,mixer_rate,budget);
            if(mono.empty()||mono.size()>budget)continue;budget-=mono.size();result.bank[id].push_back(std::move(mono));
        }return result;
    }
    void install_classic(ClassicLoaded result){
        {Lock lock(stream);for(auto &v:voices)v=Voice{};classic_bank=std::move(result.bank);movement.classic=classic_wanted&&!classic_bank.empty();}
        classic_status=!classic_wanted?"":classic_bank.empty()?"CS:S sounds unavailable; using bunnyhop.lol sounds.":"Classic CS:S sounds active";
        if(!result.error.empty())classic_status+=" (cached content; "+result.error+")";rebind_wind();
    }
    void prepare_classic(){
        if(!enabled_||!classic_wanted||classic_loading.valid())return;classic_reload=false;classic_status="Loading Classic CS:S sounds…";
        if(mode_==AudioMode::offline){install_classic(load_classic(classic_map,{}));return;}
        const auto mapping=classic_map;const auto fetch=classic_loader;
        classic_loading=std::async(std::launch::async,[this,mapping,fetch](){return load_classic(mapping,fetch);});
    }
    const bool enabled_;
    const AudioMode mode_;
    struct Lock {SDL_AudioStream *s;explicit Lock(SDL_AudioStream *stream):s(stream){if(s)SDL_LockAudioStream(s);}~Lock(){if(s)SDL_UnlockAudioStream(s);}};
    double elapsed=0;uint64_t rendered=0;uint32_t random_seed=977;
    std::unordered_map<std::string,double> last_start;
    std::unordered_map<std::string,size_t> last_variant;
    std::string bank_error;
    AnnouncerPolicy announcer; nlohmann::json announcer_prefs=default_announcer();
    uint32_t measured=0,perfect=0;bool scroll_style=false,perfect_tick=false;
    LongjumpAnnouncements longjumps;std::string movement_style="autohop";
    bool focused=true,mute_background=true;float master_volume=.65f;
    bool use_custom_sfx=false;
    std::string sfx_status_text;
    std::array<Voice,48> voices{};
    SDL_AudioStream *stream=nullptr;
    float volume=.65f,sfx_volume=1,ui_volume=1,music_volume=1,ambience_volume=1;bool footsteps_enabled=true,weapon_sounds_enabled=true,wind_enabled=true,others_enabled=true,ghosts_enabled=true;
    std::array<float,3> listener_position{};double listener_yaw=0;
    struct SpatialState{MovementAudio movement;bool grounded=false,first=true;uint32_t attack_tick=~0u,jump_tick=~0u;};
    std::unordered_map<std::string,SpatialState> spatial_states;
    size_t variant=0;
    MovementAudio movement;
    nlohmann::json mix,gun_sounds,weapon_audio,ost;
    struct PendingCue{double at;std::string id;float gain;};std::vector<PendingCue> pending_cues;
    BhWeaponReport previous_weapon{};
    std::set<std::string> finished_results;std::deque<std::string> finished_order;
    std::filesystem::path assets_root,data_root;
    Music music;
    OfflineMusic offline_music;
    ImpactSurfaces impact_surfaces;BhContext *map_core=nullptr;
    static void SDLCALL callback(void *data,SDL_AudioStream *stream,int needed,int) {
        auto &self=*static_cast<Audio*>(data);
        std::array<float,1024> output{};
        while(needed>0) {
            const auto count=std::min(size_t((needed+7)/8),output.size()/2);std::fill(output.begin(),output.end(),0);
            self.mix_samples(output.data(),count);
            SDL_PutAudioStreamData(stream,output.data(),int(count*2*sizeof(float)));needed-=int(count*2*sizeof(float));
        }
    }

    float random(){random_seed^=random_seed<<13;random_seed^=random_seed>>17;random_seed^=random_seed<<5;return float(double(random_seed)/4294967296.);}
    void mix_samples(float *output,size_t count){
        std::fill(output,output+count*2,0.f);
        for(auto &v:voices)if(v.samples&&!v.samples->empty())for(size_t i=0;i<count;++i){
            if(v.cursor>=v.samples->size()){if(v.loop)v.cursor=std::fmod(v.cursor,double(v.samples->size()));else{v.samples=nullptr;break;}}
            const size_t at=size_t(v.cursor),next=at+1<v.samples->size()?at+1:v.loop?0:at;
            float sample=(*v.samples)[at]+((*v.samples)[next]-(*v.samples)[at])*float(v.cursor-at);
            if(v.cutoff>0){const float a=1-std::exp(-6.2831853f*v.cutoff/mixer_rate);v.filtered+=a*(sample-v.filtered);sample=v.filtered;}
            sample*=v.gain*volume*(v.bus==1?ui_volume:v.bus==2?ambience_volume:sfx_volume);
            const auto pan=pan_gains(v.pan);output[2*i]+=sample*pan[0];output[2*i+1]+=sample*pan[1];v.cursor+=v.rate;
        }
        for(size_t i=0;i<count*2;++i)output[i]=std::clamp(output[i],-.98f,.98f);
        rendered+=count;
    }

    // Which bank a cue plays from. The custom pack wins where it has the cue
    // and the shipped one answers everywhere else.
    const std::vector<std::vector<float>> *bank_for(const std::string &id) const {
        if(use_custom_sfx) {const auto found=custom.find(id);if(found!=custom.end()&&!found->second.empty())return &found->second;}
        if(classic_wanted){const auto found=classic_bank.find(id);if(found!=classic_bank.end()&&!found->second.empty())return &found->second;}
        const auto found=sounds.find(id);return found==sounds.end()?nullptr:&found->second;
    }

    // Voices hold raw pointers into whichever bank they came from, so the
    // looping wind has to be re-aimed whenever the banks change.
    void rebind_wind() {
        Lock lock(stream);
        for(int i=0;i<2;++i){const std::string id=i?"wind_high":"wind";const auto *bank=bank_for(id);
            voices[i]=bank&&!bank->empty()?Voice{&bank->front(),0,0,true,1,2,0,id}:Voice{};}
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
            track.role=entry.value("role",std::string("game"));
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
    static constexpr int sample_rate=mixer_rate;
    Audio(const std::filesystem::path &assets,const std::filesystem::path &data,bool enabled=true)
        :Audio(assets,data,enabled?AudioMode::live:AudioMode::disabled){}
    Audio(const std::filesystem::path &assets,const std::filesystem::path &data,AudioMode mode)
        :enabled_(mode!=AudioMode::disabled),mode_(mode),assets_root(assets),data_root(data) {
        if(!enabled_)return;
        try {
            std::ifstream meta(assets/"audio.json");nlohmann::json manifest;meta>>manifest;
            mix=manifest.value("mix",nlohmann::json::object());gun_sounds=manifest.value("guns",nlohmann::json::object());
            weapon_audio=manifest.value("weaponAudio",nlohmann::json::array());
            classic_map=manifest.value("classic",nlohmann::json::object());
            ost=manifest.value("music",nlohmann::json::array());
            size_t missing=0;
            for(auto it=manifest["sfx"].begin();it!=manifest["sfx"].end();++it) {
                const unsigned n=std::min(it.value().value("variants",0u),32u);
                for(unsigned i=1;i<=n;++i) {
                    const auto file=assets/"audio"/(it.key()+"-"+std::to_string(i)+".f32");
                    std::ifstream f(file,std::ios::binary|std::ios::ate);const auto size=f.tellg();
                    if(!f||size<=0||size>32*1024*1024||size%4){++missing;continue;}
                    std::vector<float> samples(size_t(size)/4);f.seekg(0);f.read(reinterpret_cast<char*>(samples.data()),size);
                    if(f)sounds[it.key()].push_back(std::move(samples));
                }
            }
            if(sounds.empty())bank_error="No sound effect assets loaded";else if(missing)bank_error=std::to_string(missing)+" sound effect assets missing or invalid";
            rebind_wind();
            if(mode_!=AudioMode::live)return;
            if(!SDL_InitSubSystem(SDL_INIT_AUDIO))throw std::runtime_error(SDL_GetError());
            SDL_AudioSpec spec{SDL_AUDIO_F32,2,mixer_rate};
            stream=SDL_OpenAudioDeviceStream(SDL_AUDIO_DEVICE_DEFAULT_PLAYBACK,&spec,callback,this);
            if(!stream)throw std::runtime_error(SDL_GetError());
            rebind_wind();
            SDL_ResumeAudioStreamDevice(stream);
        }catch(const std::exception &e){bank_error=e.what();std::cerr<<"Audio unavailable: "<<e.what()<<'\n';}
    }
    ~Audio(){if(classic_loading.valid())classic_loading.wait();if(stream){SDL_DestroyAudioStream(stream);SDL_QuitSubSystem(SDL_INIT_AUDIO);}}
    const std::string &load_error()const{return bank_error;}
    bool has_cue(const std::string &id)const{const auto *bank=bank_for(id);return bank&&!bank->empty();}
    // Stereo frames, interleaved F32. Offline mode never opens an SDL device or Music stream.
    std::vector<float> render_samples(size_t count,bool gameplay=true){
        if(mode_!=AudioMode::offline)throw std::runtime_error("render_samples requires offline Audio");
        if(count>size_t(sample_rate)*60)throw std::runtime_error("Audio render chunk too large");
        std::vector<float> out(count*2);mix_samples(out.data(),count);
        if(!gameplay)std::fill(out.begin(),out.end(),0.f);
        offline_music.mix(out.data(),count,sample_rate,volume*music_volume);
        for(auto &v:out)v=std::clamp(v,-.98f,.98f);
        return out;
    }
    void set_classic_loader(std::function<void()> fetch){classic_loader=std::move(fetch);if(classic_loading.valid())classic_reload=true;else prepare_classic();}
    const std::string &classic_sound_status()const{return classic_status;}
    nlohmann::json status()const{return {{"classicLoading",classic_loading.valid()},{"classicActive",movement.classic},{"classicStatus",classic_status},{"sfxStatus",sfx_status_text},{"error",bank_error}};}
    bool classic_active()const{return movement.classic;}
    void set_map(BhContext *core){map_core=core;impact_surfaces.build(core);}
    void set_style(const std::string &style){if(movement_style!=style)longjumps.reset();movement_style=style;scroll_style=native::scroll_style(style);}
    void focus(bool value){focused=value;Lock lock(stream);volume=(!focused&&mute_background)?0:master_volume;music.gain(volume*music_volume);}
    void verified_finish(const std::string &event,const std::string &id){
        if(id.empty()||(event!="pb"&&event!="wr")||finished_results.contains(id))return;
        finished_results.insert(id);finished_order.push_back(id);if(finished_order.size()>512){finished_results.erase(finished_order.front());finished_order.pop_front();}
        play(event=="wr"?"finish_wr":"finish_pb");announce(event,id);duck_music(.3f,2.5);
    }
    void announce(const std::string &event,const std::string &id={},bool remote=false,const std::string &preview={}){
        if(!announcer_event(event))return;auto p=announcer_prefs;if(!preview.empty()){if(!announcer_line(preview))return;p[event]=preview;}
        const std::string cue="announcer_"+p.at(event).get<std::string>();const auto *bank=bank_for(cue);
        float audible;{Lock lock(stream);audible=volume*sfx_volume;}
        if(!bank||bank->empty()||audible<=0){p["enabled"]=false;if(!id.empty()&&preview.empty())announcer.admit(p,event,elapsed,0,id,remote);return;}
        double duration=0;for(const auto &b:*bank)duration=std::max(duration,double(b.size())/mixer_rate);
        const auto line=announcer.admit(p,event,elapsed,duration,id,remote,!preview.empty());if(line.empty())return;
        {Lock lock(stream);for(auto &v:voices)if(v.id.starts_with("announcer_"))v.samples=nullptr;}
        play("announcer_"+line,p.at("volume"));duck_music(.35f,duration);
    }

    // "default" is the bunnyhop.lol pack, anything else is the player's own.
    void set_sfx_pack(bool custom_pack) {
        if(!enabled_)return;
        if(custom_pack==use_custom_sfx&&(!custom_pack||!custom.empty()))return;
        // Every voice points into one of the banks, so nothing may still be
        // playing while they are rebuilt.
        {Lock lock(stream);for(auto &v:voices)v=Voice{};}
        use_custom_sfx=custom_pack;
        if(custom_pack)load_custom_sfx();
        else {custom.clear();sfx_status_text.clear();}
        rebind_wind();
    }
    std::vector<MusicTrack> export_music_tracks(bool custom_pack)const{
        auto tracks=custom_pack?scan_music_pack(data_root/"bgm"):shipped_music();
        if(custom_pack)for(auto &track:tracks)track.id=track.file.filename().string(); // distinguish equal stems with different codecs
        std::erase_if(tracks,[](const MusicTrack &track){return track.role!="game";});
        return tracks;
    }
    nlohmann::json export_music_catalog(bool custom_pack)const{
        auto result=nlohmann::json::array();for(const auto &track:export_music_tracks(custom_pack))result.push_back({{"id",track.id},{"title",track.title}});return result;
    }
    void export_music(bool custom_pack,const std::string &id,uint64_t start,uint64_t end,double offset,float level,bool loop,bool duck){
        if(mode_!=AudioMode::offline)throw std::runtime_error("Export music requires offline Audio.");
        const auto tracks=export_music_tracks(custom_pack);
        const auto found=std::find_if(tracks.begin(),tracks.end(),[&](const MusicTrack &track){return track.id==id;});
        if(found==tracks.end())throw std::runtime_error("Export music is unavailable in the selected music pack. Choose a track again.");
        offline_music.load(*found,start,end,offset,level,loop,duck);
    }
    void set_music_pack(bool custom_pack) {
        if(mode_!=AudioMode::live)return;
        if(custom_pack)
            music.set_playlist(scan_music_pack(data_root/"bgm"),
                "No music yet. Drop audio files into "+(data_root/"bgm").string()+" to hear them here.");
        else
            music.set_playlist(shipped_music(),"The bunnyhop.lol OST is not bundled with this build.");
    }
    // Called once a frame: music decoding cannot run on the audio thread.
    void pump() {if(classic_loading.valid()&&classic_loading.wait_for(std::chrono::seconds(0))==std::future_status::ready){install_classic(classic_loading.get());if(classic_reload)prepare_classic();}if(mode_==AudioMode::live)music.pump();}
    const std::string &sfx_status() const {return sfx_status_text;}
    const std::string &music_status() const {return music.status();}
    const std::string &music_title() const {return music.title();}
    void duck_music(float depth=.35f,double hold=2.5){if(mode_==AudioMode::live)music.duck(depth,hold);else if(mode_==AudioMode::offline)offline_music.duck(depth,hold);}
    void skip_track() {if(mode_==AudioMode::live)music.skip();}
    void set_music_scene(bool gameplay) {if(mode_==AudioMode::live)music.set_scene(gameplay);}
    void music_control(const std::string &action) {
        if(mode_!=AudioMode::live)return;
        if(action=="previous")music.previous();
        else if(action=="toggle")music.toggle();
        else if(action=="next")music.skip();
    }
    nlohmann::json music_state() const {
        const auto *track=music.shown();
        return {{"id",track?track->id:""},{"title",track?track->title:""},{"role",track?track->role:""},
                {"playing",enabled_&&music.is_playing()},{"available",enabled_&&music.active()},
                {"loading",enabled_&&music.is_loading()},{"status",music.status()}};
    }

    void gain(float value){master_volume=std::clamp(value,0.f,1.f);Lock lock(stream);volume=(!focused&&mute_background)?0:master_volume;if(mode_==AudioMode::live)music.gain(volume*music_volume);}
    void preferences(const nlohmann::json &p){
        {Lock lock(stream);
        master_volume=p.value("muted",false)?0:p.value("volume",.65f);mute_background=p.value("muteInBackground",true);volume=(!focused&&mute_background)?0:master_volume;
        sfx_volume=p.value("muteSfx",false)?0:p.value("sfxVolume",1.f);ui_volume=p.value("muteUi",false)?0:p.value("uiVolume",1.f);
        ambience_volume=p.value("muteAmbience",false)?0:p.value("ambienceVolume",1.f);music_volume=p.value("muteMusic",false)?0:p.value("musicVolume",1.f);
        footsteps_enabled=p.value("footsteps",true);weapon_sounds_enabled=p.value("weaponSounds",true);wind_enabled=p.value("wind",true);others_enabled=p.value("othersAudio",true);ghosts_enabled=p.value("ghostAudio",true);
        perfect_tick=p.value("perfectTick",false);announcer_prefs=p.value("announcer",default_announcer());
        movement.footsteps=footsteps_enabled;
        if(mode_==AudioMode::live)music.gain(volume*music_volume);}
        const bool wanted=p.value("classicSounds",false);if(wanted!=classic_wanted){classic_wanted=wanted;movement.classic=wanted&&!classic_bank.empty();if(wanted)prepare_classic();else {classic_status.clear();reset();}}
    }
    void play(const std::string &id,float gain=1,double rate=1,float pan=0,bool positional=false) {
        if(!enabled_||!std::isfinite(gain)||!std::isfinite(rate)||gain<=0)return;
        const auto *found=bank_for(id);if(!found||found->empty())return;
        std::string layer;
        {Lock lock(stream);const double now=double(rendered)/mixer_rate;
        const auto def=mix.value(id,nlohmann::json::object());const double gap=def.value("gap",0.);
        const auto last=last_start.find(id);if(!positional){if(last!=last_start.end()&&now-last->second<gap)return;last_start[id]=now;}
        const size_t max=def.value("max",48u)+(positional?2u:0u);size_t active=0;auto oldest=voices.end();
        for(auto it=voices.begin()+2;it!=voices.end();++it)if(it->samples&&it->id==id){++active;if(oldest==voices.end()||it->cursor>oldest->cursor)oldest=it;}
        auto at=active>=max&&oldest!=voices.end()?oldest:std::find_if(voices.begin()+2,voices.end(),[](const Voice &v){return !v.samples;});
        if(at==voices.end())at=voices.begin()+2+(variant%(voices.size()-2));
        const std::string bus=def.value("bus",std::string("sfx"));const float level=def.value("gain",1.f),jitter=def.value("jitter",0.f);
        size_t pick=size_t(random()*found->size())%found->size();auto previous=last_variant.find(id);if(found->size()>1&&previous!=last_variant.end()&&pick==previous->second)pick=(pick+1)%found->size();last_variant[id]=pick;++variant;
        *at={&(*found)[pick],0,std::max(0.f,gain*level),false,std::clamp(rate*(1+(random()*2-1)*jitter),.25,4.),bus=="ui"?1:bus=="ambience"?2:0,std::clamp(pan,-1.f,1.f),id};
        layer=def.value("layer",std::string());}
        if(!layer.empty()&&layer!=id)play(layer,gain,rate,pan,positional);
    }
    void impact(const BhAttackReport &attack,const std::string &surface){if(!attack.hit)return;const auto material=surface=="grass"?"dirt":surface=="water"?"concrete":surface;const bool knife=attack.weapon==1,stab=knife&&attack.mode==2;spatial("impact_"+material,attack.end,stab?1.25f:knife?.95f:.75f,stab?.85:knife?1.:1.12);}
    void listener(const float position[3],double yaw){std::copy(position,position+3,listener_position.begin());listener_yaw=yaw;}
    void spatial(const std::string &id,const float position[3],float gain=1,double rate=1){
        const auto mix=spatial_mix(position,listener_position.data(),listener_yaw);if(mix.gain>0)play(id,gain*mix.gain,rate,mix.pan,true);
    }
    void spatial_actor(const native_render::Actor &a,double dt,bool ghost=false){
        if((ghost&&!ghosts_enabled)||(!ghost&&!others_enabled))return;
        if(spatial_states.size()>512)spatial_states.clear();auto &s=spatial_states[a.id];BhState p{};
        std::copy(a.frame.position,a.frame.position+3,p.position);std::copy(a.frame.velocity,a.frame.velocity+3,p.velocity);p.grounded=!!(a.frame.flags&2);p.crouched=!!(a.frame.flags&1);p.on_ladder=!!(a.frame.flags&4);
        if(a.snapped){s.movement.reset();s.first=true;}if(!s.first&&!s.grounded&&p.grounded)p.events|=4;if(!s.first&&s.grounded&&!p.grounded&&p.velocity[2]>120&&s.jump_tick!=a.frame.tick){p.events|=2;s.jump_tick=a.frame.tick;}if(a.jumped&&s.jump_tick!=a.frame.tick){p.events|=2;s.jump_tick=a.frame.tick;}
        BhSurfaceProbe probe{};probe.water_z=NAN;const bool found=map_core&&bh_surface_at(map_core,p.position[0],p.position[1],p.position[2],&probe);const double depth=found?probe.water_z-p.position[2]:NAN;static const char *surfaces[]={"concrete","metal","wood","grass","tile","water"};
        s.movement.footsteps=footsteps_enabled;s.movement.classic=movement.classic;s.movement.tick(p,std::clamp(dt,0.,.1),depth,surfaces[std::clamp(probe.surface,0,5)],[&](const std::string &id,double gain,double rate){spatial(id,a.frame.position,float(gain)*(ghost?.35f:.65f),rate);});s.first=false;s.grounded=p.grounded;
        if(a.attack&&s.attack_tick!=a.frame.tick){s.attack_tick=a.frame.tick;if(!weapon_sounds_enabled)return;std::string cue=a.frame.weapon==1?(a.attack==2?"carrot_stab":"carrot_swing"):"shot_pistol";
            const nlohmann::json *gun=nullptr;if(gun_sounds.is_array()&&a.frame.weapon<gun_sounds.size()&&gun_sounds[a.frame.weapon].is_object())gun=&gun_sounds[a.frame.weapon];else if(gun_sounds.is_object()&&gun_sounds.contains(std::to_string(a.frame.weapon)))gun=&gun_sounds[std::to_string(a.frame.weapon)];
            if(a.frame.weapon!=1&&gun)cue=gun->value(a.silenced?"silenced":"fire",gun->value("fire",cue));spatial(cue,a.frame.position,ghost?.3f:.65f,a.frame.weapon!=1&&gun?gun->value("fireRate",1.):1.);
        }
    }
    void reset() {offline_music.reset();movement.reset();longjumps.reset();spatial_states.clear();announcer.reset_attempt();announcer.reset_clock();pending_cues.clear();previous_weapon={};measured=perfect=0;Lock lock(stream);for(auto &v:voices){if(!v.loop)v.samples=nullptr;else{v.cursor=0;v.filtered=0;}}voices[0].gain=voices[1].gain=0;last_start.clear();last_variant.clear();random_seed=977;variant=0;elapsed=0;rendered=0;}
    void pause() {Lock lock(stream);voices[0].gain=voices[1].gain=0;}
    void tick(const BhSnapshot &s,const BhRunState &run,const BhWeaponReport &weapon,const BhAttackReport *attack,double dt,const std::string &surface="concrete",double water_depth=std::numeric_limits<double>::quiet_NaN(),const BhJumpObservation *jump_observation=nullptr) {
        if(!enabled_)return;
        elapsed+=dt;
        const auto &p=s.player;const double speed=std::hypot(p.velocity[0],p.velocity[1]);
        movement.tick(p,dt,water_depth,surface,[&](const std::string &id,double gain,double rate){play(id,float(gain),rate);});
        const nlohmann::json *sounds_for_gun=nullptr;
        if(gun_sounds.is_array()&&weapon.active<gun_sounds.size()&&gun_sounds[weapon.active].is_object())sounds_for_gun=&gun_sounds[weapon.active];
        else if(gun_sounds.is_object()&&gun_sounds.contains(std::to_string(weapon.active)))sounds_for_gun=&gun_sounds[std::to_string(weapon.active)];
        auto gun=[&](const std::string &kind,const std::string &fallback){
            return sounds_for_gun?sounds_for_gun->value(kind,fallback):fallback;
        };
        if(run.update_flags&(1|4))announcer.reset_attempt();
        const int hop=run.measured_jumps>measured?(run.perfect_jumps>perfect?1:0):-1;measured=run.measured_jumps;perfect=run.perfect_jumps;
        const bool broken=run.status!=1||p.on_ladder||(p.events&(1|8))||s.movement_mode!=0;
        const auto event=announcer.tick(announcer_prefs,speed,scroll_style?hop:-1,p.grounded,dt,broken);if(!event.empty())announce(event);
        if(longjumps.tick(s,jump_observation,dt,movement_style,announcer_prefs.at("ljThreshold").get<double>()))announce("lj");
        if(scroll_style&&hop==1&&!broken&&perfect_tick)play("split",.12f,1.5);
        if(run.update_flags&1)play("start_beep");if(run.update_flags&16)play("split");if(run.update_flags&2){duck_music(.3f,1.2);play("finish");}
        const nlohmann::json *timeline=weapon_audio.is_array()&&weapon.active<weapon_audio.size()&&weapon_audio[weapon.active].is_object()?&weapon_audio[weapon.active]:nullptr;
        auto fallback=[](const std::string &kind){
            static const std::unordered_map<std::string,std::string> ids={{"draw","gun_draw"},{"magOut","gun_mag_out"},{"magIn","gun_mag_in"},{"slide","gun_slide"},{"pump","gun_pump"},{"shell","gun_shell_in"},{"silTwist","gun_silencer_twist"},{"silSeat","gun_silencer_seat"},{"silCrack","gun_silencer_crack"},{"silOff","gun_silencer_off"}};
            const auto found=ids.find(kind);return found==ids.end()?std::string():found->second;
        };
        auto schedule=[&](const std::string &clip,double offset=0.,double scale=1.){
            if(!timeline||!timeline->contains(clip))return;for(const auto &cue:timeline->at(clip)){
                if(!cue.is_array()||cue.size()!=3)continue;const auto kind=cue[1].get<std::string>();const auto id=gun(kind,fallback(kind));if(!id.empty())pending_cues.push_back({elapsed+offset+cue[0].get<double>()*scale,id,cue[2].get<float>()});
            }
        };
        // Settings -> Audio -> Weapon sounds: every cue below (draw, reload, fire,
        // knife swing/stab, impacts) is weapon audio; the gameplay itself is unchanged.
        if(!weapon_sounds_enabled)pending_cues.clear();
        else{
        if(weapon.active!=previous_weapon.active||(weapon.flags&(1|32|64|1024)))pending_cues.clear();
        if(weapon.flags&1){if(weapon.active==1)play("carrot_draw");else if(timeline)schedule("draw");else play(gun("draw","gun_draw"));}
        if(weapon.flags&2)play(gun("pickup","gun_pickup"));
        const bool shells=timeline&&timeline->at("timing").contains("shells");
        if(weapon.flags&4){pending_cues.clear();if(shells){const auto &t=timeline->at("timing").at("shells");schedule("shellInsert",t.at("start").get<double>());}else if(timeline){const double seconds=weapon.reload_ticks*dt,authored=timeline->at("timing").value("reload",2.4);schedule(weapon.clip==0?"reloadEmpty":"reload",0,seconds>0?seconds/authored:1);}else play(gun("magOut","gun_mag_out"));}
        if(shells&&weapon.active==previous_weapon.active&&weapon.clip>previous_weapon.clip){if(weapon.flags&8)schedule("shellEnd");else if(weapon.reload_ticks)schedule("shellInsert");}
        if((weapon.flags&8)&&!timeline)play(gun("slide","gun_slide"));
        if(weapon.flags&16)play(gun("dry","gun_dry"));if(weapon.flags&128)play(gun("mode","gun_mode"));
        if(weapon.flags&256){pending_cues.clear();const double scale=weapon.silencer_ticks*dt/(114./37.);schedule(weapon.silencer?"silencerOn":"silencerOff",0,scale>0?scale:1);}
        if(attack){
            if(shells)pending_cues.clear();
            play(attack->weapon==1?(attack->mode==2?"carrot_stab":"carrot_swing"):gun(weapon.silencer?"silenced":"fire",gun("fire","shot_pistol")),1,attack->weapon==1||!sounds_for_gun?1:sounds_for_gun->value("fireRate",1.));
            if(timeline&&timeline->at("timing").contains("pump"))pending_cues.push_back({elapsed+timeline->at("timing").at("pump").at("at").get<double>(),gun("pump","gun_pump"),1});
            if(attack->hit)impact(*attack,impact_surfaces.surface(map_core,*attack));
        }
        for(auto it=pending_cues.begin();it!=pending_cues.end();)if(it->at<=elapsed+1e-9){play(it->id,it->gain);it=pending_cues.erase(it);}else ++it;
        }
        previous_weapon=weapon;
        const double speed3=std::hypot(speed,double(p.velocity[2])),b=std::clamp((speed3-270)/1000,0.,1.);
        const double high=std::pow(std::clamp((speed3-750)/1300,0.,1.),1.5)*(p.grounded?.5:1.);
        Lock lock(stream);
        voices[0].gain=wind_enabled?float(std::pow(b,1.25)*(p.grounded?.55:1.)*mix.value("wind",nlohmann::json::object()).value("gain",.9f)):0;
        voices[0].rate=.85+.4*b;voices[0].cutoff=float(450+7500*std::pow(b,1.4));
        voices[1].gain=wind_enabled?float(high*mix.value("wind_high",nlohmann::json::object()).value("gain",.6f)):0;
        voices[1].rate=.9+.3*high;voices[1].cutoff=float(3000+9000*high);
    }
};
}
