#pragma once
#include "bunnyhop_native.h"
#include "native_input.hpp"
#include "native_math.hpp"
#include "render_shaders.hpp"
#include "scene_draw_list.hpp"
#include "render_math.hpp"
#include "water_capture.hpp"
#include "texture_bleed.hpp"
#include "ghost_trails.hpp"
#include "graphics_settings.hpp"
#include "runner_view.hpp"
#include "paint.hpp"
#include "measure.hpp"
#include "scene_lighting.hpp"
#include "sky_image.hpp"
#include "zone_effects.hpp"
#include "resource_loading.hpp"
#include "actor_anim.hpp"
#include "tp_inspect.hpp"
#include "knife_spinner.hpp"
#include "inspect_cues.hpp"
#include <span>
#include "nlohmann/json.hpp"
#include <filesystem>
#include <chrono>
#include <sstream>
#include <regex>
#include <zlib.h>
#include <memory>
#include <optional>
#include <future>
#include <thread>
#include <array>
#include <SDL3/SDL.h>
#include <SDL3/SDL_opengl.h>
#include "player_material.hpp"
#include "ponytail_motion.hpp"
#include <algorithm>
#include <cmath>
#include <deque>
#include <fstream>
#include <iostream>
#include <limits>
#include <numeric>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace native {
// All GL entry points come from the active SDL context, including on Linux.
// clang-format off
#define GL_FUNCTIONS(X) \
    X(void, Viewport, (GLint, GLint, GLsizei, GLsizei)) \
    X(void, ClearColor, (GLfloat, GLfloat, GLfloat, GLfloat)) \
    X(void, Clear, (GLbitfield)) \
    X(void, Enable, (GLenum)) \
    X(void, Disable, (GLenum)) \
    X(void, ColorMask, (GLboolean, GLboolean, GLboolean, GLboolean)) \
    X(void, PolygonOffset, (GLfloat, GLfloat)) \
    X(void, DepthMask, (GLboolean)) \
    X(void, DepthFunc, (GLenum)) \
    X(void, CullFace, (GLenum)) \
    X(void, FrontFace, (GLenum)) \
    X(void, BlendFunc, (GLenum, GLenum)) \
    X(void, GenVertexArrays, (GLsizei, GLuint *)) \
    X(void, BindVertexArray, (GLuint)) \
    X(void, DeleteVertexArrays, (GLsizei, const GLuint *)) \
    X(void, GenBuffers, (GLsizei, GLuint *)) \
    X(void, BindBuffer, (GLenum, GLuint)) \
    X(void, BufferData, (GLenum, GLsizeiptr, const void *, GLenum)) \
    X(void, DeleteBuffers, (GLsizei, const GLuint *)) \
    X(void, EnableVertexAttribArray, (GLuint)) \
    X(void, VertexAttribPointer, (GLuint, GLint, GLenum, GLboolean, GLsizei, const void *)) \
    X(GLuint, CreateShader, (GLenum)) \
    X(void, ShaderSource, (GLuint, GLsizei, const GLchar *const *, const GLint *)) \
    X(void, CompileShader, (GLuint)) \
    X(void, GetShaderiv, (GLuint, GLenum, GLint *)) \
    X(void, GetShaderInfoLog, (GLuint, GLsizei, GLsizei *, GLchar *)) \
    X(void, DeleteShader, (GLuint)) \
    X(GLuint, CreateProgram, (void)) \
    X(void, AttachShader, (GLuint, GLuint)) \
    X(void, LinkProgram, (GLuint)) \
    X(void, GetProgramiv, (GLuint, GLenum, GLint *)) \
    X(void, GetProgramInfoLog, (GLuint, GLsizei, GLsizei *, GLchar *)) \
    X(void, DeleteProgram, (GLuint)) \
    X(void, UseProgram, (GLuint)) \
    X(GLint, GetUniformLocation, (GLuint, const GLchar *)) \
    X(void, UniformMatrix4fv, (GLint, GLsizei, GLboolean, const GLfloat *)) \
    X(void, Uniform1i, (GLint, GLint)) \
    X(void, Uniform1f, (GLint, GLfloat)) \
    X(void, Uniform4fv, (GLint, GLsizei, const GLfloat *)) \
    X(void, Uniform3fv, (GLint, GLsizei, const GLfloat *)) \
    X(void, Uniform2fv, (GLint, GLsizei, const GLfloat *)) \
    X(void, Uniform1iv, (GLint, GLsizei, const GLint *)) \
    X(void, Uniform3f, (GLint, GLfloat, GLfloat, GLfloat)) \
    X(void, GenTextures, (GLsizei, GLuint *)) \
    X(void, BindTexture, (GLenum, GLuint)) \
    X(void, ActiveTexture, (GLenum)) \
    X(void, TexParameteri, (GLenum, GLenum, GLint)) \
    X(void, TexImage2D, (GLenum, GLint, GLint, GLsizei, GLsizei, GLint, GLenum, GLenum, const void *)) \
    X(void, CopyTexSubImage2D, (GLenum, GLint, GLint, GLint, GLint, GLint, GLsizei, GLsizei)) \
    X(void, CopyTexImage2D, (GLenum, GLint, GLenum, GLint, GLint, GLsizei, GLsizei, GLint)) \
    X(void, GenerateMipmap, (GLenum)) \
    X(void, DeleteTextures, (GLsizei, const GLuint *)) \
    X(void, DrawElements, (GLenum, GLsizei, GLenum, const void *)) \
    X(void, DrawElementsInstanced, (GLenum, GLsizei, GLenum, const void *, GLsizei)) \
    X(void, DrawArraysInstanced, (GLenum, GLint, GLsizei, GLsizei)) \
    X(void, DrawArrays, (GLenum, GLint, GLsizei)) \
    X(void, PixelStorei, (GLenum, GLint)) \
    X(void, ReadPixels, (GLint, GLint, GLsizei, GLsizei, GLenum, GLenum, void *)) \
    X(void, GetIntegerv, (GLenum, GLint *)) \
    X(const GLubyte *, GetString, (GLenum)) \
    X(GLenum, GetError, (void)) \
    X(void, Uniform2f, (GLint, GLfloat, GLfloat)) \
    X(void, GenFramebuffers, (GLsizei, GLuint *)) \
    X(void, BindFramebuffer, (GLenum, GLuint)) \
    X(void, DeleteFramebuffers, (GLsizei, const GLuint *)) \
    X(void, FramebufferTexture2D, (GLenum, GLenum, GLenum, GLuint, GLint)) \
    X(GLenum, CheckFramebufferStatus, (GLenum)) \
    X(void, GenRenderbuffers, (GLsizei, GLuint *)) \
    X(void, BindRenderbuffer, (GLenum, GLuint)) \
    X(void, DeleteRenderbuffers, (GLsizei, const GLuint *)) \
    X(void, RenderbufferStorageMultisample, (GLenum, GLsizei, GLenum, GLsizei, GLsizei)) \
    X(void, BlitFramebuffer, (GLint, GLint, GLint, GLint, GLint, GLint, GLint, GLint, GLbitfield, GLenum)) \
    X(void, TexParameterf, (GLenum, GLenum, GLfloat)) \
    X(void, GetFloatv, (GLenum, GLfloat *)) \
    X(void, RenderbufferStorage, (GLenum, GLenum, GLsizei, GLsizei)) \
    X(void, FramebufferRenderbuffer, (GLenum, GLenum, GLenum, GLuint)) \
    X(void *, MapBufferRange, (GLenum, GLintptr, GLsizeiptr, GLbitfield)) \
    X(GLboolean, UnmapBuffer, (GLenum)) \
    X(GLsync, FenceSync, (GLenum, GLbitfield)) \
    X(GLenum, ClientWaitSync, (GLsync, GLbitfield, GLuint64)) \
    X(void, DeleteSync, (GLsync)) \
    X(void, DrawBuffer, (GLenum)) \
    X(void, ReadBuffer, (GLenum))
// clang-format on

struct Gl {
#define DECLARE(ret, name, args) ret(APIENTRY *name) args = nullptr;
    GL_FUNCTIONS(DECLARE)
#undef DECLARE

    template <class Resolve>
    void load(Resolve resolve) {
#define LOAD(ret, name, args) \
    name = reinterpret_cast<decltype(name)>(resolve("gl" #name)); \
    if (!name) throw std::runtime_error("Missing OpenGL function gl" #name);
        GL_FUNCTIONS(LOAD)
#undef LOAD
    }

    void load() { load(SDL_GL_GetProcAddress); }
};

inline GLuint shader(Gl &gl, GLenum kind, const char *source) {
    GLuint id = gl.CreateShader(kind);
    gl.ShaderSource(id, 1, &source, nullptr);
    gl.CompileShader(id);
    GLint ok = 0;
    gl.GetShaderiv(id, GL_COMPILE_STATUS, &ok);
    if (!ok) {
        char log[4096]{};
        gl.GetShaderInfoLog(id, sizeof(log), nullptr, log);
        gl.DeleteShader(id);
        throw std::runtime_error(std::string("Shader compilation failed: ") + log);
    }
    return id;
}

inline GLuint link_program(Gl &gl, const char *vertex_source, const char *fragment_source) {
    const GLuint vertex = shader(gl, GL_VERTEX_SHADER, vertex_source);
    GLuint fragment = 0, program = 0;
    try {
        fragment = shader(gl, GL_FRAGMENT_SHADER, fragment_source);
        program = gl.CreateProgram();
        gl.AttachShader(program, vertex);
        gl.AttachShader(program, fragment);
        gl.LinkProgram(program);
        GLint ok = 0;
        gl.GetProgramiv(program, GL_LINK_STATUS, &ok);
        if (!ok) {
            char log[4096]{};
            gl.GetProgramInfoLog(program, sizeof(log), nullptr, log);
            throw std::runtime_error(std::string("Shader link failed: ") + log);
        }
    } catch (...) {
        gl.DeleteShader(vertex);
        if (fragment) gl.DeleteShader(fragment);
        if (program) gl.DeleteProgram(program);
        throw;
    }
    gl.DeleteShader(vertex);
    gl.DeleteShader(fragment);
    return program;
}

#include "native_presentation.hpp"
#include "native_viewmodel.hpp"
#include "native_map_effects.hpp"
// Standard headers must be included at file scope before these GL-dependent definitions.
#include "source_hdr.hpp"
#include "enhanced_look.hpp"
#include "sun_shadows.hpp"
#include "water_reflection.hpp"

// The website's route guide (apps/web/src/ghost-route.ts): the path in the ghost's colour and a white wire box on
// every takeoff, as screen-space lines of a fixed pixel width. Segments are expanded to quads once, at upload.
class GhostRouteGeometry {
    static constexpr float path_width_points = 2.5f, path_opacity = .85f;
    static constexpr float marker_width_points = 2, marker_opacity = .95f;
    static constexpr float marker_half_width_units = 6, marker_below_units = 1, marker_above_units = 2;
    static constexpr float route_lift_units = 2;

    struct Vertex {
        native_render::Vec3 point, other;
        float side = 0;
    };

    struct Mesh {
        GLuint vao = 0, buffer = 0;
        GLsizei pathVertices = 0, markerVertices = 0;
    };

    Gl &gl;
    GLuint program = 0;
    std::array<Mesh, 4> meshes;
    std::vector<Vertex> vertices;
    GLint projectionLocation = -1, colorLocation = -1, widthLocation = -1, viewportLocation = -1;

    void add_segment(const native_render::Vec3 &from, const native_render::Vec3 &to) {
        const Vertex a{from, to, 1}, b{from, to, -1}, c{to, from, -1}, d{to, from, 1};
        for (const auto &vertex : {a, b, c, a, c, d})
            vertices.push_back(vertex);
    }

    void add_path(const native_render::GhostPath &path, bool fullPath) {
        if (!fullPath) {
            for (const auto &link : path.jump_links)
                add_segment(link.from, link.to);
            return;
        }
        for (size_t tick = path.start + 1; tick <= path.end && tick < path.frames.size(); ++tick) {
            if (path.teleports[tick] || !native_render::valid_ghost_position(path.frames[tick - 1])
                || !native_render::valid_ghost_position(path.frames[tick]))
                continue;
            add_segment(
                    native_render::ghost_feet(path.frames[tick - 1], route_lift_units),
                    native_render::ghost_feet(path.frames[tick], route_lift_units)
            );
        }
    }

    void add_marker(const native_render::Vec3 &takeoff) {
        constexpr float w = marker_half_width_units;
        std::array<native_render::Vec3, 8> corners;
        for (size_t corner = 0; corner < corners.size(); ++corner) {
            corners[corner] = {
                    takeoff[0] + ((corner & 1) ? w : -w),
                    takeoff[1] + ((corner & 2) ? w : -w),
                    takeoff[2] + ((corner & 4) ? marker_above_units : -marker_below_units)
            };
        }
        constexpr std::array<std::array<int, 2>, 12> edges = {
                {{0, 1}, {1, 3}, {3, 2}, {2, 0}, {4, 5}, {5, 7}, {7, 6}, {6, 4}, {0, 4}, {1, 5}, {2, 6}, {3, 7}}
        };
        for (const auto &edge : edges)
            add_segment(corners[size_t(edge[0])], corners[size_t(edge[1])]);
    }

public:
    explicit GhostRouteGeometry(Gl &api) : gl(api) {
        const char *vertex = R"(#version 330 core
layout(location=0)in vec3 point;layout(location=1)in vec3 other;layout(location=2)in float side;
uniform mat4 projection;uniform vec2 viewport;uniform float width;
void main(){vec4 a=projection*vec4(point,1),b=projection*vec4(other,1);
if(a.w<1e-3){a=a+(b-a)*((1e-3-a.w)/(b.w-a.w));}if(b.w<1e-3){b=b+(a-b)*((1e-3-b.w)/(a.w-b.w));}
vec2 d=b.xy/b.w-a.xy/a.w;d.x*=viewport.x/viewport.y;d=length(d)>1e-6?normalize(d):vec2(1,0);
vec2 n=vec2(-d.y,d.x);n.x*=viewport.y/viewport.x;gl_Position=a+vec4(n*side*width/viewport.y*a.w,0,0);}
)";
        const char *fragment = R"(#version 330 core
uniform vec4 tint;out vec4 color;void main(){color=tint;}
)";
        program = link_program(gl, vertex, fragment);
        projectionLocation = gl.GetUniformLocation(program, "projection");
        colorLocation = gl.GetUniformLocation(program, "tint");
        widthLocation = gl.GetUniformLocation(program, "width");
        viewportLocation = gl.GetUniformLocation(program, "viewport");
        for (auto &mesh : meshes) {
            gl.GenVertexArrays(1, &mesh.vao);
            gl.GenBuffers(1, &mesh.buffer);
            gl.BindVertexArray(mesh.vao);
            gl.BindBuffer(GL_ARRAY_BUFFER, mesh.buffer);
            const int sizes[3] = {3, 3, 1};
            const size_t offsets[3] = {offsetof(Vertex, point), offsetof(Vertex, other), offsetof(Vertex, side)};
            for (GLuint attribute = 0; attribute < 3; ++attribute) {
                gl.EnableVertexAttribArray(attribute);
                gl.VertexAttribPointer(
                        attribute,
                        sizes[attribute],
                        GL_FLOAT,
                        GL_FALSE,
                        sizeof(Vertex),
                        reinterpret_cast<void *>(offsets[attribute])
                );
            }
        }
    }

    ~GhostRouteGeometry() {
        for (auto &mesh : meshes) {
            gl.DeleteBuffers(1, &mesh.buffer);
            gl.DeleteVertexArrays(1, &mesh.vao);
        }
        gl.DeleteProgram(program);
    }

    void upload(unsigned slot, const native_render::GhostPath &path, bool fullPath) {
        vertices.clear();
        add_path(path, fullPath);
        auto &mesh = meshes.at(slot);
        mesh.pathVertices = GLsizei(vertices.size());
        for (const auto &takeoff : path.jumps)
            add_marker(takeoff);
        mesh.markerVertices = GLsizei(vertices.size()) - mesh.pathVertices;
        gl.BindBuffer(GL_ARRAY_BUFFER, mesh.buffer);
        gl.BufferData(GL_ARRAY_BUFFER, vertices.size() * sizeof(Vertex), vertices.data(), GL_STATIC_DRAW);
        vertices.clear();
        vertices.shrink_to_fit();
    }

    void
    draw(unsigned slot,
         const native::Matrix &projection,
         const std::array<float, 3> &color,
         int viewportWidth,
         int viewportHeight,
         float pixelDensity) {
        const auto &mesh = meshes.at(slot);
        if (!mesh.pathVertices && !mesh.markerVertices) return;
        gl.Enable(GL_DEPTH_TEST);
        gl.DepthMask(GL_FALSE);
        gl.Disable(GL_CULL_FACE);
        gl.Enable(GL_BLEND);
        gl.BlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
        gl.UseProgram(program);
        gl.UniformMatrix4fv(projectionLocation, 1, GL_FALSE, projection.data());
        gl.Uniform2f(viewportLocation, float(std::max(viewportWidth, 1)), float(std::max(viewportHeight, 1)));
        gl.BindVertexArray(mesh.vao);
        gl.Uniform1f(widthLocation, path_width_points * pixelDensity);
        const float pathTint[4] = {color[0], color[1], color[2], path_opacity};
        gl.Uniform4fv(colorLocation, 1, pathTint);
        gl.DrawArrays(GL_TRIANGLES, 0, mesh.pathVertices);
        gl.Uniform1f(widthLocation, marker_width_points * pixelDensity);
        const float markerTint[4] = {1, 1, 1, marker_opacity};
        gl.Uniform4fv(colorLocation, 1, markerTint);
        gl.DrawArrays(GL_TRIANGLES, mesh.pathVertices, mesh.markerVertices);
        gl.DepthMask(GL_TRUE);
        gl.Disable(GL_BLEND);
    }
};

class Renderer {
    struct Geometry {
        GLuint vao = 0, vbo = 0, ebo = 0, blend = 0;
        size_t indices = 0;
    };

