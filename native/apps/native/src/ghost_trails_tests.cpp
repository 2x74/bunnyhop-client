#include "ghost_trails.hpp"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
int main(){
    native_render::GhostTrails trails;trails.sample("primary",0,{0,0,0});assert(trails.sample("primary",.02,{1,0,0}).size()==2);assert(trails.sample("ghost-1",.02,{9,0,0}).size()==1);
    assert(trails.sample("primary",.03,{1000,0,0}).size()==1);assert(trails.sample("primary",.01,{1000,0,0}).size()==1);assert(trails.sample("primary",.02,{1001,0,0},true).size()==1);
    for(int i=0;i<400;++i)trails.sample("primary",i*.01,{float(i),0,0});assert(trails.sample("primary",4,{400,0,0}).size()<=101);
    trails.retain({"ghost-1"});assert(trails.size()==1);trails.sample("a",4,{1,0,0});trails.sample("b",4,{1,0,0});trails.sample("c",4,{1,0,0});assert(trails.sample("fifth",4,{1,0,0}).empty());trails.clear();assert(trails.size()==0);
}
