#pragma once
// The Enhanced and Cinematic looks' post-processing, ported from the web game's graphics/composer-pipeline.ts. The
// world draws into a half-float target with a depth texture, holding the same gamma-encoded colour the world shaders
// write to the screen. Then, on the linear frame:
//
// - contact shading (three's SSAOPass, toned down to 22%): a half-size occlusion estimate from depth;
// - on maps with HDR lighting, CS:S's exposure and bloom (SourceHdr) first, like the web's SourceHdrPass; elsewhere
//   the look's own soft glow (three's UnrealBloomPass: threshold .88, radius .35, five blurred levels);
// - the grade: saturation, exposure, a contrast pivot at 18% grey, the filmic highlight shoulder, and atmospheric
//   haze over distance;
// - sun shafts: 24 steps toward the sun over open sky;
// - back to sRGB, then edge smoothing (FXAA) before the viewmodel and HUD.
//
// Everything runs in one composite pass after the optional occlusion and bloom passes, so Enhanced with its default
// switches costs one bloom chain, one composite and one FXAA pass over the Source look.
//
//   EnhancedLook look(gl, emptyVao);
//   look.begin(w, h, samples);  ...draw the world...  look.finish(target, w, h, frame, hdr, dt);
#include <array>
#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <string>

namespace native_look {
inline const std::string look_common = R"(#version 330 core
in vec2 uv;out vec4 color;
vec3 toGamma(vec3 c){c=max(c,vec3(0));return mix(c*12.92,1.055*pow(c,vec3(1./2.4))-.055,step(vec3(.0031308),c));}
vec3 toLinear(vec3 g){g=max(g,vec3(0));return mix(g/12.92,pow((g+.055)/1.055,vec3(2.4)),step(vec3(.04045),g));}
float luminance(vec3 c){return dot(c,vec3(.2126,.7152,.0722));}
)";

// LuminosityHighPassShader at half size: four taps of the linear frame, kept above the threshold.
inline const std::string bright_fragment = look_common + R"(uniform sampler2D frame;uniform vec2 texel;
uniform float threshold;
vec3 bright(vec2 at){vec3 c=toLinear(texture(frame,at).rgb);return c*smoothstep(threshold,threshold+.01,luminance(c));}
void main(){
 color=vec4((bright(uv-texel*.5)+bright(uv+texel*.5)+bright(uv+vec2(texel.x,-texel.y)*.5)+bright(uv+vec2(-texel.x,texel.y)*.5))*.25,1);
}
)";

// UnrealBloomPass's separable blur: a Gaussian with sigma equal to the kernel radius.
inline const std::string blur_fragment = look_common + R"(uniform sampler2D source;uniform vec2 direction;
uniform int radius;
float gauss(float x,float sigma){return .39894*exp(-.5*x*x/(sigma*sigma))/sigma;}
void main(){
 float sigma=float(radius),sum=gauss(0.,sigma);vec3 c=texture(source,uv).rgb*sum;
 for(int i=1;i<radius;i++){float w=gauss(float(i),sigma);vec2 o=direction*float(i);
  c+=(texture(source,uv+o).rgb+texture(source,uv-o).rgb)*w;sum+=2.*w;}
 color=vec4(c/sum,1);
}
)";

