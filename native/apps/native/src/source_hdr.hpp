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
//   SourceHdr hdr(gl, emptyVao);
//   hdr.begin(w, h);  ...draw the world...  hdr.finish(target, w, h, dtSeconds);  ...draw viewmodel / HUD...
#include <algorithm>
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
    // Calibrated so bhop_shutdown's start (pad *230, yaw 90) sits at exposure 1, as in a CS:S render of that view.
    static constexpr float target = .37f, minExposure = .5f, maxExposure = 2, adaptRate = 1.2f, adaptDown = 3;
    static constexpr double measureEvery = .12;
    static constexpr int lumWidth = 32, lumHeight = 18;
    static constexpr size_t goalHistory = 10;

    struct Target {
        GLuint fbo = 0, texture = 0;
    };

    Gl &gl;
    GLuint emptyVao;
    GLuint downsample = 0, blur = 0, composite = 0, luminance = 0;
    GLuint sceneFbo = 0, sceneColor = 0, sceneDepth = 0;
    GLuint multisampleFbo = 0, multisampleColor = 0, multisampleDepth = 0;
    int requestedSamples = 0, currentSamples = -1;
    Target quarter[2], lum;
    int quarterWidth = 0, quarterHeight = 0;
    GLuint pbo = 0;
    GLsync fence = nullptr;
    int width = 0, height = 0;
    float exposure = 1;
    std::deque<float> goals;
    double sinceMeasure = 0;

    GLint loc(GLuint program, const char *name) { return gl.GetUniformLocation(program, name); }

    Target make_target(int w, int h, GLenum format, GLenum type, GLint internal) {
        Target t;
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
            throw std::runtime_error("Native HDR target incomplete");
        return t;
    }

    void destroy(Target &t) {
        if (t.fbo) gl.DeleteFramebuffers(1, &t.fbo);
        if (t.texture) gl.DeleteTextures(1, &t.texture);
        t = {};
    }

    void release_targets() {
        if (sceneFbo) gl.DeleteFramebuffers(1, &sceneFbo);
        if (sceneColor) gl.DeleteTextures(1, &sceneColor);
        if (sceneDepth) gl.DeleteRenderbuffers(1, &sceneDepth);
        if (multisampleFbo) gl.DeleteFramebuffers(1, &multisampleFbo);
        if (multisampleColor) gl.DeleteRenderbuffers(1, &multisampleColor);
        if (multisampleDepth) gl.DeleteRenderbuffers(1, &multisampleDepth);
        multisampleFbo = multisampleColor = multisampleDepth = 0;
        sceneFbo = sceneColor = sceneDepth = 0;
        destroy(quarter[0]);
        destroy(quarter[1]);
        width = height = 0;
    }

    void ensure_targets(int w, int h) {
        if (w == width && h == height && sceneFbo && currentSamples == requestedSamples) return;
        release_targets();
        Target scene = make_target(w, h, GL_RGBA, GL_HALF_FLOAT, GL_RGBA16F);
        sceneFbo = scene.fbo;
        sceneColor = scene.texture;
        gl.GenRenderbuffers(1, &sceneDepth);
        gl.BindRenderbuffer(GL_RENDERBUFFER, sceneDepth);
        gl.RenderbufferStorage(GL_RENDERBUFFER, GL_DEPTH24_STENCIL8, w, h);
        gl.FramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_STENCIL_ATTACHMENT, GL_RENDERBUFFER, sceneDepth);
        if (gl.CheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE)
            throw std::runtime_error("Native HDR scene target incomplete");
        if (requestedSamples) {
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
            if (gl.CheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) {
                throw std::runtime_error("HDR multisample target incomplete");
            }
        }
        currentSamples = requestedSamples;
        width = w;
        height = h;
    }

    void ensure_bloom_targets(int w, int h) {
        const int qw = std::max(1, w / 4), qh = std::max(1, h / 4);
        if (quarter[0].fbo && quarterWidth == qw && quarterHeight == qh) return;
        destroy(quarter[0]);
        destroy(quarter[1]);
        for (auto &q : quarter)
            q = make_target(qw, qh, GL_RGBA, GL_HALF_FLOAT, GL_RGBA16F);
        quarterWidth = qw;
        quarterHeight = qh;
    }

    void fullscreen(GLuint program) {
        gl.UseProgram(program);
        gl.BindVertexArray(emptyVao);
        gl.DrawArrays(GL_TRIANGLES, 0, 3);
    }

    void blur_into(const Target &from, const Target &to, float sx, float sy, float scale) {
        gl.BindFramebuffer(GL_FRAMEBUFFER, to.fbo);
        gl.UseProgram(blur);
        gl.ActiveTexture(GL_TEXTURE0);
        gl.BindTexture(GL_TEXTURE_2D, from.texture);
        gl.Uniform1i(loc(blur, "source"), 0);
        gl.Uniform2f(loc(blur, "stepSize"), sx, sy);
        gl.Uniform1f(loc(blur, "scale"), scale);
        fullscreen(blur);
    }

    void add_goal(const uint8_t *pixels) {
        double sum = 0;
        for (int i = 0; i < lumWidth * lumHeight; i++)
            sum += pixels[i * 4];
        const float mean = std::max(1e-4f, float(sum / (255. * lumWidth * lumHeight)));
        goals.push_back(std::clamp(target / mean, minExposure, maxExposure));
        if (goals.size() > goalHistory) goals.pop_front();
    }

    // Measure now and then (asynchronously) and move the exposure toward the averaged goal.
    void meter(GLuint scene, double dt) {
        if (fence) {
            const GLenum state = gl.ClientWaitSync(fence, 0, 0);
            if (state == GL_ALREADY_SIGNALED || state == GL_CONDITION_SATISFIED) {
                gl.DeleteSync(fence);
                fence = nullptr;
                gl.BindBuffer(GL_PIXEL_PACK_BUFFER, pbo);
                if (const auto *pixels = static_cast<const uint8_t *>(
                            gl.MapBufferRange(GL_PIXEL_PACK_BUFFER, 0, lumWidth * lumHeight * 4, GL_MAP_READ_BIT)
                    )) {
                    add_goal(pixels);
                    gl.UnmapBuffer(GL_PIXEL_PACK_BUFFER);
                }
                gl.BindBuffer(GL_PIXEL_PACK_BUFFER, 0);
            }
        }
        sinceMeasure += dt;
        if (!fence && sinceMeasure >= measureEvery) {
            sinceMeasure = 0;
            gl.BindFramebuffer(GL_FRAMEBUFFER, lum.fbo);
            gl.Viewport(0, 0, lumWidth, lumHeight);
            gl.UseProgram(luminance);
            gl.ActiveTexture(GL_TEXTURE0);
            gl.BindTexture(GL_TEXTURE_2D, scene);
            gl.Uniform1i(loc(luminance, "scene"), 0);
            gl.Uniform1f(loc(luminance, "exposure"), exposure);
            fullscreen(luminance);
            gl.BindBuffer(GL_PIXEL_PACK_BUFFER, pbo);
            gl.PixelStorei(GL_PACK_ALIGNMENT, 1);
            gl.ReadPixels(0, 0, lumWidth, lumHeight, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
            gl.BindBuffer(GL_PIXEL_PACK_BUFFER, 0);
            fence = gl.FenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE, 0);
        }
        if (goals.empty()) return;
        const float goal = std::accumulate(goals.begin(), goals.end(), 0.f) / goals.size(),
                    stops = std::log2(goal / exposure);
        exposure *= std::exp2(stops * std::min(1.f, float(adaptRate * (stops < 0 ? adaptDown : 1) * dt)));
    }

