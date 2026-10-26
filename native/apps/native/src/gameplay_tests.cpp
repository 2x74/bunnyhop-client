#include "settings.hpp"
#include "start_point.hpp"
#include "replay_camera.hpp"
#include "weapon_commands.hpp"
#include "spatial_audio.hpp"
#include "hud_text.hpp"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <iostream>
static float trace_fraction=1;
extern "C" int bh_trace_camera(BhContext*,const float[3],const float[3],float radius,float *out){assert(radius==6);*out=trace_fraction;return 1;}
template<class F> void rejects(F fn){bool rejected=false;try{fn();}catch(...){rejected=true;}assert(rejected);}
int main(){
    const auto defaults=native::default_settings();
    // Old persisted objects merge with new defaults without wiping user binds.
    const auto migrated=native::patch_settings(defaults,{{"sensitivity",3.5},{"binds",{{"jump",{"MWheelDown"}}}}});
    assert(migrated["invertY"]==false&&migrated["sensitivity"]==3.5&&migrated["viewmodelSway"]==1);
    assert(migrated["binds"]["jump"][0]=="MWheelDown"&&migrated["binds"].contains("setStart"));
    // A full serialized configuration must remain loadable after the schema grows.
    assert(native::patch_settings(defaults,native::Json::parse(migrated.dump()))==migrated);
    rejects([&]{native::patch_settings(defaults,{{"crosshairColor","#fff;"}});});
    rejects([&]{native::patch_settings(defaults,{{"crosshairColor","#gg0000"}});});
    rejects([&]{native::patch_settings(defaults,{{"viewmodelFov",101}});});
    rejects([&]{native::patch_settings(defaults,{{"sfxVolume",-1}});});
    rejects([&]{native::patch_settings(defaults,{{"waterQuality","ultra"}});});
    rejects([&]{native::patch_settings(defaults,{{"ghostOpacity",2}});});
    rejects([&]{native::patch_settings(defaults,{{"hudLayout",{{"timer",{{"x",50},{"y",20},{"scale",0}}}}}});});
    const auto layout=native::patch_settings(defaults,{{"hudLayout",{{"timer",{{"x",50},{"y",20},{"scale",1.5},{"visible",false}}}}}});
    assert(!layout["hudLayout"]["timer"]["visible"].get<bool>());
    native::Input normal,inverted;inverted.invert_y=true;
    normal.accumulate(10,8);inverted.accumulate(10,8);normal.arrived(20);inverted.arrived(20);
    normal.take_tick(0,10);inverted.take_tick(0,10);assert(normal.pitch==-inverted.pitch&&normal.yaw()==inverted.yaw());
    normal.take_tick(10,20);inverted.take_tick(10,20);assert(normal.pitch==-inverted.pitch);
    normal.motion(1,3);inverted.motion(1,3);assert(normal.pitch==-inverted.pitch);
    native::RestartGuard guard;
    assert(guard.press("restart",0,true,true,true)); // wheel remains immediate
    assert(!guard.press("restart",0,true,false,false)); // hold also applies before timer
    assert(!guard.frame(499,true,false));assert(guard.frame(500,true,false)=="restart");assert(!guard.frame(1000,true,false));
    guard.press("restart",0,true,true,false);assert(!guard.frame(300,false,false));assert(!guard.frame(600,true,false));
    guard.press("restart",0,true,true,false);assert(!guard.frame(600,true,true));
    BhZone zone{};zone.maxs[0]=zone.maxs[1]=100;zone.mins[2]=1;zone.maxs[2]=50;
    BhState player{};player.grounded=1;player.position[0]=player.position[1]=50;
    std::vector<BhZone> zones={zone};assert(native::start_point_problem(player,zones,0,false).empty());
    player.position[0]=15;assert(!native::start_point_problem(player,zones,0,false).empty());player.position[0]=50;
    assert(!native::start_point_problem(player,zones,0,true).empty());player.velocity[0]=2;assert(!native::start_point_problem(player,zones,0,false).empty());player.velocity[0]=0;
    native::StartPoints points;points.save("map",0,player,90,-5);native::StartPoints restored;assert(restored.load(native::Json::parse(points.points.dump())));assert(restored.get("map",0)->yaw==90);assert(!restored.get("map",1));
    assert(!restored.load({{"bad",{{"position",{1,2,3}},{"yaw",0},{"pitch",100}}}}));
    native::ReplayCamera camera;native::Input view;float eye[3]{};player.view_offset_z=64;
    assert(camera.set_mode("chase"));trace_fraction=.5;camera.sample(reinterpret_cast<BhContext*>(1),player,0,0,0,eye,view);assert(std::abs(eye[0]-(50-std::cos(14*3.141592653589793/180)*46))<.001);assert(std::abs(eye[2]-(56+std::sin(14*3.141592653589793/180)*46))<.001);
    assert(!camera.set_mode("unknown"));assert(camera.mode=="chase");
    camera.set_mode("free");camera.sample(nullptr,player,0,0,0,eye,view);native::Input flight;flight.held=native::forward;const float free_start=camera.position[0];camera.move(flight,.1);assert(std::abs(camera.position[0]-free_start-50)<.001);
    camera.reset();assert(!camera.initialized);
    const float listener[]={0,0,0},right[]={0,-80,0},left[]={0,80,0},far[]={2000,0,0};
    assert(native::spatial_mix(right,listener,0).pan==1&&native::spatial_mix(left,listener,0).pan==-1);
    assert(native::spatial_mix(right,listener,180).pan<-.99&&native::spatial_mix(far,listener,0).gain==0);
    assert(native::spatial_mix(listener,listener,0).gain==1&&native::spatial_mix(listener,listener,0).pan==0);
    assert((native::pan_gains(1)==std::array<float,2>{0,1})&&(native::pan_gains(0)==std::array<float,2>{1,1}));
    assert(native::text_prefix("héllo",2)=="hé");assert(native::text_tail("ab猫狗",2)=="狗");
    assert(native::text_prefix("e\xcc\x81x",1)=="e\xcc\x81");
    const auto emoji=native::text_clusters("👩🏽‍💻!");assert(emoji.size()==2&&emoji[0].text=="👩🏽‍💻");
    const auto wrapped=native::wrap_text("猫狗猫",2);assert(wrapped.size()==3&&wrapped[1]=="狗");
    assert(native::text_clusters("🇺🇸!").size()==2);
    native::KeptWeapons kept;BhWeaponReport report{};report.active=report.secondary=3;report.flags=512;kept.observe(report);
    report.flags=0;report.silencer=1;kept.observe(report);assert(kept.weapons()==std::vector<uint32_t>{3}&&kept.modes()[0]);
    report.active=report.primary=16;report.flags=512;report.silencer=0;kept.observe(report); // a practice-only primary
    assert(kept.restarted(false,true)==std::vector<uint32_t>{3});assert(kept.next()==(3|32|64));assert(kept.next()==0);
    assert(kept.restarted(true,true)==(std::vector<uint32_t>{3,16}));assert(kept.next()==(3|32|64));
    for(int i=0;i<9;++i)assert(kept.next()==0);assert(kept.next()==(16|32));
    kept.restarted(true,false);assert(kept.next()==3);kept.cancel();for(int i=0;i<20;++i)assert(kept.next()==0);
    // A map strip has no drop flag and must not forget commanded weapons.
    report={};kept.observe(report);assert(kept.weapons().size()==2);
    report.primary=report.active=16;kept.observe(report);report.primary=0;report.active=1;report.flags=32;kept.observe(report);assert(kept.weapons()==std::vector<uint32_t>{3});
    report.flags=512;kept.observe(report);assert(kept.weapons().empty());
    std::cout<<"Gameplay preferences, start points, guard and replay cameras passed\n";
}
