#pragma once
// CS:S's HDR look (mat_hdr_level 2) for maps compiled with HDR lighting: auto exposure and bloom, ported from the
// web game's graphics/source-hdr.ts (itself from SDK 2013's viewpostprocess.cpp as cstrike runs it). LDR-only maps
// draw the way CS:S draws them too: exposure 1, no bloom, straight to the screen.
//
// The world draws into a half-float target holding exactly what the world shaders would have written to the screen
// (gamma-encoded, not yet clamped), so translucent blending and the gamma-space water/sky fog stay as they are.
// Then, from the linearised frame:
// - bloom (Generate8BitBloomTexture with dev/downsample_non_hdr_cstrike): a quarter-size copy of the exposed frame
//   shaped as `luminance * colour`, blurred by BlurFilterX/Y's 13 taps, and added onto the gamma-space frame;
// - auto exposure (CLuminanceHistogramSystem's original algorithm, which cstrike forces): the mean luminance of the
//   exposed, gamma-space frame over the centre 90% x 85% sets the goal TARGET / mean, averaged over the last 10 goals
//   and clamped to 0.5 - 2. The current exposure moves toward it over about a second, three times faster when
//   darkening. The mean is read back through a pixel-pack buffer and a fence a few times a second, never stalling.
// With exposure 1 and no bloom the composite is exactly the straight render.
//
//   SourceHdr hdr(context, maximumSamples);
//   hdr.begin(w, h);  ...draw the world...  hdr.finish(target, w, h, dtSeconds);  ...draw viewmodel / HUD...
#include "gfx.hpp"
#include "post_gl_bridge.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <deque>
#include <numeric>
#include <stdexcept>
#include <string>

namespace native_hdr {
inline const char *hdr_vertex = R"(#version 330 core
out vec2 uv;void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);uv=p;gl_Position=vec4(p*2.-1.,0,1);}
)";
// The scene target holds gamma-encoded colour; exposed() is the linear, exposed, clamped colour CS:S's framebuffer
// would hold.
inline const std::string hdr_common = R"(#version 330 core
in vec2 uv;out vec4 color;uniform sampler2D scene;uniform float exposure;
vec3 toGamma(vec3 c){c=clamp(c,0.,1.);return mix(c*12.92,1.055*pow(c,vec3(1./2.4))-.055,step(vec3(.0031308),c));}
vec3 toLinear(vec3 g){g=max(g,vec3(0));return mix(g/12.92,pow((g+.055)/1.055,vec3(2.4)),step(vec3(.04045),g));}
vec3 exposed(vec2 at){return clamp(toLinear(texture(scene,at).rgb)*exposure,0.,1.);}
)";
// Downsample_nohdr_ps2x.fxc (CSTRIKE): four taps of the exposed frame, each NTSC luminance * linear colour.
inline const std::string hdr_downsample = hdr_common + R"(uniform vec2 texel;
vec3 shape(vec2 at){vec3 c=exposed(at);return dot(c,vec3(.3,.59,.11))*c;}
void main(){color=vec4((shape(uv-texel)+shape(uv+vec2(texel.x,-texel.y))+shape(uv+vec2(-texel.x,texel.y))+shape(uv+texel))*.25,1);}
)";
// BlurFilter_ps2x.fxc: 13 taps at BlurFilterX/Y.cpp's offsets (in quarter-size texels), times scale.
inline const char *hdr_blur = R"(#version 330 core
in vec2 uv;out vec4 color;uniform sampler2D source;uniform vec2 stepSize;uniform float scale;
vec3 pair(float o){return texture(source,uv+stepSize*o).rgb+texture(source,uv-stepSize*o).rgb;}
void main(){vec3 c=texture(source,uv).rgb*.2013+pair(1.3366)*.2185+pair(3.4295)*.0821+pair(5.4264)*.0461+pair(7.4359)*.0262+pair(9.4436)*.0162+pair(11.4401)*.0102;color=vec4(c*scale,1);}
)";
// Engine_Post_ps2x.fxc: the exposed frame in gamma space, plus the bloom texture as is.
inline const std::string hdr_composite = hdr_common + R"(uniform sampler2D bloom;uniform bool hasBloom;
void main(){color=vec4(toGamma(exposed(uv))+(hasBloom?texture(bloom,uv).rgb:vec3(0)),1);}
)";
// luminance_compare_ps2x.fxc's luminance of the exposed gamma-space frame, over the metered centre.
inline const std::string hdr_luminance = hdr_common + R"(
void main(){color=vec4(vec3(dot(toGamma(exposed(vec2(.05,.075)+uv*vec2(.9,.85))),vec3(.2125,.7154,.0721))),1);}
)";
}  // namespace native_hdr

