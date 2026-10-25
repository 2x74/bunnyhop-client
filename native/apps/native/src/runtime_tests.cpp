#include "practice.hpp"
#include "hud_geometry.hpp"
#include "leave_hold.hpp"
#include "map_jobs.hpp"
#include "settings.hpp"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <thread>
#include <mutex>
#include <iostream>
using namespace std::chrono_literals;
int main(){
    native::Practice p;
    assert(p.key_allowed("save",true));assert(!p.key_allowed("tele",true));assert(p.key_allowed("noclip",false));
    p.menu_open=true;assert(p.key_allowed("tele",true));assert(p.key_allowed("noclip",true));
    p.menu_open=false;p.active=true;p.tool="teleport";p.noclip=true;assert(p.key_allowed("next",true));
    assert(!native::practice_allows_event(p.active,"beat")&&!native::practice_allows_event(p.active,"finish"));
    assert(native::practice_allows_event(p.active,"reset"));
    p.restart();assert(!p.active&&!p.noclip&&p.tool.empty());assert(native::practice_allows_event(p.active,"beat"));
    p.mode=p.active=true;p.restart();assert(p.active&&!p.noclip);
    p.retain({1,"autohop","autohop",0});p.retain({2,"scroll","scroll",0});p.step(-1);assert(p.number()==1);p.step(-1);assert(p.number()==1);p.step(8);assert(p.number()==2);
    assert(native::practice_unavailable(true,false,true,false,false)=="Practice is for solo play, not servers.");
    assert(native::practice_unavailable(true,false,false,false,true)=="No practice during a gauntlet.");
    p=native::Practice{};assert(!p.active&&!p.mode&&!p.menu_open&&p.checkpoints.empty()); // new map/replay
    const auto prefs=native::default_settings();assert(prefs["hudScale"]==100&&prefs["practiceKeepVelocity"]==true);
    assert(prefs["binds"]["cpPrev"].empty()&&prefs["binds"]["cpNext"].empty()&&prefs["binds"]["mainMenu"].empty());
    for(float percent:{50.f,100.f,175.f}){
        const native::HudGeometry g(1280,720,percent);assert(std::abs(g.scale-.8f*percent/100)<1e-6f);
        // The centre remains fixed; default bottom spacing and glyph/key gaps all scale together.
        assert(std::abs(g.width*.5f*g.scale-640)<.001f);
        assert(std::abs((g.height-154)*g.scale-(720-154*g.scale))<.001f);
        assert(std::abs(4*g.scale/(.8f*percent/100)-4)<1e-6f);
        auto patch=native::patch_settings(prefs,{{"hudScale",int(percent)}});assert(patch["hudScale"]==int(percent));
    }
    for(double percent:{49.,176.,100.5}){bool threw=false;try{native::patch_settings(prefs,{{"hudScale",percent}});}catch(...){threw=true;}assert(threw);}
    native::LeaveHold hold;using R=native::LeaveHold::Result;
    assert(hold.press(0,false,true)==R::leave);assert(hold.press(100,true,true)==R::none);
    assert(hold.frame(699,true,false)==R::none&&hold.progress(699)>.99f);assert(hold.frame(700,true,false)==R::leave);
    hold.press(1000,true,true);assert(hold.frame(1100,false,false)==R::tap&&hold.progress(1100)<0);
    hold.press(2000,true,true);assert(hold.frame(2700,true,true)==R::none&&hold.progress(2700)<0);
    assert(hold.press(3000,true,false)==R::ask);assert(hold.press(5001,true,false)==R::ask);assert(hold.press(6000,true,false)==R::leave);
    // Timed practice uses the same hold/wheel guard as a timed ranked run.
    p.active=p.mode=true;assert(native::leave_requires_confirmation(1,false));
    assert(!native::leave_requires_confirmation(0,false)&&!native::leave_requires_confirmation(2,false)&&!native::leave_requires_confirmation(1,true));
    native::LeaveHold practice_hold;
    assert(practice_hold.press(10000,native::leave_requires_confirmation(1,false),true)==R::none);
    assert(practice_hold.frame(10599,true,false)==R::none&&practice_hold.frame(10600,true,false)==R::leave);
    assert(practice_hold.press(11000,native::leave_requires_confirmation(1,false),false)==R::ask);
    assert(practice_hold.press(13000,native::leave_requires_confirmation(1,false),false)==R::leave);
    // Leave while one worker owns the shared cache; its stale progress must never overwrite the new request.
    std::atomic_bool entered=false,old_stopped=false;std::mutex cache,progress;std::string status;
    {
        native::MapJobs<int> jobs;
        jobs.start([&](const std::atomic_bool &cancel){std::lock_guard lock(cache);entered=true;while(!cancel)std::this_thread::yield();{std::lock_guard p(progress);if(!cancel)status="stale";}old_stopped=true;throw std::runtime_error("cancelled");return 0;});
        while(!entered)std::this_thread::yield();jobs.cancel();assert(!jobs.valid());
        jobs.start([&](const std::atomic_bool &cancel){std::lock_guard lock(cache);assert(!cancel);{std::lock_guard p(progress);status="new map";}return 42;});
        assert(jobs.get()==42);assert(old_stopped&&status=="new map");jobs.poll();
        entered=false;old_stopped=false;
        jobs.start([&](const std::atomic_bool &cancel){entered=true;while(!cancel)std::this_thread::yield();old_stopped=true;return 0;});
        while(!entered)std::this_thread::yield(); // destructor must cancel before joining
    }
    assert(old_stopped);
    std::cout<<"Native runtime practice, HUD geometry, leave hold and worker lifecycle passed\n";
}