public:
    // CS:S's bloom on or off; exposure still adapts without it. bloomScale: env_tonemap_controller's SetBloomScale.
    bool bloom = true;
    float bloomScale = 1;

    void samples(int count) {
        GLint maximum = 0;
        gl.GetIntegerv(GL_MAX_SAMPLES, &maximum);
        requestedSamples = std::clamp(count, 0, maximum);
    }

    SourceHdr(Gl &g, GLuint vao) : gl(g), emptyVao(vao) {
        using namespace native_hdr;
        downsample = link_program(gl, hdr_vertex, hdr_downsample.c_str());
        blur = link_program(gl, hdr_vertex, hdr_blur);
        composite = link_program(gl, hdr_vertex, hdr_composite.c_str());
        luminance = link_program(gl, hdr_vertex, hdr_luminance.c_str());
        lum = make_target(lumWidth, lumHeight, GL_RGBA, GL_UNSIGNED_BYTE, GL_RGBA8);
        gl.GenBuffers(1, &pbo);
        gl.BindBuffer(GL_PIXEL_PACK_BUFFER, pbo);
        gl.BufferData(GL_PIXEL_PACK_BUFFER, lumWidth * lumHeight * 4, nullptr, GL_STREAM_READ);
        gl.BindBuffer(GL_PIXEL_PACK_BUFFER, 0);
        gl.BindFramebuffer(GL_FRAMEBUFFER, 0);
    }

    ~SourceHdr() {
        if (fence) gl.DeleteSync(fence);
        release_targets();
        destroy(lum);
        if (pbo) gl.DeleteBuffers(1, &pbo);
        for (GLuint p : {downsample, blur, composite, luminance})
            if (p) gl.DeleteProgram(p);
    }

    SourceHdr(const SourceHdr &) = delete;
    SourceHdr &operator=(const SourceHdr &) = delete;

    float current_exposure() const { return exposure; }

    // A new map or a cut: start from exposure 1 like a level load does.
    void reset() {
        exposure = 1;
        goals.clear();
        sinceMeasure = 0;
    }

    // Bind the half-float world target (sized to the frame) for the world's draws.
    void begin(int w, int h) {
        ensure_targets(w, h);
        gl.BindFramebuffer(GL_FRAMEBUFFER, multisampleFbo ? multisampleFbo : sceneFbo);
        gl.Viewport(0, 0, w, h);
    }

    void refraction_source(int w, int h) {
        if (multisampleFbo) {
            gl.BindFramebuffer(GL_READ_FRAMEBUFFER, multisampleFbo);
            gl.BindFramebuffer(GL_DRAW_FRAMEBUFFER, sceneFbo);
            gl.BlitFramebuffer(0, 0, w, h, 0, 0, w, h, GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT, GL_NEAREST);
        }
        gl.BindFramebuffer(GL_READ_FRAMEBUFFER, sceneFbo);
    }

    // Bloom and expose the world into `targetFbo` (the frame's own framebuffer), then meter.
    void finish(GLuint targetFbo, int w, int h, double dt) {
        if (multisampleFbo) {
            gl.BindFramebuffer(GL_READ_FRAMEBUFFER, multisampleFbo);
            gl.BindFramebuffer(GL_DRAW_FRAMEBUFFER, sceneFbo);
            gl.BlitFramebuffer(0, 0, w, h, 0, 0, w, h, GL_COLOR_BUFFER_BIT, GL_NEAREST);
        }
        expose(sceneColor, targetFbo, w, h, dt);
        gl.Enable(GL_DEPTH_TEST);
        gl.DepthMask(GL_TRUE);
    }

    // Bloom and expose `scene` (a gamma-encoded half-float frame of w x h) into `targetFbo`, then meter it. The
    // Enhanced and Cinematic looks call this on their own scene target.
    void expose(GLuint scene, GLuint targetFbo, int w, int h, double dt) {
        gl.Disable(GL_DEPTH_TEST);
        gl.Disable(GL_BLEND);
        gl.Disable(GL_CULL_FACE);
        gl.DepthMask(GL_FALSE);
        const bool withBloom = bloom && bloomScale > 0;
        if (withBloom) {
            ensure_bloom_targets(w, h);
            const auto &a = quarter[0], &b = quarter[1];
            gl.BindFramebuffer(GL_FRAMEBUFFER, a.fbo);
            gl.Viewport(0, 0, quarterWidth, quarterHeight);
            gl.UseProgram(downsample);
            gl.ActiveTexture(GL_TEXTURE0);
            gl.BindTexture(GL_TEXTURE_2D, scene);
            gl.Uniform1i(loc(downsample, "scene"), 0);
            gl.Uniform1f(loc(downsample, "exposure"), exposure);
            gl.Uniform2f(loc(downsample, "texel"), 1.f / w, 1.f / h);
            fullscreen(downsample);
            blur_into(a, b, 1.f / quarterWidth, 0, 1);
            blur_into(b, a, 0, 1.f / quarterHeight, bloomScale);
        }
        gl.BindFramebuffer(GL_FRAMEBUFFER, targetFbo);
        gl.Viewport(0, 0, w, h);
        gl.UseProgram(composite);
        gl.ActiveTexture(GL_TEXTURE0);
        gl.BindTexture(GL_TEXTURE_2D, scene);
        gl.Uniform1i(loc(composite, "scene"), 0);
        gl.Uniform1f(loc(composite, "exposure"), exposure);
        gl.ActiveTexture(GL_TEXTURE1);
        gl.BindTexture(GL_TEXTURE_2D, quarter[0].texture);
        gl.Uniform1i(loc(composite, "bloom"), 1);
        gl.Uniform1i(loc(composite, "hasBloom"), withBloom);
        fullscreen(composite);
        meter(scene, std::clamp(dt, 0., .25));
        gl.BindFramebuffer(GL_FRAMEBUFFER, targetFbo);
        gl.Viewport(0, 0, w, h);
        gl.ActiveTexture(GL_TEXTURE0);
    }
};

