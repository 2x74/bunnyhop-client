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
//   EnhancedLook look(context, maximumSamples);
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
 for(int i=0;i<10;i++){if(done1&&done2)break;
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
        native::gfx::RenderTarget resource;
        int width = 0, height = 0;
    };

    struct BrightConstants {
        std::array<float, 2> texel;
        float threshold;
    };

    struct BlurConstants {
        std::array<float, 2> direction;
        int32_t radius;
    };

    struct ContactConstants {
        std::array<float, 2> projectionScale, nearFar, texel;
    };

    struct CompositeConstants {
        std::array<float, 4> bloomWeights;
        float bloomWeight4;
        uint32_t hasContact, hasBloom;
        float contactStrength;
        std::array<float, 2> contactTexel;
        float saturation, contrast, exposure, shoulder, haze, hazeDistance;
        std::array<float, 2> nearFar, sunUv;
        std::array<float, 3> sunColor;
        float shafts;
    };

    native::gfx::Context &context;
    native::gfx::Program brightProgram, blurProgram, contactProgram, compositeProgram, fxaaProgram;
    native::gfx::ConstantBinding brightConstants, blurConstants, contactConstants, compositeConstants, fxaaConstants;
    native::gfx::Geometry geometry;
    native::gfx::Sampler linearSampler, depthSampler;
    native::gfx::Pipeline pipeline;
    native::gfx::RenderTarget scene, multisample;
    int maximumSamples, width = 0, height = 0, requestedSamples = 0, currentSamples = -1;
    Target exposed, contact, output, bright;
    std::array<Target, bloom_levels> bloomHorizontal, bloomVertical;

    Target make_target(int w, int h, native::gfx::Format format = native::gfx::Format::rgba16f) {
        return {context.create_target({w, h, format}), w, h};
    }

    void release_targets() {
        context.destroy(scene);
        context.destroy(multisample);
        for (auto *t : {&exposed, &contact, &output, &bright})
            context.destroy(t->resource);
        for (size_t i = 0; i < size_t(bloom_levels); i++) {
            context.destroy(bloomHorizontal[i].resource);
            context.destroy(bloomVertical[i].resource);
        }
        width = height = 0;
    }

    void ensure_targets(int w, int h) {
        using namespace native::gfx;
        if (w == width && h == height && currentSamples == requestedSamples) return;
        release_targets();
        scene = context.create_target({w, h, Format::rgba16f, Format::depth24_stencil8});
        if (requestedSamples)
            multisample = context.create_target({w, h, Format::rgba16f, Format::depth24_stencil8, requestedSamples});
        exposed = make_target(w, h);
        output = make_target(w, h, Format::rgba8);
        // The seam has no R8 target. RGBA8 preserves the quantized red channel used by the composite.
        contact = make_target(std::max(1, w / 2), std::max(1, h / 2), Format::r8);
        int levelWidth = std::max(1, w / 2), levelHeight = std::max(1, h / 2);
        bright = make_target(levelWidth, levelHeight);
        for (size_t i = 0; i < size_t(bloom_levels); i++) {
            bloomHorizontal[i] = make_target(levelWidth, levelHeight);
            bloomVertical[i] = make_target(levelWidth, levelHeight);
            levelWidth = std::max(1, levelWidth / 2);
            levelHeight = std::max(1, levelHeight / 2);
        }
        currentSamples = requestedSamples;
        width = w;
        height = h;
    }

    void draw() {
        context.pipeline(pipeline);
        context.bind_geometry(geometry);
        context.draw(native::gfx::Primitive::triangles, 0, 3);
        for (unsigned unit = 1; unit < 8; ++unit)
            context.bind_texture(unit, {});
        context.bind_texture(0, {});
    }

    void bind_target(const Target &target) {
        context.bind_target(target.resource);
        context.viewport({0, 0, target.width, target.height});
    }

    void draw_contact(const LookFrame &frame) {
        bind_target(contact);
        context.bind_program(contactProgram);
        const ContactConstants block{
                frame.projection_scale,
                {native::camera_near_plane, native::camera_far_plane},
                {1.f / width, 1.f / height}
        };
        context.constants(contactConstants, &block);
        context.bind_texture(0, scene.depth, depthSampler);
        draw();
    }

    void blur_into(native::gfx::Texture input, const Target &target, float x, float y, int radius) {
        bind_target(target);
        context.bind_program(blurProgram);
        const BlurConstants block{{x, y}, radius};
        context.constants(blurConstants, &block);
        context.bind_texture(0, input, linearSampler);
        draw();
    }

    void draw_bloom(native::gfx::Texture frameTexture) {
        bind_target(bright);
        context.bind_program(brightProgram);
        const BrightConstants block{{1.f / width, 1.f / height}, bloom_threshold};
        context.constants(brightConstants, &block);
        context.bind_texture(0, frameTexture, linearSampler);
        draw();
        auto input = bright.resource.color;
        for (size_t i = 0; i < size_t(bloom_levels); i++) {
            const auto &horizontal = bloomHorizontal[i], &vertical = bloomVertical[i];
            blur_into(input, horizontal, 1.f / horizontal.width, 0, blur_radii[i]);
            blur_into(horizontal.resource.color, vertical, 0, 1.f / vertical.height, blur_radii[i]);
            input = vertical.resource.color;
        }
    }

    void composite(native::gfx::Texture frameTexture, const LookFrame &frame, bool withContact, bool withBloom) {
        context.bind_program(compositeProgram);
        context.bind_texture(0, frameTexture, linearSampler);
        context.bind_texture(1, scene.depth, depthSampler);
        context.bind_texture(2, contact.resource.color, linearSampler);
        CompositeConstants block{};
        std::array<float, bloom_levels> weights{};
        for (size_t i = 0; i < size_t(bloom_levels); i++) {
            const float factor = bloom_factors[i];
            weights[i] = (withBloom ? frame.bloom_strength : 0) * (factor + (1.2f - factor - factor) * bloom_radius);
            context.bind_texture(3 + unsigned(i), bloomVertical[i].resource.color, linearSampler);
        }
        std::copy_n(weights.begin(), 4, block.bloomWeights.begin());
        block.bloomWeight4 = weights[4];
        block.hasContact = uint32_t(withContact);
        block.hasBloom = uint32_t(withBloom);
        block.contactStrength = frame.contact_strength;
        block.contactTexel = {1.f / contact.width, 1.f / contact.height};
        block.saturation = frame.saturation;
        block.contrast = frame.contrast;
        block.exposure = frame.exposure;
        block.shoulder = frame.shoulder;
        block.haze = frame.haze;
        block.hazeDistance = frame.haze_distance;
        block.nearFar = {native::camera_near_plane, native::camera_far_plane};
        block.sunUv = frame.sun_uv;
        block.sunColor = frame.sun_color;
        block.shafts = frame.shafts;
        context.constants(compositeConstants, &block);
        draw();
    }

    void resolve_multisample() {
        if (!requestedSamples) return;
        context.resolve_color(multisample, scene);
        context.resolve_depth(multisample, scene);
    }

    void create_programs() {
        using namespace native::gfx;
        using namespace native_look;
        const char *vertex = native_hdr::hdr_vertex;
        brightProgram = context.create_program({{"look-bright", ""}, vertex, bright_fragment.c_str()});
        blurProgram = context.create_program({{"look-blur", ""}, vertex, blur_fragment.c_str()});
        contactProgram = context.create_program({{"look-contact", ""}, vertex, contact_fragment.c_str()});
        compositeProgram = context.create_program({{"look-composite", ""}, vertex, composite_fragment.c_str()});
        fxaaProgram = context.create_program({{"look-fxaa", ""}, vertex, fxaa_fragment.c_str()});
        static constexpr ConstantField brightFields[] = {
                {"texel", offsetof(BrightConstants, texel), 8, ConstantType::float2},
                {"threshold", offsetof(BrightConstants, threshold), 4, ConstantType::float1}
        };
        static constexpr ConstantField blurFields[] = {
                {"direction", offsetof(BlurConstants, direction), 8, ConstantType::float2},
                {"radius", offsetof(BlurConstants, radius), 4, ConstantType::int1}
        };
        static constexpr ConstantField contactFields[] = {
                {"projectionScale", offsetof(ContactConstants, projectionScale), 8, ConstantType::float2},
                {"nearFar", offsetof(ContactConstants, nearFar), 8, ConstantType::float2},
                {"texel", offsetof(ContactConstants, texel), 8, ConstantType::float2}
        };
        brightConstants = context.create_constants(brightProgram, {brightFields, sizeof(BrightConstants)});
        blurConstants = context.create_constants(blurProgram, {blurFields, sizeof(BlurConstants)});
        contactConstants = context.create_constants(contactProgram, {contactFields, sizeof(ContactConstants)});
        static constexpr ConstantField fxaaFields[] = {{"texel", 0, 8, ConstantType::float2}};
        fxaaConstants = context.create_constants(fxaaProgram, {fxaaFields, 8});
        create_composite_constants();
        context.texture_unit(brightProgram, "frame", 0);
        context.texture_unit(blurProgram, "source", 0);
        context.texture_unit(contactProgram, "depthTexture", 0);
        context.texture_unit(fxaaProgram, "frame", 0);
        context.texture_unit(compositeProgram, "frame", 0);
        context.texture_unit(compositeProgram, "depthTexture", 1);
        context.texture_unit(compositeProgram, "contact", 2);
        static constexpr const char *names[] = {"bloom0", "bloom1", "bloom2", "bloom3", "bloom4"};
        for (unsigned i = 0; i < bloom_levels; i++)
            context.texture_unit(compositeProgram, names[i], 3 + i);
    }

    void create_composite_constants() {
        using namespace native::gfx;
        static constexpr ConstantField fields[] = {
                {"bloomWeights", offsetof(CompositeConstants, bloomWeights), 16, ConstantType::float4},
                {"bloomWeight4", offsetof(CompositeConstants, bloomWeight4), 4, ConstantType::float1},
                {"hasContact", offsetof(CompositeConstants, hasContact), 4, ConstantType::bool32},
                {"hasBloom", offsetof(CompositeConstants, hasBloom), 4, ConstantType::bool32},
                {"contactStrength", offsetof(CompositeConstants, contactStrength), 4, ConstantType::float1},
                {"contactTexel", offsetof(CompositeConstants, contactTexel), 8, ConstantType::float2},
                {"saturation", offsetof(CompositeConstants, saturation), 4, ConstantType::float1},
                {"contrast", offsetof(CompositeConstants, contrast), 4, ConstantType::float1},
                {"exposure", offsetof(CompositeConstants, exposure), 4, ConstantType::float1},
                {"shoulder", offsetof(CompositeConstants, shoulder), 4, ConstantType::float1},
                {"haze", offsetof(CompositeConstants, haze), 4, ConstantType::float1},
                {"hazeDistance", offsetof(CompositeConstants, hazeDistance), 4, ConstantType::float1},
                {"nearFar", offsetof(CompositeConstants, nearFar), 8, ConstantType::float2},
                {"sunUv", offsetof(CompositeConstants, sunUv), 8, ConstantType::float2},
                {"sunColor", offsetof(CompositeConstants, sunColor), 12, ConstantType::float3},
                {"shafts", offsetof(CompositeConstants, shafts), 4, ConstantType::float1}
        };
        compositeConstants = context.create_constants(compositeProgram, {fields, sizeof(CompositeConstants)});
    }

    void release() {
        release_targets();
        for (auto *program : {&brightProgram, &blurProgram, &contactProgram, &compositeProgram, &fxaaProgram})
            context.destroy(*program);
        context.destroy(geometry);
        context.destroy(linearSampler);
        context.destroy(depthSampler);
        context.destroy(pipeline);
    }