// Screen-space occlusion from the depth texture: 16 fixed hemisphere samples turned per pixel, within 12 units.
inline const std::string contact_fragment = look_common + R"(uniform sampler2D depthTexture;
uniform vec2 projectionScale,nearFar,texel;
float viewDepth(float d){return nearFar.x*nearFar.y/(nearFar.y-d*(nearFar.y-nearFar.x));}
vec3 viewPosition(vec2 at){float z=viewDepth(texture(depthTexture,at).r);return vec3((at*2.-1.)/projectionScale*z,-z);}
float hash(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}
void main(){
 float d=texture(depthTexture,uv).r;if(d>=.99999){color=vec4(1);return;}
 vec3 p=viewPosition(uv);
 vec3 n=normalize(cross(viewPosition(uv+vec2(texel.x,0))-p,viewPosition(uv+vec2(0,texel.y))-p));
 if(dot(n,p)>0.)n=-n;
 float angle=hash(floor(gl_FragCoord.xy))*6.2831853;
 vec3 t=normalize(cross(n,abs(n.z)<.9?vec3(0,0,1):vec3(1,0,0)));t=t*cos(angle)+cross(n,t)*sin(angle);
 vec3 b=cross(n,t);float occluded=0.;
 for(int i=0;i<16;i++){
  float k=float(i)/16.,scale=.1+.9*k*k,phi=float(i)*2.3999632;
  float r=sqrt(fract(float(i)*.618034+.31)),h=sqrt(max(0.,1.-r*r));
  vec3 s=p+(t*cos(phi)*r+b*sin(phi)*r+n*h)*12.*scale;
  vec2 at=(s.xy/-s.z)*projectionScale*.5+.5;
  float scene=viewDepth(texture(depthTexture,at).r);
  float delta=-s.z-scene;
  occluded+=step(.05,delta)*smoothstep(0.,1.,12./max(abs(delta),12.));
 }
 color=vec4(vec3(1.-occluded/16.),1);
}
)";

inline const std::string composite_fragment = look_common + R"(uniform sampler2D frame,depthTexture,contact;
uniform sampler2D bloom0,bloom1,bloom2,bloom3,bloom4;uniform vec4 bloomWeights;uniform float bloomWeight4;
uniform bool hasContact,hasBloom;uniform float contactStrength;uniform vec2 contactTexel;
uniform float saturation,contrast,exposure,shoulder,haze,hazeDistance;uniform vec2 nearFar;
uniform vec2 sunUv;uniform vec3 sunColor;uniform float shafts;
float viewDepth(float d){return nearFar.x*nearFar.y/(nearFar.y-d*(nearFar.y-nearFar.x));}
float occlusion(){
 float a=texture(contact,uv+contactTexel*vec2(-.5,-.5)).r+texture(contact,uv+contactTexel*vec2(.5,-.5)).r;
 a+=texture(contact,uv+contactTexel*vec2(-.5,.5)).r+texture(contact,uv+contactTexel*vec2(.5,.5)).r;
 return mix(1.,a*.25,contactStrength);
}
vec3 bloom(){
 vec3 b=texture(bloom0,uv).rgb*bloomWeights.x+texture(bloom1,uv).rgb*bloomWeights.y;
 b+=texture(bloom2,uv).rgb*bloomWeights.z+texture(bloom3,uv).rgb*bloomWeights.w;
 return b+texture(bloom4,uv).rgb*bloomWeight4;
}
vec3 grade(vec3 c){
 c=mix(vec3(luminance(c)),c,saturation)*exposure;
 c=pow(max(c,vec3(0)),vec3(contrast))*pow(.18,1.-contrast);
 vec3 film=(c*(2.51*c+.03))/(c*(2.43*c+.59)+.14);
 return mix(c,film,shoulder);
}
vec3 fog(vec3 c,float d){
 if(haze<=0.)return c;
 float z=viewDepth(d),amount=(1.-exp(-z/hazeDistance))*haze*step(d,.99999);
 return mix(c,vec3(.42,.53,.65),amount);
}
vec3 sunShafts(float d){
 vec2 stepUv=(sunUv-uv)/24.,p=uv;float rays=0.,weight=1.;
 for(int i=0;i<24;i++){p+=stepUv;float s=texture(depthTexture,clamp(p,vec2(0),vec2(1))).r;vec2 o=p-sunUv;
  rays+=step(.99999,s)*exp(-dot(o,o)*160.)*weight;weight*=.96;}
 return sunColor*rays*shafts*(.35+.65*step(.99999,d));
}
void main(){
 vec3 c=toLinear(texture(frame,uv).rgb);
 if(hasContact)c*=occlusion();
 if(hasBloom)c+=bloom();
 float d=texture(depthTexture,uv).r;
 c=fog(grade(c),d);
 if(shafts>0.)c+=sunShafts(d);
 color=vec4(toGamma(c),1);
}
)";