// Reused scene target for MSAA, resolution/aspect scaling and display grading.
class GraphicsTarget {
    Gl &gl;
    GLuint vao = 0, program = 0, framebuffer = 0, color = 0, depth = 0;
    GLuint multisample_framebuffer = 0, multisample_color = 0, multisample_depth = 0;
    int width = 0, height = 0, samples = -1;
    GLint brightness_location = -1, gamma_location = -1, vibrance_location = -1;

    void storage(GLuint renderbuffer, GLenum format, int count, int w, int h) {
        gl.BindRenderbuffer(GL_RENDERBUFFER, renderbuffer);
        if (count) {
            gl.RenderbufferStorageMultisample(GL_RENDERBUFFER, count, format, w, h);
        } else {
            gl.RenderbufferStorage(GL_RENDERBUFFER, format, w, h);
        }
    }

    void check_target() {
        if (gl.CheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) {
            throw std::runtime_error("Graphics target incomplete");
        }
    }

    void resize(int w, int h, int count) {
        if (width == w && height == h && samples == count) {
            return;
        }
        gl.BindFramebuffer(GL_FRAMEBUFFER, framebuffer);
        gl.BindTexture(GL_TEXTURE_2D, color);
        gl.TexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
        gl.FramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, color, 0);
        storage(depth, GL_DEPTH_COMPONENT24, 0, w, h);
        gl.FramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_RENDERBUFFER, depth);
        check_target();
        if (count) {
            gl.BindFramebuffer(GL_FRAMEBUFFER, multisample_framebuffer);
            storage(multisample_color, GL_RGBA8, count, w, h);
            storage(multisample_depth, GL_DEPTH_COMPONENT24, count, w, h);
            gl.FramebufferRenderbuffer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_RENDERBUFFER, multisample_color);
            gl.FramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_RENDERBUFFER, multisample_depth);
            check_target();
        }
        width = w;
        height = h;
        samples = count;
    }

