#pragma once
// Dedicated full-client evidence: caller loads a real map and exits after this run.
// Include after menu_backdrop.hpp, which owns backbuffer_png.
#include "renderer.hpp"
#include "hud.hpp"
#include "native_chat.hpp"
#include <filesystem>
#include <fstream>
#include <nlohmann/json.hpp>
namespace native {
inline nlohmann::json presentation_smoke(Gl &gl,BhContext *core,Renderer &renderer,NativeHud &hud,int width,int height,const std::filesystem::path &output,const std::string &map="smoke") {
    if(!core||width<=0||height<=0)throw std::runtime_error("Invalid presentation smoke surface");
    std::filesystem::create_directories(output);
    nlohmann::json evidence={{"map",map},{"width",width},{"height",height},{"source","canonical native simulation and renderer"},{"weapons",nlohmann::json::array()}};
    BhSnapshot snapshot{};BhWeaponReport weapon{};BhRunState run{};BhCmd cmd{};BhState state{};
    Input input;double seconds=0;BhSettings settings{};bh_default_settings(&settings); // Normal 100 Hz client physics.
    auto checked=[&](int ok,const char *what){if(!ok)throw std::runtime_error(std::string(what)+": "+bh_last_error(core));};
    auto draw=[&](const std::string &notice){
        checked(bh_snapshot(core,&snapshot),"snapshot");checked(bh_weapon_report(core,&weapon),"weapon report");bh_run_state(core,&run);
        input.set_angles(cmd.pitch,cmd.yaw);const float eye[]={snapshot.player.position[0],snapshot.player.position[1],snapshot.player.position[2]+snapshot.player.view_offset_z};
        renderer.draw(width,height,eye,input,&snapshot,seconds);
        hud.draw(width,height,snapshot,run,cmd,map,"normal",notice,100,true,true,false,weapon);
    };
    auto step=[&](uint32_t buttons){cmd.buttons=buttons;checked(bh_step(core,&cmd,&state),"canonical step");seconds+=settings.tick_interval;renderer.simulation_tick();hud.tick(state);draw("Native presentation proof");};
    auto save=[&](const std::string &name){const auto png=backbuffer_png(gl,width,height,64u*1024u*1024u);if(png.empty())throw std::runtime_error("Empty screenshot");const auto path=output/(name+".png");std::ofstream file(path,std::ios::binary);file.write(png.data(),png.size());if(!file)throw std::runtime_error("Writing "+path.string());if(gl.GetError()!=GL_NO_ERROR)throw std::runtime_error("GL error capturing "+name);return path.string();};
    renderer.set_viewmodel_visible(true);
    for(const auto &[id,name]:std::vector<std::pair<uint32_t,std::string>>{{3,"usp"},{17,"ak47"},{8,"m3"},{22,"awp"}}){
        checked(bh_reset(core),"reset");renderer.reset_presentation();hud.reset_history();
        checked(bh_snapshot(core,&snapshot),"spawn");cmd={};cmd.yaw=snapshot.player.teleport_angles[1];cmd.pitch=5;
        step(id<<16);for(int i=0;i<150;i++)step(0);
        const auto clip_before=weapon.clip;bool fired=false;BhAttackReport attack{};
        for(int i=0;i<512;i++){
            step(native::attack);
            if(bh_attack_report(core,&attack)){fired=true;break;}
        }
        if(!fired||attack.weapon!=id||weapon.clip+1!=clip_before)throw std::runtime_error(name+" did not produce authoritative shot/ammo debit");
        nlohmann::json item={{"weapon",id},{"name",name},{"shotTick",state.tick},{"clipBefore",clip_before},{"clipAfter",weapon.clip},{"attackMode",attack.mode},{"hit",attack.hit},{"rayStart",attack.start},{"rayEnd",attack.end},{"attackImage",save(name+"-attack")}};
        for(int i=0;i<5;i++)step(0);item["recoilImage"]=save(name+"-recoil");
        for(int i=0;i<155;i++)step(0);
        step(1u<<13);
        if(!(weapon.flags&4)&&!weapon.reload_ticks)throw std::runtime_error(name+" reload did not start");
        item["reloadTick"]=state.tick;item["reloadTicksRemaining"]=weapon.reload_ticks;item["reloadImage"]=save(name+"-reload-start");
        for(int i=0;i<70;i++)step(0);item["reloadMotionImage"]=save(name+"-reload-motion");
        for(int i=0;i<700;i++)step(0);
        if(weapon.clip!=clip_before)throw std::runtime_error(name+" reload did not refill");
        item["clipReloaded"]=weapon.clip;evidence["weapons"].push_back(item);
    }
    checked(bh_reset(core),"knife reset");renderer.reset_presentation();cmd={};step(0);
    renderer.inspect_press();for(int i=0;i<35;i++)step(0);evidence["knifeInspectImage"]=save("knife-inspect");
    Chat chat;chat.active=true;
    chat.push("Native Unicode: café 日本語 한국어 العربية 🐇", "Bunny", "player",seconds,120,{"#55ddff","★","JP","1","native-proof"});
    chat.push("Clickable profile https://bunnyhop.lol/u/native-proof", "Guide", "system",seconds,120);
    chat.input="Unicode input 日本語 🐇";chat.cursor=chat.input.size();chat.composition="入力";chat.suggestions={"/help","/restart"};
    draw("Canonical shots / reload / inspect / Unicode");
    hud.draw_chat_overlay(width,height,chat.visible(seconds),chat.input,chat.composition,chat.suggestions,true,0,100,&chat,chat.viewport(seconds));
    evidence["unicodeChatImage"]=save("unicode-chat");
    evidence["glError"]=0;evidence["simulationSeconds"]=seconds;
    std::ofstream report(output/"presentation-evidence.json");report<<evidence.dump(2);if(!report)throw std::runtime_error("Writing presentation evidence JSON");
    return evidence;
}
}
