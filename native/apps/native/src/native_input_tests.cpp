#include "native_input.hpp"
#include "native_math.hpp"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <cmath>
#include <iostream>

namespace {
bool close(double a,double b,double tolerance=1e-5) { return std::abs(a-b)<tolerance; }
void timestamped_input() {
    struct Motion {uint64_t time;double x,y;};
    const Motion reports[]={{0,1,0},{5,2,1},{10,3,2},{10,-1,-1},
        {11,4,1},{20,-2,-1},{21,5,0},{35,.125,.5}};
    native::Input delayed,even;
    delayed.set_angles(0,90);even.set_angles(0,90);
    for(const auto &r:reports)delayed.motion_at(r.time,r.x,r.y);
    delayed.frame_at(5);delayed.frame_at(20);
    assert(delayed.yaw()==90 && delayed.pitch==0);
    const auto empty=delayed.look_sample();
    assert(empty && empty->events==0 && empty->frames==0 && empty->count==0);
    // Rendering previews pending motion on a copy, never advancing the tick input.
    auto preview=delayed;preview.consume_all();
    assert(close(preview.yaw(),90-12.125*.044));
    assert(delayed.yaw()==90 && delayed.pitch==0);
    size_t next=0;
    for(uint64_t tick_end:{10,20,30,40}) {
        while(next<std::size(reports)&&reports[next].time<=tick_end) {
            const auto &r=reports[next++];even.motion_at(r.time,r.x,r.y);
        }
        if(tick_end==10)even.frame_at(5);
        if(tick_end==20)even.frame_at(20);
        delayed.consume_until(tick_end);even.consume_until(tick_end);
        const auto a=delayed.command(),b=even.command();
        assert(a.yaw==b.yaw && a.pitch==b.pitch && a.buttons==b.buttons);
        const auto al=delayed.look_sample(),bl=even.look_sample();
        assert(bool(al)==bool(bl));
        if(al) {
            assert(al->base==bl->base && al->k==bl->k && al->count==bl->count);
            assert(al->epoch==bl->epoch && al->kind==bl->kind);
            assert(al->events==bl->events && al->reports==bl->reports && al->frames==bl->frames);
            assert(float(native::Input::normalize(al->base-al->count*al->k))==a.yaw);
            const int counts[]={5,7,12};
            assert(al->count==counts[tick_end/10-1]);
        } else assert(tick_end==40); // Fractional reports select the uncounted path.
    }
    const double final_yaw=delayed.yaw();delayed.consume_all();
    assert(delayed.yaw()==final_yaw); // No report can be consumed twice.

    native::Input boundary;
    boundary.motion_at(11,7,0);boundary.motion_at(10,2,5000);boundary.motion_at(10,-1,-5000);
    boundary.frame_at(10);boundary.frame_at(11);
    boundary.consume_until(9);auto look=boundary.look_sample();
    assert(look && look->count==0 && look->events==0 && look->frames==0);
    boundary.consume_until(10);look=boundary.look_sample();
    assert(look && look->count==1 && look->events==2 && look->reports==2 && look->frames==1);
    assert(boundary.pitch==-89); // Equal timestamps preserve delivery order through pitch clamps.
    boundary.consume_until(10);look=boundary.look_sample();assert(look->events==0 && look->frames==0);
    boundary.consume_until(11);look=boundary.look_sample();
    assert(look->count==8 && look->events==1 && look->frames==1);
}

void queued_resets_and_settings() {
    native::Input input;input.set_angles(0,90);
    input.motion_at(10,2,1);input.motion_at(20,3,2);input.motion_at(30,-1,-1);
    input.consume_until(10);auto look=input.look_sample();assert(look->count==2 && look->events==1);
    // A simulation teleport rebases the consumed angle, preserving later real reports.
    BhState state{};state.events=native::teleported;state.teleport_angles[0]=10;state.teleport_angles[1]=180;
    input.events(state);const auto teleport_epoch=input.epoch;
    input.consume_until(20);look=input.look_sample();
    assert(close(input.yaw(),180-3*.044) && close(input.pitch,10+2*.044));
    assert(look->epoch==teleport_epoch && look->kind==2 && look->count==3 && look->events==1);
    state.events=native::angles_changed;state.angle_change[0]=2;state.angle_change[1]=90;
    input.events(state);input.consume_until(30);look=input.look_sample();
    assert(close(input.yaw(),270-2*.044) && close(input.pitch,12+.044));
    assert(look->kind==3 && look->count==-1 && look->events==1);

    input.button(native::forward,true);input.pulse=native::jump;
    input.motion_at(40,100,100);input.frame_at(40);input.frame();
    // Pause, focus/menu capture changes and restarts discard queued reports/telemetry.
    input.clear_at(35);input.set_angles(0,90);
    input.motion_at(34,100,100);input.motion_at(35,100,100);input.frame_at(35);
    input.consume_all();look=input.look_sample();
    assert(input.command().buttons==0 && input.yaw()==90 && input.pitch==0);
    assert(look->count==0 && look->events==0 && look->reports==0 && look->frames==0);
    input.motion_at(36,2,1);input.frame_at(36);input.consume_until(36);look=input.look_sample();
    assert(close(input.yaw(),90-2*.044) && look->events==1 && look->frames==1);
    input.motion_at(50,100,100);input.clear();input.consume_all();
    assert(close(input.yaw(),90-2*.044));

    native::Input settings;
    settings.motion_at(10,2,3);settings.set_sensitivity(3);
    settings.separate_vertical=true;settings.vertical_sensitivity=5;
    settings.motion_at(20,4,5);
    settings.consume_until(10);look=settings.look_sample();
    assert(close(settings.yaw(),360-2*.044) && close(settings.pitch,3*.044));
    assert(look->k==2*.022 && look->count==2 && look->events==1);
    const double before=settings.yaw();settings.consume_until(20);look=settings.look_sample();
    assert(close(settings.yaw(),before-4*.066) && close(settings.pitch,3*.044+5*.11));
    assert(look->k==3*.022 && look->count==4 && look->events==1 && look->kind==4);
    assert(close(look->base,before));
    const double after=settings.yaw();settings.set_sensitivity(4);look=settings.look_sample();
    assert(settings.yaw()==after && look->count==0 && look->kind==4 && look->events==0);

    native::Input fractional;
    fractional.motion_at(1,std::numeric_limits<double>::infinity(),0);
    fractional.motion_at(1,0,std::numeric_limits<double>::quiet_NaN());
    for(uint64_t i=1;i<=8;++i) {
        fractional.motion_at(i,.125,.25);fractional.frame_at(i);fractional.consume_until(i);
        look=fractional.look_sample();
        if(i<8)assert(!look);
        else assert(look && look->count==1 && look->events==1 && look->reports==1 && look->frames==1);
        assert(close(fractional.yaw(),native::Input::normalize(-double(i)*.125*.044)));
    }
    fractional.consume_all();look=fractional.look_sample();assert(look->events==0 && look->frames==0);
}
}
int main() {
    timestamped_input();queued_resets_and_settings();
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
    std::cout << "Native input and Source camera checks passed\n";
}
