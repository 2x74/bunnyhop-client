#include "audio.hpp"
#include "settings.hpp"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <chrono>
#include <iostream>
// The impact fixture is a vertical wood wall; no SDL, GL or simulation instance.
static float vertices[]={0,0,0,0,0,0,0,0,0,0, 0,100,0,0,0,0,0,0,0,0, 0,0,100,0,0,0,0,0,0,0};
static uint32_t indices[]={0,1,2};static BhGroup group={0,0,0,3,0};static BhMaterial material={-1,0,0,1,.5,{1,1,1}};
extern "C" const float *bh_vertices(const BhContext*,size_t*n){*n=30;return vertices;}
extern "C" const uint32_t *bh_indices(const BhContext*,size_t*n){*n=3;return indices;}
extern "C" const BhGroup *bh_groups(const BhContext*,size_t*n){*n=1;return &group;}
extern "C" const BhMaterial *bh_materials(const BhContext*,size_t*n){*n=1;return &material;}
extern "C" const char *bh_material_names_json(BhContext*,size_t*n){static const std::string names="[\"wood/crate\"]";*n=names.size();return names.c_str();}
extern "C" int bh_model_transform(BhContext*,uint32_t,BhTransform*){return 0;}
static bool audible(const std::vector<float>&v){return std::any_of(v.begin(),v.end(),[](float x){return std::abs(x)>1e-6;});}
static void pcm(const std::filesystem::path&p,float value){std::vector<float> wave(2205,value);std::ofstream out(p,std::ios::binary);out.write(reinterpret_cast<char*>(wave.data()),wave.size()*4);}
int main(int argc,char **argv){
    assert(SDL_WasInit(SDL_INIT_AUDIO)==0);
    auto p=native::default_announcer();p["enabled"]=true;native::AnnouncerPolicy policy;
    assert(policy.admit(p,"speed",0,2)=="godlike");assert(policy.admit(p,"streak",3,1).empty());assert(policy.admit(p,"pb",.1,2,"run1")=="perfect");assert(policy.admit(p,"wr",.2,2,"run2")=="godlike");assert(policy.admit(p,"pb",10,2,"run1").empty());
    p["enabled"]=false;assert(policy.admit(p,"wr",10,1,"muted").empty());p["enabled"]=true;assert(policy.admit(p,"wr",11,1,"muted").empty());assert(policy.admit(p,"lj",12,1,{},true).empty());
    native::AnnouncerPolicy reversed;p["speedThreshold"]=2000;p["highSpeedThreshold"]=1000;assert(reversed.tick(p,2500,-1,false,.01,false)=="speed");assert(reversed.tick(p,2500,-1,false,.01,false).empty());reversed.reset_attempt();p["speed"]="off";p["highSpeed"]="off";p["streakThreshold"]=2;assert(reversed.tick(p,0,1,false,.01,false).empty());assert(reversed.tick(p,0,1,false,.01,false)=="streak");
    native::MovementAudio move;move.classic=true;move.footsteps=false;std::vector<std::string> ids;auto sink=[&](const std::string&id,double,double){ids.push_back(id);};BhState state{};state.velocity[0]=250;state.velocity[2]=-300;move.tick(state,.01,NAN,"wood",sink);state.events=6;state.velocity[2]=300;move.tick(state,.01,NAN,"wood",sink);assert(ids==std::vector<std::string>{"step_wood"});ids.clear();state.events=0;state.grounded=1;state.velocity[0]=250;for(int i=0;i<50;++i)move.tick(state,.01,NAN,"wood",sink);assert(ids.empty());state.events=2;move.tick(state,.01,NAN,"metal",sink);assert(ids==std::vector<std::string>{"step_metal"});
    const auto dir=std::filesystem::temp_directory_path()/("bunnyhop-audio-"+std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));std::filesystem::create_directories(dir/"audio");
    nlohmann::json manifest={{"sfx",nlohmann::json::object()},{"mix",nlohmann::json::object()}};
    for(const std::string id:{"jump","step_metal","ui_click","wind","wind_high","announcer_perfect","announcer_godlike","announcer_holyshit","finish_pb","finish_wr","impact_wood"}){manifest["sfx"][id]={{"variants",1}};manifest["mix"][id]={{"bus",id=="ui_click"?"ui":id.starts_with("wind")?"ambience":"sfx"},{"gain",1},{"max",2},{"gap",id=="jump"?.05:0}};pcm(dir/"audio"/(id+"-1.f32"),.1f);}
    manifest["classic"]={{"step_metal",{"sound/player/footsteps/metal1.wav"}}};std::filesystem::create_directories(dir/"classic/sound/player/footsteps");
    {std::ofstream wav(dir/"classic/sound/player/footsteps/metal1.wav",std::ios::binary);auto u16=[&](unsigned n){wav.put(char(n));wav.put(char(n>>8));};auto u32=[&](unsigned n){u16(n);u16(n>>16);};wav.write("RIFF",4);u32(36+4410);wav.write("WAVEfmt ",8);u32(16);u16(1);u16(1);u32(22050);u32(44100);u16(2);u16(16);wav.write("data",4);u32(4410);for(int i=0;i<2205;++i)u16(9830);}
    std::ofstream(dir/"audio.json")<<manifest;
    {native::Audio audio(dir,dir,native::AudioMode::offline);assert(audio.load_error().empty());auto settings=native::default_settings();audio.preferences(settings);audio.play("jump");audio.play("jump");const auto once=audio.render_samples(200);audio.reset();audio.play("jump");assert(once==audio.render_samples(200)); // debounce, deterministic reset
      settings["muteSfx"]=true;audio.reset();audio.preferences(settings);audio.play("jump");assert(!audible(audio.render_samples(100)));audio.play("ui_click");assert(audible(audio.render_samples(100)));
      audio.reset();settings["muted"]=true;audio.preferences(settings);audio.play("ui_click");assert(!audible(audio.render_samples(100)));
      settings["muted"]=false;settings["muteSfx"]=false;settings["muteAmbience"]=true;audio.preferences(settings);audio.reset();BhSnapshot snapshot{};snapshot.player.velocity[0]=2000;BhRunState run{};BhWeaponReport weapon{};audio.tick(snapshot,run,weapon,nullptr,.01);assert(!audible(audio.render_samples(100)));settings["muteAmbience"]=false;audio.preferences(settings);audio.reset();audio.tick(snapshot,run,weapon,nullptr,.01);const auto wind=audio.render_samples(100);assert(audible(wind));audio.reset();audio.tick(snapshot,run,weapon,nullptr,.01);assert(wind==audio.render_samples(100));
      audio.reset();settings["wind"]=false;settings["announcer"]["enabled"]=true;audio.preferences(settings);audio.verified_finish("pb","once");assert(audible(audio.render_samples(22050)));audio.verified_finish("pb","once");assert(!audible(audio.render_samples(200)));
      // Automatic LJ reaches the same offline mixer used by replay export. Ordinary
      // movement tails are consumed per tick, so only the landing announcement remains.
      auto longjump=[&](bool enabled,int fault,double interval=.01,unsigned air_ticks=75,float step=3){audio.reset();settings["wind"]=false;settings["footsteps"]=false;settings["announcer"]["enabled"]=enabled;settings["announcer"]["ljThreshold"]=250;audio.preferences(settings);audio.set_style("autohop");BhState pre{};pre.grounded=1;pre.velocity[0]=250;bool heard=false;
        for(unsigned i=1;i<=15+air_ticks;++i){BhState post=pre;post.tick=i;post.events=0;if(i>15){const unsigned k=i-15;post.position[0]=k*step;post.position[2]=k==air_ticks?1.5f:40.f;post.velocity[0]=250+k;post.grounded=k==air_ticks;if(k==1)post.events=2;else if(k==air_ticks)post.events=4;}
          BhSnapshot s{};s.player=post;BhJumpObservation o{pre,post,BhCmd{},uint32_t(!(fault==1&&i==40)),uint32_t(fault==2&&i>=40)};o.command.side=-450;audio.tick(s,BhRunState{},BhWeaponReport{},nullptr,interval,"concrete",NAN,&o);const auto samples=audio.render_samples(441);if(i==15+air_ticks)heard=audible(samples);pre=post;
        }return heard;};
      assert(longjump(true,0));assert(longjump(true,0,.05,14,16));assert(!longjump(true,0,.01,14,16));assert(!longjump(false,0));assert(!longjump(true,1));assert(!longjump(true,2));
      audio.focus(false);audio.play("ui_click");assert(!audible(audio.render_samples(100)));audio.focus(true);audio.play("ui_click");assert(audible(audio.render_samples(100)));
      audio.reset();settings["classicSounds"]=true;audio.preferences(settings);assert(audio.classic_active());audio.play("step_metal");const auto classic=audio.render_samples(10);assert(classic[0]>.19f);audio.reset();audio.play("jump");assert(audible(audio.render_samples(10))); // missing classic cues keep shipped bank
      native::ImpactSurfaces impacts;impacts.build(reinterpret_cast<BhContext*>(1));BhAttackReport hit{};hit.hit=1;hit.end[1]=hit.end[2]=20;hit.normal[0]=1;assert(impacts.surface(nullptr,hit)=="wood");audio.reset();audio.impact(hit,"wood");assert(audible(audio.render_samples(100)));
    }
    {native::Audio missing(dir/"missing",dir,native::AudioMode::offline);assert(!missing.load_error().empty());}
    if(argc>1){native::Audio shipped(argv[1],dir,native::AudioMode::offline);assert(shipped.load_error().empty());for(const char *id:{"announcer_perfect","announcer_godlike","announcer_holyshit","wind_high","supporter_gift","gun_silencer_twist"})assert(shipped.has_cue(id));}
    std::filesystem::remove_all(dir);assert(SDL_WasInit(SDL_INIT_AUDIO)==0);std::cout<<"Offline audio, channel gates, cue dedupe, announcer policy, CS:S movement and impact materials passed\n";
}
