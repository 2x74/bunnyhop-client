#pragma once
#ifdef _WIN32
#include <d3d11.h>
#include <wrl/client.h>
#include <algorithm>
#include <array>
#include <chrono>
#include <stdexcept>
#include <thread>
#include <vector>

class BenchmarkGpuD3D11 {
    template <class T>
    using Pointer = Microsoft::WRL::ComPtr<T>;

    struct Query {
        Pointer<ID3D11Query> disjoint, start, end;
        size_t frame = 0;
        bool pending = false;
    };

    ID3D11DeviceContext *context_;
    std::array<Query, 32> queries_;
    std::vector<double> frames_;
    Query *active_ = nullptr;

    void collect(Query &query, bool wait) {
        if (!query.pending) return;
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
        D3D11_QUERY_DATA_TIMESTAMP_DISJOINT disjoint{};
        HRESULT result;
        while ((result = context_->GetData(query.disjoint.Get(), &disjoint, sizeof disjoint, 0)) == S_FALSE) {
            if (!wait) return;
            if (std::chrono::steady_clock::now() >= deadline) throw std::runtime_error("D3D11 GPU timer timed out");
            std::this_thread::yield();
        }
        UINT64 start = 0, end = 0;
        if (FAILED(result) || context_->GetData(query.start.Get(), &start, sizeof start, 0) != S_OK
            || context_->GetData(query.end.Get(), &end, sizeof end, 0) != S_OK)
            throw std::runtime_error("D3D11 GPU timer failed");
        if (!disjoint.Disjoint && disjoint.Frequency && end >= start)
            frames_[query.frame] = double(end - start) * 1000 / double(disjoint.Frequency);
        query.pending = false;
    }

public:
    BenchmarkGpuD3D11(void *device, void *context) : context_(static_cast<ID3D11DeviceContext *>(context)) {
        auto *native_device = static_cast<ID3D11Device *>(device);
        for (auto &query : queries_) {
            const D3D11_QUERY_DESC disjoint{D3D11_QUERY_TIMESTAMP_DISJOINT, 0}, timestamp{D3D11_QUERY_TIMESTAMP, 0};
            if (FAILED(native_device->CreateQuery(&disjoint, &query.disjoint))
                || FAILED(native_device->CreateQuery(&timestamp, &query.start))
                || FAILED(native_device->CreateQuery(&timestamp, &query.end)))
                throw std::runtime_error("Cannot create D3D11 GPU timers");
        }
    }

    void begin() {
        const size_t frame = frames_.size();
        frames_.push_back(-1);
        for (auto &query : queries_)
            collect(query, false);
        auto &query = queries_[frame % queries_.size()];
        if (query.pending) return;
        query.frame = frame;
        context_->Begin(query.disjoint.Get());
        context_->End(query.start.Get());
        active_ = &query;
    }

    void end() {
        if (!active_) return;
        context_->End(active_->end.Get());
        context_->End(active_->disjoint.Get());
        active_->pending = true;
        active_ = nullptr;
    }

    std::vector<double> finish(size_t warmup) {
        for (auto &query : queries_)
            collect(query, true);
        return {frames_.begin() + std::min(warmup, frames_.size()), frames_.end()};
    }
};
#endif
