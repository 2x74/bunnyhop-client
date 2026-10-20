#include "room_modes.hpp"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <iostream>
using J=nlohmann::json;
J race(std::string state="countdown",std::string id="r1",unsigned track=0){return {{"id",id},{"state",state},{"map","bhop_eazy"},{"style","sideways"},{"track",track},{"a",{{"name","Alice"},{"slot",1},{"finish",nullptr}}},{"b",{{"name","Bob"},{"slot",2},{"finish",nullptr}}},{"you","a"},{"expiresAt",11000},{"goAt",10000},{"endsAt",70000}};}
J event(J body,uint64_t generation=1,std::string room="room-a"){return {{"generation",generation},{"id",room},{"event",body}};}
J update(J r,double offset=0){return event({{"t","race"},{"race",r},{"nativeClockOffsetMs",offset}});}
int main(){
 native::RoomModes modes;auto action=modes.event(update(race()),"bhop_eazy",true,7000);
 assert(action.restart&&action.stop_spectating&&action.track==0&&action.style=="sideways"&&modes.frozen());
 assert(!modes.event(update(race()),"bhop_eazy",false,8000).restart);
 assert(modes.notice(8000).find("2")!=std::string::npos);
 assert(modes.notice(11000).find("Waiting for GO")!=std::string::npos&&modes.frozen());
 action=modes.event(update(race("live")),"bhop_eazy",false,11000);
 assert(action.restart&&!action.stop_spectating&&!modes.frozen());assert(modes.notice(11000).find("GO")!=std::string::npos);
 assert(!modes.event(update(race("live")),"bhop_eazy",false,12000).restart);
 assert(modes.notice(71000).find("waiting for server result")!=std::string::npos); // Never invent a local winner/timeout.
 modes.event(update(race("settling")),"bhop_eazy",false,71000);assert(modes.notice(71000).find("checking server")!=std::string::npos);
 auto result=race("over");result["winner"]="b";result["outcome"]="finish";result["a"]["finish"]={{"time",8.1},{"real",8.7},{"status","verified"}};result["b"]["finish"]={{"time",9.1},{"real",8.4},{"status","verified"}};
 modes.event(update(result),"bhop_eazy",false,72000);assert(modes.notice(72000).find("Bob won")!=std::string::npos);assert(modes.notice(72000).find("00:08.700")!=std::string::npos);assert(modes.notice(80001).empty());
 // A fresh client reconnecting to a live race never resets an already-started run.
 native::RoomModes reconnect;assert(!reconnect.event(event({{"t","welcome"},{"race",race("live")}}),"bhop_eazy",false,12000).restart);
 assert(!reconnect.frozen());
 // Map loading defers countdown placement; a GO received during loading is applied once after the map is ready.
 native::RoomModes loading;assert(!loading.event(update(race()),"old_map",true,7000).restart);assert(!loading.frozen());action=loading.map_loaded("bhop_eazy",true,8000);assert(action.restart&&action.stop_spectating&&loading.frozen());
 native::RoomModes late;late.event(update(race()),"old_map",false,7000);late.event(update(race("live")),"old_map",false,11000);action=late.map_loaded("bhop_eazy",false,12000);assert(action.restart&&!late.frozen());assert(!late.map_loaded("bhop_eazy",false,12001).restart);
 // Bonus tracks preserve the selected main-track style (native reset applies autohop to the bonus).
 native::RoomModes bonus;action=bonus.event(update(race("countdown","bonus",2)),"bhop_eazy",false,7000);assert(action.restart&&action.track==2&&action.style.empty());
 // Offset comes from the transport's clock, never from elapsed simulation ticks.
 native::RoomModes clock;clock.event(update(race(),5000),"bhop_eazy",false,2000);assert(clock.notice(2000).find("3")!=std::string::npos);
 // Cancelled/expired invitations have no race result; leaving and old callbacks cannot refreeze another room.
 auto expired=race("over","invite");expired["goAt"]=nullptr;expired["outcome"]="expired";clock.event(update(expired),"bhop_eazy",false,3000);assert(clock.notice(3000).empty()&&!clock.frozen());
 modes.event(event({{"t","nativeLeave"}}),"bhop_eazy",false,90000);assert(!modes.has_race());assert(!modes.event(update(race()),"bhop_eazy",false,90001).restart);
 action=modes.event(event({{"t","race"},{"race",race("countdown","new")}},2,"room-b"),"bhop_eazy",false,90002);assert(action.restart&&modes.frozen());modes.event(update(race()),"bhop_eazy",false,90003);assert(modes.frozen());
 modes.event(event({{"t","nativeStatus"},{"status","closed"}},2,"room-b"),"bhop_eazy",false,90004);assert(!modes.frozen());
 std::cout<<"Native room countdown, GO, authoritative results, reconnect and map placement checks passed\n";
}
