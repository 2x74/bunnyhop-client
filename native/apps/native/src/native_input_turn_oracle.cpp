// Emits the production Input's view state for the optional private-server
// admission oracle. No server dependency enters the shipped client.
#include "native_input.hpp"
#include <iomanip>
#include <iostream>

int main() {
    std::cout << std::setprecision(17) << '[';
    bool first_case=true;
    for(const char *name:{"canonical", "custom", "raw", "teleport", "pusher", "sensitivity", "scroll", "scroll-practice"}) {
        const std::string_view mode=name;
        if(!first_case)std::cout << ',';first_case=false;
        native::Input input;input.set_angles(0,359.99);
        native::TurnAdmission admission;
        const bool scroll=mode=="scroll"||mode=="scroll-practice";
        std::cout << "{\"name\":\"" << name << "\",\"style\":\"" << (scroll?"scroll":"autohop") << "\",\"ticks\":[";
        for(unsigned tick=0;tick<8;++tick) {
            if(tick)std::cout << ',';
            uint32_t events=0;
            if(tick==2) {
                if(mode=="raw")input.set_yaw(42,5);
                if(mode=="teleport"){input.set_angles(12,42,2);events=1;}
                if(mode=="pusher"){input.set_yaw(input.yaw()+30,3);events=16;}
                if(mode=="sensitivity")input.set_sensitivity(1.73);
            }
            // Integral and fractional report totals, mouse motion and both turn directions.
            input.frame();input.motion(tick%2?.5:1,0);
            if(native::turn_binds_allowed(scroll?"scroll":"autohop",mode=="scroll-practice")) {
                const double rate=(mode=="custom"?118.888888:210)*(tick<4?1:-1);
                input.turn(rate,double(float(.01)));admission.observe(rate,scroll);
            }
            const auto cmd=input.command();const auto look=*input.look_sample();
            std::cout << "{\"yaw\":" << cmd.yaw << ",\"buttons\":" << cmd.buttons << ",\"event\":" << events
                << ",\"look\":{\"base\":" << look.base << ",\"k\":" << look.k << ",\"count\":" << look.count
                << ",\"epoch\":" << look.epoch << ",\"kind\":" << look.kind << ",\"frames\":" << look.frames
                << ",\"events\":" << look.events << ",\"reports\":" << look.reports << "}}";
        }
        std::cout << "],\"localOnly\":" << (admission.local_only?"true":"false") << '}';
    }
    std::cout << "]\n";
}