class SourceHdr {
    static constexpr float target = .37f, minExposure = .5f, maxExposure = 2, adaptRate = 1.2f, adaptDown = 3;
    static constexpr double measureEvery = .12;
    static constexpr int lumWidth = 32, lumHeight = 18;
    static constexpr size_t goalHistory = 10, readbackSlots = 3;

    struct SceneConstants {
        float exposure;
        std::array<float, 2> texel{};
        uint32_t hasBloom = 0;
    };

    struct BlurConstants {
        std::array<float, 2> stepSize;
        float scale;
    };

    native::gfx::Context &context;
    native::gfx::Program downsample, blur, composite, luminance;
    native::gfx::ConstantBinding downsampleConstants, blurConstants, compositeConstants, luminanceConstants;
    native::gfx::Geometry geometry;
    native::gfx::Sampler sampler;
    native::gfx::Pipeline pipeline;
    native::gfx::RenderTarget scene, multisample, quarter[2], lum;
    std::array<native::gfx::Readback, readbackSlots> readbacks{};
    size_t readbackSlot = 0;
    int maximumSamples, requestedSamples = 0, currentSamples = -1;
    int quarterWidth = 0, quarterHeight = 0, width = 0, height = 0;
    float exposure = 1;
    std::deque<float> goals;
    double sinceMeasure = 0;

    void release_targets() {
        context.destroy(scene);
        context.destroy(multisample);
        for (auto &q : quarter)
            context.destroy(q);
        width = height = quarterWidth = quarterHeight = 0;
    }

    void ensure_targets(int w, int h) {
        using namespace native::gfx;
        if (w == width && h == height && currentSamples == requestedSamples) return;
        release_targets();
        scene = context.create_target({w, h, Format::rgba16f, Format::depth24_stencil8});
        if (requestedSamples)
            multisample = context.create_target({w, h, Format::rgba16f, Format::depth24_stencil8, requestedSamples});
        currentSamples = requestedSamples;
        width = w;
        height = h;
    }

    void ensure_bloom_targets(int w, int h) {
        const int qw = std::max(1, w / 4), qh = std::max(1, h / 4);
        if (quarterWidth == qw && quarterHeight == qh) return;
        for (auto &q : quarter) {
            context.destroy(q);
            q = context.create_target({qw, qh, native::gfx::Format::rgba16f});
        }
        quarterWidth = qw;
        quarterHeight = qh;
    }

    void fullscreen(native::gfx::Program program) {
        context.pipeline(pipeline);
        context.bind_program(program);
        context.bind_geometry(geometry);
        context.draw(native::gfx::Primitive::triangles, 0, 3);
        context.bind_texture(1, {});
        context.bind_texture(0, {});
    }

    void blur_into(
            const native::gfx::RenderTarget &from, const native::gfx::RenderTarget &to, float sx, float sy, float scale
    ) {
        context.bind_target(to);
        context.viewport({0, 0, quarterWidth, quarterHeight});
        context.bind_program(blur);
        const BlurConstants block{{sx, sy}, scale};
        context.constants(blurConstants, &block);
        context.bind_texture(0, from.color, sampler);
        fullscreen(blur);
    }