public:
    EnhancedLook(native::gfx::Context &graphics, int maximum_samples)
        : context(graphics)
        , maximumSamples(maximum_samples) {
        try {
            create_programs();
            geometry = context.create_geometry(0, {});
            linearSampler = context.create_sampler({});
            depthSampler = context.create_sampler({native::gfx::Filter::nearest, native::gfx::Filter::nearest});
            pipeline = context.create_pipeline({{}, {false, false}, {}});
        } catch (...) {
            release();
            throw;
        }
    }

    explicit EnhancedLook(native::gfx::Context &graphics)
        : EnhancedLook(
                  graphics, graphics.max_samples(native::gfx::Format::rgba16f, native::gfx::Format::depth24_stencil8)
          ) {}

    ~EnhancedLook() { release(); }

    EnhancedLook(const EnhancedLook &) = delete;
    EnhancedLook &operator=(const EnhancedLook &) = delete;

    void samples(int count) { requestedSamples = std::clamp(count, 0, maximumSamples); }

    void begin(int w, int h) {
        ensure_targets(w, h);
        context.bind_target(requestedSamples ? multisample : scene);
        context.viewport({0, 0, w, h});
    }

    native::gfx::TargetView refraction_source() {
        resolve_multisample();
        return scene;
    }

    void finish(native::gfx::TargetView destination, const LookFrame &frame, SourceHdr *hdr, double dt) {
        resolve_multisample();
        auto frameTexture = scene.color;
        if (hdr) {
            hdr->expose(scene.color, exposed.resource, width, height, dt);
            frameTexture = exposed.resource.color;
        }
        const bool withContact = frame.contact_strength > 0;
        const bool withBloom = !hdr && frame.bloom_strength > 0;
        if (withContact) draw_contact(frame);
        if (withBloom) draw_bloom(frameTexture);
        context.bind_target(frame.spatial_aa ? output.resource : destination);
        context.viewport({0, 0, width, height});
        composite(frameTexture, frame, withContact, withBloom);
        if (frame.spatial_aa) {
            context.bind_target(destination);
            context.viewport({0, 0, width, height});
            context.bind_program(fxaaProgram);
            context.bind_texture(0, output.resource.color, linearSampler);
            const std::array<float, 2> block{1.f / width, 1.f / height};
            context.constants(fxaaConstants, block.data());
            draw();
        }
        context.bind_target(destination);
        context.viewport({0, 0, width, height});
        context.depth_test(true);
        context.depth_write(true);
    }
};