// FXAA 3.11's PC quality search, condensed: find the edge from local luma contrast, walk along it to its ends and
// blend across it by how far the pixel sits from the nearer end.
inline const std::string fxaa_fragment = look_common + R"(uniform sampler2D frame;uniform vec2 texel;
float lumaAt(vec2 p){return luminance(texture(frame,p).rgb);}
void main(){
 vec3 rgbM=texture(frame,uv).rgb;float m=luminance(rgbM);
 float n=lumaAt(uv+vec2(0,texel.y)),s=lumaAt(uv-vec2(0,texel.y)),e=lumaAt(uv+vec2(texel.x,0)),w=lumaAt(uv-vec2(texel.x,0));
 float maxL=max(m,max(max(n,s),max(e,w))),minL=min(m,min(min(n,s),min(e,w))),range=maxL-minL;
 if(range<max(.0312,maxL*.063)){color=vec4(rgbM,1);return;}
 float ne=lumaAt(uv+texel),sw=lumaAt(uv-texel),nw=lumaAt(uv+vec2(-texel.x,texel.y)),se=lumaAt(uv+vec2(texel.x,-texel.y));
 float edgeH=abs(nw+ne-2.*n)+2.*abs(w+e-2.*m)+abs(sw+se-2.*s);
 float edgeV=abs(nw+sw-2.*w)+2.*abs(n+s-2.*m)+abs(ne+se-2.*e);
 bool horizontal=edgeH>=edgeV;
 float stepLength=horizontal?texel.y:texel.x,l1=horizontal?s:w,l2=horizontal?n:e;
 float g1=abs(l1-m),g2=abs(l2-m);bool first=g1>=g2;float gradient=.25*max(g1,g2);
 if(first)stepLength=-stepLength;float localAverage=.5*((first?l1:l2)+m);
 vec2 edgeUv=uv;if(horizontal)edgeUv.y+=stepLength*.5;else edgeUv.x+=stepLength*.5;
 vec2 offset=horizontal?vec2(texel.x,0):vec2(0,texel.y);
 vec2 uv1=edgeUv-offset,uv2=edgeUv+offset;float end1=lumaAt(uv1)-localAverage,end2=lumaAt(uv2)-localAverage;
 bool done1=abs(end1)>=gradient,done2=abs(end2)>=gradient;
 const float steps[10]=float[10](1.,1.,1.,1.5,2.,2.,2.,2.,4.,8.);
 for(int i=0;i<10&&!(done1&&done2);i++){
  if(!done1){uv1-=offset*steps[i];end1=lumaAt(uv1)-localAverage;done1=abs(end1)>=gradient;}
  if(!done2){uv2+=offset*steps[i];end2=lumaAt(uv2)-localAverage;done2=abs(end2)>=gradient;}
 }
 float d1=horizontal?uv.x-uv1.x:uv.y-uv1.y,d2=horizontal?uv2.x-uv.x:uv2.y-uv.y;
 bool nearFirst=d1<d2;float nearest=min(d1,d2),span=d1+d2;
 bool correct=((nearFirst?end1:end2)<0.)!=(m-localAverage<0.);
 float pixelOffset=correct?.5-nearest/span:0.;
 float average=(2.*(n+s+e+w)+ne+nw+se+sw)/12.;
 float sub=clamp(abs(average-m)/range,0.,1.),subOffset=(-2.*sub+3.)*sub*sub;
 pixelOffset=max(pixelOffset,subOffset*subOffset*.75);
 vec2 at=uv;if(horizontal)at.y+=pixelOffset*stepLength;else at.x+=pixelOffset*stepLength;
 color=vec4(texture(frame,at).rgb,1);
}
)";
}  // namespace native_look