    void add_goal(const std::array<uint8_t, lumWidth * lumHeight * 4> &pixels) {
        double sum = 0;
        for (int i = 0; i < lumWidth * lumHeight; i++)
            sum += pixels[size_t(i) * 4];
        const float mean = std::max(1e-4f, float(sum / (255. * lumWidth * lumHeight)));
        goals.push_back(std::clamp(target / mean, minExposure, maxExposure));
        if (goals.size() > goalHistory) goals.pop_front();
    }

    void meter(native::gfx::Texture texture, double dt) {
        using namespace native::gfx;
        auto *readback = &readbacks[readbackSlot];
        if (context.pending(*readback)) {
            const auto state = context.poll(*readback);
            if (state == Wait::failed) throw std::runtime_error("HDR exposure readback failed");
            if (state == Wait::ready) {
                std::array<uint8_t, lumWidth * lumHeight * 4> pixels{};
                context.collect(*readback, std::as_writable_bytes(std::span(pixels)), RowOrigin::bottom, 0);
                add_goal(pixels);
                readbackSlot = (readbackSlot + 1) % readbackSlots;
                readback = &readbacks[readbackSlot];
            }
        }
        sinceMeasure += dt;
        // Keep one measurement in flight, preserving the original exposure goal cadence as the ring wraps.
        if (!context.pending(*readback) && sinceMeasure >= measureEvery) {
            sinceMeasure = 0;
            context.bind_target(lum);
            context.viewport({0, 0, lumWidth, lumHeight});
            context.bind_program(luminance);
            const SceneConstants block{exposure};
            context.constants(luminanceConstants, &block);
            context.bind_texture(0, texture, sampler);
            fullscreen(luminance);
            context.enqueue_readback(lum, *readback);
        }
        if (goals.empty()) return;
        const float goal = std::accumulate(goals.begin(), goals.end(), 0.f) / goals.size(),
                    stops = std::log2(goal / exposure);
        exposure *= std::exp2(stops * std::min(1.f, float(adaptRate * (stops < 0 ? adaptDown : 1) * dt)));
    }

    void create() {
        using namespace native::gfx;
        using namespace native_hdr;
        downsample = context.create_program({{"hdr-downsample", ""}, hdr_vertex, hdr_downsample.c_str()});
        blur = context.create_program({{"hdr-blur", ""}, hdr_vertex, hdr_blur});
        composite = context.create_program({{"hdr-composite", ""}, hdr_vertex, hdr_composite.c_str()});
        luminance = context.create_program({{"hdr-luminance", ""}, hdr_vertex, hdr_luminance.c_str()});
        static constexpr ConstantField sceneFields[] = {
                {"exposure", offsetof(SceneConstants, exposure), 4, ConstantType::float1},
                {"texel", offsetof(SceneConstants, texel), 8, ConstantType::float2},
                {"hasBloom", offsetof(SceneConstants, hasBloom), 4, ConstantType::bool32}
        };
        static constexpr ConstantField blurFields[] = {
                {"stepSize", offsetof(BlurConstants, stepSize), 8, ConstantType::float2},
                {"scale", offsetof(BlurConstants, scale), 4, ConstantType::float1}
        };
        for (auto entry :
             {std::pair{downsample, &downsampleConstants},
              {composite, &compositeConstants},
              {luminance, &luminanceConstants}}) {
            *entry.second = context.create_constants(entry.first, {sceneFields, sizeof(SceneConstants)});
            context.texture_unit(entry.first, "scene", 0);
        }
        blurConstants = context.create_constants(blur, {blurFields, sizeof(BlurConstants)});
        context.texture_unit(blur, "source", 0);
        context.texture_unit(composite, "bloom", 1);
        geometry = context.create_geometry(0, {});
        sampler = context.create_sampler({});
        pipeline = context.create_pipeline({{}, {false, false}, {}});
        lum = context.create_target({lumWidth, lumHeight, Format::rgba8});
        for (auto &readback : readbacks)
            readback = context.create_readback(lumWidth, lumHeight);
    }

    void release() {
        for (auto &readback : readbacks)
            context.destroy(readback);
        release_targets();
        context.destroy(lum);
        for (auto *program : {&downsample, &blur, &composite, &luminance})
            context.destroy(*program);
        context.destroy(geometry);
        context.destroy(sampler);
        context.destroy(pipeline);
    }

public:
    bool bloom = true;
    float bloomScale = 1;

