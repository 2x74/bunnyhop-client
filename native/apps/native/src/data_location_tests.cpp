// Settings -> Game data: where the client keeps its data, and moving it.
// Usage: data_location_tests [DIR_ON_ANOTHER_DRIVE] (adds the cross-volume copy case)
#include "data_location.hpp"
#include <cassert>
#include <chrono>
#include <fstream>
#include <iostream>
namespace fs=std::filesystem;
namespace dl=native::data_location;
static void put(const fs::path &p,const std::string &s){fs::create_directories(p.parent_path());std::ofstream(p,std::ios::binary)<<s;}
static std::string get(const fs::path &p){std::ifstream in(p,std::ios::binary);return {std::istreambuf_iterator<char>(in),{}};}
static fs::path scratch(const fs::path &base,const char *name){
    const auto p=base/(std::string("bh-data-location-")+name+"-"+std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    fs::remove_all(p);fs::create_directories(p);return p;
}
static void fill(const fs::path &root){
    put(root/"settings.json","{\"sensitivity\":2}");put(root/"replays/a.bhr","replay");put(root/"objects/ab/cdef","x"+std::string(4096,'y'));
    fs::create_directories(root/"bgm");
}
static void check_moved(const fs::path &from,const fs::path &to,const fs::path &def){
    assert(get(to/"settings.json")=="{\"sensitivity\":2}");assert(get(to/"replays/a.bhr")=="replay");assert(get(to/"objects/ab/cdef").size()==4097);
    assert(fs::is_directory(to/"bgm"));assert(dl::entries(from,def).empty());
}
static void move_case(const fs::path &base_from,const fs::path &base_to,const char *name){
    const auto def=scratch(base_from,name);fill(def);
    dl::write(def,{def,std::nullopt});assert(!fs::exists(def/dl::pointer_name)); // default folder needs no file
    const auto dest_parent=scratch(base_to,name);
    const auto choice=dl::choose(dest_parent,def,def);assert(choice.problem.empty());assert(dl::same(choice.target,dest_parent));
    dl::write(def,{def,choice.target});
    auto loc=dl::read(def);assert(dl::same(loc.active,def)&&loc.pending&&dl::same(*loc.pending,choice.target));
    dl::Progress progress;const auto error=dl::move(loc.active,*loc.pending,def,progress);
    if(!error.empty()){std::cerr<<error<<'\n';assert(false);}
    assert(progress.done==progress.total&&progress.total>4000);
    check_moved(def,choice.target,def);
    dl::write(def,{choice.target,std::nullopt});loc=dl::read(def);assert(dl::same(loc.active,choice.target)&&!loc.pending);
    assert(fs::exists(def/dl::pointer_name)); // pointer stays in the default folder, untouched by the move
    // And back to the default folder.
    const auto back=dl::choose(def,loc.active,def);assert(back.problem.empty()&&dl::same(back.target,def));
    assert(dl::move(loc.active,back.target,def,progress).empty());check_moved(loc.active,def,def);
    dl::write(def,{def,std::nullopt});assert(!fs::exists(def/dl::pointer_name));
    fs::remove_all(def);fs::remove_all(dest_parent);
}
int main(int argc,char **argv){
    const auto tmp=fs::temp_directory_path();
    // choose(): empty folder used as is; a folder with files gets "Bunnyhop Data" inside.
    {const auto def=scratch(tmp,"choose");fill(def);const auto other=scratch(tmp,"other");
     assert(dl::same(dl::choose(other,def,def).target,other));
     put(other/"photo.jpg","x");const auto c=dl::choose(other,def,def);assert(c.problem.empty()&&dl::same(c.target,other/dl::subfolder_name));
     put(other/dl::subfolder_name/"thing","x");assert(!dl::choose(other,def,def).problem.empty());
     assert(!dl::choose(def,def,def).problem.empty());                       // already in use
     assert(!dl::choose(def/"replays",def,def).problem.empty());              // inside the current folder
     assert(!dl::choose(def.parent_path(),def,def).problem.empty()||dl::same(dl::choose(def.parent_path(),def,def).target,def.parent_path()/dl::subfolder_name)); // never the folder holding it as is
     assert(!dl::choose(fs::path("relative/dir"),def,def).problem.empty());
     put(other/"file.txt","x");assert(!dl::choose(other/"file.txt",def,def).problem.empty());
     fs::remove_all(def);fs::remove_all(other);}
    // read(): broken or odd pointer files fall back to the default folder.
    {const auto def=scratch(tmp,"read");put(def/dl::pointer_name,"{not json");assert(dl::same(dl::read(def).active,def));
     put(def/dl::pointer_name,"{\"path\":\"relative\"}");assert(dl::same(dl::read(def).active,def));
     put(def/dl::pointer_name,"[]");assert(dl::same(dl::read(def).active,def)&&!dl::read(def).pending);
     fs::remove_all(def);}
    // move(): refuses to overwrite, leaving everything in place.
    {const auto def=scratch(tmp,"conflict");fill(def);const auto to=scratch(tmp,"conflict-to");put(to/"replays/x","keep");
     dl::Progress p;assert(!dl::move(def,to,def,p).empty());assert(get(def/"settings.json")=="{\"sensitivity\":2}");assert(get(to/"replays/x")=="keep");
     fs::remove_all(def);fs::remove_all(to);}
    move_case(tmp,tmp,"same-volume");
    if(argc>1){assert(!dl::same_volume(tmp,argv[1]));move_case(tmp,argv[1],"cross-volume");std::cout<<"cross-volume ok\n";}
    std::cout<<"data location ok\n";
}