// What one frame of the look draws with (renderer.hpp fills it from the settings, the profile and the camera).
struct LookFrame {
    float bloom_strength = 0;
    float saturation = 1, contrast = 1, exposure = 1, shoulder = 0;
    float haze = 0, haze_distance = 9000;
    float contact_strength = 0;
    bool spatial_aa = true;
    // The sun on screen (0-1) and its colour for sun shafts; strength 0 draws none.
    std::array<float, 2> sun_uv{.5f, .5f};
    std::array<float, 3> sun_color{1, 1, 1};
    float shafts = 0;
    // Projection terms for contact shading: x and y scale of the projection matrix.
    std::array<float, 2> projection_scale{1, 1};
};

class EnhancedLook {
    static constexpr int bloom_levels = 5;
    static constexpr float bloom_threshold = .88f, bloom_radius = .35f;
    static constexpr std::array<float, bloom_levels> bloom_factors{1, .8f, .6f, .4f, .2f};
    static constexpr std::array<int, bloom_levels> blur_radii{3, 5, 7, 9, 11};

    struct Target {
        GLuint fbo = 0, texture = 0;
        int width = 0, height = 0;
    };

    Gl &gl;
    GLuint emptyVao;
    GLuint brightProgram = 0, blurProgram = 0, contactProgram = 0, compositeProgram = 0, fxaaProgram = 0;
    GLuint sceneFbo = 0, sceneColor = 0, sceneDepth = 0;
    GLuint multisampleFbo = 0, multisampleColor = 0, multisampleDepth = 0;
    int width = 0, height = 0, requestedSamples = 0, currentSamples = -1;
    // After CS:S's exposure on maps with HDR lighting; the composite reads it instead of the scene.
    Target exposed, contact, output;
    std::array<Target, bloom_levels> bloomHorizontal, bloomVertical;
    Target bright;