    SourceHdr(native::gfx::Context &graphics, int maximum_samples, native::gfx::TargetView restore_target = {})
        : context(graphics)
        , maximumSamples(maximum_samples) {
        try {
            create();
        } catch (...) {
            release();
            context.bind_target(restore_target);
            throw;
        }
        context.bind_target(restore_target);
    }

    // Temporary bridge: renderer.hpp can construct this lazily while its frame target is bound.
    SourceHdr(native::gfx::Context &graphics, Gl &gl)
        : SourceHdr(graphics, native_post::maximum_samples(gl), native_post::current_target(gl)) {}

    ~SourceHdr() { release(); }

    SourceHdr(const SourceHdr &) = delete;
    SourceHdr &operator=(const SourceHdr &) = delete;

    void samples(int count) { requestedSamples = std::clamp(count, 0, maximumSamples); }

    float current_exposure() const { return exposure; }

    void reset() {
        exposure = 1;
        goals.clear();
        sinceMeasure = 0;
    }

    void begin(int w, int h) {
        ensure_targets(w, h);
        context.bind_target(requestedSamples ? multisample : scene);
        context.viewport({0, 0, w, h});
    }

    native::gfx::TargetView refraction_source(int, int) {
        if (requestedSamples) {
            context.resolve_color(multisample, scene);
            context.resolve_depth(multisample, scene);
        }
        // Temporary bridge: renderer.hpp still copies refraction from the bound read target.
        context.bind_target(scene);
        return scene;
    }

    void finish(native::gfx::TargetView destination, int w, int h, double dt) {
        if (requestedSamples) context.resolve_color(multisample, scene);
        expose(scene.color, destination, w, h, dt);
        context.depth_test(true);
        context.depth_write(true);
    }

    // Temporary bridge for renderer.hpp's borrowed framebuffer argument.
    void finish(uint32_t framebuffer, int w, int h, double dt) {
        finish(native_post::target(framebuffer, w, h), w, h, dt);
    }

    void expose(native::gfx::Texture texture, native::gfx::TargetView destination, int w, int h, double dt) {
        const bool withBloom = bloom && bloomScale > 0;
        if (withBloom) {
            ensure_bloom_targets(w, h);
            const auto &a = quarter[0], &b = quarter[1];
            context.bind_target(a);
            context.viewport({0, 0, quarterWidth, quarterHeight});
            context.bind_program(downsample);
            const SceneConstants block{exposure, {1.f / w, 1.f / h}};
            context.constants(downsampleConstants, &block);
            context.bind_texture(0, texture, sampler);
            fullscreen(downsample);
            blur_into(a, b, 1.f / quarterWidth, 0, 1);
            blur_into(b, a, 0, 1.f / quarterHeight, bloomScale);
        }
        context.bind_target(destination);
        context.viewport({0, 0, w, h});
        context.bind_program(composite);
        const SceneConstants block{exposure, {}, uint32_t(withBloom)};
        context.constants(compositeConstants, &block);
        context.bind_texture(0, texture, sampler);
        context.bind_texture(1, quarter[0].color, sampler);
        fullscreen(composite);
        meter(texture, std::clamp(dt, 0., .25));
        context.bind_target(destination);
        context.viewport({0, 0, w, h});
    }
};

// Reused scene target for MSAA, resolution/aspect scaling and display grading.
class GraphicsTarget {
    native::gfx::Context &context;
    native::gfx::Program program;
    native::gfx::Geometry geometry;
    native::gfx::Pipeline pipeline;
    native::gfx::ConstantBinding constants;
    native::gfx::Sampler linearSampler, nearestSampler;
    native::gfx::RenderTarget scene, multisample;
    int maximumSamples, width = 0, height = 0, samples = -1;

