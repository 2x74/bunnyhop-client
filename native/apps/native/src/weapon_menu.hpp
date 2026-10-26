#pragma once
#include "weapon_commands.hpp"
#include <array>
#include <optional>
#include <string>
#include <vector>
namespace native {
struct WeaponMenuContext {unsigned physics=17;bool anyGun=false,replay=false,spectating=false,noclip=false;};
struct WeaponMenuResult {bool handled=false;std::optional<uint32_t> weapon;std::string refusal;};
struct WeaponMenuEntry {const char *label;uint32_t id;};
class NativeWeaponMenu {
    int category=-1;size_t page=0;
    static constexpr size_t page_size=7;
    static const std::array<const char*,7> &categories(){static const std::array<const char*,7> names={"Bunnyhop guns","Pistols","Shotguns","SMGs","Rifles","Snipers","Heavy"};return names;}
    std::vector<WeaponMenuEntry> entries()const{
        switch(category){
            case 0:return {{"Cottontail / USP",3},{"Thumper / Glock",2},{"Jackrabbit / Five-Seven",7},{"Seed Drill / P90",14},{"Furrow / AK-47",17},{"Broadfork / M3",8},{"Hedgerow / XM1014",9},{"Beanpole / AWP",22},{"Knife",1}};
            case 1:return {{"USP",3},{"Glock",2},{"P228",4},{"Desert Eagle",5},{"Dual Elites",6},{"Five-Seven",7},{"Knife",1}};
            case 2:return {{"M3",8},{"XM1014",9}};
            case 3:return {{"MAC-10",10},{"TMP",11},{"MP5",12},{"UMP-45",13},{"P90",14}};
            case 4:return {{"Galil",15},{"FAMAS",16},{"AK-47",17},{"M4A1",18},{"SG552",19},{"AUG",20}};
            case 5:return {{"Scout",21},{"AWP",22},{"G3SG1",23},{"SG550",24}};
            case 6:return {{"M249",25}};
            default:return {};
        }
    }
public:
    bool open=false;
    void show(){open=true;category=-1;page=0;}
    void toggle(){if(open)close();else show();}
    void close(){open=false;category=-1;page=0;}
    std::string title()const{return category<0?"Weapons":std::string(categories()[size_t(category)])+" ("+std::to_string(page+1)+"/"+std::to_string((entries().size()+page_size-1)/page_size)+")";}
    static std::string refusal(uint32_t id,const WeaponMenuContext &context){
        if(context.replay||context.spectating||context.noclip)return "Weapon commands are unavailable while watching or noclipping.";
        if(context.physics<7)return "Weapon commands require physics v7 or later.";
        if(id<1||id>25)return "Unknown weapon.";
        if(!context.anyGun&&!ranked_command_weapon(id))return "Ranked runs only allow the USP, Glock and knife.";
        return {};
    }
    std::vector<std::string> rows(const WeaponMenuContext &context)const{
        std::vector<std::string> out;
        if(category<0){for(size_t i=0;i<categories().size();++i)out.push_back(std::to_string(i+1)+". "+categories()[i]);}
        else{const auto list=entries();for(size_t i=page*page_size;i<std::min(list.size(),(page+1)*page_size);++i)out.push_back(std::to_string(i%page_size+1)+". "+list[i].label+(refusal(list[i].id,context).empty()?"":" [unavailable]"));out.push_back(page?"8. Previous page":"8. Categories");if((page+1)*page_size<list.size())out.push_back("9. Next page");}
        out.push_back("0. Close");if(!context.anyGun)out.push_back("Practice has every gun.");return out;
    }
    WeaponMenuResult key(unsigned digit,const WeaponMenuContext &context){
        if(!open||digit>9)return {};WeaponMenuResult result;result.handled=true;if(digit==0){close();return result;}
        if(category<0){if(digit>=1&&digit<=categories().size()){category=int(digit-1);page=0;}return result;}
        const auto list=entries();if(digit==8){if(page)--page;else category=-1;return result;}if(digit==9){if((page+1)*page_size<list.size())++page;return result;}
        if(digit<1||digit>page_size)return result;const size_t index=page*page_size+digit-1;if(index>=list.size())return result;
        result.refusal=refusal(list[index].id,context);if(result.refusal.empty()){result.weapon=list[index].id;close();}return result;
    }
};
}
