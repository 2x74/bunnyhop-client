#pragma once
// Include after renderer.hpp: uses its SDL-resolved Gl and shader linker, and
// the same Source-space (Z-up) camera helpers. No map, asset or core is needed.
#include "native_math.hpp"
#include <array>
#include <vector>
#include <cstddef>
#include <algorithm>
#include <cmath>
#include <string>
#include <cstdint>
#include <stdexcept>
#include <zlib.h>

namespace native {
template<class GlApi> class MenuScene {
    struct Vertex { float p[3], n[3], color[3]; };
    GlApi &gl;
    unsigned program=0,vao=0,vbo=0;
    int count=0,view_location=-1;
    using V=std::array<float,3>;
    static void box(std::vector<Vertex> &out,V center,V size,V color) {
        static constexpr int faces[6][4]={{0,2,3,1},{4,5,7,6},{0,1,5,4},{2,6,7,3},{0,4,6,2},{1,3,7,5}};
        static constexpr float normals[6][3]={{0,0,-1},{0,0,1},{0,-1,0},{0,1,0},{-1,0,0},{1,0,0}};
        for(int f=0;f<6;f++)for(int corner:{0,1,2,0,2,3}) {
            Vertex v{};int i=faces[f][corner];
            for(int k=0;k<3;k++){v.p[k]=center[k]+((i&(1<<k))?1.f:-1.f)*size[k]*.5f;v.n[k]=normals[f][k];v.color[k]=color[k];}
            out.push_back(v);
        }
    }
    static std::vector<Vertex> geometry() {
        std::vector<Vertex> vertices;vertices.reserve(12000);
        const V ink{.12f,.15f,.15f},cream{.81f,.77f,.65f},amber{.88f,.51f,.17f},edge{.33f,.27f,.19f};
        // A compact architectural maquette, with thick solid platforms and warm
        // landing surfaces. The ground grid supplies perspective and scale.
        box(vertices,{0,100,-34},{5000,5000,28},ink);
        for(int i=-12;i<=12;i++) {
            box(vertices,{float(i*180),100,-19},{1.4f,4320,1},{.17f,.19f,.18f});
            box(vertices,{0,float(i*180)+100,-19},{4320,1.4f,1},{.17f,.19f,.18f});
        }
        const V positions[]={{-420,-370,45},{-190,-180,95},{60,-80,155},{245,130,220},{130,385,290},{-130,530,350}};
        for(int i=0;i<6;i++) {
            const auto p=positions[i];const float width=i==5?310.f:190.f;
            // Stylized contact shadows and a recessed dark foundation.
            box(vertices,{p[0]+28,p[1]+28,-17},{width+38,width+38,2},{.085f,.105f,.105f});
            box(vertices,{p[0],p[1],p[2]-35},{width,width,70},edge);
            box(vertices,{p[0],p[1],p[2]+2},{width+4,width+4,12},i==5?amber:cream);
            box(vertices,{p[0],p[1]-width*.5f-1,p[2]-13},{width,3,7},amber);
            // Three short alignment bars on each landing.
            for(int j=-1;j<=1;j++)box(vertices,{p[0]+j*19,p[1]-width*.22f,p[2]+9},{6,25,1},edge);
        }
        // The finish gate and a small abstract bunny, made from real solid
        // geometry. Its cream ears and amber face reference the game palette.
        const float x=-130,y=570,z=365;
        box(vertices,{x-133,y+40,z+175},{15,22,350},amber);
        box(vertices,{x+133,y+40,z+175},{15,22,350},amber);
        box(vertices,{x,y+40,z+350},{281,22,15},amber);
        box(vertices,{x,y,z+53},{83,66,100},cream);
        box(vertices,{x,y-5,z+128},{103,76,77},cream);
        box(vertices,{x-31,y,z+205},{24,32,90},cream);
        box(vertices,{x+31,y,z+213},{24,32,106},cream);
        box(vertices,{x-31,y-17,z+205},{10,2,62},amber);
        box(vertices,{x+31,y-17,z+213},{10,2,78},amber);
        box(vertices,{x,y-44,z+130},{85,5,24},amber);
        box(vertices,{x-22,y-48,z+131},{9,3,9},ink);
        box(vertices,{x+22,y-48,z+131},{9,3,9},ink);
        box(vertices,{x-29,y-25,z+12},{42,75,22},cream);
        box(vertices,{x+29,y-25,z+12},{42,75,22},cream);
        return vertices;
    }
    void release() {
        if(vbo)gl.DeleteBuffers(1,&vbo);if(vao)gl.DeleteVertexArrays(1,&vao);if(program)gl.DeleteProgram(program);
        vbo=vao=program=0;
    }
public:
    explicit MenuScene(GlApi &api):gl(api) {
        constexpr const char *vs=R"glsl(#version 330 core
layout(location=0) in vec3 position;
layout(location=1) in vec3 normal;
layout(location=2) in vec3 color;
uniform mat4 viewProjection;
out vec3 surfaceColor;out vec3 surfaceNormal;out vec3 worldPosition;
void main(){worldPosition=position;surfaceNormal=normal;surfaceColor=color;
 gl_Position=viewProjection*vec4(position,1.0);
 // Leave the left third of the frame for navigation.
 gl_Position.x+=.40*gl_Position.w;gl_Position.y+=.10*gl_Position.w;}
)glsl";
        constexpr const char *fs=R"glsl(#version 330 core
in vec3 surfaceColor;in vec3 surfaceNormal;in vec3 worldPosition;out vec4 fragColor;
void main(){vec3 n=normalize(surfaceNormal);
 float light=.45+.55*max(dot(n,normalize(vec3(-.5,-.7,1.2))),0.0);
 vec3 c=surfaceColor*light;
 float distanceFog=smoothstep(950.0,2800.0,length(worldPosition.xy));
 c=mix(c,vec3(.075,.092,.095),distanceFog*.9);
 fragColor=vec4(c,1.0);}
)glsl";
        try {
            program=link_program(gl,vs,fs);view_location=gl.GetUniformLocation(program,"viewProjection");
            const auto vertices=geometry();count=int(vertices.size());
            gl.GenVertexArrays(1,&vao);gl.GenBuffers(1,&vbo);gl.BindVertexArray(vao);gl.BindBuffer(GL_ARRAY_BUFFER,vbo);
            gl.BufferData(GL_ARRAY_BUFFER,vertices.size()*sizeof(Vertex),vertices.data(),GL_STATIC_DRAW);
            for(unsigned i=0;i<3;i++){gl.EnableVertexAttribArray(i);gl.VertexAttribPointer(i,3,GL_FLOAT,GL_FALSE,sizeof(Vertex),reinterpret_cast<void*>(i*3*sizeof(float)));}
            gl.BindVertexArray(0);gl.BindBuffer(GL_ARRAY_BUFFER,0);
        } catch(...) {release();throw;}
    }
    ~MenuScene(){release();}
    MenuScene(const MenuScene&)=delete;MenuScene& operator=(const MenuScene&)=delete;
    // This is the whole no-map frame. Call while the SDL context is current,
    // before SwapWindow; destroy before ContextCleanup. Start reduced until the
    // WebView delivers its OS preference; a fixed camera still shows full 3D.
    // Capture once for separate-window GTK menus. The caller supplies the real
    // drawable size; this never reads outside it or needs an FBO. The next game
    // frame overwrites this small preview before swap. Reuse the returned PNG.
    std::string snapshot_png(int drawable_width,int drawable_height) {
        if(drawable_width<=0||drawable_height<=0)return {};
        const float scale=std::min({1.f,float(drawable_width)/1280,float(drawable_height)/720});
        const int width=std::max(1,int(1280*scale)),height=std::max(1,int(720*scale));
        std::vector<unsigned char> pixels(size_t(width)*height*3),rows(size_t(width*3+1)*height);
        int alignment=4,depth_function=GL_LESS,viewport[4]{};gl.GetIntegerv(GL_PACK_ALIGNMENT,&alignment);gl.GetIntegerv(GL_VIEWPORT,viewport);gl.GetIntegerv(GL_DEPTH_FUNC,&depth_function);
        draw(width,height,0,true);gl.PixelStorei(GL_PACK_ALIGNMENT,1);
        gl.ReadPixels(0,0,width,height,GL_RGB,GL_UNSIGNED_BYTE,pixels.data());
        gl.PixelStorei(GL_PACK_ALIGNMENT,alignment);gl.Viewport(viewport[0],viewport[1],viewport[2],viewport[3]);gl.DepthFunc(depth_function);
        for(int y=0;y<height;y++)std::copy_n(pixels.data()+size_t(height-1-y)*width*3,width*3,rows.data()+size_t(y)*(width*3+1)+1);
        uLongf bytes=compressBound(rows.size());std::string compressed(bytes,'\0');
        if(compress2(reinterpret_cast<Bytef*>(compressed.data()),&bytes,rows.data(),rows.size(),Z_BEST_SPEED)!=Z_OK)
            throw std::runtime_error("Menu scene PNG compression failed");
        compressed.resize(bytes);
        auto integer=[](std::string &s,uint32_t n){for(int shift:{24,16,8,0})s.push_back(char(n>>shift));};
        std::string png("\x89PNG\r\n\x1a\n",8);
        auto chunk=[&](const char *kind,const std::string &data){integer(png,uint32_t(data.size()));const size_t start=png.size();png.append(kind,4);png+=data;integer(png,uint32_t(crc32(0,reinterpret_cast<const Bytef*>(png.data()+start),uInt(4+data.size()))));};
        std::string header;integer(header,width);integer(header,height);header.append("\x08\x02\0\0\0",5);
        chunk("IHDR",header);chunk("IDAT",compressed);chunk("IEND",{});return png;
    }
    void draw(int width,int height,double seconds,bool reduced_motion=true) {
        if(width<=0||height<=0)return;
        const double t=reduced_motion?0:seconds;
        const double yaw=123+std::sin(t*.10)*2.4;
        const float distance=1120,aim[3]={-25,100,220};
        const float eye[3]={aim[0]-float(std::cos(yaw*radians))*distance,
            aim[1]-float(std::sin(yaw*radians))*distance,aim[2]+760};
        const auto vp=camera_matrix(eye,yaw,std::atan2(760.0,double(distance))/radians,float(width)/height);
        gl.Viewport(0,0,width,height);gl.Disable(GL_SCISSOR_TEST);gl.Disable(GL_BLEND);gl.Disable(GL_CULL_FACE);
        gl.Disable(GL_POLYGON_OFFSET_FILL);gl.Enable(GL_DEPTH_TEST);gl.DepthMask(GL_TRUE);gl.DepthFunc(GL_LESS);
        gl.ColorMask(GL_TRUE,GL_TRUE,GL_TRUE,GL_TRUE);gl.ClearColor(.075f,.092f,.095f,1);gl.Clear(GL_COLOR_BUFFER_BIT|GL_DEPTH_BUFFER_BIT);
        gl.UseProgram(program);gl.UniformMatrix4fv(view_location,1,GL_FALSE,vp.data());gl.BindVertexArray(vao);
        gl.DrawArrays(GL_TRIANGLES,0,count);gl.BindVertexArray(0);gl.UseProgram(0);
    }
};
}