    void resize(int w, int h, int count) {
        using namespace native::gfx;
        if (width == w && height == h && samples == count) return;
        context.destroy(scene);
        context.destroy(multisample);
        scene = context.create_target({w, h, Format::rgba8, Format::depth24});
        if (count) multisample = context.create_target({w, h, Format::rgba8, Format::depth24, count});
        width = w;
        height = h;
        samples = count;
    }

public:
    GraphicsTarget(native::gfx::Context &graphics, int maximum_samples)
        : context(graphics)
        , maximumSamples(maximum_samples) {
        const char *fragment = R"(#version 330 core
in vec2 uv;out vec4 color;uniform sampler2D scene;uniform float brightness,gamma,vibrance;
void main(){
 vec3 source=pow(max(texture(scene,uv).rgb,vec3(0)),vec3(1./gamma))*brightness;
 float luminance=dot(source,vec3(.213,.715,.072));
 color=vec4(mix(vec3(luminance),source,vibrance),1);
}
)";
        using namespace native::gfx;
        program = context.create_program({{"graphics-target", ""}, native_hdr::hdr_vertex, fragment});
        static constexpr ConstantField fields[] = {
                {"brightness", 0, 4, ConstantType::float1},
                {"gamma", 4, 4, ConstantType::float1},
                {"vibrance", 8, 4, ConstantType::float1}
        };
        constants = context.create_constants(program, {fields, 12});
        context.texture_unit(program, "scene", 0);
        geometry = context.create_geometry(0, {});
        pipeline = context.create_pipeline({{}, {false, false}, {}});
        linearSampler = context.create_sampler({});
        nearestSampler = context.create_sampler({Filter::nearest, Filter::nearest});
    }

    // Temporary bridge for the legacy renderer's GL sample-limit query.
    GraphicsTarget(native::gfx::Context &graphics, Gl &gl)
        : GraphicsTarget(graphics, native_post::maximum_samples(gl)) {}

    ~GraphicsTarget() {
        context.destroy(scene);
        context.destroy(multisample);
        context.destroy(program);
        context.destroy(geometry);
        context.destroy(pipeline);
        context.destroy(linearSampler);
        context.destroy(nearestSampler);
    }

    GraphicsTarget(const GraphicsTarget &) = delete;
    GraphicsTarget &operator=(const GraphicsTarget &) = delete;

    void begin(const native::GraphicsView &view, int requested_samples) {
        resize(view.width, view.height, std::clamp(requested_samples, 0, maximumSamples));
        context.bind_target(samples ? multisample : scene);
    }

    native::gfx::TargetView refraction_source() {
        if (samples) {
            context.resolve_color(multisample, scene);
            context.resolve_depth(multisample, scene);
        }
        // Temporary bridge: renderer.hpp still copies refraction from the bound read target.
        context.bind_target(scene);
        return scene;
    }

    void
    finish(native::gfx::TargetView destination,
           int output_width,
           int output_height,
           const native::GraphicsView &view,
           const native::GraphicsSettings &settings) {
        if (samples) context.resolve_color(multisample, scene);
        context.bind_target(destination);
        context.viewport({0, 0, output_width, output_height});
        context.pipeline(pipeline);
        context.clear_color({0, 0, 0, 1});
        context.viewport({view.x, view.y, view.output_width, view.output_height});
        context.bind_program(program);
        const std::array<float, 3> block{settings.brightness, settings.gamma, settings.vibrance};
        context.constants(constants, block.data());
        context.bind_texture(0, scene.color, settings.pixelated ? nearestSampler : linearSampler);
        context.bind_geometry(geometry);
        context.draw(native::gfx::Primitive::triangles, 0, 3);
        context.bind_texture(0, {});
        context.viewport({0, 0, output_width, output_height});
        context.depth_write(true);
        context.depth_test(true);
    }

    // Temporary bridge for renderer.hpp's borrowed framebuffer argument.
    void
    finish(uint32_t framebuffer,
           int output_width,
           int output_height,
           const native::GraphicsView &view,
           const native::GraphicsSettings &settings) {
        finish(native_post::target(framebuffer, output_width, output_height),
               output_width,
               output_height,
               view,
               settings);
    }
};