    struct Volume {
        std::array<float, 3> lo{}, hi{}, color{.2f, .3f, .35f};
        std::array<float, 2> range{0, 400}, span{};
    };

    using ProfileClock = std::chrono::steady_clock;

    struct FrameProfile {
        double lightmapRefresh = 0, lightmapUpload = 0, sky = 0, buildCull = 0, sort = 0, submit = 0, presentation = 0,
               hdrFinish = 0, waterReflection = 0;
        double floorReport = 0, floorDraw = 0, actorDraw = 0, presentationBuild = 0, presentationWaterUniforms = 0,
               presentationSubmit = 0, viewmodel = 0;
        uint64_t groups = 0, survivors = 0, drawCalls = 0, triangles = 0, atlasUpdateBytes = 0, floorCount = 0;
        bool hdrAuthored = false, hdrEffective = false;
        size_t waterVolumes = 0;
    } frameProfile;

    bool profiling = false;

    ProfileClock::time_point profile_now() const {
        return profiling ? ProfileClock::now() : ProfileClock::time_point{};
    }

    void profile_elapsed(double &value, ProfileClock::time_point start) {
        if (profiling) value += std::chrono::duration<double, std::milli>(ProfileClock::now() - start).count();
    }

    Gl &gl;
    BhContext *core;
    Geometry worldMesh, propMesh, skyMesh;
    float fieldOfView = 90;
    std::vector<native_render::Actor> roomActors;
    std::optional<native_render::Actor> replayActor, compareActor;
    std::string outfit, packedLoadout;
    GLuint refractColor = 0, refractDepth = 0;
    int refractWidth = 0, refractHeight = 0, waterQuality = 1;
    bool hasWaterMaterials = false, waterBeneathFaces = false;
    // The Source look's water captures (water_capture.hpp). sceneCaptured: the scene pass being drawn has refraction.
    native_render::WaterCapturePlanner waterPlanner;
    native_render::WaterCapturePlan waterPlan;
    std::unique_ptr<WaterReflectionTarget> waterReflection;
    bool reflectionDrawn = false, sceneCaptured = false;
    static constexpr float no_clip_height = -1e30f;
    float clipHeight = no_clip_height;
    GLuint program = 0, skyProgram = 0, depthProgram = 0, emptyVao = 0, lightmap = 0, white = 0, checker = 0,
           planesTexture = 0;
    std::vector<GLuint> ownedTextures;
    std::unordered_map<uint64_t, GLuint> textures;
    std::unordered_map<int32_t, std::pair<uint32_t, uint32_t>> textureSizes;
    std::unordered_map<int32_t, std::array<float, 3>> textureAverages;
    std::vector<BhGroup> groups, skyGroups;
    std::vector<BhPropGroup> propGroups;
    std::vector<GLuint> normals;
    std::array<float, 3> sunDirection{.35f, .45f, .82f};
    bool hasSun = false;
    std::vector<BhMaterial> materials;
    std::vector<BhMaterialExtra> extras;
    std::vector<Volume> volumes;
    std::array<int32_t, 6> skyMaterials{-1, -1, -1, -1, -1, -1};
    BhSkyInfo skyInfo{};
    bool hasSky = false;
    NativeMapEffects mapEffects;
    std::unique_ptr<NativePresentation> presentation;
    std::unique_ptr<NativeViewmodel> viewmodel;
    bool viewmodelVisible = true, floorWeaponsVisible = true;
    std::optional<uint32_t> viewmodelWeapon;
    std::optional<native_render::Actor> spectatedActor;
    uint32_t spectatedTick = ~0u, spectatedFlags = 0;
    bool spectatedSilenced = false, viewmodelLeftHand = false;
    native_render::EventQueue<unsigned, 32> spectatedAttacks;
    // Source look (source_hdr.hpp): CS:S's exposure and bloom on maps whose lightmap came from HDR lighting.
    BhLightmapInfo lightmapInfo{1, 0};
    bool sourceLook = true, hdrUnavailable = false;
    std::unique_ptr<SourceHdr> hdr;
    double lastSeconds = -1;

    // CS:S's exposure and bloom on maps with HDR lighting: the Source look's own pass, and the first step of the
    // Enhanced and Cinematic looks.
    SourceHdr *hdr_object() {
        if (!sourceLook || graphics.potato || graphics.fullbright || !lightmapInfo.hdr || hdrUnavailable)
            return nullptr;
        if (!hdr) try {
                hdr = std::make_unique<SourceHdr>(gl, emptyVao);
            } catch (const std::exception &e) {
                hdrUnavailable = true;
                std::cerr << "Native HDR unavailable, drawing straight: " << e.what() << '\n';
                return nullptr;
            }
        if (hdr) hdr->bloom = graphics.bloom;
        return hdr.get();
    }

    SourceHdr *hdr_pass() { return graphics.look.composer() ? nullptr : hdr_object(); }

    // The Enhanced and Cinematic looks (enhanced_look.hpp). Potato draws plainly, as on the website.
    std::unique_ptr<EnhancedLook> enhanced;
    bool enhancedUnavailable = false;
    // The pass drawing this frame's world, for the water's refraction copy.
    EnhancedLook *frameLook = nullptr;

    EnhancedLook *enhanced_pass() {
        if (!graphics.look.composer() || graphics.potato || enhancedUnavailable) return nullptr;
        if (!enhanced) try {
                enhanced = std::make_unique<EnhancedLook>(gl, emptyVao);
            } catch (const std::exception &e) {
                enhancedUnavailable = true;
                std::cerr << "Enhanced look unavailable, drawing the Source look: " << e.what() << '\n';
                return nullptr;
            }
        return enhanced.get();
    }

    // The picked sky pack (sky_library.hpp), uploaded once per sky.
    GLuint skyPanorama = 0;
    std::string skyPanoramaId;
    native::SkyPicture skyPanoramaInfo;
    std::string mapName, mapSha;
    native::MapSun mapSun;
    native::SceneSun frameSun;
    // Sun shadows of the composer looks (sun_shadows.hpp), on their own texture unit.
    std::unique_ptr<SunShadowMap> sunShadows;
    GLuint cutoutDepthProgram = 0;
    static constexpr GLint sun_shadow_unit = 11;
    float frameSkyYaw = 0;
    static constexpr GLint sky_panorama_unit = 10;

    bool panorama_drawn() const {
        return graphics.look.composer() && !graphics.potato && graphics.look.sky_mode == native::SkyMode::pack
               && skyPanorama && skyPanoramaId == graphics.look.sky_pack_id;
    }

    static constexpr double paint_second_ns = 1'000'000'000;
    bool toolsVisible = true, paintHeld = false, paintVisible = true;
    std::string paintHeldCode;
    std::string measureLabel;
    native_render::SurfaceToolBindings toolBindings;
    native_render::Paint paint;
    native_render::Measure measure;
    native::GraphicsSettings graphics, chosenGraphics;
    std::optional<native::RunnerView> runnerView;
    std::unique_ptr<GraphicsTarget> graphicsTarget;
    bool anisotropySupported = false;
    uint32_t queuedWeaponFlags = 0, queuedAttackMode = 0;
    bool queuedAttack = false;

    struct UniformNameHash {
        using is_transparent = void;

        size_t operator()(std::string_view name) const { return std::hash<std::string_view>{}(name); }
    };

    using UniformMap = std::unordered_map<std::string, GLint, UniformNameHash, std::equal_to<>>;
    std::unordered_map<GLuint, UniformMap> uniformLocations;

    GLint loc(GLuint p, const char *name) {
        auto &locations = uniformLocations[p];
        const auto found = locations.find(name);
        if (found != locations.end()) return found->second;
        const GLint value = gl.GetUniformLocation(p, name);
        locations.emplace(name, value);
        return value;
    }

