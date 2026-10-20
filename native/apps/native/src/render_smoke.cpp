// Deterministic framebuffer evidence for the actual native renderer. No menus, network, timer or recording.
#include "renderer.hpp"
#include <cstdlib>
#include <optional>
int main(int argc,char **argv){
    try {
        std::string map,content,output,waterOutput,action,outfit="outfit-cream",loadout;bool actor=false;float opacity=.45,actorYaw=0,actorPitch=0,actorSpeed=0;uint32_t actorFlags=2;float eye[3]={};bool explicitEye=false,worldOnly=false;double yaw=0,pitch=0,seconds=2;int weapon=-1;
        for(int i=1;i<argc;i++){
            const std::string arg=argv[i];auto value=[&](){if(++i>=argc)throw std::runtime_error("missing argument value");return std::string(argv[i]);};
            auto number=[&](){const auto text=value();size_t used=0;const double n=std::stod(text,&used);if(used!=text.size()||!std::isfinite(n))throw std::runtime_error("invalid finite number");return n;};
            if(arg=="--map")map=value();else if(arg=="--content-root")content=value();else if(arg=="--out")output=value();else if(arg=="--eye"){for(float &n:eye)n=number();explicitEye=true;}else if(arg=="--yaw")yaw=number();else if(arg=="--pitch")pitch=number();else if(arg=="--seconds")seconds=number();else if(arg=="--weapon")weapon=int(number());else if(arg=="--world-only")worldOnly=true;else if(arg=="--water-json")waterOutput=value();else if(arg=="--action")action=value();else if(arg=="--outfit")outfit=value();else if(arg=="--loadout")loadout=value();else if(arg=="--actor")actor=true;else if(arg=="--opacity")opacity=number();else if(arg=="--actor-yaw")actorYaw=number();else if(arg=="--actor-pitch")actorPitch=number();else if(arg=="--actor-flags")actorFlags=uint32_t(number());else if(arg=="--actor-speed")actorSpeed=number();else throw std::runtime_error("unknown render smoke option: "+arg);
        }
        if(map.empty()||output.empty())throw std::runtime_error("usage: --map FILE --out FILE.ppm [--content-root DIR] [--eye x y z] [--yaw DEG] [--pitch DEG] [--weapon ID] [--world-only] [--seconds TIME]");
        if(!SDL_Init(SDL_INIT_VIDEO))throw std::runtime_error(SDL_GetError());struct Sdl{~Sdl(){SDL_Quit();}}sdl;
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION,3);SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION,3);SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK,SDL_GL_CONTEXT_PROFILE_CORE);SDL_GL_SetAttribute(SDL_GL_DEPTH_SIZE,24);
        auto *window=SDL_CreateWindow("Native render evidence",1280,720,SDL_WINDOW_OPENGL|SDL_WINDOW_HIDDEN);if(!window)throw std::runtime_error(SDL_GetError());struct Window{SDL_Window*w;~Window(){SDL_DestroyWindow(w);}}cleanup{window};
        const auto context=SDL_GL_CreateContext(window);if(!context)throw std::runtime_error(SDL_GetError());struct Context{SDL_GLContext c;~Context(){SDL_GL_DestroyContext(c);}}contextCleanup{context};SDL_GL_MakeCurrent(window,context);SDL_GL_SetSwapInterval(0);
        Gl gl;gl.load();using Core=std::unique_ptr<BhContext,decltype(&bh_destroy)>;Core core(bh_create(),&bh_destroy);if(!core||!bh_load_map(core.get(),map.c_str(),content.empty()?nullptr:content.c_str()))throw std::runtime_error(core?bh_last_error(core.get()):"native core creation failed");
        if(!waterOutput.empty()){size_t n=0;const char *json=bh_water_json(core.get(),&n);std::ofstream f(waterOutput,std::ios::binary);if(json&&n)f.write(json,n);if(!f)throw std::runtime_error("cannot write water evidence");}
        BhSettings settings{};bh_default_settings(&settings);if(!bh_set_settings(core.get(),&settings))throw std::runtime_error(bh_last_error(core.get()));BhSnapshot snapshot{};bh_snapshot(core.get(),&snapshot);
        if(!explicitEye)for(int k=0;k<3;k++)eye[k]=snapshot.player.position[k]+(k==2?snapshot.player.view_offset_z:0);
        native::Input input;input.set_angles(pitch,yaw);Renderer renderer(gl,core.get());renderer.set_viewmodel_visible(!worldOnly&&weapon<0);renderer.set_cosmetics(outfit,loadout);
        if(actor){native_render::Actor a;a.id="smoke";a.name="Native bunny";a.outfit=outfit;a.loadout=loadout;a.opacity=opacity;for(int k=0;k<3;k++)a.frame.position[k]=snapshot.player.position[k];a.frame.yaw=actorYaw;a.frame.pitch=actorPitch;a.frame.velocity[0]=actorSpeed;a.frame.flags=actorFlags;a.frame.weapon=weapon>0?weapon:1;renderer.set_room_actors({a});}
        int width=0,height=0;SDL_GetWindowSizeInPixels(window,&width,&height);
        std::unique_ptr<NativeViewmodel> preview;if(!worldOnly&&weapon>=0)preview=std::make_unique<NativeViewmodel>(gl);if(preview)preview->cosmetics(outfit,loadout);
        if(action=="inspect"){if(preview)preview->inspect_press();else renderer.inspect_press();}
        renderer.draw(width,height,eye,input,&snapshot,0);if(preview)preview->draw(width,height,snapshot,weapon,action=="reload"?4:0,action=="fire"||action=="stab",action=="stab"?2:1,0);
        renderer.draw(width,height,eye,input,&snapshot,seconds);if(preview)preview->draw(width,height,snapshot,weapon,0,false,0,seconds);
        const auto error=gl.GetError();if(error!=GL_NO_ERROR)throw std::runtime_error("native render GL error "+std::to_string(error));renderer.screenshot(output,width,height);
        std::cout<<"Native render evidence: "<<width<<'x'<<height<<", yaw="<<yaw<<", pitch="<<pitch<<", camera="<<eye[0]<<','<<eye[1]<<','<<eye[2]<<"; GL_NO_ERROR\n";
        return 0;
    } catch(const std::exception &error){std::cerr<<"Render smoke: "<<error.what()<<'\n';return 1;}
}
