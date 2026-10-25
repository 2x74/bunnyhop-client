// Standalone native scene evidence; no map or gameplay core is initialized.
#include "renderer.hpp"
#include "menu_scene.hpp"
int main(int argc,char **argv) {
    try {
        if(argc!=2)throw std::runtime_error("usage: menu-scene-smoke OUTPUT.png");
        if(!SDL_Init(SDL_INIT_VIDEO))throw std::runtime_error(SDL_GetError());
        struct Quit {~Quit(){SDL_Quit();}} quit;
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION,3);SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION,3);
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK,SDL_GL_CONTEXT_PROFILE_CORE);
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_FLAGS,SDL_GL_CONTEXT_FORWARD_COMPATIBLE_FLAG);
        using Window=std::unique_ptr<SDL_Window,decltype(&SDL_DestroyWindow)>;
        Window window(SDL_CreateWindow("Menu scene test",1280,720,SDL_WINDOW_OPENGL|SDL_WINDOW_HIDDEN),SDL_DestroyWindow);
        if(!window)throw std::runtime_error(SDL_GetError());
        auto context=SDL_GL_CreateContext(window.get());if(!context)throw std::runtime_error(SDL_GetError());
        struct Context {SDL_GLContext c;~Context(){SDL_GL_DestroyContext(c);}} cleanup{context};
        Gl gl;gl.load();native::MenuScene scene(gl);
        auto frame=[&](double time,bool reduced){scene.draw(1280,720,time,reduced);std::vector<unsigned char> pixels(1280*720*3);gl.PixelStorei(GL_PACK_ALIGNMENT,1);gl.ReadPixels(0,0,1280,720,GL_RGB,GL_UNSIGNED_BYTE,pixels.data());return pixels;};
        const auto fixed=frame(0,true);
        if(fixed!=frame(20,true))throw std::runtime_error("Reduced-motion frame changed");
        if(fixed==frame(20,false))throw std::runtime_error("Live camera did not move");
        gl.DepthFunc(GL_LEQUAL);gl.Viewport(3,5,1270,710);gl.PixelStorei(GL_PACK_ALIGNMENT,8);
        const auto png=scene.snapshot_png(1280,720);
        int depth_function=0,alignment=0,viewport[4]{};gl.GetIntegerv(GL_DEPTH_FUNC,&depth_function);gl.GetIntegerv(GL_PACK_ALIGNMENT,&alignment);gl.GetIntegerv(GL_VIEWPORT,viewport);
        if(depth_function!=GL_LEQUAL||alignment!=8||viewport[0]!=3||viewport[1]!=5||viewport[2]!=1270||viewport[3]!=710)
            throw std::runtime_error("Scene capture leaked depth, viewport, or pixel-pack state");
        if(png.size()<1000||png.size()>200000)throw std::runtime_error("Unexpected scene capture size");
        if(scene.snapshot_png(0,0)!="")throw std::runtime_error("Empty drawable was captured");
        scene.draw(0,0,0);if(gl.GetError()!=GL_NO_ERROR)throw std::runtime_error("Scene caused a GL error");
        std::ofstream out(argv[1],std::ios::binary);out.write(png.data(),png.size());if(!out)throw std::runtime_error("Could not write PNG");
        std::cout<<"Scene: static frame stable, camera moves, zero-size safe, GL_NO_ERROR; PNG "<<png.size()<<" bytes\n";
    }catch(const std::exception &e){std::cerr<<e.what()<<'\n';return 1;}
}
