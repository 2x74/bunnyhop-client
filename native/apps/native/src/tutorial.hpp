#pragma once
#include "bunnyhop_native.h"
#include "nlohmann/json.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

namespace native {
namespace tutorial {
using Json=nlohmann::json;
constexpr uint32_t teleported=1, jumped=2;
inline double speed(const float v[3]) { return std::hypot(double(v[0]),double(v[1])); }
inline double wrap(double a) { return std::fmod(std::fmod(a+180,360)+360,360)-180; }
inline bool in_box(const float p[3],const Json &box,double pad=0,double below=0) {
    if(!box.is_object()||!box.contains("min")||!box.contains("max"))return false;
    for(int k=0;k<3;k++)if(p[k]<box.at("min").at(k).get<double>()-pad-(k==2?below:0)||p[k]>box.at("max").at(k).get<double>()+pad)return false;
    return true;
}
inline Json finite(double value) { return std::isfinite(value)?Json(value):Json(nullptr); }

// Deliberately mirrors web tutorial/goals.ts, including reset's lifetime best/jump counters.
// The web meter is specified at the simulation's fixed 100 Hz; dt only drives prompt timing.
struct StrafeMeter {
    bool airborne=false,forwardInAir=false,grounded=true;
    double speed=0,turn=0,turnRate=0,angle=90,signedAngle=0,edge=90,band=0,gain=0;
    int key=0,syncGood=0,syncTotal=0,chain=0,bestChain=0,jumps=0,breaks=0,groundTicks=0,tolerance=2;
    std::optional<double> hopGain,lastHopSpeed;double prevYaw=std::numeric_limits<double>::quiet_NaN();
    explicit StrafeMeter(int value=2):tolerance(value){}
    void reset() {prevYaw=std::numeric_limits<double>::quiet_NaN();groundTicks=chain=syncGood=syncTotal=0;hopGain.reset();lastHopSpeed.reset();turnRate=0;}
    double sync()const{return syncTotal?100.*syncGood/syncTotal:0;}
    void update(const BhState &pre,const BhState &post,const BhCmd &cmd,uint32_t events) {
        if(events&teleported){reset();prevYaw=cmd.yaw;speed=tutorial::speed(post.velocity);return;}
        speed=tutorial::speed(post.velocity);airborne=!pre.grounded&&!post.grounded;key=cmd.side<0?-1:cmd.side>0?1:0;
        turn=std::isfinite(prevYaw)?wrap(double(cmd.yaw)-prevYaw):0;prevYaw=cmd.yaw;turnRate+=(turn*100-turnRate)*.15;
        const double yaw=double(cmd.yaw)*3.14159265358979323846/180;
        const double wx=cmd.forward*std::cos(yaw)+cmd.side*std::sin(yaw),wy=cmd.forward*std::sin(yaw)-cmd.side*std::cos(yaw),wl=std::hypot(wx,wy),vl=tutorial::speed(pre.velocity);
        if(wl>0&&vl>1){const double p=(pre.velocity[0]*wx+pre.velocity[1]*wy)/wl;angle=std::acos(std::clamp(p/vl,-1.,1.))*180/3.14159265358979323846;edge=std::asin(std::min(1.,30/vl))*180/3.14159265358979323846;band=(angle-90)/edge;signedAngle=pre.velocity[0]*wy-pre.velocity[1]*wx>=0?angle:-angle;}
        else{angle=90;band=std::numeric_limits<double>::quiet_NaN();}
        gain=airborne?speed-vl:0;forwardInAir=airborne&&cmd.forward!=0;
        if(airborne&&turn!=0&&wl>0){syncTotal++;const double cross=pre.velocity[0]*wy-pre.velocity[1]*wx;if((turn>0&&cross>0)||(turn<0&&cross<0))syncGood++;}
        grounded=post.grounded;if(post.grounded)groundTicks++;
        if(events&jumped){chain=groundTicks<=tolerance||chain==0?chain+1:1;bestChain=std::max(bestChain,chain);jumps++;const double s=tutorial::speed(pre.velocity);hopGain=lastHopSpeed?std::optional<double>(s-*lastHopSpeed):std::nullopt;lastHopSpeed=s;groundTicks=0;}
        else if(groundTicks>std::max(tolerance,8)){if(chain>0)breaks++;chain=0;lastHopSpeed.reset();hopGain.reset();}
    }
    Json json()const{return {{"airborne",airborne},{"speed",speed},{"key",key},{"turn",turn},{"turnRate",turnRate},{"angle",angle},{"signedAngle",signedAngle},{"edge",edge},{"forwardInAir",forwardInAir},{"band",finite(band)},{"gain",gain},{"syncGood",syncGood},{"syncTotal",syncTotal},{"sync",sync()},{"chain",chain},{"bestChain",bestChain},{"hopGain",hopGain?finite(*hopGain):Json(nullptr)},{"lastHopSpeed",lastHopSpeed?finite(*lastHopSpeed):Json(nullptr)},{"jumps",jumps},{"breaks",breaks},{"groundTicks",groundTicks},{"grounded",grounded}};}
};

struct Goal {std::string id;double value=0,target=0;bool lower=false,done=false;Json json()const{return {{"id",id},{"value",finite(value)},{"target",target},{"lower",lower},{"done",done}};}};
struct LessonGoals {
    Json lesson;std::vector<Goal> goals;std::vector<bool> gatesLit;int leftTicks=0,rightTicks=0;std::optional<double> finishedAt;
    explicit LessonGoals(Json geometry,double goldSeconds=20):lesson(std::move(geometry)){
        const auto id=lesson.at("id").get<std::string>();
        if(id=="jump")goals={{"hops",0,5}};else if(id=="strafe")goals={{"left",0,80},{"right",0,80}};else if(id=="speed")goals={{"speed",0,400}};else if(id=="final")goals={{"finish",0,1},{"gold",std::numeric_limits<double>::infinity(),goldSeconds,true}};else throw std::runtime_error("Unknown tutorial lesson: "+id);
        gatesLit.resize(lesson.value("gates",Json::array()).size(),false);
    }
    bool done()const {return std::all_of(goals.begin(),goals.end(),[](const Goal &g){return g.done||g.lower;});}
    const Goal *current()const {for(const auto &g:goals)if(!g.done&&!g.lower)return &g;return nullptr;}
    void set(const std::string &id,double value){for(auto &g:goals)if(g.id==id){g.value=g.lower?std::min(g.value,value):std::max(g.value,value);g.done=g.lower?g.value<=g.target:g.value>=g.target;return;}}
    void finish(double seconds){if(!std::isfinite(seconds)||seconds<0)throw std::runtime_error("Invalid tutorial finish time");finishedAt=seconds;set("finish",1);set("gold",seconds);}
    int update(const BhState &post,const StrafeMeter &m){
        const auto id=lesson.at("id").get<std::string>();int lit=-1;
        if(id=="jump")set("hops",m.bestChain);
        else if(id=="strafe"){if(m.airborne&&m.gain>0){if(m.key<0&&m.turn>0)leftTicks++;if(m.key>0&&m.turn<0)rightTicks++;}set("left",leftTicks);set("right",rightTicks);}
        else if(id=="speed"){set("speed",std::floor(m.speed));const auto gates=lesson.value("gates",Json::array());for(size_t i=0;i<gates.size();i++)if(!gatesLit[i]&&m.speed>=gates[i].at("speed").get<double>()){gatesLit[i]=true;lit=int(i);}}
        else if(id=="final"&&!finishedAt){const auto checkpoints=lesson.value("checkpoints",Json::array());if(!checkpoints.empty()&&in_box(post.position,checkpoints[0]))set("finish",1);}
        return lit;
    }
    Json json()const {Json out=Json::array();for(const auto &g:goals)out.push_back(g.json());return out;}
};

struct Coach {
    std::string nudge,candidate;int idleTicks=0,count=0,left=0;bool legit=false;
    explicit Coach(bool value=false):legit(value){}
    void reset(){nudge.clear();candidate.clear();count=left=idleTicks=0;}
    void show(const std::string &value,int ticks=160){nudge=value;left=ticks;}
    static std::string condition(const std::string &lesson,const StrafeMeter &m,bool done){
        if(!m.airborne)return {};if(m.forwardInAir&&(lesson!="final"||m.key!=0))return "forward";if(done||lesson=="final")return {};
        const int turning=std::abs(m.turnRate)>25?(m.turnRate>0?1:-1):0;
        if(m.key&&turning&&-m.key!=turning)return "opposite";
        if(m.key&&std::abs(m.turnRate)<8)return m.key<0?"mouse-left":"mouse-right";
        if(!m.key&&turning)return turning>0?"key-left":"key-right";
        if(m.key&&m.band>1.4&&m.gain<0)return "slower";return {};
    }
    void update(const std::string &lesson,const BhState &pre,uint32_t events,const StrafeMeter &m,int breaksBefore,bool done){
        idleTicks=m.grounded&&m.speed<40?idleTicks+1:0;if(left>0&&--left==0)nudge.clear();
        if(events&teleported){if(lesson=="final"&&pre.position[2]<-8)show("edge",260);else reset();return;}
        if(lesson=="jump"){if(!done&&m.breaks>breaksBefore&&m.jumps>1)show(legit?"scroll-on-land":"keep-holding",260);return;}
        const auto c=condition(lesson,m,done);count=!c.empty()&&c==candidate?count+1:!c.empty()?1:0;candidate=c;
        const int hold=c=="forward"?20:c=="opposite"?25:c=="slower"?60:!c.empty()?45:1;if(!c.empty()&&count>=hold)show(c);
    }
};
} // namespace tutorial

class Tutorial {
public:
    using Json=nlohmann::json;
    struct Spawn {std::array<float,3> position{};float yaw=0;};
    struct TickResult {bool completed=false,reached_exit=false,finished=false;int next_lesson=-1,gate=-1;double progress=0;};
private:
    Json data;std::vector<tutorial::LessonGoals> lessons;std::array<bool,4> completedLessons{};int current=-1;bool active=false,legit=false;
    tutorial::StrafeMeter meter;tutorial::Coach coach;double clock=0,showUntil=0,progressAt=0,progressValue=0;std::string previousStep;
    std::array<float,3> previousPosition{};bool havePosition=false;
    const tutorial::LessonGoals &goals()const{return lessons.at(current);}tutorial::LessonGoals &goals(){return lessons.at(current);}
    static std::string substitute(std::string s,const std::array<std::string,4> &keys){const char *tokens[]={"{jump}","{forward}","{left}","{right}"};for(int k=0;k<4;k++){size_t at=0;while((at=s.find(tokens[k],at))!=std::string::npos){s.replace(at,std::char_traits<char>::length(tokens[k]),keys[k]);at+=keys[k].size();}}return s;}
    std::array<std::string,4> keys{"Space","W","A","D"};
public:
    explicit Tutorial(Json jsonData,bool legitScroll=false):data(std::move(jsonData)),legit(legitScroll),meter(legitScroll?5:2),coach(legitScroll){
        const auto &raw=data.at("lessons");if(!raw.is_array()||raw.size()!=4)throw std::runtime_error("Tutorial needs four lessons");const char *ids[]={"jump","strafe","speed","final"};
        for(size_t i=0;i<raw.size();i++){if(raw[i].at("id")!=ids[i])throw std::runtime_error("Invalid tutorial lesson order");for(const auto &axis:raw[i].at("start").at("position"))if(!axis.is_number()||!std::isfinite(axis.get<double>()))throw std::runtime_error("Invalid tutorial spawn");if(raw[i]["start"]["position"].size()!=3)throw std::runtime_error("Invalid tutorial spawn");const double demo=raw[i].value("demoSeconds",0.);lessons.emplace_back(raw[i],demo>0?std::ceil(demo*1.4):20);}
    }
    void start(int index){if(index<0||index>=int(lessons.size()))throw std::runtime_error("Invalid tutorial lesson");current=index;active=true;meter.reset();coach.reset();havePosition=false;showUntil=clock+9;progressAt=clock;progressValue=0;previousStep=goals().current()?goals().current()->id:"";}
    void start(const std::string &id){for(size_t i=0;i<lessons.size();i++)if(lessons[i].lesson.at("id")==id){start(int(i));return;}throw std::runtime_error("Unknown tutorial lesson: "+id);}
    void set_legit(bool value){legit=value;meter.tolerance=value?5:2;coach.legit=value;}
    void stop(){active=false;coach.reset();}
    bool is_active()const{return active;}
    int lesson_index()const{return current;}
    std::string lesson_id()const{return current>=0?goals().lesson.at("id").get<std::string>():"";}
    Spawn spawn()const{if(current<0)throw std::runtime_error("Tutorial not started");const auto &spot=lesson_id()=="final"&&data.contains("bonusStart")?data.at("bonusStart"):goals().lesson.at("start");Spawn out;for(int k=0;k<3;k++)out.position[k]=spot.at("position").at(k);out.yaw=spot.at("yaw");return out;}
    const Json &lesson_data()const{if(current<0)throw std::runtime_error("Tutorial not started");return goals().lesson;}
    bool finished()const{return completedLessons[3];}
    void set_keys(std::array<std::string,4> labels){keys=std::move(labels);}
    void set_completed(const Json &ids){if(!ids.is_array())throw std::runtime_error("Tutorial completed must be an ID array");for(const auto &id:ids)for(size_t i=0;i<lessons.size();i++)if(id==lessons[i].lesson.at("id"))completedLessons[i]=true;}
    void finish(double seconds){if(!active||lesson_id()!="final")return;goals().finish(seconds);completedLessons[current]=true;}
    TickResult tick(const BhState &pre,const BhState &post,const BhCmd &filteredCmd,uint32_t events,double dt=.01){
        TickResult out;if(!active)return out;if(!std::isfinite(dt)||dt<0||dt>1)throw std::runtime_error("Invalid tutorial tick duration");clock+=dt;
        if(havePosition){double d=0;for(int k=0;k<3;k++){const double v=pre.position[k]-previousPosition[k];d+=v*v;}if(d>96*96){meter.reset();coach.reset();}}
        for(int k=0;k<3;k++)previousPosition[k]=post.position[k];havePosition=true;
        const int breaks=meter.breaks;meter.update(pre,post,filteredCmd,events);auto &g=goals();const bool was=g.done();out.gate=g.update(post,meter);out.completed=!was&&g.done();if(g.done())completedLessons[current]=true;
        const auto *goal=g.current();const std::string step=goal?goal->id:"";const double value=goal?goal->value:0;
        if(value!=progressValue){progressValue=value;progressAt=clock;}else if(goal&&lesson_id()!="final"&&clock-progressAt>6){showUntil=clock+4;progressAt=clock;}
        if(step!=previousStep){if(!step.empty())showUntil=clock+5;previousStep=step;}
        coach.update(lesson_id(),pre,events,meter,breaks,g.done());out.finished=finished();out.progress=goal?std::clamp(goal->value/goal->target,0.,1.):1;
        // Portals can teleport straight into the next room in the same physics tick. Let the host
        // restart there, especially final -> its standing bonus-start pad, never inherited speed.
        if(!g.lesson.at("exit").is_null()&&tutorial::in_box(post.position,g.lesson.at("exit"))&&g.done()){out.reached_exit=true;out.next_lesson=current+1;}
        for(size_t i=0;i<lessons.size();i++)if(int(i)!=current&&tutorial::in_box(post.position,lessons[i].lesson.at("room"),2,64)){out.reached_exit=true;out.next_lesson=int(i);break;}
        return out;
    }
    std::string notice()const{
        if(!active||current<0)return {};if(goals().done()&&lesson_id()=="final")return "Tutorial complete. You can bhop.";
        const std::pair<const char*,const char*> nudges[]={{"forward","Let go of {forward} in the air"},{"opposite","Mouse and key the same way"},{"mouse-left","Move the mouse left too"},{"mouse-right","Move the mouse right too"},{"key-left","Hold {left} while you turn left"},{"key-right","Hold {right} while you turn right"},{"slower","Turn a little slower and smoother"},{"keep-holding","Keep holding it, no need to tap"},{"scroll-on-land","Scroll right as you touch down"},{"edge","Jump at the edge, not before"}};
        for(const auto &[id,line]:nudges)if(coach.nudge==id)return substitute(line,keys);
        if(goals().done()&&lesson_id()!="final")return "The exit is open, hop through";
        if(clock>showUntil&&coach.idleTicks<300)return {};
        const std::string id=lesson_id();std::string line=id=="jump"?(legit?"Scroll to jump each time you land":"Hold {jump} to keep jumping"):id=="strafe"?(goals().current()&&goals().current()->id=="right"?"Now {right}, mouse right":"In the air: hold {left}, move the mouse left"):id=="speed"?"Switch sides each jump to build speed":"Jump at the orange edges";return substitute(line,keys);
    }
    Json stateJSON()const{
        Json completed=Json::array();for(size_t i=0;i<lessons.size();i++)if(completedLessons[i])completed.push_back(lessons[i].lesson.at("id"));
        Json out={{"active",active},{"lesson",lesson_id()},{"lessonIndex",current},{"completed",completed},{"finished",finished()},{"notice",notice()},{"meter",meter.json()},{"nudge",coach.nudge.empty()?Json(nullptr):Json(coach.nudge)},{"idleTicks",coach.idleTicks}};
        if(current>=0){out["goals"]=goals().json();out["gates"]=goals().gatesLit;out["done"]=goals().done();}return out;
    }
};
} // namespace native
