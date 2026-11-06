#pragma once
#include <chrono>
#if defined(__APPLE__) || defined(__linux__)
#include <execinfo.h>
#endif

namespace native_perf {
using Clock = std::chrono::steady_clock;
inline native::Gl original;
inline nlohmann::json calls = nlohmann::json::object();
inline nlohmann::json stacks = nlohmann::json::array();
inline bool recording = false;

template <typename Call>
auto timed(const char *name, Call call) {
    const auto start = Clock::now();
    auto record = [&] {
        if (!recording) return;
        const double ms = std::chrono::duration<double, std::milli>(Clock::now() - start).count();
        auto &entry = calls[name];
        if (entry.is_null()) entry = {{"count", 0}, {"totalMs", 0.}, {"maxMs", 0.}};
        entry["count"] = entry["count"].get<unsigned>() + 1;
        entry["totalMs"] = entry["totalMs"].get<double>() + ms;
        entry["maxMs"] = std::max(entry["maxMs"].get<double>(), ms);
#if defined(__APPLE__) || defined(__linux__)
        if (ms >= 2 && stacks.size() < 80) {
            void *frames[24];
            const int count = backtrace(frames, 24);
            char **names = backtrace_symbols(frames, count);
            nlohmann::json stack = nlohmann::json::array();
            if (names) {
                for (int i = 0; i < count; ++i)
                    stack.push_back(names[i]);
                free(names);
            }
            stacks.push_back({{"call", name}, {"ms", ms}, {"stack", stack}});
        }
#endif
    };
    if constexpr (std::is_void_v<decltype(call())>) {
        call();
        record();
    } else {
        auto result = call();
        record();
        return result;
    }
}

inline void install(native::Gl &gl) {
    original = gl;
    gl.CompileShader = [](GLuint id) {
        timed("CompileShader", [&] { original.CompileShader(id); });
    };
    gl.LinkProgram = [](GLuint id) {
        timed("LinkProgram", [&] { original.LinkProgram(id); });
    };
    gl.GetShaderiv = [](GLuint id, GLenum key, GLint *value) {
        timed("GetShaderiv", [&] { original.GetShaderiv(id, key, value); });
    };
    gl.GetProgramiv = [](GLuint id, GLenum key, GLint *value) {
        timed("GetProgramiv", [&] { original.GetProgramiv(id, key, value); });
    };
    gl.GetUniformLocation = [](GLuint id, const GLchar *name) {
        return timed("GetUniformLocation", [&] { return original.GetUniformLocation(id, name); });
    };
#define BH_PERF_VOID(name, signature, arguments) \
    gl.name = [] signature { \
        timed(#name, [&] { original.name arguments; }); \
    };
    BH_PERF_VOID(GenVertexArrays, (GLsizei n, GLuint * ids), (n, ids))
    BH_PERF_VOID(BindVertexArray, (GLuint id), (id))
    BH_PERF_VOID(BindBuffer, (GLenum target, GLuint id), (target, id))
    BH_PERF_VOID(
            VertexAttribPointer,
            (GLuint i, GLint n, GLenum t, GLboolean norm, GLsizei stride, const void *data),
            (i, n, t, norm, stride, data)
    )
    BH_PERF_VOID(Uniform1f, (GLint at, GLfloat v), (at, v))
    BH_PERF_VOID(Uniform1i, (GLint at, GLint v), (at, v))
    BH_PERF_VOID(Uniform2f, (GLint at, GLfloat a, GLfloat b), (at, a, b))
    BH_PERF_VOID(Uniform3fv, (GLint at, GLsizei n, const GLfloat *v), (at, n, v))
    BH_PERF_VOID(Uniform4fv, (GLint at, GLsizei n, const GLfloat *v), (at, n, v))
    BH_PERF_VOID(UniformMatrix4fv, (GLint at, GLsizei n, GLboolean transpose, const GLfloat *v), (at, n, transpose, v))
#undef BH_PERF_VOID
    gl.UseProgram = [](GLuint id) {
        timed("UseProgram", [&] { original.UseProgram(id); });
    };
    gl.DrawArrays = [](GLenum mode, GLint first, GLsizei count) {
        timed("DrawArrays", [&] { original.DrawArrays(mode, first, count); });
    };
    gl.DrawElements = [](GLenum mode, GLsizei count, GLenum type, const void *indices) {
        timed("DrawElements", [&] { original.DrawElements(mode, count, type, indices); });
    };
    gl.DrawArraysInstanced = [](GLenum mode, GLint first, GLsizei count, GLsizei instances) {
        timed("DrawArraysInstanced", [&] { original.DrawArraysInstanced(mode, first, count, instances); });
    };
    gl.DrawElementsInstanced = [](GLenum mode, GLsizei count, GLenum type, const void *indices, GLsizei instances) {
        timed("DrawElementsInstanced", [&] { original.DrawElementsInstanced(mode, count, type, indices, instances); });
    };
    gl.TexImage2D = [](GLenum target,
                       GLint level,
                       GLint internal,
                       GLsizei w,
                       GLsizei h,
                       GLint border,
                       GLenum format,
                       GLenum type,
                       const void *data) {
        timed("TexImage2D", [&] { original.TexImage2D(target, level, internal, w, h, border, format, type, data); });
    };
    gl.BufferData = [](GLenum target, GLsizeiptr bytes, const void *data, GLenum usage) {
        timed("BufferData", [&] { original.BufferData(target, bytes, data, usage); });
    };
    gl.ReadPixels = [](GLint x, GLint y, GLsizei w, GLsizei h, GLenum format, GLenum type, void *data) {
        timed("ReadPixels", [&] { original.ReadPixels(x, y, w, h, format, type, data); });
    };
}

inline void reset() {
    calls = nlohmann::json::object();
    stacks = nlohmann::json::array();
    recording = true;
}

inline double elapsed(Clock::time_point start) {
    return std::chrono::duration<double, std::milli>(Clock::now() - start).count();
}
}  // namespace native_perf