    Target make_target(int w, int h, GLint internal, GLenum format, GLenum type) {
        Target t;
        t.width = w;
        t.height = h;
        gl.GenTextures(1, &t.texture);
        gl.BindTexture(GL_TEXTURE_2D, t.texture);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
        gl.TexImage2D(GL_TEXTURE_2D, 0, internal, w, h, 0, format, type, nullptr);
        gl.GenFramebuffers(1, &t.fbo);
        gl.BindFramebuffer(GL_FRAMEBUFFER, t.fbo);
        gl.FramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, t.texture, 0);
        if (gl.CheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE)
            throw std::runtime_error("Enhanced look target incomplete");
        return t;
    }

    Target half_float_target(int w, int h) { return make_target(w, h, GL_RGBA16F, GL_RGBA, GL_HALF_FLOAT); }

    void destroy(Target &t) {
        if (t.fbo) gl.DeleteFramebuffers(1, &t.fbo);
        if (t.texture) gl.DeleteTextures(1, &t.texture);
        t = {};
    }

    void release_targets() {
        for (GLuint *fbo : {&sceneFbo, &multisampleFbo})
            if (*fbo) gl.DeleteFramebuffers(1, fbo);
        for (GLuint *texture : {&sceneColor, &sceneDepth})
            if (*texture) gl.DeleteTextures(1, texture);
        for (GLuint *buffer : {&multisampleColor, &multisampleDepth})
            if (*buffer) gl.DeleteRenderbuffers(1, buffer);
        sceneFbo = multisampleFbo = sceneColor = sceneDepth = multisampleColor = multisampleDepth = 0;
        for (Target *t : {&exposed, &contact, &output, &bright})
            destroy(*t);
        for (int i = 0; i < bloom_levels; i++) {
            destroy(bloomHorizontal[size_t(i)]);
            destroy(bloomVertical[size_t(i)]);
        }
        width = height = 0;
    }

    void make_scene_target(int w, int h) {
        gl.GenTextures(1, &sceneColor);
        gl.BindTexture(GL_TEXTURE_2D, sceneColor);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
        gl.TexImage2D(GL_TEXTURE_2D, 0, GL_RGBA16F, w, h, 0, GL_RGBA, GL_HALF_FLOAT, nullptr);
        gl.GenTextures(1, &sceneDepth);
        gl.BindTexture(GL_TEXTURE_2D, sceneDepth);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
        gl.TexImage2D(GL_TEXTURE_2D, 0, GL_DEPTH24_STENCIL8, w, h, 0, GL_DEPTH_STENCIL, GL_UNSIGNED_INT_24_8, nullptr);
        gl.GenFramebuffers(1, &sceneFbo);
        gl.BindFramebuffer(GL_FRAMEBUFFER, sceneFbo);
        gl.FramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, sceneColor, 0);
        gl.FramebufferTexture2D(GL_FRAMEBUFFER, GL_DEPTH_STENCIL_ATTACHMENT, GL_TEXTURE_2D, sceneDepth, 0);
        if (gl.CheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE)
            throw std::runtime_error("Enhanced look scene target incomplete");
    }

    void make_multisample_target(int w, int h) {
        gl.GenFramebuffers(1, &multisampleFbo);
        gl.BindFramebuffer(GL_FRAMEBUFFER, multisampleFbo);
        gl.GenRenderbuffers(1, &multisampleColor);
        gl.BindRenderbuffer(GL_RENDERBUFFER, multisampleColor);
        gl.RenderbufferStorageMultisample(GL_RENDERBUFFER, requestedSamples, GL_RGBA16F, w, h);
        gl.FramebufferRenderbuffer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_RENDERBUFFER, multisampleColor);
        gl.GenRenderbuffers(1, &multisampleDepth);
        gl.BindRenderbuffer(GL_RENDERBUFFER, multisampleDepth);
        gl.RenderbufferStorageMultisample(GL_RENDERBUFFER, requestedSamples, GL_DEPTH24_STENCIL8, w, h);
        gl.FramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_STENCIL_ATTACHMENT, GL_RENDERBUFFER, multisampleDepth);
        if (gl.CheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE)
            throw std::runtime_error("Enhanced look multisample target incomplete");
    }

    void ensure_targets(int w, int h) {
        if (w == width && h == height && sceneFbo && currentSamples == requestedSamples) return;
        release_targets();
        make_scene_target(w, h);
        if (requestedSamples) make_multisample_target(w, h);
        currentSamples = requestedSamples;
        exposed = half_float_target(w, h);
        output = make_target(w, h, GL_RGBA8, GL_RGBA, GL_UNSIGNED_BYTE);
        contact = make_target(std::max(1, w / 2), std::max(1, h / 2), GL_R8, GL_RED, GL_UNSIGNED_BYTE);
        int levelWidth = std::max(1, w / 2), levelHeight = std::max(1, h / 2);
        bright = half_float_target(levelWidth, levelHeight);
        for (int i = 0; i < bloom_levels; i++) {
            bloomHorizontal[size_t(i)] = half_float_target(levelWidth, levelHeight);
            bloomVertical[size_t(i)] = half_float_target(levelWidth, levelHeight);
            levelWidth = std::max(1, levelWidth / 2);
            levelHeight = std::max(1, levelHeight / 2);
        }
        width = w;
        height = h;
    }

    GLint loc(GLuint program, const char *name) { return gl.GetUniformLocation(program, name); }

    void bind_texture(GLuint program, const char *name, int unit, GLuint texture) {
        gl.ActiveTexture(GL_TEXTURE0 + unit);
        gl.BindTexture(GL_TEXTURE_2D, texture);
        gl.Uniform1i(loc(program, name), unit);
    }

    void draw_into(const Target &target) {
        gl.BindFramebuffer(GL_FRAMEBUFFER, target.fbo);
        gl.Viewport(0, 0, target.width, target.height);
        gl.BindVertexArray(emptyVao);
        gl.DrawArrays(GL_TRIANGLES, 0, 3);
    }

    void draw_contact(const LookFrame &frame) {
        gl.UseProgram(contactProgram);
        bind_texture(contactProgram, "depthTexture", 0, sceneDepth);
        gl.Uniform2f(loc(contactProgram, "projectionScale"), frame.projection_scale[0], frame.projection_scale[1]);
        gl.Uniform2f(loc(contactProgram, "nearFar"), native::camera_near_plane, native::camera_far_plane);
        gl.Uniform2f(loc(contactProgram, "texel"), 1.f / width, 1.f / height);
        draw_into(contact);
    }

    // UnrealBloomPass: the bright parts at half size, each level blurred and halved again.
    void draw_bloom(GLuint frameTexture) {
        gl.UseProgram(brightProgram);
        bind_texture(brightProgram, "frame", 0, frameTexture);
        gl.Uniform2f(loc(brightProgram, "texel"), 1.f / width, 1.f / height);
        gl.Uniform1f(loc(brightProgram, "threshold"), bloom_threshold);
        draw_into(bright);
        gl.UseProgram(blurProgram);
        GLuint input = bright.texture;
        for (size_t i = 0; i < size_t(bloom_levels); i++) {
            const auto &horizontal = bloomHorizontal[i], &vertical = bloomVertical[i];
            gl.Uniform1i(loc(blurProgram, "radius"), blur_radii[i]);
            bind_texture(blurProgram, "source", 0, input);
            gl.Uniform2f(loc(blurProgram, "direction"), 1.f / horizontal.width, 0);
            draw_into(horizontal);
            bind_texture(blurProgram, "source", 0, horizontal.texture);
            gl.Uniform2f(loc(blurProgram, "direction"), 0, 1.f / vertical.height);
            draw_into(vertical);
            input = vertical.texture;
        }
    }

    void bloom_uniforms(float strength) {
        static constexpr const char *names[bloom_levels] = {"bloom0", "bloom1", "bloom2", "bloom3", "bloom4"};
        std::array<float, bloom_levels> weights{};
        for (size_t i = 0; i < size_t(bloom_levels); i++) {
            const float factor = bloom_factors[i];
            weights[i] = strength * (factor + (1.2f - factor - factor) * bloom_radius);
            bind_texture(compositeProgram, names[i], 3 + int(i), bloomVertical[i].texture);
        }
        gl.Uniform4fv(loc(compositeProgram, "bloomWeights"), 1, weights.data());
        gl.Uniform1f(loc(compositeProgram, "bloomWeight4"), weights[4]);
    }

    void composite(GLuint frameTexture, const LookFrame &frame, bool withContact, bool withBloom) {
        const GLuint p = compositeProgram;
        gl.UseProgram(p);
        bind_texture(p, "frame", 0, frameTexture);
        bind_texture(p, "depthTexture", 1, sceneDepth);
        bind_texture(p, "contact", 2, contact.texture);
        bloom_uniforms(withBloom ? frame.bloom_strength : 0);
        gl.Uniform1i(loc(p, "hasContact"), withContact);
        gl.Uniform1i(loc(p, "hasBloom"), withBloom);
        gl.Uniform1f(loc(p, "contactStrength"), frame.contact_strength);
        gl.Uniform2f(loc(p, "contactTexel"), 1.f / contact.width, 1.f / contact.height);
        gl.Uniform1f(loc(p, "saturation"), frame.saturation);
        gl.Uniform1f(loc(p, "contrast"), frame.contrast);
        gl.Uniform1f(loc(p, "exposure"), frame.exposure);
        gl.Uniform1f(loc(p, "shoulder"), frame.shoulder);
        gl.Uniform1f(loc(p, "haze"), frame.haze);
        gl.Uniform1f(loc(p, "hazeDistance"), frame.haze_distance);
        gl.Uniform2f(loc(p, "nearFar"), native::camera_near_plane, native::camera_far_plane);
        gl.Uniform2f(loc(p, "sunUv"), frame.sun_uv[0], frame.sun_uv[1]);
        gl.Uniform3fv(loc(p, "sunColor"), 1, frame.sun_color.data());
        gl.Uniform1f(loc(p, "shafts"), frame.shafts);
        gl.BindVertexArray(emptyVao);
        gl.DrawArrays(GL_TRIANGLES, 0, 3);
    }

    void resolve_multisample(GLbitfield buffers) {
        if (!multisampleFbo) return;
        gl.BindFramebuffer(GL_READ_FRAMEBUFFER, multisampleFbo);
        gl.BindFramebuffer(GL_DRAW_FRAMEBUFFER, sceneFbo);
        gl.BlitFramebuffer(0, 0, width, height, 0, 0, width, height, buffers, GL_NEAREST);
    }

