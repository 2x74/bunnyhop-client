#pragma once
#include "bunnyhop_native.h"
#include "native_input.hpp"
#include "native_math.hpp"
#include "render_shaders.hpp"
#include "render_math.hpp"
#include "ghost_trails.hpp"
#include "graphics_settings.hpp"
#include "paint.hpp"
#include "measure.hpp"
#include "zone_effects.hpp"
#include "actor_anim.hpp"
#include "tp_inspect.hpp"
#include <span>
#include "nlohmann/json.hpp"
#include <filesystem>
#include <chrono>
#include <sstream>
#include <regex>
#include <zlib.h>
#include <memory>
#include <optional>
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
    X(void, DeleteSync, (GLsync))
// clang-format on

struct Gl {
#define DECLARE(ret, name, args) ret(APIENTRY *name) args = nullptr;
    GL_FUNCTIONS(DECLARE)
#undef DECLARE

    void load() {
#define LOAD(ret, name, args) \
    name = reinterpret_cast<decltype(name)>(SDL_GL_GetProcAddress("gl" #name)); \
    if (!name) throw std::runtime_error("Missing OpenGL function gl" #name);
        GL_FUNCTIONS(LOAD)
#undef LOAD
    }
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
               hdrFinish = 0;
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
    bool hasWaterMaterials = false;
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

    SourceHdr *hdr_pass() {
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

    bool toolsVisible = true, paintHeld = false;
    std::string measureLabel;
    double lastPaintSeconds = -1;
    native_render::SurfaceToolBindings toolBindings;
    native_render::Paint paint;
    native_render::Measure measure;
    native::GraphicsSettings graphics;
    std::unique_ptr<GraphicsTarget> graphicsTarget;
    bool anisotropySupported = false;
    uint32_t queuedWeaponFlags = 0, queuedAttackMode = 0;
    bool queuedAttack = false;
    std::unordered_map<GLuint, std::unordered_map<std::string, GLint>> uniformLocations;

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

    void cache_texture(int32_t index, bool raw = false) {
        if (index < 0) return;
        const uint64_t key = uint32_t(index) | (uint64_t(raw) << 32);
        if (textures.count(key)) return;
        BhImage image{};
        GLuint id = checker;
        if (bh_texture(core, index, &image)) {
            textureSizes[index] = {image.width, image.height};
            id = upload(image, true, true, !raw);
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

    void load_normals() {
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
        }
        normals.resize(materials.size());
        if (!hasSun) return;
        raw = bh_material_names_json(core, &count);
        if (!raw || !count) return;
        const auto names = nlohmann::json::parse(raw, raw + count);
        std::unordered_map<std::string, GLuint> cached;
        for (size_t i = 0; i < normals.size() && i < names.size(); i++) {
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

    void bind_material(uint32_t index, bool prop) {
        const BhMaterial fallback = {-1, 1, 0, 1, .5f, {1, 1, 1}};
        const auto &m = index < materials.size() ? materials[index] : fallback;
        if (graphics.potato) {
            const auto found = textureAverages.find(m.texture);
            const std::array<float, 3> fallbackColor = {.5f, .5f, .5f};
            gl.Uniform3fv(
                    loc(program, "flatColor"),
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
        gl.Uniform1i(loc(program, "hasNormal"), graphics.material_response && index < normals.size() && normals[index]);
        gl.Uniform1i(loc(program, "hasSecondary"), e.texture2 >= 0);
        gl.Uniform1i(loc(program, "hasDetail"), e.detail >= 0 && !graphics.potato);
        gl.Uniform1f(loc(program, "detailScale"), e.detail_scale);
        gl.Uniform1f(loc(program, "detailBlend"), e.detail_blend);
        gl.Uniform3fv(loc(program, "tint"), 1, m.color);
        gl.Uniform1f(loc(program, "opacity"), m.alpha);
        gl.Uniform1f(loc(program, "cutoff"), (m.flags & 2) ? m.alpha_ref : 0);
        gl.Uniform1i(loc(program, "unlit"), (m.flags & 16) != 0 || (!prop && lightmap == white));
        gl.Uniform1i(loc(program, "props"), prop);
        gl.Uniform1i(loc(program, "kind"), m.kind);
        gl.Uniform1i(loc(program, "aboveWater"), e.above_water);
        gl.Uniform1i(loc(program, "additive"), (m.flags & 8) != 0);
        if ((m.flags & 4) || m.kind == 2)
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

    void water_uniforms(GLuint target, const float eye[3]) {
        gl.Uniform3fv(loc(target, "cameraPosition"), 1, eye);
        std::vector<size_t> order;
        std::vector<std::array<float, 4>> rects(volumes.size());
        const auto vp = camera(eye, lastYaw, lastPitch, float(viewportWidth) / viewportHeight);
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
        if (auto *hdr = hdr_pass())
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

    void draw_scene(const native::Matrix &vp, const float eye[3], bool sky, double time) {
        auto phaseStart = profile_now();
        gl.UseProgram(program);
        gl.UniformMatrix4fv(loc(program, "viewProjection"), 1, GL_FALSE, vp.data());
        water_uniforms(program, eye);
        gl.Uniform1f(loc(program, "timeSeconds"), time);
        gl.Uniform1i(loc(program, "detailedWater"), waterQuality > 0 && !graphics.potato && !sky && hasWaterMaterials);
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
        std::unordered_map<uint64_t, BhTransform> transforms;

        struct Draw {
            uint32_t material, first, count;
            bool prop;
            int32_t entity;
            uint32_t model;
            float distance;
        };

        std::vector<Draw> draws;
        for (const auto &g : groups)
            if (bool(g.sky3d) == sky)
                draws.push_back({g.material, g.first_index, g.index_count, false, -1, g.model, 0});
        for (const auto &g : propGroups)
            if (bool(g.sky3d) == sky) draws.push_back({g.material, g.first_index, g.index_count, true, g.entity, 0, 0});
        if (profiling) frameProfile.groups += draws.size();
        // Cull transformed bounds before submission; sort translucency from current, transformed centres.
        draws.erase(
                std::remove_if(
                        draws.begin(),
                        draws.end(),
                        [&](Draw &d) {
                            const uint64_t transformKey =
                                    (uint64_t(d.prop) << 63) | uint32_t(d.prop ? d.entity : d.model);
                            auto found = transforms.find(transformKey);
                            if (found == transforms.end()) {
                                BhTransform t{};
                                t.visible = 1;
                                if (d.prop && d.entity >= 0)
                                    bh_prop_transform(core, d.entity, &t);
                                else if (!d.prop && d.model)
                                    bh_model_transform(core, d.model, &t);
                                found = transforms.emplace(transformKey, t).first;
                            }
                            if (!found->second.visible) return true;
                            const auto model = native::model_matrix(found->second);
                            const uint64_t key = (uint64_t(d.prop) << 63) | d.first;
                            const auto at = groupBounds.find(key);
                            if (at != groupBounds.end()) {
                                const auto bounds = native_render::transformed_bounds(at->second, model);
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
        const bool visibleWater = hasWaterMaterials && std::any_of(draws.begin(), draws.end(), [&](const Draw &d) {
                                      return d.material < materials.size() && materials[d.material].kind == 2;
                                  });
        for (int pass = 0; pass < 2; pass++) {
            const double sortBefore = frameProfile.sort;
            phaseStart = profile_now();
            if (pass) {
                if (!sky && waterQuality > 0 && !graphics.potato && visibleWater) capture_refraction();
                gl.Enable(GL_BLEND);
                gl.DepthMask(GL_FALSE);
                auto sortStart = profile_now();
                std::stable_sort(draws.begin(), draws.end(), [](const Draw &a, const Draw &b) {
                    return a.distance > b.distance;
                });
                profile_elapsed(frameProfile.sort, sortStart);
            } else {
                gl.Disable(GL_BLEND);
                gl.DepthMask(GL_TRUE);
            }
            for (const auto &d : draws) {
                const auto &m = d.material < materials.size() ? materials[d.material] : materials.front();
                if (transparent(m) != (pass != 0)) continue;
                const uint64_t transformKey = (uint64_t(d.prop) << 63) | uint32_t(d.prop ? d.entity : d.model);
                auto found = transforms.find(transformKey);
                if (found == transforms.end()) {
                    BhTransform t{};
                    t.visible = 1;
                    if (d.prop && d.entity >= 0)
                        bh_prop_transform(core, d.entity, &t);
                    else if (!d.prop && d.model)
                        bh_model_transform(core, d.model, &t);
                    found = transforms.emplace(transformKey, t).first;
                }
                if (!found->second.visible) continue;
                const auto model = native::model_matrix(found->second);
                gl.UniformMatrix4fv(loc(program, "model"), 1, GL_FALSE, model.data());
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
    };

    struct ShotEffect {
        BhAttackReport report;
        native_render::ShotBasis basis;
        double started;
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
            shotEffects.push_back({event.report, event.basis, seconds});
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
                    if (!viewmodelVisible)
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
        if (toolsVisible) {
            paint.draw(core, *presentation);
            measure.draw(core, *presentation, eye);
        }
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
        water_uniforms(presentation->shader(), eye);
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
        const native_render::Vec3 eye = {state.position[0], state.position[1], state.position[2] + state.view_offset_z};
        const auto hit = native_render::pick_surface(core, eye, input.yaw(), input.pitch);
        if (!hit) return "No surface in range. Aim at a nearby wall or floor.";
        if (action == "measurePoint") {
            measure.pick(core, *hit);
            return measure.text(core);
        }
        return paint.stamp(core, *hit, double(SDL_GetTicksNS()) / 1e9, held) ? "Paint mark placed."
                                                                             : "Paint mark skipped.";
    }

    const char *
    tool_key(std::string_view code, bool down, bool repeat, const BhState &state, const native::Input &input) {
        const int action = toolBindings.match(code);
        if (action < 0) return nullptr;
        if (action == 0) paintHeld = down;
        if (!down || repeat) return nullptr;
        return surface_tool(native_render::SurfaceToolBindings::actions[size_t(action)], state, input);
    }

    void surface_tools_frame(const BhState &state, const native::Input &input, bool active, double seconds) {
        if (!active) {
            paintHeld = false;
            return;
        }
        constexpr double paintInterval = .1;
        if (paintHeld && seconds - lastPaintSeconds >= paintInterval) {
            lastPaintSeconds = seconds;
            surface_tool("paint", state, input, true);
        }
    }

    std::string tool_message(const nlohmann::json &message, const BhState &state, const native::Input &input) {
        const auto type = message.at("type").get<std::string>();
        const auto action = message.at("action").get<std::string>();
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

    Renderer(Gl &g, BhContext *c, const std::filesystem::path &assetRoot = BUNNYHOP_NATIVE_ASSET_ROOT)
        : gl(g)
        , core(c) {
        measureLabel.reserve(100);
        program = link_program(gl, native_render::world_vertex, native_render::world_fragment().c_str());
        skyProgram = link_program(gl, native_render::sky_vertex, native_render::sky_fragment().c_str());
        depthProgram = link_program(gl, native_render::depth_vertex, native_render::depth_fragment);
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
        worldMesh = geometry(verts, nv, 10, indices, ni, blend, nb);
        auto group_center = [&](uint64_t key,
                                uint32_t first,
                                uint32_t count,
                                const float *v,
                                size_t floats,
                                int stride,
                                const uint32_t *ix,
                                size_t n) {
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
        };
        for (const auto &item : groups)
            group_center(item.first_index, item.first_index, item.index_count, verts, nv, 10, indices, ni);
        size_t pv = 0, pi = 0, pg = 0;
        const float *propVertices = bh_prop_vertices(core, &pv);
        const auto *propIndices = bh_prop_indices(core, &pi);
        const auto *rawProps = bh_prop_groups(core, &pg);
        propMesh = geometry(propVertices, pv, 8, propIndices, pi);
        if (rawProps && pg) propGroups.assign(rawProps, rawProps + pg);
        for (const auto &item : propGroups)
            group_center(
                    (uint64_t(1) << 63) | item.first_index,
                    item.first_index,
                    item.index_count,
                    propVertices,
                    pv,
                    8,
                    propIndices,
                    pi
            );
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
        for (const auto &m : materials)
            cache_texture(m.texture);
        for (const auto &e : extras) {
            cache_texture(e.texture2);
            cache_texture(e.detail, true);
        }
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
        if (planes.empty()) planes.resize(4);
        GLint limit = 0;
        gl.GetIntegerv(GL_MAX_TEXTURE_SIZE, &limit);
        if (planes.size() / 4 > size_t(limit)) throw std::runtime_error("Native water plane texture exceeds GPU size");
        gl.GenTextures(1, &planesTexture);
        gl.BindTexture(GL_TEXTURE_2D, planesTexture);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
        gl.TexImage2D(GL_TEXTURE_2D, 0, GL_RGBA32F, planes.size() / 4, 1, 0, GL_RGBA, GL_FLOAT, planes.data());
        gl.UseProgram(program);
        gl.Uniform1i(loc(program, "baseTexture"), 0);
        gl.Uniform1i(loc(program, "lightTexture"), 1);
        gl.Uniform1i(loc(program, "secondaryTexture"), 2);
        gl.Uniform1i(loc(program, "detailTexture"), 3);
        gl.Uniform1i(loc(program, "sceneColor"), 4);
        gl.Uniform1i(loc(program, "sceneDepth"), 5);
        gl.Uniform1f(loc(program, "lightmapScale"), lightmapInfo.scale);
        load_normals();
        gl.UseProgram(program);
        gl.Uniform1i(loc(program, "normalTexture"), 7);
        gl.Uniform3fv(loc(program, "sunDirection"), 1, sunDirection.data());
        presentation = std::make_unique<NativePresentation>(gl);
        mapEffects.load(core);

        anisotropySupported = SDL_GL_ExtensionSupported("GL_EXT_texture_filter_anisotropic");
        viewmodel = std::make_unique<NativeViewmodel>(gl, assetRoot);
        gl.Enable(GL_DEPTH_TEST);
        gl.DepthFunc(GL_LEQUAL);
        gl.CullFace(GL_BACK);
        gl.FrontFace(GL_CCW);
        std::cout << "Native renderer: " << nv / 10 << " BSP vertices, " << pv / 8 << " prop vertices, " << sv / 3
                  << " sky vertices, " << volumes.size() << " water volumes, 3D sky=" << hasSky << "\n";
    }

    ~Renderer() {
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
    }

    void graphics_settings(const nlohmann::json &settings) {
        graphics = native::GraphicsSettings::read(settings);
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
        paintHeld = false;
        toolsVisible = settings.value("hud", true);
        hdr_pass();
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

    void set_source_look(bool value) { sourceLook = value; }

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
        GLint frameTarget = 0;
        gl.GetIntegerv(GL_FRAMEBUFFER_BINDING, &frameTarget);
        SourceHdr *pass = hdr_pass();
        if (profiling) frameProfile.hdrEffective = pass != nullptr;
        if (pass) {
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
        gl.Disable(GL_BLEND);
        gl.Disable(GL_CULL_FACE);
        gl.Disable(GL_DEPTH_TEST);
        gl.DepthMask(GL_FALSE);
        gl.UseProgram(skyProgram);
        gl.BindVertexArray(emptyVao);
        water_uniforms(skyProgram, eye);
        const float cy = std::cos(lastYaw * native::radians), sy = std::sin(lastYaw * native::radians),
                    cp = std::cos(lastPitch * native::radians), sp = std::sin(lastPitch * native::radians);
        gl.Uniform3f(loc(skyProgram, "forward"), cp * cy, cp * sy, -sp);
        gl.Uniform3f(loc(skyProgram, "right"), sy, -cy, 0);
        gl.Uniform3f(loc(skyProgram, "up"), sp * cy, sp * sy, cp);
        gl.Uniform1f(loc(skyProgram, "skyExposure"), graphics.sky_exposure);
        gl.Uniform1f(loc(skyProgram, "aspect"), float(width) / height);
        gl.Uniform1f(loc(skyProgram, "cot"), (4.f / 3.f) / std::tan(float(fieldOfView * native::radians * .5)));
        GLint present[6]{}, half[6]{};
        for (int i = 0; i < 6; i++) {
            GLuint id = white;
            const int32_t m = skyMaterials[i];
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
            const auto name = "sky" + std::to_string(i);
            gl.Uniform1i(loc(skyProgram, name.c_str()), i);
        }
        gl.Uniform1iv(loc(skyProgram, "skyPresent"), 6, present);
        gl.Uniform1iv(loc(skyProgram, "skyHalf"), 6, half);
        if (!graphics.potato) gl.DrawArrays(GL_TRIANGLES, 0, 3);
        gl.Enable(GL_DEPTH_TEST);
        gl.DepthMask(GL_TRUE);
        gl.DepthFunc(GL_LEQUAL);
        const double skySceneBefore = frameProfile.buildCull + frameProfile.sort + frameProfile.submit;
        if (hasSky && !graphics.potato && skyInfo.scale > 0) {
            float skyEye[3];
            for (int k = 0; k < 3; k++)
                skyEye[k] = skyInfo.origin[k] + eye[k] / skyInfo.scale;
            const auto vp = camera(skyEye, lastYaw, lastPitch, float(width) / height);
            draw_scene(vp, skyEye, true, seconds);
            gl.Clear(GL_DEPTH_BUFFER_BIT);
        }
        const auto vp = camera(eye, lastYaw, lastPitch, float(width) / height);
        gl.ActiveTexture(GL_TEXTURE7);
        gl.BindTexture(GL_TEXTURE_2D, white);
        if (skyMesh.vao) {
            gl.Disable(GL_BLEND);
            gl.DepthMask(GL_TRUE);
            gl.UseProgram(depthProgram);
            gl.UniformMatrix4fv(loc(depthProgram, "viewProjection"), 1, GL_FALSE, vp.data());
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
                gl.DrawElements(
                        GL_TRIANGLES,
                        item.index_count,
                        GL_UNSIGNED_INT,
                        reinterpret_cast<void *>(uintptr_t(item.first_index) * 4)
                );
            }
            gl.ColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
            gl.Disable(GL_POLYGON_OFFSET_FILL);
        }
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
        if (pass) pass->finish(GLuint(frameTarget), width, height, dt);
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
