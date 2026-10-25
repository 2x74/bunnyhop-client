#include "native_input.hpp"
#include "native_math.hpp"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <cmath>
#include <iostream>
#include <vector>

namespace {
bool close(double a,double b,double tolerance=1e-5) { return std::abs(a-b)<tolerance; }
}
int main() {
    native::Input input;
    input.set_angles(0,90);
    for(int i=0;i<10000;++i) input.motion(.125,.001);
    assert(close(input.yaw(),35)); assert(close(input.pitch,.44));
    input.set_yaw(0); input.motion(1,0); assert(close(input.yaw(),359.956));
    const double before_sensitivity=input.yaw();
    input.set_sensitivity(1.73); assert(close(input.yaw(),before_sensitivity));
    input.set_angles(0,90); input.motion(.25,.5);
    assert(close(input.yaw(),native::Input::normalize(90-.25*(1.73*.022))));
    assert(close(input.pitch,.5*1.73*.022));
    input.set_sensitivity(2);
    input.motion(0,100000); assert(input.pitch==89);
    input.motion(0,-100000); assert(input.pitch==-89);
    input.button(native::forward,true); input.button(native::right,true);
    input.pulse|=native::jump;
    auto first=input.command(),second=input.command();
    assert(first.forward==450 && first.side==450 && (first.buttons&native::jump));
    assert(!(second.buttons&native::jump) && second.forward==450);
    input.button(native::back,true); input.button(native::left,true);
    auto opposed=input.command(); assert(opposed.forward==0 && opposed.side==0);
    input.clear(); assert(input.command().buttons==0);
    BhState state{}; state.events=native::teleported|native::angles_changed;
    state.teleport_angles[0]=12; state.teleport_angles[1]=270;
    state.angle_change[0]=10; state.angle_change[1]=20;
    input.events(state); assert(close(input.pitch,12) && close(input.yaw(),270));
    assert(input.look_sample()->kind==2);
    state.events=native::angles_changed; input.events(state);
    assert(close(input.pitch,22) && close(input.yaw(),290));
    assert(input.look_sample()->kind==3);
    // Recorded counts describe the actual SDL stream; a trackpad is never rounded.
    native::Input mouse;mouse.set_angles(0,90);mouse.frame();mouse.frame();
    mouse.motion(3,2);mouse.motion(-1,-1);
    auto telemetry=mouse.look_sample();assert(telemetry);
    assert(telemetry->count==2 && telemetry->frames==2 && telemetry->events==2 && telemetry->reports==2);
    assert(close(native::Input::normalize(telemetry->base-telemetry->count*telemetry->k),mouse.command().yaw,1e-4));
    telemetry=mouse.look_sample();assert(telemetry->frames==0 && telemetry->events==0 && telemetry->count==2);
    mouse.motion(.125,0);const auto fractional_yaw=mouse.yaw();
    assert(!mouse.look_sample() && close(mouse.yaw(),fractional_yaw));
    const auto epoch=mouse.epoch;mouse.set_sensitivity(3);
    telemetry=mouse.look_sample();assert(telemetry && telemetry->kind==4 && telemetry->epoch==epoch+1 && telemetry->count==0);
    assert(close(mouse.yaw(),fractional_yaw));
    mouse.separate_vertical=true;mouse.vertical_sensitivity=5;mouse.pitch=0;
    mouse.motion(1,2);assert(close(mouse.pitch,.22));
    const auto safe_yaw=mouse.yaw(),safe_pitch=mouse.pitch;
    mouse.motion(std::numeric_limits<double>::infinity(),1);
    mouse.motion(1,std::numeric_limits<double>::quiet_NaN());
    assert(mouse.yaw()==safe_yaw && mouse.pitch==safe_pitch);
    const float eye[3]={0,0,0};
    auto project=[&](double yaw,double pitch,float x,float y,float z) {
        auto m=native::camera_matrix(eye,yaw,pitch,4.f/3.f);
        return std::array<float,4>{m[0]*x+m[4]*y+m[8]*z+m[12],m[1]*x+m[5]*y+m[9]*z+m[13],m[2]*x+m[6]*y+m[10]*z+m[14],m[3]*x+m[7]*y+m[11]*z+m[15]};
    };
    // Source +X is forward, -Y is screen right, +Z is screen up.
    auto center=project(0,0,100,0,0),right=project(0,0,100,-10,0),up=project(0,0,100,0,10);
    assert(center[3]>0 && close(center[0],0) && close(center[1],0));
    assert(right[0]>0 && up[1]>0);
    auto down=project(0,45,100,0,-100); assert(close(down[1],0,.001));
    BhTransform transform{{10,20,30},{0,90,0},1};
    auto model=native::model_matrix(transform);
    assert(close(model[0],0) && close(model[1],1) && close(model[12],10) && close(model[14],30));
    // ---- tick-windowed motion -------------------------------------------
    //
    // The property under test is that how a flick divides between ticks
    // follows the mouse report timestamps and nothing else. The old
    // behaviour applied every report polled in a frame to the first tick
    // after the poll, so a 60 Hz frame gave one tick sixteen reports and the
    // next tick none, while 1000 Hz gave one each. Same hand movement,
    // different simulation input.
    {
        constexpr uint64_t tick_ns=10'000'000;  // 100 Hz
        // A steady 1000 Hz mouse: one count every millisecond for 5 ticks.
        auto reports=[]{std::vector<native::Input::Report> r;for(int i=0;i<50;++i)r.push_back({uint64_t(i)*1'000'000+500'000,1,0});return r;}();

        // Replays those reports against a given poll pattern and returns the
        // mouse counts each tick actually simulated.
        auto counts_per_tick=[&](const std::vector<int> &ticks_per_poll) {
            native::Input in;in.set_angles(0,0);
            std::vector<int> counts;size_t next=0;uint64_t sim=0;
            for(const int ticks:ticks_per_poll) {
                // The poll delivers everything stamped up to the end of the
                // ticks it is about to drive, which is what SDL does.
                const uint64_t poll_until=sim+uint64_t(ticks)*tick_ns;
                while(next<reports.size()&&reports[next].at_ns<=poll_until){in.motion_at(reports[next].at_ns,reports[next].x,reports[next].y);++next;}
                for(int t=0;t<ticks;++t){sim+=tick_ns;in.consume_until(sim);const auto sample=in.look_sample();assert(sample);counts.push_back(sample->count);in.set_yaw(in.yaw());}
            }
            return counts;
        };

        const auto one_tick_per_frame=counts_per_tick({1,1,1,1,1});      // 100 fps
        const auto two_ticks_per_frame=counts_per_tick({2,2,1});          // 50 fps
        const auto uneven=counts_per_tick({1,3,1});                       // a stutter

        // Ten reports land in every tick regardless of how they were polled.
        for(const auto &run:{one_tick_per_frame,two_ticks_per_frame,uneven}) {
            assert(run.size()==5);
            for(const int count:run) assert(count==10);
        }
        assert(one_tick_per_frame==two_ticks_per_frame);
        assert(one_tick_per_frame==uneven);

        // Nothing is invented or lost: every report is simulated exactly once.
        int total=0;for(const int count:uneven) total+=count;
        assert(total==int(reports.size()));
    }
    {
        // A report is never divided between ticks — BhLookSample has to stay
        // integral, so splitting one count across a boundary would make the
        // sample unrepresentable and silently drop the whole tick's look.
        native::Input in;in.set_angles(0,0);
        in.motion_at(1'000'000,3,0);in.motion_at(15'000'000,4,0);
        in.consume_until(10'000'000);
        auto first=in.look_sample();assert(first && first->count==3);
        in.set_yaw(in.yaw());
        in.consume_until(20'000'000);
        auto second=in.look_sample();assert(second && second->count==4);
    }
    {
        // Reports arriving out of order are ordered rather than stranded
        // behind a newer timestamp where no deadline would ever claim them.
        native::Input in;in.set_angles(0,0);
        in.motion_at(9'000'000,1,0);in.motion_at(2'000'000,1,0);
        in.consume_until(9'000'000);
        assert(in.pending_reports()==0);
        auto sample=in.look_sample();assert(sample && sample->count==2);
    }
    {
        // A stall must not grow the queue without bound, and must not lose
        // aim the player made: the oldest report is applied early instead.
        native::Input in;in.set_angles(0,0);
        for(std::size_t i=0;i<native::Input::max_pending+64;++i) in.motion_at(uint64_t(i+1)*1'000'000,1,0);
        assert(in.pending_reports()<=native::Input::max_pending);
        in.consume_all();
        auto sample=in.look_sample();
        assert(sample && sample->count==int32_t(native::Input::max_pending+64));
    }
    {
        // motion_events must describe the tick that consumed them, since it
        // is reported per sample and not per frame.
        native::Input in;in.set_angles(0,0);
        in.motion_at(1'000'000,1,0);in.motion_at(2'000'000,1,0);in.motion_at(12'000'000,1,0);
        in.consume_until(10'000'000);
        auto first=in.look_sample();assert(first && first->events==2);
        in.set_yaw(in.yaw());in.consume_until(20'000'000);
        auto second=in.look_sample();assert(second && second->events==1);
    }
    {
        // Resetting input state drops queued motion; it belongs to a run or a
        // capture session that has ended.
        native::Input in;in.motion_at(1'000'000,5,0);
        assert(in.pending_reports()==1);
        in.clear();
        assert(in.pending_reports()==0);
    }

    std::cout << "Native input and Source camera checks passed\n";
}
