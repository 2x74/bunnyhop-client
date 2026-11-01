#pragma once
#include "benchmark_gpu_d3d11.hpp"
#include <memory>
#include <SDL3/SDL.h>
#include <SDL3/SDL_opengl.h>
#include <algorithm>
#include <array>
#include <vector>
#include <stdexcept>

// A delayed query ring keeps readback out of the measured render interval.
class BenchmarkGpu {
    struct Query {
        GLuint id = 0;
        size_t frame = 0;
        bool pending = false;
    };

#ifdef _WIN32
    std::unique_ptr<BenchmarkGpuD3D11> d3d11_;
#endif
    std::array<Query, 32> queries_{};
    void(APIENTRY *generate_)(GLsizei, GLuint *) = nullptr;
    void(APIENTRY *destroy_)(GLsizei, const GLuint *) = nullptr;
    void(APIENTRY *begin_)(GLenum, GLuint) = nullptr;
    void(APIENTRY *end_)(GLenum) = nullptr;
    void(APIENTRY *available_)(GLuint, GLenum, GLint *) = nullptr;
    void(APIENTRY *value_)(GLuint, GLenum, GLuint64 *) = nullptr;
    bool active_ = false;
    std::vector<double> frames_;

    template <class Function>
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
    BenchmarkGpu(void *device = nullptr, void *context = nullptr) {
        (void)device;
        (void)context;
        if (device) {
#ifdef _WIN32
            d3d11_ = std::make_unique<BenchmarkGpuD3D11>(device, context);
#endif
            return;
        }
        load(generate_, "glGenQueries");
        load(destroy_, "glDeleteQueries");
        load(begin_, "glBeginQuery");
        load(end_, "glEndQuery");
        load(available_, "glGetQueryObjectiv");
        load(value_, "glGetQueryObjectui64v");
    }

    ~BenchmarkGpu() {
        if (destroy_)
            for (const auto &query : queries_)
                if (query.id) destroy_(1, &query.id);
    }

    bool supported() const {
#ifdef _WIN32
        if (d3d11_) return true;
#endif
        return generate_ && destroy_ && begin_ && end_ && available_ && value_;
    }

    void begin() {
#ifdef _WIN32
        if (d3d11_) return d3d11_->begin();
#endif
        const size_t frame = frames_.size();
        frames_.push_back(-1);
        if (!supported()) return;
        for (auto &query : queries_)
            collect(query, false);
        auto &query = queries_[frame % queries_.size()];
        if (query.pending) return;
        if (!query.id) generate_(1, &query.id);
        query.frame = frame;
        begin_(GL_TIME_ELAPSED, query.id);
        active_ = true;
    }

    void end() {
#ifdef _WIN32
        if (d3d11_) return d3d11_->end();
#endif
        if (!active_) return;
        end_(GL_TIME_ELAPSED);
        queries_[(frames_.size() - 1) % queries_.size()].pending = true;
        active_ = false;
    }

    std::vector<double> finish(size_t warmup) {
#ifdef _WIN32
        if (d3d11_) return d3d11_->finish(warmup);
#endif
        if (supported())
            for (auto &query : queries_)
                collect(query, true);
        return {frames_.begin() + std::min(warmup, frames_.size()), frames_.end()};
    }
};