    GLuint upload(const BhImage &image, bool repeat, bool mipmap, bool srgb = true) {
        if (!image.rgba || !image.width || !image.height || uint64_t(image.width) * image.height * 4 > image.byte_count)
            throw std::runtime_error("Invalid native texture");
        GLint limit = 0;
        gl.GetIntegerv(GL_MAX_TEXTURE_SIZE, &limit);
        if (image.width > uint32_t(limit) || image.height > uint32_t(limit))
            throw std::runtime_error("Native texture exceeds GPU limit");
        GLuint id = 0;
        gl.GenTextures(1, &id);
        ownedTextures.push_back(id);
        gl.BindTexture(GL_TEXTURE_2D, id);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, mipmap ? GL_LINEAR_MIPMAP_LINEAR : GL_LINEAR);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, repeat ? GL_REPEAT : GL_CLAMP_TO_EDGE);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, repeat ? GL_REPEAT : GL_CLAMP_TO_EDGE);
        gl.PixelStorei(GL_UNPACK_ALIGNMENT, 1);
        gl.TexImage2D(
                GL_TEXTURE_2D,
                0,
                srgb ? GL_SRGB8_ALPHA8 : GL_RGBA8,
                image.width,
                image.height,
                0,
                GL_RGBA,
                GL_UNSIGNED_BYTE,
                image.rgba
        );
        if (mipmap) gl.GenerateMipmap(GL_TEXTURE_2D);
        return id;
    }

    GLuint texture(int32_t index, bool raw = false) {
        if (index < 0) return white;
        const uint64_t key = uint32_t(index) | (uint64_t(raw) << 32);
        const auto found = textures.find(key);
        return found == textures.end() ? checker : found->second;
    }

    ResourceLoading cache_texture(int32_t index, bool raw = false) {
        if (index < 0) co_return;
        const uint64_t key = uint32_t(index) | (uint64_t(raw) << 32);
        if (textures.count(key)) co_return;
        BhImage image{};
        GLuint id = checker;
        if (bh_texture(core, index, &image)) {
            textureSizes[index] = {image.width, image.height};
            std::vector<uint8_t> pixels;
            if (!raw && cutoutTextures.count(index)) {
                pixels.assign(image.rgba, image.rgba + image.byte_count);
                const auto width = image.width, height = image.height;
                std::packaged_task<std::vector<uint8_t>()> prepare(
                        [pixels = std::move(pixels), width, height]() mutable {
                            if (native_render::has_transparent_texels(pixels))
                                native_render::bleed_transparent_texels(pixels, width, height);
                            return std::move(pixels);
                        }
                );
                auto result = prepare.get_future();
                std::thread(std::move(prepare)).detach();
                while (result.wait_for(std::chrono::seconds(0)) != std::future_status::ready)
                    co_yield "cutout pixels";
                pixels = result.get();
            }
            co_yield "upload texture";
            const BhImage prepared{
                    pixels.empty() ? image.rgba : pixels.data(), image.byte_count, image.width, image.height
            };
            id = upload(prepared, true, true, !raw);
            if (!raw) {
                std::array<float, 3> average{};
                const size_t pixels = size_t(image.width) * image.height;
                const size_t step = std::max(size_t(1), pixels / 4096);
                size_t count = 0;
                for (size_t pixel = 0; pixel < pixels; pixel += step) {
                    for (size_t channel = 0; channel < 3; ++channel) {
                        average[channel] += native_render::srgb_linear(float(image.rgba[pixel * 4 + channel]) / 255);
                    }
                    ++count;
                }
                for (auto &channel : average)
                    channel /= std::max(size_t(1), count);
                textureAverages[index] = average;
            }
        }
        textures.emplace(key, id);
    }

    // BhMaterial flags (bunnyhop_core's MAT_TRANSLUCENT, MAT_ALPHATEST).
    static constexpr uint32_t material_translucent = 1, material_alpha_test = 2;
    // Textures a cutout or translucent material reads alpha from (texture_bleed.hpp).
    std::unordered_set<int32_t> cutoutTextures;

    std::string normal_path(std::string name, int depth = 0) {
        if (depth > 6) return {};
        std::transform(name.begin(), name.end(), name.begin(), [](unsigned char c) { return char(std::tolower(c)); });
        std::replace(name.begin(), name.end(), '\\', '/');
        if (name.rfind("materials/", 0) == 0) name.erase(0, 10);
        if (name.ends_with(".vmt")) name.resize(name.size() - 4);
        const std::string path = "materials/" + name + ".vmt";
        size_t count = 0;
        const auto *raw = bh_content_read(core, path.c_str(), &count);
        if (!raw || !count) return {};
        std::string text(reinterpret_cast<const char *>(raw), count);
        text = std::regex_replace(text, std::regex(R"(//[^\r\n]*)"), "");
        if (std::regex_search(text, std::regex(R"("?\$ssbump"?\s+"?1\b)", std::regex::icase))
            || std::regex_search(text, std::regex(R"("?\$bumptransform"?\s+)", std::regex::icase)))
            return {};
        std::smatch match;
        if (std::regex_search(text, match, std::regex(R"rx("?\$bumpmap"?\s+"([^"\r\n]+)")rx", std::regex::icase))) {
            std::string bump = match[1];
            std::transform(bump.begin(), bump.end(), bump.begin(), [](unsigned char c) {
                return char(std::tolower(c));
            });
            std::replace(bump.begin(), bump.end(), '\\', '/');
            if (bump.rfind("materials/", 0) == 0) bump.erase(0, 10);
            if (bump.ends_with(".vtf")) bump.resize(bump.size() - 4);
            return "materials/" + bump + ".vtf";
        }
        if (std::regex_search(text, match, std::regex(R"rx("?include"?\s+"([^"\r\n]+)")rx", std::regex::icase)))
            return normal_path(match[1], depth + 1);
        return {};
    }

    ResourceLoading load_normals() {
        size_t count = 0;
        const char *raw = bh_entities_json(core, &count);
        if (raw && count) {
            const auto entities = nlohmann::json::parse(raw, raw + count);
            for (const auto &e : entities) {
                if (e.value("classname", "") != "light_environment") continue;
                float pitch = 0, yaw = 0, roll = 0;
                std::stringstream angles(e.value("angles", "0 0 0"));
                angles >> pitch >> yaw >> roll;
                if (e.contains("pitch")) try {
                        pitch = std::stof(e.at("pitch").get<std::string>());
                    } catch (...) {
                        break;
                    }
                if (std::isfinite(pitch) && std::isfinite(yaw)) {
                    pitch *= native::radians;
                    yaw *= native::radians;
                    sunDirection = {
                            -std::cos(pitch) * std::cos(yaw), -std::cos(pitch) * std::sin(yaw), -std::sin(pitch)
                    };
                    hasSun = true;
                }
                break;
            }
            mapSun = native::read_map_sun(entities, sunDirection, hasSun);
        }
        normals.resize(materials.size());
        if (!hasSun) co_return;
        raw = bh_material_names_json(core, &count);
        if (!raw || !count) co_return;
        const auto names = nlohmann::json::parse(raw, raw + count);
        std::unordered_map<std::string, GLuint> cached;
        for (size_t i = 0; i < normals.size() && i < names.size(); i++) {
            co_yield "normal texture";
            const auto path = normal_path(names[i]);
            if (path.empty()) continue;
            if (cached.count(path)) {
                normals[i] = cached.at(path);
                continue;
            }
            size_t bytes = 0;
            const auto *vtf = bh_content_read(core, path.c_str(), &bytes);
            if (!vtf || bytes < 64 || vtf[0] != 'V' || vtf[1] != 'T' || vtf[2] != 'F' || vtf[3] != 0) continue;
            const uint32_t f = uint32_t(vtf[52]) | (uint32_t(vtf[53]) << 8) | (uint32_t(vtf[54]) << 16)
                               | (uint32_t(vtf[55]) << 24);
            if (f != 0 && f != 1 && f != 2 && f != 3 && f != 11 && f != 12 && f != 13 && f != 14 && f != 15 && f != 16
                && f != 20)
                continue;
            BhImage image{};
            if (bh_texture_path(core, path.c_str(), &image)) {
                normals[i] = upload(image, true, true, false);
                cached.emplace(path, normals[i]);
            }
        }
        std::cout << "Native embedded normal textures: " << cached.size() << "\n";
    }

    // Upward-facing world water, per cell, for the capture distance and plane choice (water_capture.hpp).
    void load_water_cells(const float *vertices, const uint32_t *indices) {
        constexpr size_t stride = 10, normal_z = 5;
        native_render::WaterCellBuilder builder;
        for (const auto &g : groups) {
            if (g.sky3d || g.model || g.material >= materials.size() || g.material >= extras.size()) continue;
            if (materials[g.material].kind != 2 || !extras[g.material].above_water) continue;
            for (size_t t = g.first_index; t + 2 < size_t(g.first_index) + g.index_count; t += 3) {
                std::array<native_render::Vec3, 3> corners;
                for (int c = 0; c < 3; c++) {
                    const size_t at = size_t(indices[t + c]) * stride;
                    corners[c] = {vertices[at], vertices[at + 1], vertices[at + 2]};
                }
                builder.add_triangle(g.material, corners, vertices[size_t(indices[t]) * stride + normal_z]);
            }
        }
        waterPlanner.load(builder.cells(), materials.size());
    }

    Geometry geometry(
            const float *vertices,
            size_t floats,
            int stride,
            const uint32_t *indices,
            size_t count,
            const float *blend = nullptr,
            size_t blends = 0
    ) {
        Geometry out;
        if (!floats || !count) return out;
        if (!vertices || !indices || floats % stride || count > size_t(std::numeric_limits<GLsizei>::max()))
            throw std::runtime_error("Invalid native geometry buffer");
        for (size_t i = 0; i < count; i++)
            if (indices[i] >= floats / stride) throw std::runtime_error("Native mesh index out of bounds");
        out.indices = count;
        gl.GenVertexArrays(1, &out.vao);
        gl.BindVertexArray(out.vao);
        gl.GenBuffers(1, &out.vbo);
        gl.BindBuffer(GL_ARRAY_BUFFER, out.vbo);
        gl.BufferData(GL_ARRAY_BUFFER, floats * sizeof(float), vertices, GL_STATIC_DRAW);
        gl.GenBuffers(1, &out.ebo);
        gl.BindBuffer(GL_ELEMENT_ARRAY_BUFFER, out.ebo);
        gl.BufferData(GL_ELEMENT_ARRAY_BUFFER, count * sizeof(uint32_t), indices, GL_STATIC_DRAW);
        gl.EnableVertexAttribArray(0);
        gl.VertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, stride * sizeof(float), nullptr);
        if (stride >= 8) {
            for (int i = 1; i < 3; i++) {
                gl.EnableVertexAttribArray(i);
                gl.VertexAttribPointer(
                        i,
                        i == 1 ? 3 : 2,
                        GL_FLOAT,
                        GL_FALSE,
                        stride * sizeof(float),
                        reinterpret_cast<void *>(size_t(i == 1 ? 3 : 6) * sizeof(float))
                );
            }
        }
        if (stride == 10) {
            gl.EnableVertexAttribArray(3);
            gl.VertexAttribPointer(
                    3, 2, GL_FLOAT, GL_FALSE, stride * sizeof(float), reinterpret_cast<void *>(8 * sizeof(float))
            );
        }
        if (blend && blends == floats / stride) {
            gl.GenBuffers(1, &out.blend);
            gl.BindBuffer(GL_ARRAY_BUFFER, out.blend);
            gl.BufferData(GL_ARRAY_BUFFER, blends * sizeof(float), blend, GL_STATIC_DRAW);
            gl.EnableVertexAttribArray(4);
            gl.VertexAttribPointer(4, 1, GL_FLOAT, GL_FALSE, sizeof(float), nullptr);
        }
        return out;
    }

    void destroy(Geometry &mesh) {
        if (mesh.blend) gl.DeleteBuffers(1, &mesh.blend);
        if (mesh.ebo) gl.DeleteBuffers(1, &mesh.ebo);
        if (mesh.vbo) gl.DeleteBuffers(1, &mesh.vbo);
        if (mesh.vao) gl.DeleteVertexArrays(1, &mesh.vao);
    }

    bool transparent(const BhMaterial &m) const {
        return (m.flags & (1 | 8)) || m.kind == 2 || m.kind == 3 || m.alpha < 1;
    }

    // Per-draw uniforms of the world program, looked up once: bind_material runs for every draw of every pass.
    struct MaterialUniforms {
        GLint model = -1, flatColor = -1, hasNormal = -1, hasSecondary = -1, hasDetail = -1, detailScale = -1;
        GLint detailBlend = -1, tint = -1, opacity = -1, cutoff = -1, unlit = -1, props = -1, kind = -1;
        GLint aboveWater = -1, captureReady = -1, waterFogEnd = -1, additive = -1;

        void read(Gl &gl, GLuint program) {
            const std::pair<GLint *, const char *> uniforms[] = {
                    {&model, "model"},
                    {&flatColor, "flatColor"},
                    {&hasNormal, "hasNormal"},
                    {&hasSecondary, "hasSecondary"},
                    {&hasDetail, "hasDetail"},
                    {&detailScale, "detailScale"},
                    {&detailBlend, "detailBlend"},
                    {&tint, "tint"},
                    {&opacity, "opacity"},
                    {&cutoff, "cutoff"},
                    {&unlit, "unlit"},
                    {&props, "props"},
                    {&kind, "kind"},
                    {&aboveWater, "aboveWater"},
                    {&captureReady, "captureReady"},
                    {&waterFogEnd, "waterFogEnd"},
                    {&additive, "additive"},
            };
            for (const auto &[location, name] : uniforms)
                *location = gl.GetUniformLocation(program, name);
        }
    } materialUniforms;

    void bind_material(uint32_t index, bool prop) {
        const BhMaterial fallback = {-1, 1, 0, 1, .5f, {1, 1, 1}};
        const auto &m = index < materials.size() ? materials[index] : fallback;
        if (graphics.potato) {
            const auto found = textureAverages.find(m.texture);
            const std::array<float, 3> fallbackColor = {.5f, .5f, .5f};
            gl.Uniform3fv(
                    materialUniforms.flatColor,
                    1,
                    found == textureAverages.end() ? fallbackColor.data() : found->second.data()
            );
        }
        const BhMaterialExtra empty = {-1, -1, 4, 1, 0, 400, 1};
        const auto &e = index < extras.size() ? extras[index] : empty;
        gl.ActiveTexture(GL_TEXTURE0);
        gl.BindTexture(GL_TEXTURE_2D, m.texture < 0 ? (m.kind == 1 ? checker : white) : texture(m.texture));
        gl.ActiveTexture(GL_TEXTURE2);
        gl.BindTexture(GL_TEXTURE_2D, texture(e.texture2));
        gl.ActiveTexture(GL_TEXTURE3);
        gl.BindTexture(GL_TEXTURE_2D, texture(e.detail, true));
        gl.ActiveTexture(GL_TEXTURE7);
        gl.BindTexture(GL_TEXTURE_2D, index < normals.size() && normals[index] ? normals[index] : white);
        const bool hasNormal = graphics.material_response && index < normals.size() && normals[index];
        gl.Uniform1i(materialUniforms.hasNormal, hasNormal);
        gl.Uniform1i(materialUniforms.hasSecondary, e.texture2 >= 0);
        gl.Uniform1i(materialUniforms.hasDetail, e.detail >= 0 && !graphics.potato);
        gl.Uniform1f(materialUniforms.detailScale, e.detail_scale);
        gl.Uniform1f(materialUniforms.detailBlend, e.detail_blend);
        gl.Uniform3fv(materialUniforms.tint, 1, m.color);
        gl.Uniform1f(materialUniforms.opacity, m.alpha);
        gl.Uniform1f(materialUniforms.cutoff, (m.flags & 2) ? m.alpha_ref : 0);
        gl.Uniform1i(materialUniforms.unlit, (m.flags & 16) != 0 || (!prop && lightmap == white));
        gl.Uniform1i(materialUniforms.props, prop);
        gl.Uniform1i(materialUniforms.kind, m.kind);
        gl.Uniform1i(materialUniforms.aboveWater, e.above_water);
        if (m.kind == 2) {
            gl.Uniform1i(materialUniforms.captureReady, sceneCaptured && waterPlanner.ready(index));
            gl.Uniform1f(materialUniforms.waterFogEnd, std::max(1.f, e.fog_end));
        }
        gl.Uniform1i(materialUniforms.additive, (m.flags & 8) != 0);
        const bool doubleSided = m.kind == 2 ? native_render::water_face_double_sided(waterBeneathFaces, e.above_water)
                                             : (m.flags & 4) != 0;
        if (doubleSided)
            gl.Disable(GL_CULL_FACE);
        else
            gl.Enable(GL_CULL_FACE);
        gl.BlendFunc(GL_SRC_ALPHA, (m.flags & 8) ? GL_ONE : GL_ONE_MINUS_SRC_ALPHA);
        if (m.kind == 2) {
            gl.Enable(GL_POLYGON_OFFSET_FILL);
            gl.PolygonOffset(-1, -4);
        } else
            gl.Disable(GL_POLYGON_OFFSET_FILL);
    }

    int viewportWidth = 1, viewportHeight = 1;
    // Window pixels per point: the route's line widths are in points, like the website's CSS pixels.
    float pixelDensity = 1;

    void water_uniforms(GLuint target, const float eye[3], const native::Matrix &vp) {
        gl.Uniform3fv(loc(target, "cameraPosition"), 1, eye);
        auto &order = waterOrder;
        auto &rects = waterRects;
        order.clear();
        rects.resize(volumes.size());
        for (size_t i = 0; i < volumes.size(); i++)
            if (native_render::screen_rect({volumes[i].lo, volumes[i].hi}, vp, rects[i])) order.push_back(i);
        auto distance = [&](size_t i) {
            float d = 0;
            for (int k = 0; k < 3; k++) {
                const float n = std::max({volumes[i].lo[k] - eye[k], 0.f, eye[k] - volumes[i].hi[k]});
                d += n * n;
            }
            return d;
        };
        std::stable_sort(order.begin(), order.end(), [&](size_t a, size_t b) { return distance(a) < distance(b); });
        if (order.size() > 24) order.resize(24);
        float lo[72]{}, hi[72]{}, color[72]{}, range[48]{}, span[48]{}, rect[96]{};
        for (size_t n = 0; n < order.size(); n++) {
            const auto &v = volumes[order[n]];
            for (int k = 0; k < 4; k++)
                rect[n * 4 + k] = rects[order[n]][k];
            for (int k = 0; k < 3; k++) {
                lo[n * 3 + k] = v.lo[k];
                hi[n * 3 + k] = v.hi[k];
                color[n * 3 + k] = v.color[k];
            }
            for (int k = 0; k < 2; k++) {
                range[n * 2 + k] = v.range[k];
                span[n * 2 + k] = v.span[k];
            }
        }
        gl.Uniform2f(loc(target, "viewportSize"), float(viewportWidth), float(viewportHeight));
        gl.Uniform4fv(loc(target, "waterRect"), GLsizei(order.size()), rect);
        gl.Uniform1i(loc(target, "waterCount"), GLint(order.size()));
        if (!order.empty()) {
            gl.Uniform3fv(loc(target, "waterMin"), order.size(), lo);
            gl.Uniform3fv(loc(target, "waterMax"), order.size(), hi);
            gl.Uniform3fv(loc(target, "waterColor"), order.size(), color);
            gl.Uniform2fv(loc(target, "waterRange"), order.size(), range);
            gl.Uniform2fv(loc(target, "waterSpan"), order.size(), span);
        }
        gl.ActiveTexture(GL_TEXTURE6);
        gl.BindTexture(GL_TEXTURE_2D, planesTexture);
        gl.Uniform1i(loc(target, "waterPlanes"), 6);
    }

    uint64_t refractionCaptures = 0;

    void capture_refraction() {
        ++refractionCaptures;
        GLint read_target = 0, draw_target = 0;
        gl.GetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &read_target);
        gl.GetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &draw_target);
        if (frameLook)
            frameLook->refraction_source();
        else if (auto *hdr = hdr_pass())
            hdr->refraction_source(viewportWidth, viewportHeight);
        else if (graphics.target_needed())
            graphicsTarget->refraction_source();
        for (int i = 0; i < 2; i++) {
            GLuint &id = i ? refractDepth : refractColor;
            if (!id) {
                gl.GenTextures(1, &id);
                ownedTextures.push_back(id);
            }
            gl.ActiveTexture(GL_TEXTURE4 + i);
            gl.BindTexture(GL_TEXTURE_2D, id);
            gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, i ? GL_NEAREST : GL_LINEAR);
            gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, i ? GL_NEAREST : GL_LINEAR);
            gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
            gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
            if (refractWidth != viewportWidth || refractHeight != viewportHeight)
                gl.CopyTexImage2D(
                        GL_TEXTURE_2D, 0, i ? GL_DEPTH_COMPONENT24 : GL_RGBA16F, 0, 0, viewportWidth, viewportHeight, 0
                );
            else
                gl.CopyTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, 0, 0, viewportWidth, viewportHeight);
        }
        refractWidth = viewportWidth;
        refractHeight = viewportHeight;
        gl.BindFramebuffer(GL_READ_FRAMEBUFFER, GLuint(read_target));
        gl.BindFramebuffer(GL_DRAW_FRAMEBUFFER, GLuint(draw_target));
    }

    struct SceneTransform {
        BhTransform value{};
        uint64_t scene = 0;
    };

    // Reused by every scene pass (3D sky, reflection, world) so drawing doesn't allocate each frame.
    native_render::SceneDrawList sceneDrawList;
    std::unordered_map<uint64_t, SceneTransform> sceneTransforms;
    uint64_t sceneNumber = 0;
    std::vector<size_t> waterOrder;
    std::vector<std::array<float, 4>> waterRects;

    const BhTransform &scene_transform(bool prop, int32_t entity, uint32_t model) {
        const uint64_t key = (uint64_t(prop) << 63) | uint32_t(prop ? entity : model);
        auto &cached = sceneTransforms[key];
        if (cached.scene != sceneNumber) {
            cached.value = {};
            cached.value.visible = 1;
            if (prop && entity >= 0)
                bh_prop_transform(core, entity, &cached.value);
            else if (!prop && model)
                bh_model_transform(core, model, &cached.value);
            cached.scene = sceneNumber;
        }
        return cached.value;
    }

    // reflection: the mirrored scene for the water reflection, without the water itself.
    void draw_scene(const native::Matrix &vp, const float eye[3], bool sky, double time, bool reflection = false) {
        auto phaseStart = profile_now();
        sceneCaptured = false;
        gl.UseProgram(program);
        gl.UniformMatrix4fv(loc(program, "viewProjection"), 1, GL_FALSE, vp.data());
        gl.Uniform1f(loc(program, "clipHeight"), clipHeight);
        water_uniforms(program, eye, vp);
        gl.Uniform1f(loc(program, "timeSeconds"), time);
        gl.Uniform1i(loc(program, "reflectionReady"), !sky && !reflection && reflectionDrawn);
        gl.Uniform1f(loc(program, "reflectionHeight"), waterPlan.reflection_height.value_or(0));
        gl.ActiveTexture(GL_TEXTURE8);
        gl.BindTexture(GL_TEXTURE_2D, reflectionDrawn ? waterReflection->texture() : white);
        gl.Uniform1i(loc(program, "fullbright"), graphics.fullbright);
        gl.Uniform1i(loc(program, "potato"), graphics.potato);
        gl.Uniform1i(loc(program, "skyPass"), sky && hasSky && skyInfo.fog_enable);
        gl.Uniform1i(loc(program, "flashlight"), flashlightEnabled && !sky);
        gl.Uniform3f(
                loc(program, "flashDirection"),
                std::cos(lastPitch * native::radians) * std::cos(lastYaw * native::radians),
                std::cos(lastPitch * native::radians) * std::sin(lastYaw * native::radians),
                -std::sin(lastPitch * native::radians)
        );
        float fog[3] = {skyInfo.fog_color[0] / 255.f, skyInfo.fog_color[1] / 255.f, skyInfo.fog_color[2] / 255.f};
        if (skyInfo.fog_blend) {
            const float dx = std::cos(lastPitch * native::radians) * std::cos(lastYaw * native::radians),
                        dy = std::cos(lastPitch * native::radians) * std::sin(lastYaw * native::radians),
                        dz = -std::sin(lastPitch * native::radians);
            const float len = std::hypot(std::hypot(skyInfo.fog_dir[0], skyInfo.fog_dir[1]), skyInfo.fog_dir[2]);
            const float t = len > 0 ? std::clamp(
                                              .5f
                                                      + .5f
                                                                * (dx * skyInfo.fog_dir[0] + dy * skyInfo.fog_dir[1]
                                                                   + dz * skyInfo.fog_dir[2])
                                                                / len,
                                              0.f,
                                              1.f
                                      )
                                    : 0;
            for (int k = 0; k < 3; k++)
                fog[k] = (skyInfo.fog_color[k] * t + skyInfo.fog_color2[k] * (1 - t)) / 255.f;
        }
        gl.Uniform3fv(loc(program, "skyFogColor"), 1, fog);
        gl.Uniform3f(
                loc(program, "skyFogRange"),
                skyInfo.fog_start / std::max(skyInfo.scale, .001f),
                skyInfo.fog_end / std::max(skyInfo.scale, .001f),
                skyInfo.fog_max_density
        );
        gl.ActiveTexture(GL_TEXTURE1);
        gl.BindTexture(GL_TEXTURE_2D, lightmap);
        ++sceneNumber;
        sceneDrawList.begin(groups.size() + propGroups.size());
        auto &draws = sceneDrawList.draws;
        for (const auto &g : groups)
            if (bool(g.sky3d) == sky) sceneDrawList.add({g.material, g.first_index, g.index_count, false, -1, g.model});
        for (const auto &g : propGroups)
            if (bool(g.sky3d) == sky) sceneDrawList.add({g.material, g.first_index, g.index_count, true, g.entity, 0});
        if (profiling) frameProfile.groups += draws.size();
        // Cull transformed bounds before submission; sort translucency from current, transformed centres.
        draws.erase(
                std::remove_if(
                        draws.begin(),
                        draws.end(),
                        [&](native_render::SceneDraw &d) {
                            const auto &transform = scene_transform(d.prop, d.entity, d.model);
                            if (!transform.visible) return true;
                            const auto model = native::model_matrix(transform);
                            const uint64_t key = (uint64_t(d.prop) << 63) | d.first;
                            const auto at = groupBounds.find(key);
                            if (at != groupBounds.end()) {
                                const auto bounds = native_render::transformed_bounds(at->second, model);
                                // The reflection clips away everything below its plane.
                                if (reflection && bounds.hi[2] < clipHeight) return true;
                                std::array<float, 4> rect;
                                if (!native_render::screen_rect(bounds, vp, rect)) return true;
                                for (int k = 0; k < 3; k++) {
                                    const float n = (bounds.lo[k] + bounds.hi[k]) * .5f - eye[k];
                                    d.distance += n * n;
                                }
                            }
                            return false;
                        }
                ),
                draws.end()
        );
        if (profiling) frameProfile.survivors += draws.size();
        profile_elapsed(frameProfile.buildCull, phaseStart);
        const bool visibleWater =
                hasWaterMaterials && std::any_of(draws.begin(), draws.end(), [&](const native_render::SceneDraw &d) {
                    return d.material < materials.size() && materials[d.material].kind == 2;
                });
        for (int pass = 0; pass < 2; pass++) {
            const double sortBefore = frameProfile.sort;
            phaseStart = profile_now();
            if (pass) {
                if (!sky && !reflection && waterPlan.refract && visibleWater) {
                    capture_refraction();
                    sceneCaptured = true;
                }
                gl.Enable(GL_BLEND);
                gl.DepthMask(GL_FALSE);
                auto sortStart = profile_now();
                sceneDrawList.back_to_front();
                profile_elapsed(frameProfile.sort, sortStart);
            } else {
                gl.Disable(GL_BLEND);
                gl.DepthMask(GL_TRUE);
            }
            for (const auto &d : draws) {
                const auto &m = d.material < materials.size() ? materials[d.material] : materials.front();
                if (transparent(m) != (pass != 0) || (reflection && m.kind == 2)) continue;
                const auto &transform = scene_transform(d.prop, d.entity, d.model);
                if (!transform.visible) continue;
                const auto model = native::model_matrix(transform);
                gl.UniformMatrix4fv(materialUniforms.model, 1, GL_FALSE, model.data());
                bind_material(d.material, d.prop);
                gl.BindVertexArray(d.prop ? propMesh.vao : worldMesh.vao);
                gl.DrawElements(
                        GL_TRIANGLES,
                        d.count,
                        GL_UNSIGNED_INT,
                        reinterpret_cast<void *>(uintptr_t(d.first) * sizeof(uint32_t))
                );
                if (profiling) {
                    frameProfile.drawCalls++;
                    frameProfile.triangles += d.count / 3;
                }
            }
            profile_elapsed(frameProfile.submit, phaseStart);
            if (profiling) frameProfile.submit -= frameProfile.sort - sortBefore;
        }
        gl.DepthMask(GL_TRUE);
        gl.Disable(GL_POLYGON_OFFSET_FILL);
        gl.Disable(GL_BLEND);
    }

    double lastYaw = 0, lastPitch = 0;
    std::unordered_map<uint64_t, std::array<float, 3>> centers;
    std::unordered_map<uint64_t, native_render::Bounds> groupBounds;
    native_render::GhostTrails ghostTrails;
    std::array<native_render::GhostPath, 4> ghostPaths;
    native_render::GhostOptions ghostOptions;
    std::unique_ptr<GhostRouteGeometry> ghostRoutes;
    std::array<bool, 4> routeAvailable{true, true, true, true};
    std::array<float, 3> ghostRouteColor{1, .761f, .239f};
    std::array<std::array<float, 3>, 2> trailColors{{{1, .761f, .239f}, {1, .761f, .239f}}};

    struct QueuedShot {
        BhAttackReport report;
        native_render::ShotBasis basis;
        // Another player's shot: its flash is drawn here, not by the viewmodel.
        bool remote = false;
    };

    struct ShotEffect {
        BhAttackReport report;
        native_render::ShotBasis basis;
        double started;
        bool remote = false;
    };

    native_render::EventQueue<QueuedShot, 128> attackEvents;
    std::vector<ShotEffect> shotEffects;

    struct Overlay {
        int entity = -1, model = -1;
        uint32_t kind = 0, flags = 0;
        std::vector<std::array<native_render::Vec3, 3>> triangles;
    };

    std::vector<Overlay> overlays;
    bool overlaysLoaded = false;
    std::vector<BhZone> timerZones;
    BhRunState zoneState{};
    uint32_t activeZoneTrack = 0;
    bool zonesVisible = true, effectsVisible = true, triggersVisible = false, clipsVisible = false,
         flashlightEnabled = false;
    native::ZoneEffects zoneEffects;
    native::SemanticPalette semanticPalette = native::semantic_palette("off");
    bool zoneGold = false;

    void load_overlays() {
        if (overlaysLoaded) return;
        overlaysLoaded = true;
        size_t overlayBytes = 0;
        const auto *overlayJson = bh_overlay_json(core, &overlayBytes);
        if (overlayJson && overlayBytes) {
            const auto json = nlohmann::json::parse(overlayJson, overlayJson + overlayBytes);
            for (const auto &raw : json) {
                Overlay o;
                o.kind = raw.value("kind", 0u);
                o.flags = raw.value("flags", 0u);
                if (raw.contains("entity") && !raw["entity"].is_null()) o.entity = raw["entity"];
                if (raw.contains("model") && !raw["model"].is_null()) o.model = raw["model"];
                std::vector<native_render::Plane> planes;
                for (const auto &p : raw.value("planes", nlohmann::json::array()))
                    if (p.size() == 4) planes.push_back({p[0], p[1], p[2], p[3]});
                o.triangles = native_render::convex_triangles(planes);
                if (!o.triangles.empty()) overlays.push_back(std::move(o));
            }
        }
    }

    void draw_presentation(const native::Matrix &vp, const float eye[3], double seconds) {
        auto presentationStart = profile_now();
        presentation->clear();
        const float cy = std::cos(lastYaw * native::radians), sy = std::sin(lastYaw * native::radians),
                    cp = std::cos(lastPitch * native::radians), sp = std::sin(lastPitch * native::radians);
        const native_render::Vec3 right = {sy, -cy, 0}, up = {sp * cy, sp * sy, cp};
        zoneEffects.frame(zoneState.status, zoneState.track, seconds, zoneGold);
        if (zonesVisible)
            for (size_t zi = 0; zi < timerZones.size(); ++zi) {
                const auto &z = timerZones[zi];
                const auto base = semanticPalette.zones[z.kind >= 2 ? 4 : z.kind + (z.track ? 2 : 0)];
                auto color = zoneEffects.color(zi, base, seconds);
                const float level = zoneEffects.level(zi);
                const float f = z.mins[2] + .5f,
                            h = std::min(
                                    std::max(1.f, z.maxs[2] - z.mins[2]), std::max(24.f, (z.maxs[2] - z.mins[2]) * .4f)
                            );
                const native_render::Vec3 corners[4] = {
                        {{z.mins[0], z.mins[1], f}},
                        {{z.maxs[0], z.mins[1], f}},
                        {{z.maxs[0], z.maxs[1], f}},
                        {{z.mins[0], z.maxs[1], f}}
                };
                for (int i = 0; i < 4; i++) {
                    const auto &a = corners[i], &b = corners[(i + 1) % 4];
                    presentation->ribbon(a, b, .45f, {base[0], base[1], base[2], .9f}, eye);
                    if (level > 0 && (b[1] - a[1]) * (eye[0] - a[0]) - (b[0] - a[0]) * (eye[1] - a[1]) > 0) {
                        auto hi = a, hb = b;
                        hi[2] += h;
                        hb[2] += h;
                        color[3] = .42f * level;
                        presentation->quad({a, b, hb, hi}, color, 3);
                    }
                }
            }
        for (const auto &event : attackEvents.take()) {
            if (shotEffects.size() == 128) shotEffects.erase(shotEffects.begin());
            shotEffects.push_back({event.report, event.basis, seconds, event.remote});
        }
        shotEffects.erase(
                std::remove_if(
                        shotEffects.begin(),
                        shotEffects.end(),
                        [&](const auto &e) { return seconds - e.started > 3 || seconds < e.started; }
                ),
                shotEffects.end()
        );
        if (effectsVisible)
            for (const auto &e : shotEffects) {
                const float age = float(seconds - e.started);
                const auto &r = e.report;
                if (r.weapon <= 1) continue;
                const auto from = e.basis.muzzle;
                native_render::Vec3 to{};
                for (int k = 0; k < 3; k++)
                    to[k] = r.end[k];
                if (age < .065f) {
                    presentation->ribbon(from, to, .4f, {1, .78f, .35f, (1 - age / .065f) * .65f}, eye);
                    if (!viewmodelVisible || e.remote)
                        presentation->billboard(from, 4.5f, {1, .7f, .2f, 1 - age / .065f}, right, up);
                }
                if (r.hit) {
                    native_render::Vec3 impact{};
                    for (int k = 0; k < 3; k++)
                        impact[k] = r.end[k] + r.normal[k] * .2f;
                    presentation->billboard(
                            impact, 2.2f, {.12f, .10f, .08f, std::min(1.f, (3 - age) * 2) * .8f}, right, up
                    );
                    if (age < .25f)
                        for (uint32_t i = 0; i < 4; i++) {
                            auto p = impact;
                            for (int k = 0; k < 3; k++)
                                p[k] += (native_render::particle_random(i, k) * 2 - 1) * age * 35
                                        + r.normal[k] * age * 20;
                            p[2] -= age * age * 80;
                            presentation->billboard(p, .65f, {1, .65f, .2f, 1 - age / .25f}, right, up);
                        }
                }
                if (age < 1.1f) {
                    auto shell = from;
                    shell[0] += e.basis.right[0] * age * 70;
                    shell[1] += e.basis.right[1] * age * 70;
                    shell[2] += age * 30 - age * age * 160;
                    presentation->billboard(shell, .65f, {.75f, .52f, .17f, 1}, right, up, false);
                }
            }
        if (effectsVisible && !graphics.potato && ghostOptions.trail) {
            if (replayActor) draw_ghost_trail(*replayActor, eye);
            for (const auto &actor : roomActors) {
                if (actor.ghost_slot >= 0) draw_ghost_trail(actor, eye);
            }
        }
        draw_ghost_route(vp);
        if (paintVisible) paint.draw(core, *presentation);
        if (toolsVisible) measure.draw(core, *presentation, eye);
        // Overlay kinds follow crates/core/src/game/overlay.rs: 0-3 are triggers
        // (!showtriggers), 4 player clips and 5 invisible walls (!showclips).
        if (triggersVisible || clipsVisible) {
            size_t count = 0;
            const auto *states = bh_overlay_states(core, &count);
            const auto &colors = semanticPalette.triggers;
            for (const auto &o : overlays) {
                if (!(o.kind >= 4 ? clipsVisible : triggersVisible)) continue;
                if (o.entity >= 0) {
                    if (!states || size_t(o.entity) >= count || !(states[o.entity] & 1)) continue;
                    if ((o.flags & 1) && (states[o.entity] & 2)) continue;
                }
                BhTransform t{};
                t.visible = 1;
                if (o.model > 0) bh_model_transform(core, uint32_t(o.model), &t);
                const auto model = native::model_matrix(t);
                const auto &c = colors[std::min(o.kind, 5u)];
                for (const auto &triangle : o.triangles) {
                    const auto a = native_render::transform_point(model, triangle[0]),
                               b = native_render::transform_point(model, triangle[1]),
                               c0 = native_render::transform_point(model, triangle[2]);
                    presentation->quad({a, b, c0, c0}, {c[0], c[1], c[2], .12f});
                }
            }
        }
        draw_map_effects(eye, seconds, right, up);
        profile_elapsed(frameProfile.presentationBuild, presentationStart);
        presentationStart = profile_now();
        gl.UseProgram(presentation->shader());
        water_uniforms(presentation->shader(), eye, vp);
        profile_elapsed(frameProfile.presentationWaterUniforms, presentationStart);
        presentationStart = profile_now();
        presentation->draw(vp, eye);
        profile_elapsed(frameProfile.presentationSubmit, presentationStart);
    }

    void draw_ghost_trail(const native_render::Actor &actor, const float eye[3]) {
        if (actor.ghost_slot < 0 || actor.ghost_slot >= int(ghostPaths.size())) return;
        const auto &path = ghostPaths[size_t(actor.ghost_slot)];
        if (!path.enabled || !ghostOptions.visible(path.source)) return;
        const auto points = ghostTrails.recorded(path, actor.frame.tick);
        auto colors = trailColors;
        if (path.source != native_render::GhostSource::pb) {
            colors.fill(native_render::ghost_source_color(path.source));
        }
        for (size_t i = 1; i < points.size(); ++i) {
            const float progress = float(i) / float(points.size() - 1);
            const auto &point = points[i];
            const float distance = std::hypot(std::hypot(eye[0] - point[0], eye[1] - point[1]), eye[2] - point[2]);
            const auto color = native_render::trail_color(colors, progress, actor.opacity, distance);
            presentation->ribbon(points[i - 1], point, 2.5f * (.15f + .85f * progress), color, eye);
        }
    }

    void draw_ghost_route(const native::Matrix &projection) {
        if (!ghostOptions.route || !ghostRoutes) return;
        int selected = -1;
        for (size_t slot = 0; slot < ghostPaths.size(); ++slot) {
            const auto &path = ghostPaths[slot];
            if (!routeAvailable[slot] || !path.enabled || path.frames.empty() || !ghostOptions.visible(path.source))
                continue;
            if (ghostOptions.route_source != native_render::GhostSource::none
                && path.source != ghostOptions.route_source)
                continue;
            if (selected < 0
                || native_render::route_priority(path.source)
                           < native_render::route_priority(ghostPaths[size_t(selected)].source))
                selected = int(slot);
        }
        if (selected < 0) return;
        const auto &path = ghostPaths[size_t(selected)];
        const auto color = path.source == native_render::GhostSource::pb
                                   ? ghostRouteColor
                                   : native_render::ghost_source_color(path.source);
        ghostRoutes->draw(unsigned(selected), projection, color, viewportWidth, viewportHeight, pixelDensity);
    }

    void draw_map_effects(
            const float eye[3], double seconds, const native_render::Vec3 &right, const native_render::Vec3 &up
    ) {
        mapEffects.draw(*presentation, core, eye, seconds, right, up, effectsVisible && !graphics.potato);
    }

public:
    nlohmann::json graphics_limits() const {
        GLint maximumSamples = 0;
        gl.GetIntegerv(GL_MAX_SAMPLES, &maximumSamples);
        float maximumAnisotropy = 1;
        if (anisotropySupported) gl.GetFloatv(0x84ff, &maximumAnisotropy);
        return {{"msaaMax", std::min(8, maximumSamples)},
                {"anisotropyMax", maximumAnisotropy},
                {"waterReflections", false},
                {"models", {"bunny"}},
                {"msaaRestartRequired", false}};
    }

    nlohmann::json surface_tools_state() {
        return {{"paintMarks", paint.count()},
                {"measurePoints", measure.count()},
                {"measurement", measure.count() == 2 ? nlohmann::json(measure.text(core)) : nlohmann::json(nullptr)}};
    }

    const char *
    surface_tool(std::string_view action, const BhState &state, const native::Input &input, bool held = false) {
        if (action == "clearPaint") {
            paint.clear();
            return "Paint cleared.";
        }
        if (action == "clearMeasure") {
            measure.clear();
            return "Measurement cleared.";
        }
        const bool painting = action == "paint" || action == "paintOnce";
        if (painting && !paint.request(double(SDL_GetTicksNS()) / paint_second_ns, held)) return "Paint mark skipped.";
        const native_render::Vec3 eye = {state.position[0], state.position[1], state.position[2] + state.view_offset_z};
        const auto hit = native_render::pick_surface(core, eye, input.yaw(), input.pitch);
        if (!hit) return "No surface in range. Aim at a nearby wall or floor.";
        if (action == "measurePoint") {
            measure.pick(core, *hit);
            return measure.text(core);
        }
        return paint.stamp(core, *hit, held) ? "Paint mark placed." : "Paint mark skipped.";
    }

    const char *tool_key(
            std::string_view code,
            bool down,
            bool repeat,
            const BhState &state,
            const native::Input &input,
            bool can_paint
    ) {
        if (!down && code == paintHeldCode) {
            paintHeld = false;
            paintHeldCode.clear();
        }
        const int action = toolBindings.match(code);
        if (action < 0) return nullptr;
        if (action < 2 && !can_paint) {
            paintHeld = false;
            return nullptr;
        }
        if (action == 0 && down && !repeat) {
            paintHeld = true;
            paintHeldCode = code;
        }
        if (!down || repeat) return nullptr;
        return surface_tool(native_render::SurfaceToolBindings::actions[size_t(action)], state, input);
    }

    void surface_tools_frame(const BhState &state, const native::Input &input, bool active, bool spectating) {
        paintVisible = !spectating;
        if (!active) {
            paintHeld = false;
            paintHeldCode.clear();
            return;
        }
        const double seconds = double(SDL_GetTicksNS()) / paint_second_ns;
        if (paintHeld && paint.ready(seconds, true)) {
            surface_tool("paint", state, input, true);
        }
    }

    std::string
    tool_message(const nlohmann::json &message, const BhState &state, const native::Input &input, bool can_paint) {
        const auto type = message.at("type").get<std::string>();
        const auto action = message.at("action").get<std::string>();
        if (type == "paint" && action != "clear" && !can_paint)
            return "Paint is unavailable while spectating or watching a replay.";
        if (action != "clear" && action != (type == "paint" ? "stamp" : "point")) {
            throw std::runtime_error("Unknown surface tool action");
        }
        const auto bound = type == "paint" ? (action == "clear" ? "clearPaint" : "paintOnce")
                                           : (action == "clear" ? "clearMeasure" : "measurePoint");
        return surface_tool(bound, state, input, message.value("held", false));
    }

    uint64_t refraction_captures() const { return refractionCaptures; }

    native::GraphicsView output_view(int width, int height) const {
        return native::graphics_view(graphics, width, height);
    }

    const native::GraphicsSettings &current_graphics() const { return graphics; }

    template <class Hud>
    void draw_measure_label(Hud &hud, const native::Matrix &vp, const float eye[3], int width, int height) {
        if (!toolsVisible || measure.count() != 2) return;
        const auto points = measure.positions(core);
        if (!points) return;
        native_render::Vec3 midpoint{};
        for (int axis = 0; axis < 3; ++axis)
            midpoint[axis] = ((*points)[0][axis] + (*points)[1][axis]) * .5f;
        float fraction = 0;
        if (!bh_trace_camera(core, eye, midpoint.data(), 0, &fraction) || fraction < .995f) return;
        float clip[4]{};
        for (int row = 0; row < 4; ++row) {
            clip[row] = vp[row] * midpoint[0] + vp[4 + row] * midpoint[1] + vp[8 + row] * midpoint[2] + vp[12 + row];
        }
        if (clip[3] <= 0 || std::abs(clip[0]) > clip[3] || std::abs(clip[1]) > clip[3]) return;
        measureLabel.assign(measure.text(core));
        hud.overlay_begin(width, height, 100);
        const auto view = native::graphics_view(graphics, width, height);
        hud.overlay_text(
                view.x + (clip[0] / clip[3] * .5f + .5f) * view.output_width,
                height - view.y - (clip[1] / clip[3] * .5f + .5f) * view.output_height,
                measureLabel,
                13,
                {1, 1, 1, 1},
                true
        );
        hud.overlay_end(width, height);
    }

    const native_render::GhostPath &ghost_path(unsigned slot) const { return ghostPaths.at(slot); }

    void set_ghost_path(unsigned slot, native_render::GhostPath path) {
        if (slot >= ghostPaths.size()) throw std::runtime_error("Invalid ghost slot");
        path.build_route();
        ghostPaths[slot] = std::move(path);
        if (ghostRoutes) ghostRoutes->upload(slot, ghostPaths[slot], ghostOptions.route_path);
    }

    void route_context(uint32_t track, const std::string &style, bool visible) {
        for (size_t slot = 0; slot < ghostPaths.size(); ++slot) {
            const auto &path = ghostPaths[slot];
            routeAvailable[slot] = visible && path.track == track
                                   && (path.source == native_render::GhostSource::custom || path.style == style);
        }
    }

    void clear_ghosts() {
        for (auto &path : ghostPaths)
            path = {};
    }

    void register_ghost(
            unsigned slot,
            uint32_t handle,
            const nlohmann::json &info,
            native_render::GhostSource source = native_render::GhostSource::custom
    ) {
        if (slot >= ghostPaths.size()) throw std::runtime_error("Invalid ghost slot");
        native_render::GhostPath path;
        path.load(core, handle, info, source);
        ghostPaths[slot] = std::move(path);
        if (ghostRoutes) ghostRoutes->upload(slot, ghostPaths[slot], ghostOptions.route_path);
    }

    void ghost_enabled(unsigned slot, bool enabled) {
        if (slot < ghostPaths.size()) ghostPaths[slot].enabled = enabled;
    }

    bool ghost_visible(unsigned slot) const {
        return slot < ghostPaths.size() && ghostPaths[slot].enabled && ghostOptions.visible(ghostPaths[slot].source);
    }

    const std::string &ghost_name(unsigned slot) const { return ghostPaths.at(slot).name; }

    const std::string &ghost_loadout(unsigned slot) const { return ghostPaths.at(slot).loadout; }

    void decorate_ghost(native_render::Actor &actor, unsigned slot) const {
        if (slot >= ghostPaths.size()) return;
        actor.ghost_slot = int(slot);
        actor.source = ghostPaths[slot].source;
        actor.near_fade = ghostOptions.near_fade;
        // As on the website: your PB ghost follows your loadout unless its replay carries one; other ghosts hold the
        // default carrot.
        if (actor.source == native_render::GhostSource::pb && actor.loadout.empty()) actor.loadout = packedLoadout;
        actor.tint = actor.source == native_render::GhostSource::pb ? ghostRouteColor
                                                                    : native_render::ghost_source_color(actor.source);
    }

    bool tag_visible(bool ghost) const { return ghost || graphics.tags_players; }

    bool tags_through_walls() const { return graphics.tags_through_walls; }

    void set_profiling(bool enabled) { profiling = enabled; }

    nlohmann::json profile_json() const {
        const auto &p = frameProfile;
        return {{"lightmapRefreshMs", p.lightmapRefresh},
                {"lightmapUploadMs", p.lightmapUpload},
                {"skyMs", p.sky},
                {"waterReflectionMs", p.waterReflection},
                {"drawSceneBuildCullMs", p.buildCull},
                {"drawSceneSortMs", p.sort},
                {"drawSceneSubmitMs", p.submit},
                {"presentationMs", p.presentation},
                {"floorReportMs", p.floorReport},
                {"floorDrawMs", p.floorDraw},
                {"floorCount", p.floorCount},
                {"actorDrawMs", p.actorDraw},
                {"presentationBuildMs", p.presentationBuild},
                {"presentationWaterUniformsMs", p.presentationWaterUniforms},
                {"presentationSubmitMs", p.presentationSubmit},
                {"viewmodelMs", p.viewmodel},
                {"hdrFinishMs", p.hdrFinish},
                {"groups", p.groups},
                {"survivors", p.survivors},
                {"drawCalls", p.drawCalls},
                {"triangles", p.triangles},
                {"atlasUpdateBytes", p.atlasUpdateBytes},
                {"hdrAuthored", p.hdrAuthored},
                {"hdrEffective", p.hdrEffective},
                {"waterVolumes", p.waterVolumes}};
    }

    void set_actor_models(const std::string &player, const std::string &ghost) {
        if (viewmodel) viewmodel->actor_models(player, ghost);
    }

    void set_player_glow(std::optional<native_render::Glow> glow) {
        if (viewmodel) viewmodel->player_glow(std::move(glow));
    }

    void set_glow_visible(bool show, bool firstPerson) {
        if (viewmodel) viewmodel->glow_visibility(show, firstPerson);
    }

    void set_ghost_cosmetics(const std::string &ghostId, const std::string &trailId) {
        if (viewmodel) {
            viewmodel->ghost_cosmetics(ghostId);
            trailColors = viewmodel->cosmetic_colors(trailId);
            ghostRouteColor = viewmodel->cosmetic_colors(ghostId)[0];
        }
    }

    void set_zones(const std::vector<BhZone> &zones) {
        timerZones = zones;
        zoneEffects.clear();
        for (const auto &z : zones)
            zoneEffects.add(z.kind, z.track);
        zoneGold = false;
    }

    void set_zone_state(uint32_t track, const BhRunState &state, bool gold = false) {
        activeZoneTrack = track;
        zoneState = state;
        zoneGold = gold;
    }

    void set_color_blind(const std::string &mode) { semanticPalette = native::semantic_palette(mode); }

    void set_zones_visible(bool value) { zonesVisible = value; }

    void set_triggers_visible(bool value) {
        if (value) load_overlays();
        triggersVisible = value;
    }

    void set_clips_visible(bool value) {
        if (value) load_overlays();
        clipsVisible = value;
    }

    void set_effects_visible(bool value) { effectsVisible = value; }

    nlohmann::json water_diagnostics() const {
        auto out = nlohmann::json::array();
        for (const auto &v : volumes)
            out.push_back({{"mins", v.lo}, {"maxs", v.hi}, {"color", v.color}, {"fogRange", v.range}});
        return out;
    }

    void set_water_quality(int value) { waterQuality = std::clamp(value, 0, 1); }

    void set_flashlight(bool value) { flashlightEnabled = value; }

    void set_viewmodel_bob(float value) {
        if (viewmodel) viewmodel->set_bob(value);
    }

    ResourceLoading loading;

    Renderer(
            Gl &g,
            BhContext *c,
            const std::filesystem::path &assetRoot = BUNNYHOP_NATIVE_ASSET_ROOT,
            bool deferred = false,
            std::unique_ptr<NativeViewmodel> prepared_viewmodel = {}
    )
        : gl(g)
        , core(c) {
        viewmodel = std::move(prepared_viewmodel);
        loading = prepare_resources(assetRoot);
        if (!deferred) {
            while (!poll_loading()) {
            }
        }
    }

    bool poll_loading() {
        constexpr auto frame_budget = std::chrono::milliseconds(2);
        const auto start = std::chrono::steady_clock::now();
        do {
            if (loading.step()) return true;
        } while (std::chrono::steady_clock::now() - start < frame_budget);
        return false;
    }

    void prepare_fallback_textures() {
        gl.GenVertexArrays(1, &emptyVao);
        const uint8_t blank[4] = {255, 255, 255, 255};
        white = upload({blank, 4, 1, 1}, true, false);
        uint8_t fallback[8 * 8 * 4];
        for (int y = 0; y < 8; y++)
            for (int x = 0; x < 8; x++) {
                const uint8_t v = ((x / 4 + y / 4) % 2) ? 140 : 185;
                const int at = (y * 8 + x) * 4;
                fallback[at] = fallback[at + 1] = fallback[at + 2] = v;
                fallback[at + 3] = 255;
            }
        checker = upload({fallback, sizeof(fallback), 8, 8}, true, true);
    }

    void record_group_bounds(
            uint64_t key,
            uint32_t first,
            uint32_t count,
            const float *v,
            size_t floats,
            int stride,
            const uint32_t *ix,
            size_t n
    ) {
        if (uint64_t(first) + count > n) throw std::runtime_error("Native draw range exceeds index buffer");
        native_render::Bounds bounds;
        bounds.lo.fill(1e30f);
        bounds.hi.fill(-1e30f);
        for (size_t i = first; i < size_t(first) + count; i++) {
            const size_t at = size_t(ix[i]) * stride;
            if (at + 2 >= floats) throw std::runtime_error("Native group vertex invalid");
            for (int k = 0; k < 3; k++) {
                bounds.lo[k] = std::min(bounds.lo[k], v[at + k]);
                bounds.hi[k] = std::max(bounds.hi[k], v[at + k]);
            }
        }
        std::array<float, 3> mid{};
        for (int k = 0; k < 3; k++)
            mid[k] = (bounds.lo[k] + bounds.hi[k]) * .5f;
        centers[key] = mid;
        groupBounds[key] = bounds;
    }

    ResourceLoading prepare_world() {
        size_t nv = 0, ni = 0, ng = 0, nm = 0, ne = 0, nb = 0;
        const float *verts = bh_vertices(core, &nv);
        const uint32_t *indices = bh_indices(core, &ni);
        const auto *rawGroups = bh_groups(core, &ng);
        const auto *rawMaterials = bh_materials(core, &nm);
        const auto *rawExtras = bh_material_extras(core, &ne);
        const float *blend = bh_blend(core, &nb);
        if (!nv || !ni || !ng || !rawGroups) throw std::runtime_error("Map has no drawable native mesh");
        if (rawMaterials && nm) materials.assign(rawMaterials, rawMaterials + nm);
        if (materials.empty()) materials.push_back({-1, 1, 0, 1, .5f, {1, 1, 1}});
        if (rawExtras && ne) extras.assign(rawExtras, rawExtras + ne);
        groups.assign(rawGroups, rawGroups + ng);
        hasWaterMaterials =
                std::any_of(materials.begin(), materials.end(), [](const BhMaterial &m) { return m.kind == 2; });
        for (size_t i = 0; i < materials.size() && i < extras.size(); i++)
            waterBeneathFaces |= materials[i].kind == 2 && !extras[i].above_water;
        co_yield "geometry";
        worldMesh = geometry(verts, nv, 10, indices, ni, blend, nb);
        co_yield "resource";
        for (const auto &item : groups) {
            record_group_bounds(item.first_index, item.first_index, item.index_count, verts, nv, 10, indices, ni);
            co_yield "resource";
        }
    }

    ResourceLoading prepare_props() {
        size_t pv = 0, pi = 0, pg = 0;
        const float *propVertices = bh_prop_vertices(core, &pv);
        const auto *propIndices = bh_prop_indices(core, &pi);
        const auto *rawProps = bh_prop_groups(core, &pg);
        propMesh = geometry(propVertices, pv, 8, propIndices, pi);
        if (rawProps && pg) propGroups.assign(rawProps, rawProps + pg);
        co_yield "resource";
        for (const auto &item : propGroups) {
            record_group_bounds(
                    (uint64_t(1) << 63) | item.first_index,
                    item.first_index,
                    item.index_count,
                    propVertices,
                    pv,
                    8,
                    propIndices,
                    pi
            );
            co_yield "resource";
        }
    }

    void prepare_sky() {
        size_t sv = 0, si = 0, sg = 0;
        const float *skyVertices = bh_sky_vertices(core, &sv);
        const auto *skyIndices = bh_sky_indices(core, &si);
        const auto *rawSky = bh_sky_groups(core, &sg);
        skyMesh = geometry(skyVertices, sv, 3, skyIndices, si);
        if (rawSky && sg) skyGroups.assign(rawSky, rawSky + sg);
        hasSky = bh_sky_info(core, &skyInfo) != 0;
        size_t skyCount = 0;
        const auto *sky = bh_sky_materials(core, &skyCount);
        if (sky && skyCount == 6) std::copy(sky, sky + 6, skyMaterials.begin());
        // The atlas is sRGB-encoded linear light times its scale (bunnyhop_core::lightmap): decode, then divide.
        BhImage image{};
        lightmap = bh_lightmap(core, &image) ? upload(image, false, false, true) : white;
        if (lightmap == white || !bh_lightmap_info(core, &lightmapInfo)) lightmapInfo = {1, 0};
    }

    ResourceLoading prepare_textures() {
        for (const auto &m : materials)
            if (m.flags & (material_translucent | material_alpha_test)) cutoutTextures.insert(m.texture);
        co_yield "resource";
        for (const auto &m : materials) {
            auto texture_loading = cache_texture(m.texture);
            while (!texture_loading.step())
                co_yield "texture";
            co_yield "texture";
        }
        for (const auto &e : extras) {
            auto secondary_loading = cache_texture(e.texture2);
            while (!secondary_loading.step())
                co_yield "secondary texture";
            auto detail_loading = cache_texture(e.detail, true);
            while (!detail_loading.step())
                co_yield "detail texture";
        }
    }

    std::vector<native_render::WaterSurface> water_surfaces(const float *verts, const uint32_t *indices) {
        std::vector<native_render::WaterSurface> waterSurfaces;
        for (const auto &g : groups) {
            if (g.material >= materials.size() || materials[g.material].kind != 2 || g.material >= extras.size()
                || !extras[g.material].above_water)
                continue;
            for (size_t t = g.first_index; t < size_t(g.first_index) + g.index_count; t += 3) {
                const size_t a = size_t(indices[t]) * 10, b = size_t(indices[t + 1]) * 10,
                             d = size_t(indices[t + 2]) * 10;
                if (verts[a + 5] < .9f) continue;
                native_render::WaterSurface surface;
                for (int k = 0; k < 3; k++) {
                    surface.center[k] = (verts[a + k] + verts[b + k] + verts[d + k]) / 3;
                    surface.color[k] = materials[g.material].color[k];
                }
                surface.range = {extras[g.material].fog_start, extras[g.material].fog_end};
                if (!(surface.range[1] > surface.range[0])) surface.range = {0, 400};
                waterSurfaces.push_back(surface);
            }
        }
        return waterSurfaces;
    }

    void upload_water_planes(std::vector<float> planes) {
        if (planes.empty()) planes.resize(4);
        GLint limit = 0;
        gl.GetIntegerv(GL_MAX_TEXTURE_SIZE, &limit);
        if (planes.size() / 4 > size_t(limit)) throw std::runtime_error("Native water plane texture exceeds GPU size");
        gl.GenTextures(1, &planesTexture);
        gl.BindTexture(GL_TEXTURE_2D, planesTexture);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
        gl.TexImage2D(GL_TEXTURE_2D, 0, GL_RGBA32F, planes.size() / 4, 1, 0, GL_RGBA, GL_FLOAT, planes.data());
    }

    ResourceLoading prepare_water() {
        size_t vertex_count = 0, index_count = 0;
        const auto *verts = bh_vertices(core, &vertex_count);
        const auto *indices = bh_indices(core, &index_count);
        const auto waterSurfaces = water_surfaces(verts, indices);
        co_yield "resource";
        load_water_cells(verts, indices);
        co_yield "resource";
        std::vector<float> planes;
        size_t waterBytes = 0;
        const auto *water = bh_water_json(core, &waterBytes);
        if (water && waterBytes) {
            const auto json = nlohmann::json::parse(water, water + waterBytes);
            const auto boxes = json.value("volumes", nlohmann::json::array()),
                       allPlanes = json.value("planes", nlohmann::json::array());
            for (size_t i = 0; i < boxes.size(); i++) {
                if (boxes[i].size() != 6) continue;
                Volume volume;
                for (int k = 0; k < 3; k++) {
                    volume.lo[k] = boxes[i][k];
                    volume.hi[k] = boxes[i][k + 3];
                }
                volume.span[0] = planes.size() / 4;
                if (i < allPlanes.size())
                    for (const auto &p : allPlanes[i])
                        if (p.size() == 4)
                            for (int k = 0; k < 4; k++)
                                planes.push_back(p[k].get<float>());
                volume.span[1] = planes.size() / 4 - volume.span[0];
                if (const auto *surface = native_render::water_surface({volume.lo, volume.hi}, waterSurfaces)) {
                    volume.color = surface->color;
                    volume.range = surface->range;
                }
                volumes.push_back(volume);
            }
        }
        upload_water_planes(std::move(planes));
    }

    void prepare_uniforms() {
        gl.UseProgram(program);
        gl.Uniform1i(loc(program, "baseTexture"), 0);
        gl.Uniform1i(loc(program, "lightTexture"), 1);
        gl.Uniform1i(loc(program, "secondaryTexture"), 2);
        gl.Uniform1i(loc(program, "detailTexture"), 3);
        gl.Uniform1i(loc(program, "sceneColor"), 4);
        gl.Uniform1i(loc(program, "sceneDepth"), 5);
        gl.Uniform1i(loc(program, "reflectionTexture"), 8);
        gl.Uniform2f(loc(program, "cameraNearFar"), native::camera_near_plane, native::camera_far_plane);
        gl.Uniform1f(loc(program, "lightmapScale"), lightmapInfo.scale);
    }

    ResourceLoading prepare_scene() {
        prepare_fallback_textures();
        auto world = prepare_world();
        while (!world.step())
            co_yield "world geometry";
        auto props = prepare_props();
        while (!props.step())
            co_yield "prop geometry";
        prepare_sky();
        co_yield "lightmap";
        auto textures = prepare_textures();
        while (!textures.step())
            co_yield "texture";
        auto water = prepare_water();
        while (!water.step())
            co_yield "water";
        prepare_uniforms();
    }

    void print_geometry() {
        size_t nv = 0, pv = 0, sv = 0;
        bh_vertices(core, &nv);
        bh_prop_vertices(core, &pv);
        bh_sky_vertices(core, &sv);
        std::cout << "Native renderer: " << nv / 10 << " BSP vertices, " << pv / 8 << " prop vertices, " << sv / 3
                  << " sky vertices, " << volumes.size() << " water volumes, 3D sky=" << hasSky << "\n";
    }

    ResourceLoading prepare_resources(std::filesystem::path assetRoot) {
        measureLabel.reserve(100);
        program = link_program(gl, native_render::world_vertex, native_render::world_fragment().c_str());
        materialUniforms.read(gl, program);
        co_yield "world shader";
        skyProgram = link_program(gl, native_render::sky_vertex, native_render::sky_fragment().c_str());
        depthProgram = link_program(gl, native_render::depth_vertex, native_render::depth_fragment);
        co_yield "sky shader";
        auto scene = prepare_scene();
        while (!scene.step())
            co_yield "scene";
        co_yield "normals";
        auto normal_loading = load_normals();
        while (!normal_loading.step())
            co_yield "normal texture";
        co_yield "resource";
        gl.UseProgram(program);
        gl.Uniform1i(loc(program, "normalTexture"), 7);
        gl.Uniform3fv(loc(program, "sunDirection"), 1, sunDirection.data());
        sunShadows = std::make_unique<SunShadowMap>(gl);
        cutoutDepthProgram = link_program(gl, native_render::cutout_depth_vertex, native_render::cutout_depth_fragment);
        gl.UseProgram(program);
        gl.Uniform1i(loc(program, "sunShadowMap"), sun_shadow_unit);
        gl.Uniform1i(loc(program, "sunActive"), 0);
        presentation = std::make_unique<NativePresentation>(gl);
        mapEffects.load(core);

        anisotropySupported = SDL_GL_ExtensionSupported("GL_EXT_texture_filter_anisotropic");
        co_yield "viewmodel";
        if (viewmodel)
            viewmodel->prepare_graphics();
        else
            viewmodel = std::make_unique<NativeViewmodel>(gl, assetRoot);
        co_yield "resource";
        gl.Enable(GL_DEPTH_TEST);
        gl.DepthFunc(GL_LEQUAL);
        gl.CullFace(GL_BACK);
        gl.FrontFace(GL_CCW);
        print_geometry();
    }

    ~Renderer() {
        loading = {};
        ghostRoutes.reset();
        graphicsTarget.reset();
        presentation.reset();
        hdr.reset();
        viewmodel.reset();
        destroy(worldMesh);
        destroy(propMesh);
        destroy(skyMesh);
        if (!ownedTextures.empty()) gl.DeleteTextures(ownedTextures.size(), ownedTextures.data());
        if (planesTexture) gl.DeleteTextures(1, &planesTexture);
        if (emptyVao) gl.DeleteVertexArrays(1, &emptyVao);
        if (program) gl.DeleteProgram(program);
        if (skyProgram) gl.DeleteProgram(skyProgram);
        if (depthProgram) gl.DeleteProgram(depthProgram);
        if (cutoutDepthProgram) gl.DeleteProgram(cutoutDepthProgram);
    }

    // A replay watched in the runner's view: their shape and fit over the viewer's own graphics settings.
    void use_runner_view(const std::optional<native::RunnerView> &view) {
        if (view == runnerView) return;
        runnerView = view;
        graphics = runnerView ? native::runner_view_graphics(chosenGraphics, *runnerView) : chosenGraphics;
    }

    void graphics_settings(const nlohmann::json &settings) {
        chosenGraphics = native::GraphicsSettings::read(settings);
        graphics = runnerView ? native::runner_view_graphics(chosenGraphics, *runnerView) : chosenGraphics;
        const bool previousRoute = ghostOptions.route, previousPath = ghostOptions.route_path;
        ghostOptions.read(settings);
        if (ghostOptions.route) {
            if (!ghostRoutes) ghostRoutes = std::make_unique<GhostRouteGeometry>(gl);
            if (!previousRoute || previousPath != ghostOptions.route_path) {
                for (unsigned slot = 0; slot < ghostPaths.size(); ++slot) {
                    ghostRoutes->upload(slot, ghostPaths[slot], ghostOptions.route_path);
                }
            }
        }
        paint.settings(settings);
        toolBindings.read(settings);
        toolsVisible = settings.value("hud", true);
        hdr_pass();
        // The looks' passes link with the settings (at map load or when the look changes), never in a run's frame.
        enhanced_pass();
        if (graphics.target_needed() && !graphicsTarget)
            graphicsTarget = std::make_unique<GraphicsTarget>(gl, emptyVao);
        sourceLook = graphics.source;
        if (hdr) hdr->bloom = graphics.bloom;
        if (anisotropySupported) {
            constexpr GLenum anisotropy = 0x84fe, maximumAnisotropy = 0x84ff;
            float maximum = 1;
            gl.GetFloatv(maximumAnisotropy, &maximum);
            for (GLuint texture : ownedTextures) {
                gl.BindTexture(GL_TEXTURE_2D, texture);
                gl.TexParameterf(GL_TEXTURE_2D, anisotropy, std::min(float(graphics.anisotropy), maximum));
            }
        }
    }

    // The Source look on or off (the Plain look). The Enhanced and Cinematic looks build on the Source look.
    void set_source_look(bool value) {
        sourceLook = value;
        if (!value)
            graphics.look.look = native::Look::classic;
        else if (graphics.look.look == native::Look::classic)
            graphics.look.look = native::Look::source;
    }

    // The map's name and build hash, for the looks' per-map lighting profiles (look_settings.hpp).
    void set_map_identity(std::string name, std::string sha) {
        mapName = std::move(name);
        mapSha = std::move(sha);
    }

    // The sky pack to draw when the look shows one (sky_library.hpp). Uploads once per sky.
    void use_sky(const std::string &id, const native::SkyPicture *picture) {
        if (id == skyPanoramaId || !picture || picture->pixels.empty()) return;
        if (!skyPanorama) {
            gl.GenTextures(1, &skyPanorama);
            ownedTextures.push_back(skyPanorama);
        }
        gl.BindTexture(GL_TEXTURE_2D, skyPanorama);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_REPEAT);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
        gl.PixelStorei(GL_UNPACK_ALIGNMENT, 2);
        gl.TexImage2D(
                GL_TEXTURE_2D,
                0,
                GL_RGB16F,
                picture->width,
                picture->height,
                0,
                GL_RGB,
                GL_HALF_FLOAT,
                picture->pixels.data()
        );
        gl.PixelStorei(GL_UNPACK_ALIGNMENT, 4);
        skyPanoramaInfo.width = picture->width;
        skyPanoramaInfo.height = picture->height;
        skyPanoramaInfo.lighting = picture->lighting;
        skyPanoramaInfo.rotation = picture->rotation;
        skyPanoramaInfo.exposure = picture->exposure;
        skyPanoramaId = id;
    }

    void set_pixel_density(float value) { pixelDensity = std::isfinite(value) && value > 0 ? value : 1; }

    // Current Source-look exposure (1 off maps with HDR lighting or with the look off).
    float exposure() const { return hdr && sourceLook && lightmapInfo.hdr ? hdr->current_exposure() : 1; }

    // Scope FOV is presentation only; persisted player FOV remains 60–130.
    void set_camera_fov(float value) {
        if (std::isfinite(value)) fieldOfView = std::clamp(value, 15.f, 130.f);
    }

    void set_fov(float value) {
        if (std::isfinite(value)) fieldOfView = std::clamp(value, 60.f, 130.f);
    }

    void set_viewmodel(
            float fov = 54,
            float x = .6f,
            float y = 1.5f,
            float z = -.9f,
            bool left = false,
            bool visible = true,
            float bob = 1,
            float sway = 1
    ) {
        viewmodelLeftHand = left;
        viewmodelVisible = visible;
        if (viewmodel) {
            viewmodel->settings(fov, x, y, z, left);
            viewmodel->set_bob(bob);
            viewmodel->set_sway(sway);
        }
    }

    void reset_presentation() {
        spectatedAttacks.clear();
        spectatedFlags = 0;
        lastSeconds = -1;
        if (hdr) hdr->reset();
        ghostTrails.clear();
        mapEffects.reset();
        attackEvents.clear();
        shotEffects.clear();
        queuedWeaponFlags = queuedAttackMode = 0;
        queuedAttack = false;
        if (viewmodel) viewmodel->reset_presentation();
    }

    // The first-person inspect's sound cues heard since the last clear.
    std::span<const native_render::InspectCue> inspect_cues() const {
        return viewmodel ? viewmodel->inspect_cues().cues() : std::span<const native_render::InspectCue>();
    }

    void clear_inspect_cues() {
        if (viewmodel) viewmodel->inspect_cues().clear();
    }

    void inspect_press() {
        if (viewmodel) viewmodel->inspect_press();
    }

    void inspect_held(bool value) {
        if (viewmodel) viewmodel->inspect_held(value);
    }

    void set_cosmetics(const std::string &value, const std::string &loadout) {
        outfit = value;
        packedLoadout = loadout;
        if (viewmodel) viewmodel->cosmetics(value, loadout);
    }

    void set_replay_actor(const BhSnapshot *snapshot, float yaw, float pitch, float opacity = .45f) {
        if (!snapshot) {
            replayActor.reset();
            return;
        }
        native_render::Actor actor;
        actor.id = "replay";
        actor.name = "Replay";
        actor.opacity = std::clamp(opacity, 0.f, 1.f);
        for (int i = 0; i < 3; i++) {
            actor.frame.position[i] = snapshot->player.position[i];
            actor.frame.velocity[i] = snapshot->player.velocity[i];
        }
        actor.frame.yaw = yaw;
        actor.frame.pitch = pitch;
        actor.frame.tick = snapshot->player.tick;
        actor.frame.flags = (snapshot->player.crouched ? 1 : 0) | (snapshot->player.grounded ? 2 : 0);
        actor.frame.weapon = 1;
        actor.outfit = outfit;
        actor.loadout = packedLoadout;
        decorate_ghost(actor, 0);
        replayActor = actor;
    }

    void set_replay_actor(
            const BhGhostFrame &frame, const std::string &actorOutfit, const std::string &loadout, float opacity = .45f
    ) {
        native_render::Actor actor;
        actor.id = "replay";
        actor.name = "Replay";
        actor.frame = frame;
        actor.outfit = actorOutfit;
        actor.loadout = loadout;
        actor.opacity = opacity;
        decorate_ghost(actor, 0);
        replayActor = std::move(actor);
    }

    void set_compare_actor(const native_render::Actor *actor) {
        if (!actor) {
            compareActor.reset();
            return;
        }
        if (!compareActor) compareActor.emplace();
        *compareActor = *actor;
    }

    void set_room_actors(const std::vector<native_render::Actor> &actors) {
        roomActors = actors;
        if (roomActors.size() > 64) roomActors.resize(64);
        for (const auto &actor : roomActors)
            queue_remote_shot(actor);
    }

    // Another player's shot (net/players.ts shot): a tracer along their view from their gun's muzzle (as posed last
    // frame) to where it meets the world here, with the flash and the impact.
    void queue_remote_shot(const native_render::Actor &actor) {
        constexpr float shot_range_units = 8192;
        constexpr float standing_eye_units = 64, crouched_eye_units = 46;
        if (actor.attack != 1 || actor.frame.weapon < 2 || actor.id.starts_with("ghost-")) return;
        const bool crouched = actor.frame.flags & 1;
        const float pitch = actor.frame.pitch * float(native::radians), yaw = actor.frame.yaw * float(native::radians);
        const native_render::Vec3 forward = {
                std::cos(pitch) * std::cos(yaw), std::cos(pitch) * std::sin(yaw), -std::sin(pitch)
        };
        float eye[3] = {actor.frame.position[0], actor.frame.position[1], actor.frame.position[2]};
        eye[2] += crouched ? crouched_eye_units : standing_eye_units;
        float far[3];
        for (int k = 0; k < 3; ++k)
            far[k] = eye[k] + forward[k] * shot_range_units;
        float fraction = 1;
        if (!bh_trace_camera(core, eye, far, 0, &fraction)) fraction = 1;
        BhAttackReport report{};
        report.weapon = actor.frame.weapon;
        report.hit = fraction < 1;
        for (int k = 0; k < 3; ++k) {
            report.start[k] = eye[k];
            report.end[k] = eye[k] + forward[k] * shot_range_units * fraction;
            report.normal[k] = -forward[k];
        }
        native_render::Vec3 from = remote_muzzle(actor, forward, crouched);
        auto basis = native_render::shot_basis(from, {report.end[0], report.end[1], report.end[2]}, false);
        basis.muzzle = from;
        attackEvents.push({report, basis, true});
    }

    // The muzzle of the bunny's posed gun, else about where it would be (in front of the right hip).
    native_render::Vec3
    remote_muzzle(const native_render::Actor &actor, const native_render::Vec3 &forward, bool crouched) const {
        if (viewmodel)
            if (const auto muzzle = viewmodel->actor_muzzle(actor.id)) return *muzzle;
        constexpr float ahead_units = 26, side_units = 7, standing_hand_units = 46, crouched_hand_units = 30;
        const float flat = std::hypot(forward[0], forward[1]);
        const float length = flat > 0 ? flat : 1;
        const native_render::Vec3 right = {forward[1] / length, -forward[0] / length, 0};
        native_render::Vec3 out{};
        for (int k = 0; k < 2; ++k)
            out[k] = actor.frame.position[k] + forward[k] / length * ahead_units + right[k] * side_units;
        out[2] = actor.frame.position[2] + (crouched ? crouched_hand_units : standing_hand_units);
        return out;
    }

    native::Matrix camera(const float eye[3], double yaw, double pitch, float aspect) {
        if (graphics.aspect > 0) aspect = graphics.aspect;
        auto vp = native::camera_matrix(eye, yaw, pitch, aspect);
        const float scale = 1 / std::tan(float(fieldOfView * native::radians * .5));
        for (int c = 0; c < 4; c++) {
            vp[c * 4] *= scale;
            vp[c * 4 + 1] *= scale;
        }
        return vp;
    }

    void set_spectated_actor(std::optional<native_render::Actor> actor) {
        const bool changed =
                bool(actor) != bool(spectatedActor) || (actor && spectatedActor && actor->id != spectatedActor->id);
        if (changed) {
            spectatedTick = ~0u;
            spectatedFlags = 0;
            spectatedAttacks.clear();
            if (viewmodel) {
                viewmodel->reset_presentation();
                if (!actor) viewmodel->inspect_held(false);
            }
        }
        if (actor) { /* Actor pulses are already fenced by RoomState, independently of interpolated pose ticks. */
            if (viewmodel && actor->inspect) viewmodel->inspect_press();
            if (actor->attack) spectatedAttacks.push(actor->attack);
            if (spectatedTick != ~0u && actor->silenced != spectatedSilenced) spectatedFlags |= 256;
            spectatedTick = actor->frame.tick;
            spectatedSilenced = actor->silenced;
            if (viewmodel) viewmodel->inspect_held(actor->inspectHeld);
        }
        spectatedActor = std::move(actor);
    }

    void set_viewmodel_weapon(std::optional<uint32_t> value) { viewmodelWeapon = value; }

    void set_viewmodel_visible(bool value) { viewmodelVisible = value; }

    void set_floor_weapons_visible(bool value) { floorWeaponsVisible = value; }

    void simulation_tick() {
        BhWeaponReport weapon{};
        BhAttackReport attack{};
        if (bh_weapon_report(core, &weapon)) queuedWeaponFlags |= weapon.flags;
        if (bh_attack_report(core, &attack)) {
            queuedAttack = true;
            queuedAttackMode = attack.mode;
            attackEvents.push(
                    {attack,
                     native_render::shot_basis(
                             {attack.start[0], attack.start[1], attack.start[2]},
                             {attack.end[0], attack.end[1], attack.end[2]},
                             viewmodelLeftHand
                     )}
            );
        }
    }

    // Geometry/materials remain tied to the loaded map; playback may supply another context of that map.
    void set_simulation_context(BhContext *context) {
        if (!context) throw std::runtime_error("Null renderer simulation context");
        core = context;
        reset_presentation();
    }

    // Source look with Water reflections, like the website's SOURCE_WATER. The native Water: Refracted setting still
    // refracts in either look.
    bool water_reflections_enabled() const { return sourceLook && graphics.water_reflections && !graphics.potato; }

    bool water_captures_enabled() const {
        return hasWaterMaterials && !graphics.potato && (water_reflections_enabled() || waterQuality > 0);
    }

    void plan_water(const float eye[3], const native::Matrix &vp) {
        reflectionDrawn = false;
        if (!water_captures_enabled()) {
            waterPlanner.clear();
            waterPlan = {};
            return;
        }
        waterPlan = waterPlanner.plan({eye[0], eye[1], eye[2]}, vp);
        if (!water_reflections_enabled()) waterPlan.reflection_height.reset();
    }

    void sky_panorama_uniforms() {
        static constexpr std::array<float, 3> default_sun{.45f, .6f, .35f};
        const auto sun = hasSun ? sunDirection : default_sun;
        const float length = std::hypot(std::hypot(sun[0], sun[1]), sun[2]);
        gl.Uniform3f(loc(skyProgram, "proceduralSun"), sun[0] / length, sun[1] / length, sun[2] / length);
        const bool shown = panorama_drawn();
        gl.Uniform1i(loc(skyProgram, "panoramaShown"), shown);
        gl.Uniform1f(loc(skyProgram, "panoramaYaw"), frameSkyYaw);
        gl.Uniform1f(loc(skyProgram, "panoramaExposure"), skyPanoramaInfo.exposure);
        gl.ActiveTexture(GL_TEXTURE0 + sky_panorama_unit);
        gl.BindTexture(GL_TEXTURE_2D, shown ? skyPanorama : white);
        gl.Uniform1i(loc(skyProgram, "panorama"), sky_panorama_unit);
        gl.ActiveTexture(GL_TEXTURE0);
    }

    // The 2D skybox, or the procedural sky, behind everything. mirrored: as the water reflection sees it.
    void draw_sky_backdrop(const float eye[3], const native::Matrix &vp, float aspect, bool mirrored) {
        static constexpr const char *face_uniforms[6] = {"sky0", "sky1", "sky2", "sky3", "sky4", "sky5"};
        gl.Disable(GL_BLEND);
        gl.Disable(GL_CULL_FACE);
        gl.Disable(GL_DEPTH_TEST);
        gl.DepthMask(GL_FALSE);
        gl.UseProgram(skyProgram);
        gl.BindVertexArray(emptyVao);
        water_uniforms(skyProgram, eye, vp);
        const float cy = std::cos(lastYaw * native::radians), sy = std::sin(lastYaw * native::radians),
                    cp = std::cos(lastPitch * native::radians), sp = std::sin(lastPitch * native::radians);
        const float flip = mirrored ? -1.f : 1.f;
        gl.Uniform3f(loc(skyProgram, "forward"), cp * cy, cp * sy, -sp * flip);
        gl.Uniform3f(loc(skyProgram, "right"), sy, -cy, 0);
        gl.Uniform3f(loc(skyProgram, "up"), sp * cy, sp * sy, cp * flip);
        gl.Uniform1f(loc(skyProgram, "skyExposure"), graphics.sky_exposure);
        gl.Uniform1f(loc(skyProgram, "aspect"), aspect);
        gl.Uniform1f(loc(skyProgram, "cot"), (4.f / 3.f) / std::tan(float(fieldOfView * native::radians * .5)));
        GLint present[6]{}, half[6]{};
        // Procedural daylight (Enhanced and Cinematic) draws the fallback sky in place of the map's faces.
        const bool procedural = graphics.look.composer() && graphics.look.sky_mode == native::SkyMode::procedural;
        for (int i = 0; i < 6; i++) {
            GLuint id = white;
            const int32_t m = procedural ? -1 : skyMaterials[i];
            if (m >= 0 && size_t(m) < materials.size()) {
                const auto t = materials[m].texture;
                if (t >= 0 && texture(t) != checker) {
                    id = texture(t);
                    present[i] = 1;
                    const auto wh = textureSizes[t];
                    half[i] = i < 4 && wh.first == wh.second * 2;
                }
            }
            gl.ActiveTexture(GL_TEXTURE0 + i);
            gl.BindTexture(GL_TEXTURE_2D, id);
            gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
            gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
            gl.Uniform1i(loc(skyProgram, face_uniforms[i]), i);
        }
        gl.Uniform1iv(loc(skyProgram, "skyPresent"), 6, present);
        gl.Uniform1iv(loc(skyProgram, "skyHalf"), 6, half);
        sky_panorama_uniforms();
        if (!graphics.potato) gl.DrawArrays(GL_TRIANGLES, 0, 3);
        gl.Enable(GL_DEPTH_TEST);
        gl.DepthMask(GL_TRUE);
        gl.DepthFunc(GL_LEQUAL);
    }

    // The 3D skybox (sky_camera) around its origin. mirror_height: the water reflection's plane in world units.
    void draw_3d_sky(const float eye[3], float aspect, double seconds, std::optional<float> mirror_height = {}) {
        if (!hasSky || graphics.potato || skyInfo.scale <= 0) return;
        float skyEye[3];
        for (int k = 0; k < 3; k++)
            skyEye[k] = skyInfo.origin[k] + eye[k] / skyInfo.scale;
        auto vp = camera(skyEye, lastYaw, lastPitch, aspect);
        if (mirror_height) {
            const float skyHeight = skyInfo.origin[2] + *mirror_height / skyInfo.scale;
            vp = native::multiply(vp, native_render::mirror_matrix(skyHeight));
            skyEye[2] = 2 * skyHeight - skyEye[2];
            clipHeight = skyHeight;
        }
        draw_scene(vp, skyEye, true, seconds, mirror_height.has_value());
        gl.Clear(GL_DEPTH_BUFFER_BIT);
    }

    // Sky brush faces only write depth, so the world behind them stays hidden as in Source.
    void draw_sky_depth(const native::Matrix &vp) {
        if (!skyMesh.vao) return;
        gl.Disable(GL_BLEND);
        gl.DepthMask(GL_TRUE);
        gl.UseProgram(depthProgram);
        gl.UniformMatrix4fv(loc(depthProgram, "viewProjection"), 1, GL_FALSE, vp.data());
        gl.Uniform1f(loc(depthProgram, "clipHeight"), clipHeight);
        gl.ColorMask(GL_FALSE, GL_FALSE, GL_FALSE, GL_FALSE);
        gl.Disable(GL_CULL_FACE);
        gl.Enable(GL_POLYGON_OFFSET_FILL);
        gl.PolygonOffset(1, 2);
        gl.BindVertexArray(skyMesh.vao);
        for (const auto &item : skyGroups) {
            if (item.sky3d) continue;
            BhTransform t{};
            t.visible = 1;
            if (item.model) bh_model_transform(core, item.model, &t);
            if (!t.visible) continue;
            const auto model = native::model_matrix(t);
            gl.UniformMatrix4fv(loc(depthProgram, "model"), 1, GL_FALSE, model.data());
            const auto first = reinterpret_cast<void *>(uintptr_t(item.first_index) * sizeof(uint32_t));
            gl.DrawElements(GL_TRIANGLES, item.index_count, GL_UNSIGNED_INT, first);
        }
        gl.ColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
        gl.Disable(GL_POLYGON_OFFSET_FILL);
    }

    struct SunTerms {
        bool active = false, shadows = false;
        float direct = 0, fill = 0, baked = 1, strength = 0;
    };

    // How strongly the profile's sun and sky light the map (web composer-pipeline.ts renderFrame's SunShadows).
    SunTerms sun_terms() const {
        SunTerms terms;
        const auto &look = graphics.look;
        if (!look.composer() || graphics.potato || graphics.fullbright || !frameSun.present) return terms;
        const auto profile = visual_profile();
        terms.fill = std::clamp(profile.sky_fill * std::clamp(look.ambient_contribution, 0.f, 2.f), 0.f, .3f);
        terms.shadows = look.dynamic_shadows;
        terms.active = terms.shadows || terms.fill > 0;
        if (!terms.shadows) return terms;
        terms.direct = std::clamp(profile.sun_direct * std::clamp(look.direct_contribution, 0.f, 2.f), 0.f, 2.f);
        terms.baked = std::clamp(profile.baked_scale, .4f, 1.f);
        terms.strength = std::clamp(look.shadow_strength, 0.f, .4f);
        return terms;
    }

    // Whether a material casts into the sun's depth map: solid, or cut out by its texture's alpha (leaves, fences).
    enum class Caster { none, solid, cutout };

    Caster caster(uint32_t material) const {
        static constexpr uint32_t additive = 8;
        if (material >= materials.size()) return Caster::none;
        const auto &m = materials[material];
        if (m.kind == 2 || m.kind == 3 || (m.flags & additive)) return Caster::none;
        return (m.flags & (material_translucent | material_alpha_test)) || m.alpha < 1 ? Caster::cutout : Caster::solid;
    }

    void cast_group(
            const Geometry &mesh,
            bool prop,
            uint32_t material,
            uint32_t first,
            uint32_t count,
            int32_t entity,
            uint32_t model,
            const native::Matrix &lightVp,
            float range,
            bool cutouts
    ) {
        static constexpr float cutout_alpha = .5f;
        const auto kind = caster(material);
        if (kind == Caster::none || (kind == Caster::cutout) != cutouts) return;
        const auto &transform = scene_transform(prop, entity, model);
        if (!transform.visible) return;
        const auto matrix = native::model_matrix(transform);
        const auto bounds = groupBounds.find((uint64_t(prop) << 63) | first);
        if (bounds != groupBounds.end() && !native_render::in_light_box(bounds->second, matrix, lightVp, range)) return;
        const GLuint shader = cutouts ? cutoutDepthProgram : depthProgram;
        if (cutouts) {
            const auto &m = materials[material];
            gl.BindTexture(GL_TEXTURE_2D, m.texture < 0 ? white : texture(m.texture));
            gl.Uniform1f(loc(shader, "cutoff"), (m.flags & material_alpha_test) ? m.alpha_ref : cutout_alpha);
        }
        gl.BindVertexArray(mesh.vao);
        gl.UniformMatrix4fv(loc(shader, "model"), 1, GL_FALSE, matrix.data());
        gl.DrawElements(GL_TRIANGLES, count, GL_UNSIGNED_INT, reinterpret_cast<void *>(uintptr_t(first) * 4));
    }

    // World groups, props and players into the sun's depth map: solid surfaces, then cut-outs by their alpha.
    void draw_shadow_casters(const native::Matrix &lightVp, float range, const float eye[3], double seconds) {
        ++sceneNumber;
        for (const bool cutouts : {false, true}) {
            const GLuint shader = cutouts ? cutoutDepthProgram : depthProgram;
            gl.UseProgram(shader);
            gl.UniformMatrix4fv(loc(shader, "viewProjection"), 1, GL_FALSE, lightVp.data());
            if (!cutouts) gl.Uniform1f(loc(shader, "clipHeight"), no_clip_height);
            gl.ActiveTexture(GL_TEXTURE0);
            gl.Uniform1i(loc(shader, "baseTexture"), 0);
            for (const auto &g : groups)
                if (!g.sky3d)
                    cast_group(
                            worldMesh,
                            false,
                            g.material,
                            g.first_index,
                            g.index_count,
                            -1,
                            g.model,
                            lightVp,
                            range,
                            cutouts
                    );
            for (const auto &g : propGroups)
                if (!g.sky3d)
                    cast_group(
                            propMesh,
                            true,
                            g.material,
                            g.first_index,
                            g.index_count,
                            g.entity,
                            0,
                            lightVp,
                            range,
                            cutouts
                    );
        }
        if (!viewmodel) return;
        for (const auto &actor : roomActors)
            if (actor.ghost_slot < 0) viewmodel->draw_actor(actor, lightVp, eye, seconds);
    }

    // The sun's depth map around the camera and the world shader's sun terms for this frame.
    void prepare_sun_light(const float eye[3], double seconds) {
        static constexpr float shadow_bias = .0003f;
        const auto terms = sun_terms();
        gl.UseProgram(program);
        gl.Uniform1i(loc(program, "sunActive"), terms.active);
        if (!terms.active) return;
        gl.Uniform1i(loc(program, "sunShadowActive"), terms.shadows);
        gl.Uniform1f(loc(program, "sunSkyFill"), terms.fill);
        gl.Uniform1f(loc(program, "sunBakedScale"), terms.baked);
        gl.Uniform1f(loc(program, "sunDirectStrength"), terms.direct);
        gl.Uniform1f(loc(program, "sunShadowStrength"), terms.strength);
        gl.Uniform3fv(loc(program, "sunLightDirection"), 1, frameSun.direction.data());
        const auto &color = !frameSun.from_pack && terms.direct > 0 ? mapSun.irradiance : frameSun.color;
        gl.Uniform3fv(loc(program, "sunLightColor"), 1, color.data());
        gl.Uniform3fv(loc(program, "sunAmbientColor"), 1, frameSun.ambient.data());
        if (!terms.shadows) return;
        const int size = graphics.look.shadow_size;
        const float range = std::clamp(graphics.look.shadow_distance, 256.f, 4096.f);
        const auto lightVp = sun_view_projection({eye[0], eye[1], eye[2]}, frameSun.direction, range, size);
        GLint drawTarget = 0, readTarget = 0;
        gl.GetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &drawTarget);
        gl.GetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &readTarget);
        sunShadows->begin(size);
        gl.Disable(GL_BLEND);
        gl.Disable(GL_CULL_FACE);
        gl.Enable(GL_DEPTH_TEST);
        gl.Enable(GL_POLYGON_OFFSET_FILL);
        gl.PolygonOffset(2, 4);
        draw_shadow_casters(lightVp, range, eye, seconds);
        gl.Disable(GL_POLYGON_OFFSET_FILL);
        gl.BindFramebuffer(GL_DRAW_FRAMEBUFFER, GLuint(drawTarget));
        gl.BindFramebuffer(GL_READ_FRAMEBUFFER, GLuint(readTarget));
        gl.UseProgram(program);
        gl.UniformMatrix4fv(loc(program, "sunShadowMatrix"), 1, GL_FALSE, lightVp.data());
        gl.Uniform1f(loc(program, "sunShadowTexel"), 1.f / float(size));
        gl.Uniform1f(loc(program, "sunShadowRadius"), size <= 512 ? 1.f : 2.f);
        gl.Uniform1f(loc(program, "sunShadowBias"), shadow_bias);
        gl.ActiveTexture(GL_TEXTURE0 + sun_shadow_unit);
        gl.BindTexture(GL_TEXTURE_2D, sunShadows->texture());
        gl.ActiveTexture(GL_TEXTURE0);
    }

    native::VisualProfile visual_profile() const {
        return native::resolve_visual_profile(graphics.look, mapName, mapSha, mapSun.present);
    }

    // This frame's sky turn and sun for the composer looks; material detail follows the pack's sun when it lights.
    void resolve_look_lighting() {
        const bool panorama = panorama_drawn();
        const bool lit =
                graphics.look.composer() && native::pack_lights_scene(graphics.look, visual_profile(), panorama);
        frameSkyYaw = panorama ? native::sky_yaw(graphics.look, lit, skyPanoramaInfo, mapSun) : 0;
        const float exposure = skyPanoramaInfo.exposure * std::exp2(std::clamp(graphics.sky_exposure, -4.f, 4.f));
        frameSun = native::resolve_scene_sun(mapSun, panorama ? &skyPanoramaInfo : nullptr, lit, frameSkyYaw, exposure);
        gl.UseProgram(program);
        gl.Uniform3fv(loc(program, "sunDirection"), 1, (frameSun.from_pack ? frameSun.direction : sunDirection).data());
    }

    // The post-processing of one Enhanced or Cinematic frame (web composer-pipeline.ts applyAppearance).
    LookFrame look_frame(const native::Matrix &vp, const float eye[3], float aspect) const {
        static constexpr float contact_shading_strength = .22f, sun_shafts_strength = .006f, default_haze = .08f;
        const auto config = native::look_config(graphics.look.look);
        const auto profile = visual_profile();
        LookFrame frame;
        frame.bloom_strength = graphics.bloom ? config.bloom * profile.bloom_scale : 0;
        frame.saturation = profile.saturation >= 0 ? profile.saturation : config.saturation;
        frame.contrast = profile.contrast >= 0 ? profile.contrast : config.contrast;
        frame.exposure = profile.exposure;
        frame.shoulder = profile.highlight_shoulder;
        frame.haze = graphics.look.atmosphere ? (profile.haze >= 0 ? profile.haze : default_haze) : 0;
        frame.haze_distance = profile.haze_distance;
        frame.contact_strength = graphics.look.contact_shading ? contact_shading_strength : 0;
        frame.spatial_aa = graphics.look.spatial_aa;
        const float scale = 1 / std::tan(float(fieldOfView * native::radians * .5));
        const float cot = 4.f / 3.f * scale, shownAspect = graphics.aspect > 0 ? graphics.aspect : aspect;
        frame.projection_scale = {cot / shownAspect, cot};
        if (graphics.look.sun_shafts && frameSun.present) {
            const float cp = std::cos(lastPitch * native::radians), sp = std::sin(lastPitch * native::radians);
            const float forward[3] = {
                    cp * float(std::cos(lastYaw * native::radians)),
                    cp * float(std::sin(lastYaw * native::radians)),
                    -sp
            };
            if (const auto at = native::project_sun(vp, eye, forward, frameSun.direction)) {
                frame.sun_uv = *at;
                frame.sun_color = frameSun.color;
                frame.shafts = sun_shafts_strength;
            }
        }
        return frame;
    }

    // Players, ghosts and the replay runner in the water's mirror, as the website's scene capture shows them.
    void draw_reflected_actors(const native::Matrix &vp, const float eye[3], double seconds) {
        if (!viewmodel) return;
        if (replayActor) viewmodel->draw_actor(*replayActor, vp, eye, seconds);
        if (compareActor) viewmodel->draw_actor(*compareActor, vp, eye, seconds);
        for (const auto &actor : roomActors)
            viewmodel->draw_actor(actor, vp, eye, seconds);
    }

    // The world mirrored through the chosen water plane, clipped to what is above it, into the half-size reflection
    // target. Restores the frame's framebuffer and viewport size.
    void draw_water_reflection(const float eye[3], float aspect, int width, int height, double seconds) {
        auto phaseStart = profile_now();
        const double scenePhases = frameProfile.buildCull + frameProfile.sort + frameProfile.submit;
        if (!waterReflection) waterReflection = std::make_unique<WaterReflectionTarget>(gl);
        GLint drawTarget = 0, readTarget = 0;
        gl.GetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &drawTarget);
        gl.GetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &readTarget);
        const float plane = *waterPlan.reflection_height;
        const float mirroredEye[3] = {eye[0], eye[1], 2 * plane - eye[2]};
        const auto vp = native::multiply(camera(eye, lastYaw, lastPitch, aspect), native_render::mirror_matrix(plane));
        waterReflection->begin(width, height);
        viewportWidth = waterReflection->width();
        viewportHeight = waterReflection->height();
        gl.FrontFace(GL_CW);
        draw_sky_backdrop(mirroredEye, vp, aspect, true);
        gl.Enable(GL_CLIP_DISTANCE0);
        draw_3d_sky(eye, aspect, seconds, plane);
        clipHeight = plane;
        gl.ActiveTexture(GL_TEXTURE7);
        gl.BindTexture(GL_TEXTURE_2D, white);
        draw_sky_depth(vp);
        draw_scene(vp, mirroredEye, false, seconds, true);
        gl.Disable(GL_CLIP_DISTANCE0);
        draw_reflected_actors(vp, mirroredEye, seconds);
        gl.FrontFace(GL_CCW);
        clipHeight = no_clip_height;
        viewportWidth = width;
        viewportHeight = height;
        gl.BindFramebuffer(GL_DRAW_FRAMEBUFFER, GLuint(drawTarget));
        gl.BindFramebuffer(GL_READ_FRAMEBUFFER, GLuint(readTarget));
        gl.Viewport(0, 0, width, height);
        reflectionDrawn = true;
        profile_elapsed(frameProfile.waterReflection, phaseStart);
        if (profiling) {
            const double sceneTime = frameProfile.buildCull + frameProfile.sort + frameProfile.submit - scenePhases;
            frameProfile.waterReflection -= sceneTime;
        }
    }

    void
    draw(int width,
         int height,
         const float eye[3],
         const native::Input &input,
         const BhSnapshot *state = nullptr,
         double seconds = -1) {
        if (width <= 0 || height <= 0) return;
        const int outputWidth = width, outputHeight = height;
        GLint outputTarget = 0;
        gl.GetIntegerv(GL_FRAMEBUFFER_BINDING, &outputTarget);
        const auto graphicsView = native::graphics_view(graphics, width, height);
        if (graphics.target_needed()) {
            graphicsTarget->begin(graphicsView, graphics.samples);
            width = graphicsView.width;
            height = graphicsView.height;
        }
        viewportWidth = width;
        viewportHeight = height;
        if (seconds < 0) seconds = SDL_GetTicks() / 1000.;
        lastYaw = input.yaw();
        lastPitch = input.pitch;
        if (viewmodel) viewmodel->view_angles(float(lastYaw), float(lastPitch));
        if (profiling) {
            frameProfile = {};
            frameProfile.hdrAuthored = lightmapInfo.hdr;
            frameProfile.waterVolumes = volumes.size();
        }
        auto phaseStart = profile_now();
        BhImage changedLightmap{};
        const int lightmapChanged = bh_lightmap_update(core, &changedLightmap);
        profile_elapsed(frameProfile.lightmapRefresh, phaseStart);
        phaseStart = profile_now();
        if (lightmapChanged > 0) {
            if (profiling) frameProfile.atlasUpdateBytes = changedLightmap.byte_count;
            gl.ActiveTexture(GL_TEXTURE1);
            gl.BindTexture(GL_TEXTURE_2D, lightmap);
            gl.TexImage2D(
                    GL_TEXTURE_2D,
                    0,
                    GL_SRGB8_ALPHA8,
                    changedLightmap.width,
                    changedLightmap.height,
                    0,
                    GL_RGBA,
                    GL_UNSIGNED_BYTE,
                    changedLightmap.rgba
            );
        }
        profile_elapsed(frameProfile.lightmapUpload, phaseStart);
        const double dt = lastSeconds < 0 ? 0 : std::max(0., seconds - lastSeconds);
        lastSeconds = seconds;
        const float aspect = float(width) / height;
        const auto vp = camera(eye, lastYaw, lastPitch, aspect);
        resolve_look_lighting();
        prepare_sun_light(eye, seconds);
        gl.Viewport(0, 0, width, height);
        plan_water(eye, vp);
        if (waterPlan.reflection_height) draw_water_reflection(eye, aspect, width, height, seconds);
        GLint frameTarget = 0;
        gl.GetIntegerv(GL_FRAMEBUFFER_BINDING, &frameTarget);
        SourceHdr *pass = hdr_pass();
        frameLook = enhanced_pass();
        if (profiling) frameProfile.hdrEffective = pass != nullptr || (frameLook && hdr_object());
        if (frameLook) {
            frameLook->samples(graphics.samples);
            frameLook->begin(width, height);
        } else if (pass) {
            pass->samples(graphics.samples);
            pass->begin(width, height);
        }
        phaseStart = profile_now();
        gl.Viewport(0, 0, width, height);
        gl.ColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
        gl.DepthMask(GL_TRUE);
        if (graphics.potato)
            gl.ClearColor(.616f, .733f, .847f, 1);
        else
            gl.ClearColor(.24, .34, .45, 1);
        gl.Clear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
        draw_sky_backdrop(eye, vp, aspect, false);
        const double skySceneBefore = frameProfile.buildCull + frameProfile.sort + frameProfile.submit;
        draw_3d_sky(eye, aspect, seconds);
        gl.ActiveTexture(GL_TEXTURE7);
        gl.BindTexture(GL_TEXTURE_2D, white);
        draw_sky_depth(vp);
        profile_elapsed(frameProfile.sky, phaseStart);
        if (profiling)
            frameProfile.sky -= frameProfile.buildCull + frameProfile.sort + frameProfile.submit - skySceneBefore;
        draw_scene(vp, eye, false, seconds);
        phaseStart = profile_now();
        if (viewmodel) {
            auto detailStart = profile_now();
            size_t floorCount = 0;
            const auto *floor = bh_floor_weapons(core, &floorCount);
            profile_elapsed(frameProfile.floorReport, detailStart);
            if (profiling) frameProfile.floorCount = floorCount;
            detailStart = profile_now();
            for (size_t i = 0; floorWeaponsVisible && floor && i < floorCount; i++)
                viewmodel->draw_floor(floor[i], vp, eye, seconds);
            profile_elapsed(frameProfile.floorDraw, detailStart);
            detailStart = profile_now();
            if (replayActor) viewmodel->draw_actor(*replayActor, vp, eye, seconds);
            if (compareActor) viewmodel->draw_actor(*compareActor, vp, eye, seconds);
            for (const auto &actor : roomActors)
                viewmodel->draw_actor(actor, vp, eye, seconds);
            profile_elapsed(frameProfile.actorDraw, detailStart);
        }
        draw_presentation(vp, eye, seconds);
        profile_elapsed(frameProfile.presentation, phaseStart);
        phaseStart = profile_now();
        if (frameLook)
            frameLook->finish(GLuint(frameTarget), look_frame(vp, eye, aspect), hdr_object(), dt);
        else if (pass)
            pass->finish(GLuint(frameTarget), width, height, dt);
        frameLook = nullptr;
        profile_elapsed(frameProfile.hdrFinish, phaseStart);
        phaseStart = profile_now();
        auto viewmodelStart = profile_now();
        BhSnapshot snapshot{};
        if (state)
            snapshot = *state;
        else
            bh_snapshot(core, &snapshot);
        BhWeaponReport weapon{};
        BhAttackReport attack{};
        bh_weapon_report(core, &weapon);
        bh_attack_report(core, &attack);
        if (viewmodel && viewmodelVisible) {
            if (spectatedActor) {
                BhWeaponReport remote{};
                remote.active = spectatedActor->frame.weapon;
                remote.silencer = spectatedActor->silenced ? 1 : 0;
                snapshot.player.tick = spectatedActor->frame.tick;
                const auto pulses = spectatedAttacks.take();
                const unsigned mode = pulses.empty() ? 0 : pulses.back();
                viewmodel->draw(
                        width,
                        height,
                        snapshot,
                        remote.active,
                        spectatedFlags,
                        !pulses.empty(),
                        mode,
                        seconds,
                        &remote,
                        !pulses.empty() || spectatedFlags != 0
                );
                spectatedFlags = 0;
            } else
                viewmodel->draw(
                        width,
                        height,
                        snapshot,
                        viewmodelWeapon.value_or(weapon.active),
                        viewmodelWeapon ? 0 : weapon.flags | queuedWeaponFlags,
                        viewmodelWeapon ? false : queuedAttack || attack.weapon != 0,
                        viewmodelWeapon ? 0
                        : queuedAttack  ? queuedAttackMode
                                        : attack.mode,
                        seconds,
                        viewmodelWeapon ? nullptr : &weapon
                );
        }
        profile_elapsed(frameProfile.viewmodel, viewmodelStart);
        profile_elapsed(frameProfile.presentation, phaseStart);
        spectatedAttacks.clear();
        spectatedFlags = 0;  // Hidden third-person viewmodels must not replay stale pulses on return to eye mode.
        queuedWeaponFlags = queuedAttackMode = 0;
        queuedAttack = false;
        gl.DepthMask(GL_TRUE);
        gl.Enable(GL_DEPTH_TEST);
        gl.Disable(GL_BLEND);
        gl.Disable(GL_POLYGON_OFFSET_FILL);
        if (graphics.target_needed()) {
            graphicsTarget->finish(GLuint(outputTarget), outputWidth, outputHeight, graphicsView, graphics);
        }
    }

    void screenshot(const std::string &path, int width, int height) {
        if (width <= 0 || height <= 0) throw std::runtime_error("Cannot capture empty framebuffer");
        std::vector<uint8_t> pixels(size_t(width) * height * 3);
        gl.PixelStorei(GL_PACK_ALIGNMENT, 1);
        gl.ReadPixels(0, 0, width, height, GL_RGB, GL_UNSIGNED_BYTE, pixels.data());
        std::ofstream file(path, std::ios::binary);
        if (!file) throw std::runtime_error("Cannot write screenshot: " + path);
        file << "P6\n" << width << ' ' << height << "\n255\n";
        for (int y = height - 1; y >= 0; y--)
            file.write(reinterpret_cast<const char *>(pixels.data() + size_t(y) * width * 3), width * 3);
        if (!file) throw std::runtime_error("Screenshot write failed: " + path);
        std::cout << "Screenshot: " << path << '\n';
    }
};
}  // namespace native