public:
    EnhancedLook(Gl &g, GLuint vao) : gl(g), emptyVao(vao) {
        using namespace native_look;
        const char *vertex = native_hdr::hdr_vertex;
        brightProgram = link_program(gl, vertex, bright_fragment.c_str());
        blurProgram = link_program(gl, vertex, blur_fragment.c_str());
        contactProgram = link_program(gl, vertex, contact_fragment.c_str());
        compositeProgram = link_program(gl, vertex, composite_fragment.c_str());
        fxaaProgram = link_program(gl, vertex, fxaa_fragment.c_str());
    }

    ~EnhancedLook() {
        release_targets();
        for (GLuint p : {brightProgram, blurProgram, contactProgram, compositeProgram, fxaaProgram})
            if (p) gl.DeleteProgram(p);
    }

    EnhancedLook(const EnhancedLook &) = delete;
    EnhancedLook &operator=(const EnhancedLook &) = delete;

    void samples(int count) {
        GLint maximum = 0;
        gl.GetIntegerv(GL_MAX_SAMPLES, &maximum);
        requestedSamples = std::clamp(count, 0, maximum);
    }

    // Binds the half-float scene target (with depth) for the world's draws.
    void begin(int w, int h) {
        ensure_targets(w, h);
        gl.BindFramebuffer(GL_FRAMEBUFFER, multisampleFbo ? multisampleFbo : sceneFbo);
        gl.Viewport(0, 0, w, h);
    }

    // The water's refraction copies from the read framebuffer: the resolved scene so far.
    void refraction_source() {
        resolve_multisample(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
        gl.BindFramebuffer(GL_READ_FRAMEBUFFER, sceneFbo);
    }

    // Post-processes the world into `targetFbo`. hdr: CS:S's exposure and bloom on maps with HDR lighting.
    void finish(GLuint targetFbo, const LookFrame &frame, SourceHdr *hdr, double dt) {
        resolve_multisample(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
        gl.Disable(GL_DEPTH_TEST);
        gl.Disable(GL_BLEND);
        gl.Disable(GL_CULL_FACE);
        gl.DepthMask(GL_FALSE);
        GLuint frameTexture = sceneColor;
        if (hdr) {
            hdr->expose(sceneColor, exposed.fbo, width, height, dt);
            frameTexture = exposed.texture;
        }
        const bool withContact = frame.contact_strength > 0;
        const bool withBloom = !hdr && frame.bloom_strength > 0;
        if (withContact) draw_contact(frame);
        if (withBloom) draw_bloom(frameTexture);
        gl.BindFramebuffer(GL_FRAMEBUFFER, frame.spatial_aa ? output.fbo : targetFbo);
        gl.Viewport(0, 0, width, height);
        composite(frameTexture, frame, withContact, withBloom);
        if (frame.spatial_aa) {
            gl.BindFramebuffer(GL_FRAMEBUFFER, targetFbo);
            gl.Viewport(0, 0, width, height);
            gl.UseProgram(fxaaProgram);
            bind_texture(fxaaProgram, "frame", 0, output.texture);
            gl.Uniform2f(loc(fxaaProgram, "texel"), 1.f / width, 1.f / height);
            gl.BindVertexArray(emptyVao);
            gl.DrawArrays(GL_TRIANGLES, 0, 3);
        }
        gl.BindFramebuffer(GL_FRAMEBUFFER, targetFbo);
        gl.Viewport(0, 0, width, height);
        gl.ActiveTexture(GL_TEXTURE0);
        gl.Enable(GL_DEPTH_TEST);
        gl.DepthMask(GL_TRUE);
    }
};
