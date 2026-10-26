#include <set>
#include "online.hpp"
#include "renderer.hpp"
#include "menu_backdrop.hpp"
#include "loadout_preview.hpp"
int main(int argc,char **argv){try{
 if(argc!=3)throw std::runtime_error("usage: loadout-preview-smoke ASSETS OUTPUT");
 if(!SDL_Init(SDL_INIT_VIDEO))throw std::runtime_error(SDL_GetError());SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION,3);SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION,3);SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK,SDL_GL_CONTEXT_PROFILE_CORE);SDL_GL_SetAttribute(SDL_GL_DEPTH_SIZE,24);
 auto *window=SDL_CreateWindow("Native loadout preview smoke",960,600,SDL_WINDOW_OPENGL|SDL_WINDOW_HIDDEN);if(!window)throw std::runtime_error(SDL_GetError());auto context=SDL_GL_CreateContext(window);if(!context)throw std::runtime_error(SDL_GetError());SDL_GL_MakeCurrent(window,context);Gl gl;gl.load();
 std::filesystem::create_directories(argv[2]);NativeLoadoutPreview preview(gl,argv[1]);
 nlohmann::json job={{"id",1},{"loadout","2;knife-bayonet;fin-sunset;glove-sport-pandora"},{"outfit","outfit-cream"},{"ghost","ghost-gold"},{"view","fp"},{"yaw",0},{"pitch",0},{"inspect",0},{"held",false},{"width",960},{"height",600}};
 nlohmann::json evidence=nlohmann::json::array();std::set<std::string> captures;
 auto capture=[&](const std::string &name,double now){gl.BindFramebuffer(GL_FRAMEBUFFER,0);gl.Viewport(11,13,601,401);const auto png=preview.render(job,now);GLint framebuffer=-1,vp[4];gl.GetIntegerv(GL_FRAMEBUFFER_BINDING,&framebuffer);gl.GetIntegerv(GL_VIEWPORT,vp);if(framebuffer!=0||vp[0]!=11||vp[1]!=13||vp[2]!=601||vp[3]!=401)throw std::runtime_error("Preview leaked framebuffer/viewport");if(gl.GetError()!=GL_NO_ERROR)throw std::runtime_error("Preview GL error");if(png.size()<1000)throw std::runtime_error("Blank PNG");if(!captures.insert(png).second)throw std::runtime_error("Duplicate view capture: "+name);std::ofstream out(std::filesystem::path(argv[2])/(name+".png"),std::ios::binary);out.write(png.data(),png.size());evidence.push_back({{"name",name},{"bytes",png.size()},{"request",job},{"framebufferRestored",true},{"viewportRestored",true}});};
 capture("combined",10);job["yaw"]=20;job["pitch"]=-10;capture("rotated",10.2);job["view"]="close";job["yaw"]=0;job["pitch"]=0;capture("close",11);
 job["view"]="fp";job["inspect"]=1;job["held"]=true;preview.render(job,12);capture("inspect",12.7);job["view"]="bunny";job["held"]=false;capture("bunny",14);job["yaw"]=115;capture("bunny-rotated",14.2);job["view"]="ghost";capture("ghost",15);
 job["view"]="onboarding";job["inspect"]=0;job["stage"]={{"clock",0},{"position",{0,0,0}},{"velocity",{0,0,0}},{"yaw",-58},{"pitch",4},{"grounded",true},{"crouched",false},{"jumped",false},{"squash",0},{"spin",0},{"acting",{{"headPitch",0},{"headYaw",0},{"headRoll",0},{"chestPitch",0},{"chestYaw",0},{"chestRoll",0},{"earL",0},{"earR",0}}}};capture("intro-idle",15.1);
 job["stage"]["clock"]=.1;job["stage"]["acting"]["headRoll"]=16;job["stage"]["acting"]["headYaw"]=24;job["stage"]["acting"]["earL"]=.8;job["stage"]["acting"]["earR"]=-.5;capture("intro-puzzled",15.2);
 job["stage"]["clock"]=.2;job["stage"]["position"]={0,0,35};job["stage"]["velocity"]={220,0,100};job["stage"]["grounded"]=false;job["stage"]["jumped"]=true;job["stage"]["squash"]=.05;job["stage"]["spin"]=120;capture("intro-hop",15.3);
 job["stage"]["clock"]=.3;job["stage"]["grounded"]=true;job["stage"]["position"]={0,0,0};job["stage"]["velocity"]={0,0,0};job["stage"]["jumped"]=false;job["stage"]["crouched"]=true;job["stage"]["squash"]=-.1;capture("intro-contact",15.4);
 auto malformed=job;malformed["stage"]["position"]={0,0};if(!preview.render(malformed,15.5).empty())throw std::runtime_error("Malformed acting pose accepted");malformed=job;malformed["stage"]["squash"]=5;if(!preview.render(malformed,15.5).empty())throw std::runtime_error("Unbounded acting squash accepted");
 auto invalid=job;invalid["width"]=-100;invalid["height"]=100000;const auto bounded=preview.render(invalid,16);if(bounded.empty())throw std::runtime_error("Bounded dimensions failed");invalid["view"]="webgl";if(!preview.render(invalid,16).empty())throw std::runtime_error("Invalid view accepted");
 std::ofstream report(std::filesystem::path(argv[2])/"evidence.json");report<<evidence.dump(2);std::cout<<"Native loadout preview smoke: "<<evidence.size()<<" distinct PNGs; GL target/viewport restoration and dimension/view validation passed\n";
 return 0;
}catch(const std::exception&e){std::cerr<<e.what()<<'\n';return 1;}}
