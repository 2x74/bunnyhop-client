#include "native_input.hpp"
#include "mouse_diagnostics.hpp"
#include <SDL3/SDL.h>
#include <cassert>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <iostream>

namespace {
constexpr uint64_t second=1000000000, tick_ns=10000000;
struct Totals {uint64_t pushed=0,polled=0,sampled=0;size_t peak=0;double x=0,y=0;};
void close(double actual,double expected){assert(std::abs(actual-expected)<1e-8);}
// Runs synthetic clock schedules through the real SDL event queue. SDL events
// only: this deliberately does not initialize video, create a window or claim
// to measure an operating-system/hardware polling rate.
Totals schedule(unsigned hz,unsigned fps,bool fractional,bool stalls){
    native::Input input;input.sensitivity=.1;Totals total;uint64_t now=0,tick=0,report=1;unsigned frame=0;
    const uint64_t duration=2*second;const unsigned reports=2*hz;
    while(now<duration){
        ++frame;const uint64_t span=second/fps+(stalls&&frame%37==0?40000000:0);now=std::min(duration,now+span);
        size_t queued=0;
        while(report<=reports&&(report*second/hz)<=now){
            // Fractional reports sometimes sum to integral spans. Preserve the
            // fractional flag across those spans rather than rounding shares.
            const float x=fractional?(report%4==0?-.125f:.375f):float(report%3==0?-1:2);
            const float y=fractional?(report%2==0?-.125f:.125f):float(report%2==0?-1:1);
            SDL_Event event{};event.type=SDL_EVENT_MOUSE_MOTION;event.motion.timestamp=report*second/hz;event.motion.xrel=x;event.motion.yrel=y;
            assert(SDL_PushEvent(&event));++total.pushed;++queued;total.x+=x;total.y+=y;++report;
        }
        // A stalled 8 kHz frame stays below 512 reports; never enqueue a
        // seconds-long stream or approach SDL's event queue limit.
        assert(queued<=512);total.peak=std::max(total.peak,queued);
        SDL_Event event{};while(SDL_PollEvent(&event)){assert(event.type==SDL_EVENT_MOUSE_MOTION);input.accumulate(event.motion.xrel,event.motion.yrel);++total.polled;}
        input.arrived(now);
        const auto before=input;
        auto render=input;render.consume_all();auto again=input;again.consume_all();
        close(render.yaw_counts,again.yaw_counts);close(input.acc_x,before.acc_x);close(input.acc_y,before.acc_y);close(input.yaw_counts,before.yaw_counts);assert(input.acc_events==before.acc_events&&input.motion_events==before.motion_events);
        // The camera sees pending reports on a copy, not once per physics
        // tick plus again on the authoritative input.
        close(render.yaw_counts,total.x);
        while(tick+tick_ns<=now){input.take_tick(tick,tick+tick_ns);tick+=tick_ns;const auto sample=input.look_sample();assert(sample);total.sampled+=sample->events;}
        input.frame();
    }
    input.consume_all();const auto tail=input.look_sample();assert(tail);total.sampled+=tail->events;
    assert(total.pushed==reports&&total.polled==reports&&total.sampled==reports);
    close(input.yaw_counts,total.x);close(input.pitch,total.y*.1*.022);close(input.acc_x,0);close(input.acc_y,0);assert(input.acc_events==0);
    const double final=input.yaw_counts;input.consume_all();close(input.yaw_counts,final);assert(input.motion_events==0);
    return total;
}
void clear_and_burst(){
    {native::Input fractional;fractional.accumulate(.25,0);fractional.accumulate(.75,0);fractional.arrived(100);fractional.take_tick(0,50);close(fractional.yaw_counts,.5);close(fractional.acc_x,.5);fractional.take_tick(50,100);close(fractional.yaw_counts,1);}
    native::Input input;constexpr unsigned burst=2048;SDL_Event event{};
    for(unsigned i=0;i<burst;++i){event={};event.type=SDL_EVENT_MOUSE_MOTION;event.motion.xrel=.125f;event.motion.yrel=-.25f;assert(SDL_PushEvent(&event));}
    unsigned drained=0;while(SDL_PollEvent(&event)){assert(event.type==SDL_EVENT_MOUSE_MOTION);input.accumulate(event.motion.xrel,event.motion.yrel);++drained;}
    assert(drained==burst&&input.acc_events==burst);input.arrived(second);input.take_tick(0,second/2);close(input.yaw_counts,128);assert(input.motion_events==1024);
    input.clear();const double yaw=input.yaw_counts,pitch=input.pitch;
    input.take_tick(second/2,second);input.consume_all();close(input.yaw_counts,yaw);close(input.pitch,pitch);assert(input.acc_events==0&&input.motion_events==0&&!input.have_split);assert(!SDL_PollEvent(&event));
    input.accumulate(.125,.25);input.arrived(second+tick_ns);input.take_tick(second,second+tick_ns);close(input.yaw_counts,yaw+.125);assert(input.motion_events==1);
    // Reject non-finite reports without poisoning later valid motion.
    input.accumulate(NAN,1);input.accumulate(1,INFINITY);input.consume_all();close(input.yaw_counts,yaw+.125);assert(input.motion_events==1);
}
}
int main(){if(!SDL_Init(SDL_INIT_EVENTS)){std::cerr<<"SDL events unavailable: "<<SDL_GetError()<<'\n';return 77;}
    native::MouseDiagnostics diagnostic;diagnostic.begin(1,true);
    for(uint64_t i=1;i<=8000;++i)diagnostic.motion(i*125000,i*125000+200000);
    diagnostic.end(second+1,second-499999);
    assert(diagnostic.last.events==8000&&diagnostic.last.peak_burst==8000);close(diagnostic.last.events_per_second,8000);close(diagnostic.last.average_age_ms,.2);close(diagnostic.last.max_pump_ms,.5);
    diagnostic.begin(second+2,false);diagnostic.motion(second+2,second+3);diagnostic.end(second+4,second+2);assert(diagnostic.last.events==8000&&!diagnostic.active);
    // Capture/restart flush removes stale SDL motion, preserving buttons/keys.
    SDL_Event pending{};pending.type=SDL_EVENT_MOUSE_MOTION;assert(SDL_PushEvent(&pending));pending={};pending.type=SDL_EVENT_KEY_DOWN;pending.key.scancode=SDL_SCANCODE_W;assert(SDL_PushEvent(&pending));SDL_FlushEvent(SDL_EVENT_MOUSE_MOTION);assert(SDL_PollEvent(&pending)&&pending.type==SDL_EVENT_KEY_DOWN);assert(!SDL_PollEvent(&pending));
    const auto start=std::chrono::steady_clock::now();Totals all;unsigned cases=0;
    for(unsigned rate:{125u,1000u,2000u,4000u,8000u})for(unsigned fps:{60u,144u,240u,360u})for(bool fractional:{false,true})for(bool stalls:{false,true}){
        const auto run=schedule(rate,fps,fractional,stalls);all.pushed+=run.pushed;all.polled+=run.polled;all.sampled+=run.sampled;all.peak=std::max(all.peak,run.peak);++cases;
    }
    clear_and_burst();const auto ms=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-start).count();
    std::cout<<"SDL synthetic mouse queue: "<<cases<<" schedules, "<<all.pushed<<" reports pushed/polled/sampled exactly; peak schedule burst "<<all.peak<<", separate 2048-report burst; "<<ms<<" ms informational elapsed. No hardware polling-rate claim.\n";SDL_Quit();
}
