#pragma once
#include <d3d11.h>
#include <dxgi.h>
#include <wrl/client.h>
#include <nlohmann/json.hpp>
#include <array>
#include <chrono>
#include <cstring>
#include <string>
#include <vector>

// Included only by the benchmark's instrumented presenter, never by the client.
namespace benchmark_latency {
using Microsoft::WRL::ComPtr;
using Json = nlohmann::json;
using Clock = std::chrono::steady_clock;

enum Phase : size_t { lock, unlock, copy, present, count };

// NVAPI R615 NV_LATENCY_RESULT_PARAMS_V1. Reserved fields keep the driver's ABI, including on older drivers.
// https://github.com/NVIDIA/nvapi/blob/main/nvapi.h (MIT; license in vendor/nvapi/LICENSE).
struct LatencyReport {
    uint32_t version;

    struct Frame {
        uint64_t frame, input, simulation_start, simulation_end, submit_start, submit_end, present_start, present_end;
        uint64_t driver_start, driver_end, queue_start, queue_end, gpu_start, gpu_end;
        uint32_t gpu_active_us, gpu_frame_us;
        uint64_t camera;
        uint32_t cross_adapter_us, ai_frame_us;
        uint8_t reserved[104];
    } frames[64];

    uint8_t reserved[32];
};

static_assert(sizeof(LatencyReport::Frame) == 240);

struct Query {
    ComPtr<ID3D11Query> disjoint, start, end;
    size_t frame = 0;
    bool pending = false;
};

struct State {
    Clock::time_point start;
    std::array<double, count> cpu{};
    std::vector<std::array<double, count>> cpu_frames;
    std::vector<double> gpu_copy;
    std::array<Query, 32> queries;
    size_t sequence = 0;
    std::vector<LatencyReport::Frame> reflex_frames;
    uint64_t last_reflex = 0;
    int reflex_status = -1;
    std::string gpu_error;
    ComPtr<ID3D11DeviceContext> context;
    ComPtr<ID3D11Device> device;
};

inline State state;

inline void prepare(size_t frames) {
    state.cpu_frames.reserve(frames);
    state.gpu_copy.reserve(frames);
    state.reflex_frames.reserve(frames);
}

inline void clock_start() {
    state.start = Clock::now();
}

inline void clock_end(Phase phase) {
    state.cpu[phase] = std::chrono::duration<double, std::milli>(Clock::now() - state.start).count();
}

inline bool make_query(ID3D11Device *device, D3D11_QUERY type, ComPtr<ID3D11Query> &query) {
    const D3D11_QUERY_DESC description{type, 0};
    return SUCCEEDED(device->CreateQuery(&description, &query));
}

inline void collect(Query &query, ID3D11DeviceContext *context) {
    if (!query.pending) return;
    D3D11_QUERY_DATA_TIMESTAMP_DISJOINT disjoint{};
    UINT64 start = 0, end = 0;
    if (context->GetData(query.disjoint.Get(), &disjoint, sizeof disjoint, D3D11_ASYNC_GETDATA_DONOTFLUSH) != S_OK
        || context->GetData(query.start.Get(), &start, sizeof start, D3D11_ASYNC_GETDATA_DONOTFLUSH) != S_OK
        || context->GetData(query.end.Get(), &end, sizeof end, D3D11_ASYNC_GETDATA_DONOTFLUSH) != S_OK)
        return;
    if (!disjoint.Disjoint && disjoint.Frequency && end >= start)
        state.gpu_copy[query.frame] = double(end - start) * 1000 / double(disjoint.Frequency);
    query.pending = false;
}

inline void copy_start(ID3D11Device *device, ID3D11DeviceContext *context) {
    state.context = context;
    for (auto &query : state.queries)
        collect(query, context);
    auto &query = state.queries[state.sequence % state.queries.size()];
    if (query.pending) return;
    if ((!query.disjoint || !query.start || !query.end)
        && (!make_query(device, D3D11_QUERY_TIMESTAMP_DISJOINT, query.disjoint)
            || !make_query(device, D3D11_QUERY_TIMESTAMP, query.start)
            || !make_query(device, D3D11_QUERY_TIMESTAMP, query.end))) {
        state.gpu_error = "D3D11 timestamp queries unavailable";
        return;
    }
    query.frame = state.sequence;
    context->Begin(query.disjoint.Get());
    context->End(query.start.Get());
}

inline void copy_end(ID3D11DeviceContext *context) {
    auto &query = state.queries[state.sequence % state.queries.size()];
    if (!query.disjoint || query.pending || query.frame != state.sequence) return;
    context->End(query.end.Get());
    context->End(query.disjoint.Get());
    query.pending = true;
}

inline Json duration(uint64_t start, uint64_t end) {
    return start && end >= start ? Json(double(end - start) / 1000) : Json();
}

inline void reflex_report(ID3D11Device *device) {
    using QueryInterface = void *(__cdecl *)(uint32_t);
    using GetLatency = int(__cdecl *)(IUnknown *, LatencyReport *);
    static const auto module = LoadLibraryW(L"nvapi64.dll");
    static const auto query =
            module ? reinterpret_cast<QueryInterface>(GetProcAddress(module, "nvapi_QueryInterface")) : nullptr;
    static const auto latency = query ? reinterpret_cast<GetLatency>(query(0x1a587f9c)) : nullptr;
    if (!latency) return;
    LatencyReport report{};
    report.version = uint32_t(sizeof report) | (1u << 16);
    state.reflex_status = latency(device, &report);
    if (state.reflex_status != 0) return;
    for (const auto &frame : report.frames) {
        if (!frame.frame || frame.frame <= state.last_reflex) continue;
        state.last_reflex = frame.frame;
        state.reflex_frames.push_back(frame);
    }
}

inline void finish(ID3D11Device *device, ID3D11DeviceContext *, bool reflex) {
    state.device = device;
    state.cpu_frames.push_back(state.cpu);
    state.cpu.fill(0);
    state.gpu_copy.push_back(-1);
    ++state.sequence;
    if (reflex && state.sequence % 32 == 0) reflex_report(device);
}

inline Json result(size_t warmup) {
    if (state.context) {
        state.context->Flush();
        const auto deadline = Clock::now() + std::chrono::seconds(2);
        bool pending = true;
        while (pending && Clock::now() < deadline) {
            pending = false;
            for (auto &query : state.queries) {
                collect(query, state.context.Get());
                pending = pending || query.pending;
            }
            if (pending) SwitchToThread();
        }
    }
    Json cpu = Json::array(), gpu = Json::array(), reflex = Json::array();
    for (size_t frame = warmup; frame < state.cpu_frames.size(); ++frame) {
        const auto &values = state.cpu_frames[frame];
        cpu.push_back(
                {{"interopLockMs", values[lock]},
                 {"interopUnlockMs", values[unlock]},
                 {"copySubmitMs", values[copy]},
                 {"presentMs", values[present]}}
        );
        gpu.push_back(state.gpu_copy[frame] >= 0 ? Json(state.gpu_copy[frame]) : Json());
    }
    for (const auto &frame : state.reflex_frames) {
        if (frame.frame <= warmup) continue;
        reflex.push_back(
                {{"frameId", frame.frame},
                 {"simulationMs", duration(frame.simulation_start, frame.simulation_end)},
                 {"renderSubmitMs", duration(frame.submit_start, frame.submit_end)},
                 {"presentMs", duration(frame.present_start, frame.present_end)},
                 {"driverMs", duration(frame.driver_start, frame.driver_end)},
                 {"osQueueMs", duration(frame.queue_start, frame.queue_end)},
                 {"gpuMs", duration(frame.gpu_start, frame.gpu_end)},
                 {"gpuActiveMs", double(frame.gpu_active_us) / 1000}}
        );
    }
    Json adapter_info;
    if (state.device) {
        ComPtr<IDXGIDevice> device;
        ComPtr<IDXGIAdapter> adapter;
        DXGI_ADAPTER_DESC description{};
        LARGE_INTEGER driver{};
        if (SUCCEEDED(state.device.As(&device)) && SUCCEEDED(device->GetAdapter(&adapter))
            && SUCCEEDED(adapter->GetDesc(&description))) {
            char name[512]{};
            WideCharToMultiByte(CP_UTF8, 0, description.Description, -1, name, sizeof name, nullptr, nullptr);
            adapter_info["gpu"] = name;
            if (SUCCEEDED(adapter->CheckInterfaceSupport(__uuidof(IDXGIDevice), &driver))) {
                const uint64_t version = uint64_t(driver.QuadPart);
                adapter_info["driver"] =
                        std::to_string((version >> 48) & 65535) + "." + std::to_string((version >> 32) & 65535) + "."
                        + std::to_string((version >> 16) & 65535) + "." + std::to_string(version & 65535);
            }
        }
    }
    return {{"adapter", adapter_info},
            {"cpuFrames", cpu},
            {"gpuCopyMs", gpu},
            {"gpuError", state.gpu_error},
            {"reflexStatus", state.reflex_status},
            {"reflexFrames", reflex},
            {"reflexUnavailableReason",
             reflex.empty() ? "No completed NvAPI reports; requires supported NVIDIA hardware/driver" : ""}};
}
}  // namespace benchmark_latency
