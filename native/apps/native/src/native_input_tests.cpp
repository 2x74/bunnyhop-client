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
    std::cout << "Native input and Source camera checks passed\n";
}
