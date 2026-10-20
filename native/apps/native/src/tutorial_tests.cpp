#include "tutorial.hpp"
#include <fstream>
#include <iostream>
#include <stdexcept>
using Json=nlohmann::json;
namespace {
void require(bool good,const std::string &why){if(!good)throw std::runtime_error(why);}
BhState state(const Json &raw){BhState out{};for(int k=0;k<3;k++){out.position[k]=raw.at("position").at(k);out.velocity[k]=raw.at("velocity").at(k);}out.grounded=raw.at("grounded").get<bool>();return out;}
BhCmd command(const Json &raw){return {raw.at("forward"),raw.at("side"),raw.at("yaw"),raw.at("pitch"),raw.at("buttons")};}
void compare(const Json &actual,const Json &expected,const std::string &where){
    if(actual.is_number()&&expected.is_number()){const double a=actual.get<double>(),b=expected.get<double>();require(std::abs(a-b)<=1e-7*std::max({1.,std::abs(a),std::abs(b)}),where+": number "+actual.dump()+" != "+expected.dump());}
    else if(expected.is_object()){for(const auto &[key,value]:expected.items()){require(actual.contains(key),where+": missing "+key);compare(actual.at(key),value,where+"."+key);}}
    else if(expected.is_array()){require(actual.is_array()&&actual.size()==expected.size(),where+": array size");for(size_t i=0;i<expected.size();i++)compare(actual.at(i),expected.at(i),where+"["+std::to_string(i)+"]");}
    else require(actual==expected,where+": "+actual.dump()+" != "+expected.dump());
}
}
int main(int argc,char **argv){try{
    if(argc!=2)throw std::runtime_error("Run bun apps/native/src/tutorial_oracle.ts FILE.json, then tutorial-tests FILE.json");
    std::ifstream file(argv[1]);Json fixture;file>>fixture;const auto &data=fixture.at("data");size_t checked=0;
    for(const auto &c:fixture.at("cases")){
        const int index=c.at("index");const bool legit=c.at("legit");native::Tutorial tutorial(data,legit);tutorial.start(index);
        const auto &lesson=data.at("lessons").at(index);native::tutorial::StrafeMeter meter(legit?5:2);meter.reset();native::tutorial::Coach coach(legit);native::tutorial::LessonGoals goals(lesson,lesson.contains("demoSeconds")?std::ceil(lesson.at("demoSeconds").get<double>()*1.4):20);
        size_t tick=0;for(const auto &t:c.at("ticks")){
            const auto pre=state(t.at("pre")),post=state(t.at("post"));const auto cmd=command(t.at("cmd"));const uint32_t events=t.at("events");const int before=meter.breaks;meter.update(pre,post,cmd,events);const int gate=goals.update(post,meter);if(t.contains("finishSeconds"))goals.finish(t["finishSeconds"]);coach.update(lesson.at("id"),pre,events,meter,before,goals.done());
            Json actual={{"meter",meter.json()},{"goals",goals.json()},{"gates",goals.gatesLit},{"nudge",coach.nudge.empty()?Json(nullptr):Json(coach.nudge)},{"idleTicks",coach.idleTicks},{"gate",gate},{"done",goals.done()}};
            const auto where=c.at("name").get<std::string>()+" tick "+std::to_string(tick++);compare(actual,t.at("expected"),where);
            const auto result=tutorial.tick(pre,post,cmd,events);if(t.contains("finishSeconds"))tutorial.finish(t["finishSeconds"]);const auto presentation=tutorial.stateJSON();compare(presentation.at("goals"),actual.at("goals"),where+" integrated goals");require(result.gate==gate,where+" integrated gate");checked++;
        }
        std::cout<<c.at("name").get<std::string>()<<": "<<tick<<" ticks match web oracle\n";
    }
    // Flow and bounds are host-facing behavior rather than arithmetic copied from the meter.
    native::Tutorial tutorial(data);tutorial.set_completed(Json::array({"final"}));tutorial.start("final");require(tutorial.notice()=="Jump at the orange edges","a new final visit has an instruction despite saved completion");tutorial.start("jump");auto spawn=tutorial.spawn();require(spawn.position[0]==data["lessons"][0]["start"]["position"][0].get<float>(),"spawn coordinate");
    BhState pre{},post{};BhCmd cmd{};pre.grounded=post.grounded=1;for(int k=0;k<3;k++)pre.position[k]=post.position[k]=spawn.position[k];
    for(int i=0;i<5;i++){post.grounded=0;auto r=tutorial.tick(pre,post,cmd,2);pre=post;require(r.completed==(i==4),"five hop completion threshold");}
    require(tutorial.notice()=="The exit is open, hop through","goal exit instruction");for(int k=0;k<3;k++)post.position[k]=data["lessons"][1]["start"]["position"][k];auto transition=tutorial.tick(pre,post,cmd,1);require(transition.reached_exit&&transition.next_lesson==1,"teleport into next room requests host restart");
    tutorial.start("final");require(tutorial.spawn().position[0]==data["bonusStart"]["position"][0].get<float>(),"final always restarts on standing bonus pad");tutorial.finish(2);require(tutorial.finished(),"authoritative final finish");const auto final=tutorial.stateJSON();require(final["goals"][1]["done"].get<bool>(),"gold time criterion");tutorial.stop();require(!tutorial.is_active()&&tutorial.notice().empty(),"stop clears HUD instruction");
    bool rejected=false;try{tutorial.start(4);}catch(const std::exception &){rejected=true;}require(rejected,"invalid lesson rejected");
    std::cout<<checked<<" production-WASM/synthetic ticks match original web meter, goals and coach; flow checks passed\n";return 0;
}catch(const std::exception &e){std::cerr<<"Tutorial test: "<<e.what()<<'\n';return 1;}}
