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
    static_assert(sizeof(BhLookSample)==40 && offsetof(BhLookSample,count)==16);
    static_assert(sizeof(BhLookSampleV2)==48 && offsetof(BhLookSampleV2,epoch)==24);
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
    assert(mouse.look_sample()->count==2.125 && close(mouse.yaw(),fractional_yaw));
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
    // ---- per-tick proration (m_rawinput 2) ------------------------------
    //
    // The property under test is that each tick's share of a frame's motion
    // follows how much of the frame's time it covers, not how many ticks the
    // frame happened to drive.
    {
        constexpr uint64_t ms=1'000'000,tick=10*ms;  // 100 Hz
        // A steady 1 count per ms, polled at the given frame lengths (ms).
        // Returns the counts each tick simulated.
        auto counts_per_tick=[&](const std::vector<int> &frames) {
            native::Input in;in.set_angles(0,0);
            std::vector<int> counts;uint64_t now=0,sim=0;
            for(const int f:frames) {
                for(int i=0;i<f;++i)in.accumulate(1,0);
                now+=uint64_t(f)*ms;in.arrived(now);
                while(sim+tick<=now){in.take_tick(sim,sim+tick);sim+=tick;
                    const auto s=in.look_sample();assert(s);counts.push_back(s->count);in.set_yaw(in.yaw());}
            }
            return counts;
        };
        // One, two, or an uneven number of ticks per frame: ten each.
        for(const auto &run:{counts_per_tick({10,10,10,10,10}),counts_per_tick({20,20,10}),counts_per_tick({10,30,10})}) {
            assert(run.size()==5);
            for(const int c:run)assert(c==10);
        }
        // A frame that ends mid-tick: 15 ms then 15 ms. The first tick takes
        // its 10 ms, the 5 left over wait, and the next two ticks share the
        // rest evenly.
        const auto split=counts_per_tick({15,15});
        assert((split==std::vector<int>{10,10,10}));
    }
    {
        // Whole counts are rounded and the remainder stays queued; nothing is
        // invented or lost.
        native::Input in;in.set_angles(0,0);
        in.accumulate(3,0);in.arrived(20);
        in.take_tick(0,10);auto a=in.look_sample();assert(a&&(a->count==1||a->count==2));
        in.take_tick(10,20);auto b=in.look_sample();assert(b&&b->count==3);
        assert(in.pending_counts()==0);
    }
    {
        // Trackpad deltas are shared exactly, not rounded into whole counts.
        native::Input in;in.set_angles(0,0);
        in.accumulate(.5,0);in.arrived(20);
        in.take_tick(0,10);assert(close(in.yaw_counts,.25));
        in.take_tick(10,20);assert(close(in.yaw_counts,.5)&&in.pending_counts()==0);
    }
    {
        // Pitch is shared the same way.
        native::Input in;in.set_angles(0,0);
        in.accumulate(0,10);in.arrived(20);in.take_tick(0,10);
        assert(close(in.pitch,5*2*.022));
    }
    {
        // Resetting input state drops waiting motion; it belongs to a run or a
        // capture session that has ended. A stale split doesn't carry over.
        native::Input in;in.accumulate(5,0);in.arrived(10);
        in.clear();assert(in.pending_counts()==0&&!in.have_split);
        in.accumulate(4,0);in.arrived(1000);in.take_tick(990,1000);
        auto s=in.look_sample();assert(s&&s->count==4);
    }
    {
        // consume_all() gives everything and forgets the split, which is what
        // the paused path and the render camera rely on.
        native::Input in;in.accumulate(7,1);in.arrived(50);in.take_tick(0,10);
        in.consume_all();assert(in.pending_counts()==0&&in.yaw_counts==7&&!in.have_split);
    }

    {
        // Integral totals must not erase fractional report provenance on either axis.
        native::Input in;
        in.accumulate(.5,.5);in.accumulate(.5,.5);in.arrived(20);
        in.take_tick(0,10);
        assert(close(in.yaw_counts,.5)&&close(in.pitch,.5*.044));
        assert(in.look_sample()->count==.5);
        in.take_tick(10,20);
        assert(close(in.yaw_counts,1)&&close(in.pitch,.044));
        assert(!in.fractional_x&&!in.fractional_y);
        // Cancellation to zero also keeps provenance until the pending span ends.
        in.accumulate(.5,0);in.accumulate(-.5,0);in.accumulate(1,0);in.arrived(40);
        in.take_tick(20,30);assert(close(in.yaw_counts,1.5));
        in.clear();assert(!in.fractional_x&&!in.fractional_y);
    }
    {
        native::Input in;in.set_angles(0,90);in.motion(.5,0);in.frame();
        in.turn(210,.01);
        auto l=in.look_sample();auto cmd=in.command();
        assert(l&&l->kind==(1|128)&&l->count==.5&&l->events==1&&l->frames==1);
        assert(cmd.buttons==native::turn_left&&close(l->base,92.1));
        in.motion(1,0);in.turn(-210,.01);l=in.look_sample();cmd=in.command();
        assert(l->kind==6&&l->count==1.5&&close(l->base,90));
        assert(cmd.buttons==native::turn_right&&in.command().buttons==0);
        in.set_angles(0,180,2);in.turn(210,.01);assert(in.look_sample()->kind==(2|128));
        in.set_yaw(10,5);in.turn(210,.01);assert(in.look_sample()->kind==(5|128));
        in.motion(.5,0);in.turn(118.888888,.01);l=in.look_sample();
        assert(l->kind==(5|128)&&l->count==.5); // Custom rate is never passed off as canonical.
        const double yaw=in.yaw();in.command();
        in.turn(std::numeric_limits<double>::infinity(),.01);in.turn(210,0);in.turn(1001,.01);
        assert(in.yaw()==yaw&&in.command().buttons==0);
        assert(!native::turn_binds_allowed("scroll",false));
        assert(native::turn_binds_allowed("scroll",true)&&native::turn_binds_allowed("wonly",false));
        assert(native::configured_turn_rate(true,true,210)==0);
        assert(native::configured_turn_rate(false,false,210)==0);
        assert(native::configured_turn_rate(true,false,.01)==.01);
        assert(native::configured_turn_rate(false,true,1000)==-1000);
        assert(native::configured_turn_rate(true,false,.009)==0);
        assert(native::configured_turn_rate(true,false,std::numeric_limits<double>::quiet_NaN())==0);
        native::TurnAdmission admission;
        assert(!admission.observe(210)&&!admission.observe(-210)&&!admission.observe(0));
        assert(admission.allows_event("finish"));
        assert(admission.observe(118.888888));
        assert(!admission.allows_event("beat")&&!admission.allows_event("finish"));
        assert(admission.allows_event("reset")&&!admission.observe(210)&&admission.local_only);
        admission.reset();assert(admission.allows_event("finish"));
        assert(admission.observe(210,true)&&!admission.allows_event("finish")); // scroll practice is local too
    }
    {
        using namespace std::chrono;
        native::InputClock clock;
        const auto start=native::InputClock::Clock::time_point{};
        clock.reset(start);
        clock.reset(start+milliseconds(250)); // blocking reset work has finished
        assert(clock.elapsed(start+milliseconds(250))==0); // no 25 stale ticks
        assert(close(clock.elapsed(start+milliseconds(260)),.01));
        clock.reset(start+milliseconds(280));
        assert(clock.elapsed(start+milliseconds(270))==0); // stale frame timestamp cannot rewind reset
        assert(close(clock.elapsed(start+milliseconds(290)),.01));
        native::Input in;in.frame();in.motion(1,2);in.accumulate(3,4);in.clear();
        assert(in.frames==0&&in.motion_events==0&&in.acc_events==0);
    }

    std::cout << "Native input and Source camera checks passed\n";
}