public:
    GraphicsTarget(Gl &api, GLuint empty_vao) : gl(api), vao(empty_vao) {
        const char *fragment = R"(#version 330 core
in vec2 uv;out vec4 color;uniform sampler2D scene;uniform float brightness,gamma,vibrance;
void main(){
 vec3 source=pow(max(texture(scene,uv).rgb,vec3(0)),vec3(1./gamma))*brightness;
 float luminance=dot(source,vec3(.213,.715,.072));
 color=vec4(mix(vec3(luminance),source,vibrance),1);
}
)";
        program = link_program(gl, native_hdr::hdr_vertex, fragment);
        brightness_location = gl.GetUniformLocation(program, "brightness");
        gamma_location = gl.GetUniformLocation(program, "gamma");
        vibrance_location = gl.GetUniformLocation(program, "vibrance");
        gl.UseProgram(program);
        gl.Uniform1i(gl.GetUniformLocation(program, "scene"), 0);
        gl.GenFramebuffers(1, &framebuffer);
        gl.GenFramebuffers(1, &multisample_framebuffer);
        gl.GenTextures(1, &color);
        gl.BindTexture(GL_TEXTURE_2D, color);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
        gl.GenRenderbuffers(1, &depth);
        gl.GenRenderbuffers(1, &multisample_color);
        gl.GenRenderbuffers(1, &multisample_depth);
    }

    ~GraphicsTarget() {
        gl.DeleteRenderbuffers(1, &multisample_depth);
        gl.DeleteRenderbuffers(1, &multisample_color);
        gl.DeleteRenderbuffers(1, &depth);
        gl.DeleteTextures(1, &color);
        gl.DeleteFramebuffers(1, &multisample_framebuffer);
        gl.DeleteFramebuffers(1, &framebuffer);
        gl.DeleteProgram(program);
    }

    void begin(const native::GraphicsView &view, int requested_samples) {
        GLint maximum_samples = 0;
        gl.GetIntegerv(GL_MAX_SAMPLES, &maximum_samples);
        resize(view.width, view.height, std::min(requested_samples, maximum_samples));
        gl.BindFramebuffer(GL_FRAMEBUFFER, samples ? multisample_framebuffer : framebuffer);
    }

    void refraction_source() {
        if (samples) {
            gl.BindFramebuffer(GL_READ_FRAMEBUFFER, multisample_framebuffer);
            gl.BindFramebuffer(GL_DRAW_FRAMEBUFFER, framebuffer);
            gl.BlitFramebuffer(
                    0, 0, width, height, 0, 0, width, height, GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT, GL_NEAREST
            );
        }
        gl.BindFramebuffer(GL_READ_FRAMEBUFFER, framebuffer);
    }

    void
    finish(GLuint target,
           int output_width,
           int output_height,
           const native::GraphicsView &view,
           const native::GraphicsSettings &settings) {
        if (samples) {
            gl.BindFramebuffer(GL_READ_FRAMEBUFFER, multisample_framebuffer);
            gl.BindFramebuffer(GL_DRAW_FRAMEBUFFER, framebuffer);
            gl.BlitFramebuffer(0, 0, width, height, 0, 0, width, height, GL_COLOR_BUFFER_BIT, GL_NEAREST);
        }
        gl.BindFramebuffer(GL_FRAMEBUFFER, target);
        gl.Viewport(0, 0, output_width, output_height);
        gl.Disable(GL_DEPTH_TEST);
        gl.Disable(GL_BLEND);
        gl.Disable(GL_CULL_FACE);
        gl.DepthMask(GL_FALSE);
        gl.ClearColor(0, 0, 0, 1);
        gl.Clear(GL_COLOR_BUFFER_BIT);
        gl.Viewport(view.x, view.y, view.output_width, view.output_height);
        gl.UseProgram(program);
        gl.ActiveTexture(GL_TEXTURE0);
        gl.BindTexture(GL_TEXTURE_2D, color);
        const int filter = settings.pixelated ? GL_NEAREST : GL_LINEAR;
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, filter);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, filter);
        gl.Uniform1f(brightness_location, settings.brightness);
        gl.Uniform1f(gamma_location, settings.gamma);
        gl.Uniform1f(vibrance_location, settings.vibrance);
        gl.BindVertexArray(vao);
        gl.DrawArrays(GL_TRIANGLES, 0, 3);
        gl.Viewport(0, 0, output_width, output_height);
        gl.DepthMask(GL_TRUE);
        gl.Enable(GL_DEPTH_TEST);
    }
};
