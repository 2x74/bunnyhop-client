#include "client_util.hpp"
#include "room_state.hpp"
#include "movement_audio.hpp"
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
    const auto original=native::default_settings();
    auto changed=native::patch_settings(original,{{"sensitivity",1.7},{"binds",{{"jump",{"MWheelUp","Space"}}}}});
    assert(changed["sensitivity"]==1.7 && changed["binds"]["forward"]==original["binds"]["forward"]);
    rejects([&]{native::patch_settings(original,{{"volume",.2},{"sensitivity",0}});});assert(original["volume"]==.65);
    for(const auto &bad:{J{{"fpsLimit",29}},J{{"fpsLimit",144.5}},J{{"volume",2}},J{{"fov","90"}},
        J{{"muted",1}},J{{"unknown",true}},J{{"binds",{{"jump",{"Escape"}}}}},J{{"binds",{{"jump",{"F10"}}}}}})
        rejects([&]{native::patch_settings(original,bad);});
    auto folder=std::filesystem::temp_directory_path()/("bunnyhop-boundary-"+std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    std::filesystem::create_directories(folder);
    struct Cleanup{std::filesystem::path path;~Cleanup(){std::error_code ec;std::filesystem::remove_all(path,ec);}} cleanup{folder};
    native::save_settings(folder/"settings.json",original);native::save_settings(folder/"settings.json",changed);
    assert(native::load_settings(folder/"settings.json")==changed);
    assert(!std::filesystem::exists(folder/"settings.json.tmp")&&!std::filesystem::exists(folder/"settings.json.previous"));
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
    std::cout<<"Native settings, replay boundaries, and room interpolation checks passed\n";
}
