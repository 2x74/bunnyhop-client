#pragma once
#include <SDL3/SDL.h>
#include <SDL3/SDL_opengl.h>
#include <stdexcept>
#include <string>

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
    X(void, ReadBuffer, (GLenum)) \
    X(void, TexImage2DMultisample, (GLenum, GLsizei, GLenum, GLsizei, GLsizei, GLboolean)) \
    X(void, GenSamplers, (GLsizei, GLuint *)) \
    X(void, DeleteSamplers, (GLsizei, const GLuint *)) \
    X(void, BindSampler, (GLuint, GLuint)) \
    X(void, SamplerParameteri, (GLuint, GLenum, GLint)) \
    X(void, SamplerParameterf, (GLuint, GLenum, GLfloat)) \
    X(void, SamplerParameterfv, (GLuint, GLenum, const GLfloat *)) \
    X(void, VertexAttribDivisor, (GLuint, GLuint))
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

}  // namespace native
