#pragma once
#include <SDL3/SDL.h>
#include <SDL3/SDL_opengl.h>
#include <array>
#include <vector>
#include <stdexcept>

// A delayed query ring keeps readback out of the measured render interval.
class BenchmarkGpu {
    struct Query { GLuint id = 0; size_t frame = 0; bool pending = false; };
    std::array<Query, 32> queries_{};
    void(APIENTRY *generate_)(GLsizei, GLuint *) = nullptr;
    void(APIENTRY *destroy_)(GLsizei, const GLuint *) = nullptr;
    void(APIENTRY *begin_)(GLenum, GLuint) = nullptr;
    void(APIENTRY *end_)(GLenum) = nullptr;
    void(APIENTRY *available_)(GLuint, GLenum, GLint *) = nullptr;
    void(APIENTRY *value_)(GLuint, GLenum, GLuint64 *) = nullptr;
    bool active_ = false;
    std::vector<double> frames_;

    template<class Function>
    static void load(Function &function, const char *name) {
        function = reinterpret_cast<Function>(SDL_GL_GetProcAddress(name));
    }

    void collect(Query &query, bool wait) {
        if (!query.pending) return;
        GLint available = 0;
        available_(query.id, GL_QUERY_RESULT_AVAILABLE, &available);
        if (!available && !wait) return;
        GLuint64 ns = 0;
        value_(query.id, GL_QUERY_RESULT, &ns);
        frames_[query.frame] = double(ns) / 1e6;
        query.pending = false;
    }

public:
    BenchmarkGpu() {
        load(generate_, "glGenQueries");
        load(destroy_, "glDeleteQueries");
        load(begin_, "glBeginQuery");
        load(end_, "glEndQuery");
        load(available_, "glGetQueryObjectiv");
        load(value_, "glGetQueryObjectui64v");
    }
    ~BenchmarkGpu() {
        if (destroy_) for (const auto &query : queries_) if (query.id) destroy_(1, &query.id);
    }
    bool supported() const { return generate_ && destroy_ && begin_ && end_ && available_ && value_; }
    void begin() {
        const size_t frame = frames_.size();
        frames_.push_back(-1);
        if (!supported()) return;
        for (auto &query : queries_) collect(query, false);
        auto &query = queries_[frame % queries_.size()];
        if (query.pending) return;
        if (!query.id) generate_(1, &query.id);
        query.frame = frame;
        begin_(GL_TIME_ELAPSED, query.id);
        active_ = true;
    }
    void end() {
        if (!active_) return;
        end_(GL_TIME_ELAPSED);
        queries_[(frames_.size() - 1) % queries_.size()].pending = true;
        active_ = false;
    }
    std::vector<double> finish(size_t warmup) {
        if (supported()) for (auto &query : queries_) collect(query, true);
        return {frames_.begin() + std::min(warmup, frames_.size()), frames_.end()};
    }
};
