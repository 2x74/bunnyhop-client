#include "client_util.hpp"
#include "room_state.hpp"
#include "movement_audio.hpp"
#include "audio.hpp"
#include <thread>
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <chrono>
#include <iostream>
using J=nlohmann::json;
template<class F> void rejects(F f){bool failed=false;try{f();}catch(const std::exception&){failed=true;}assert(failed);}
J event(uint64_t generation,std::string id,J body){return {{"generation",generation},{"id",id},{"event",body}};}
J sample(unsigned tick,float x,unsigned flags=1,float yaw=0){
    return {{"tick",tick},{"x",x},{"y",0},{"z",64},{"vx",100},{"vy",0},{"vz",0},{"yaw",yaw},{"pitch",0},{"flags",flags}};
}
J snapshot(uint64_t generation,std::string id,J samples){
    return {{"generation",generation},{"id",id},{"snapshot",{{"blocks",J::array({{{"slot",2},{"samples",samples},{"weapon",1}}})}}}};
}
int main(){
    native::MovementAudio movement;BhState state{};
    struct Cue{std::string id;double gain,rate;};std::vector<Cue> cues;
    auto hear=[&](const std::string &id,double gain,double rate){cues.push_back({id,gain,rate});};
    state.velocity[2]=-300;movement.tick(state,.01,NAN,"wood",hear);assert(cues.empty());
    state.events=6;state.velocity[2]=300;movement.tick(state,.01,NAN,"wood",hear);
    assert(cues.size()==2&&cues[0].id=="land_soft"&&cues[1].id=="jump");
    assert(std::abs(cues[0].gain-(.22+300./700)*.7)<1e-9&&cues[1].gain==.55);
    cues.clear();state.events=1|4;state.velocity[2]=0;movement.tick(state,.01,NAN,"wood",hear);
    assert(cues.size()==1&&cues[0].id=="teleport"); // Never add a landing/boost after teleport.
    cues.clear();state.events=0;state.velocity[2]=-400;movement.reset();movement.tick(state,.01,NAN,"wood",hear);
    state.velocity[2]=0;movement.tick(state,.01,40,"wood",hear);
    assert(cues.size()==1&&cues[0].id=="water_enter"&&std::abs(cues[0].gain-.85)<1e-9);
    cues.clear();state.velocity[0]=100;movement.tick(state,.01,40,"wood",hear);
    assert(cues.size()==1&&cues[0].id=="swim");
    cues.clear();state.velocity[0]=0;movement.tick(state,.01,NAN,"wood",hear);
    assert(cues.size()==1&&cues[0].id=="water_exit");
    cues.clear();movement.reset();state={};state.grounded=1;state.velocity[0]=150;
    movement.tick(state,.01,NAN,"metal",hear);
    for(int i=0;i<15;i++)movement.tick(state,.01,NAN,"metal",hear);
    assert(cues.size()==1&&cues[0].id=="step_metal"&&cues[0].gain==.55);
    {   // Replay header names: the account's display name as the web stamps it, else the web's "player".
        assert(native::replay_player_name("luna")=="luna"&&native::replay_player_name("Sync Goblin2429")=="Sync Goblin2429");
        assert(native::replay_player_name("")=="player"&&native::replay_player_name(std::string(65,'a'))=="player");
        assert(native::replay_player_name("a\nb")=="player"&&native::replay_player_name(std::string("a\0b",3))=="player");
        assert(native::replay_player_name("Ünïcødé")=="Ünïcødé");
    }
    const auto original=native::default_settings();
    {   // Turnbinds: yaw speeds and their binds.
        assert(original["yawSpeed"]==210.0&&original["yawSpeedAlt"]==210.0);
        assert(original["binds"]["turnLeft"][0]=="ArrowLeft"&&original["binds"]["turnRight"][0]=="ArrowRight"&&original["binds"]["turnFast"][0]=="Mouse4");
        auto turned=native::patch_settings(original,{{"yawSpeed",170},{"yawSpeedAlt",90.5},{"binds",{{"turnFast",{"ShiftLeft"}}}}});
        assert(turned["yawSpeed"]==170&&turned["yawSpeedAlt"]==90.5&&turned["binds"]["turnFast"][0]=="ShiftLeft");
        for(const auto &bad:{native::Json{{"yawSpeed",0}},native::Json{{"yawSpeedAlt",1001}},native::Json{{"yawSpeed","fast"}}}){
            bool threw=false;try{native::patch_settings(original,bad);}catch(const std::exception&){threw=true;}assert(threw);
        }
    }
    {   // HUD layout: known elements, x and y 0–100; a patch replaces the whole layout.
        auto laid=native::patch_settings(original,{{"hudLayout",{{"timer",{{"x",50},{"y",10.5}}},{"crosshair",{{"x",40},{"y",60}}}}}});
        assert(laid["hudLayout"]["timer"]["y"]==10.5&&laid["hudLayout"].size()==2&&original["hudLayout"].empty());
        laid=native::patch_settings(laid,{{"hudLayout",{{"timer",{{"x",1},{"y",2}}}}}});assert(laid["hudLayout"].size()==1);
        auto smooth=native::patch_settings(original,{{"strafeTrainerSmoothing",5},{"strafeTrainerHints",false}});
        assert(smooth["strafeTrainerSmoothing"]==5&&smooth["strafeTrainerHints"]==false&&original["strafeTrainerSmoothing"]==1&&original["strafeTrainerHints"]==true);
        for(const auto &bad:{native::Json{{"hudLayout",{{"nope",{{"x",1},{"y",1}}}}}},native::Json{{"hudLayout",{{"timer",{{"x",101},{"y",1}}}}}},
            native::Json{{"hudLayout",{{"timer",{{"x",1}}}}}},native::Json{{"hudLayout",{{"timer",{{"x",1},{"y",1},{"z",1}}}}}},native::Json{{"hudLayout",3}},
            native::Json{{"strafeTrainerSmoothing",0}},native::Json{{"strafeTrainerSmoothing",2.5}}}){
            bool threw=false;try{native::patch_settings(original,bad);}catch(const std::exception&){threw=true;}assert(threw);
        }
    }
    {   // Jump stats mode and interval, strafe trainer.
        auto js=native::patch_settings(original,{{"jumpStatsMode","interval"},{"jumpStatsInterval",4},{"strafeTrainer",true}});
        assert(js["jumpStatsMode"]=="interval"&&js["jumpStatsInterval"]==4&&js["strafeTrainer"]==true);
        assert(original["jumpStatsMode"]=="sixth"&&original["jumpStatsInterval"]==6&&original["strafeTrainer"]==false);
        for(const auto &bad:{native::Json{{"jumpStatsMode","seventh"}},native::Json{{"jumpStatsInterval",1}},native::Json{{"jumpStatsInterval",51}},native::Json{{"jumpStatsInterval",4.5}},native::Json{{"jumpStatsMode",3}}}){
            bool threw=false;try{native::patch_settings(original,bad);}catch(const std::exception&){threw=true;}assert(threw);
        }
    }
    auto changed=native::patch_settings(original,{{"sensitivity",1.7},{"binds",{{"jump",{"MWheelUp","Space"}}}}});
    assert(changed["sensitivity"]==1.7 && changed["binds"]["forward"]==original["binds"]["forward"]);
    rejects([&]{native::patch_settings(original,{{"volume",.2},{"sensitivity",0}});});assert(original["volume"]==.65);
    for(const auto &bad:{J{{"fpsLimit",29}},J{{"fpsLimit",144.5}},J{{"volume",2}},J{{"fov","90"}},
        J{{"muted",1}},J{{"unknown",true}},J{{"binds",{{"jump",{"Escape"}}}}},J{{"binds",{{"jump",{"F10"}}}}}})
        rejects([&]{native::patch_settings(original,bad);});
    auto folder=std::filesystem::temp_directory_path()/("bunnyhop-boundary-"+std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    std::filesystem::create_directories(folder);
    struct Cleanup{std::filesystem::path path;~Cleanup(){std::error_code ec;std::filesystem::remove_all(path,ec);}} cleanup{folder};
    {
        // Hidden/frame-limited runs disable audio once at construction. Later
        // application of persisted pack settings must not decode or open SDL.
        assert(SDL_WasInit(SDL_INIT_AUDIO) == 0);
        SDL_SetHint(SDL_HINT_AUDIO_DRIVER, "dummy");
        std::filesystem::create_directories(folder/"bgm");
        std::filesystem::create_directories(folder/"sound");
        // One second of valid mono PCM WAV, enough for a music worker to open
        // the dummy device if the constructor's gate is accidentally lost.
        std::ofstream wav(folder/"bgm"/"silence.wav", std::ios::binary);
        const auto u16 = [&](unsigned n) { wav.put(char(n)); wav.put(char(n >> 8)); };
        const auto u32 = [&](unsigned n) { u16(n); u16(n >> 16); };
        wav.write("RIFF",4);u32(36+44100);wav.write("WAVEfmt ",8);u32(16);
        u16(1);u16(1);u32(22050);u32(44100);u16(2);u16(16);
        wav.write("data",4);u32(44100);wav << std::string(44100, '\0');wav.close();
        std::filesystem::copy_file(folder/"bgm"/"silence.wav",folder/"sound"/"jump.wav");
        native::Audio audio(folder/"missing-assets",folder,false);
        for(bool custom:{true,false,true}) {
            audio.set_sfx_pack(custom);audio.set_music_pack(custom);audio.skip_track();
            for(int i=0;i<20;++i) { audio.pump();std::this_thread::sleep_for(std::chrono::milliseconds(2)); }
            assert(SDL_WasInit(SDL_INIT_AUDIO)==0);
            assert(audio.sfx_status().empty() && audio.music_status().empty() && audio.music_title().empty());
        }
    }
    native::save_settings(folder/"settings.json",original);native::save_settings(folder/"settings.json",changed);
    assert(native::load_settings(folder/"settings.json")==changed);
    assert(!std::filesystem::exists(folder/"settings.json.tmp")&&!std::filesystem::exists(folder/"settings.json.previous"));
    {
        // External links. The host decides, by parsing the authority, so
        // neither a lookalike host nor a URL that merely mentions an allowed
        // one gets through. SDL_OpenURL is never reached for any of these, so
        // nothing is launched by the test.
        for(const char *bad:{
            "http://github.com/8tp",                       // not https
            "https://github.com.evil.test/8tp",            // allowed name as a host prefix
            "https://notgithub.com/8tp",                   // allowed name as a suffix, no dot
            "https://evil.test/?next=https://github.com",  // allowed name only in the query
            "https://github.com@evil.test/",               // userinfo pointing elsewhere
            "https://evil.test#https://1998.lol",          // allowed name only in the fragment
            "https://discord.gg.evil.test/bunnyhop",       // Discord invite host as a prefix
            "https://notdiscord.gg/bunnyhop",              // Discord invite host as a suffix, no dot
            "javascript:alert(1)", "file:///etc/passwd", "https://", "",
        }) assert(!native::open_external(bad));
        assert(native::external_url_allowed("https://checkout.stripe.com/c/pay/cs_test_example"));
        assert(native::external_url_allowed("https://checkout.stripe.com:443/pay/cs_test_example"));
        for(const char *bad:{"https://checkout.stripe.com/", "https://checkout.stripe.com:444/c/pay/x", "https://checkout.stripe.com.evil.test/c/pay/x", "https://other.checkout.stripe.com/c/pay/x", "https://checkout.stripe.com@evil.test/c/pay/x", "https://billing.stripe.com/pay/x"})assert(!native::external_url_allowed(bad));
        // A control character can be re-read by whatever the desktop hands it to.
        assert(!native::open_external("https://github.com/\n8tp"));
        assert(!native::open_external("https://github.com/"+std::string(4096,'a')));
    }
    assert(native::decode_base64("TWFu")==std::vector<uint8_t>({'M','a','n'}));
    assert(native::decode_base64("TWE=")==std::vector<uint8_t>({'M','a'}));
    assert(native::decode_base64("TQ==")==std::vector<uint8_t>({'M'}));
    for(const auto &bad:{"","TQ=","T==Q","TQ==TQ==","TQ$="})rejects([&]{native::decode_base64(bad);});
    rejects([&]{native::decode_base64(std::string(12*1024*1024,'A'));});
    {std::ofstream out(folder/"safe.bhr");out<<"fixture";}
    assert(native::replay_file(folder,"safe.bhr")==folder/"safe.bhr");
    for(const auto &bad:{"../safe.bhr","a/safe.bhr","a\\safe.bhr","C:safe.bhr",".","safe.txt","missing.bhr"})
        rejects([&]{native::replay_file(folder,bad);});
    rejects([&]{native::replay_file(folder,std::string("safe\0.bhr",9));});
    std::error_code symlink_error;std::filesystem::create_symlink(folder/"safe.bhr",folder/"alias.bhr",symlink_error);
    if(!symlink_error)rejects([&]{native::replay_file(folder,"alias.bhr");});
    assert(native::mouse_code(SDL_BUTTON_RIGHT)=="Mouse2" && native::key_code(SDL_SCANCODE_W)=="KeyW");
    native::RoomState room;
    const auto welcome=J{{"t","welcome"},{"you",1},{"map",{{"name","bhop_eazy"}}},
        {"players",J::array({{{"slot",1},{"name","Self"}},{{"slot",2},{"name","Friend"}}})}};
    assert(room.event(event(2,"room-a",welcome))=="bhop_eazy");
    room.snapshot(snapshot(2,"room-a",J::array({sample(100,0,1,350),sample(120,20,1,10)})),1.);
    auto actors=room.actors(1.);assert(actors.size()==1);
    assert(std::abs(actors[0].frame.position[0]-10)<.001 && std::abs(std::remainder(actors[0].frame.yaw,360.f))<.001);
    // Old rooms and old teleports must never rewind a current peer.
    room.snapshot(snapshot(1,"room-a",J::array({sample(200,999)})),1.);
    room.snapshot(snapshot(2,"other",J::array({sample(200,999)})),1.);
    room.snapshot(snapshot(2,"room-a",J::array({sample(90,999,9)})),1.);
    assert(std::abs(room.actors(1.)[0].frame.position[0]-10)<.001);
    room.event(event(2,"other",{{"t","nativeMap"},{"map","bad"}}));assert(room.id=="room-a");
    room.snapshot(snapshot(2,"room-a",J::array({sample(140,500,9)})),1.);
    assert(room.actors(1.)[0].frame.position[0]==500); // Teleport is not interpolated across the map.
    room.snapshot(snapshot(2,"room-a",J::array({sample(150,20000)})),1.);
    assert(room.actors(1.)[0].frame.position[0]==500);
    room.event(event(2,"room-a",{{"t","player"},{"slot",2},{"patch",{{"spec",1}}}}));assert(room.actors(1.).empty());
    room.event(event(2,"room-a",{{"t","player"},{"slot",2},{"patch",{{"spec",nullptr}}}}));assert(room.actors(1.).size()==1);
    room.event(event(2,"room-a",{{"t","player"},{"slot",1},{"patch",{{"spec",2}}}}));
    assert(room.spectator_target==2 && room.spectated(1.)->frame.position[0]==500);
    room.event(event(2,"room-a",{{"t","player"},{"slot",1},{"patch",{{"spec",nullptr}}}}));
    assert(!room.spectator_target && !room.spectated(1.));
    assert(room.actors(12.).empty());
    assert(room.event(event(2,"room-a",{{"t","nativeMap"},{"map","bhop_japan"}}))=="bhop_japan");
    assert(room.actors(1.).empty());
    room.event(event(3,"room-b",welcome));room.event(event(2,"room-a",{{"t","nativeLeave"}}));assert(room.id=="room-b");
    room.event(event(3,"room-b",{{"t","nativeLeave"}}));assert(room.id.empty()&&room.actors(1.).empty());
    // Host Main menu keeps its generation fence: an old map-change timeout,
    // welcome or snapshot must not resurrect a closed room after leaving.
    room.event(event(7,"old-room",welcome));room.close();
    assert(room.generation==7&&room.id.empty()&&room.map.empty());
    assert(room.event(event(7,"old-room",{{"t","nativeMap"},{"map","bhop_late"}})).empty());
    assert(room.event(event(7,"old-room",welcome)).empty());
    assert(room.event(event(6,"old-room",welcome)).empty());
    room.snapshot(snapshot(7,"old-room",J::array({sample(300,999)})),20.);
    assert(room.generation==7&&room.id.empty()&&room.map.empty()&&room.actors(20.).empty());
    // A deliberate newer join succeeds; a late leave from the old lifecycle
    // cannot close it, and its own nativeLeave seals that generation too.
    assert(room.event(event(9,"new-room",welcome))=="bhop_eazy");
    room.event(event(7,"old-room",{{"t","nativeLeave"}}));assert(room.id=="new-room");
    room.event(event(9,"new-room",{{"t","nativeLeave"}}));
    assert(room.event(event(9,"new-room",{{"t","nativeMap"},{"map","bhop_late"}})).empty());
    assert(room.id.empty()&&room.map.empty()&&room.generation==9);
    std::cout<<"Native settings, replay boundaries, and room interpolation checks passed\n";
}
