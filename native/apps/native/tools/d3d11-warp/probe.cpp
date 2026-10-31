#include <windows.h>
#include <d3d11.h>
#include <d3dcompiler.h>
#include <dxgi1_2.h>
#include <wincodec.h>
#include <wrl/client.h>
#include <nlohmann/json.hpp>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <vector>

namespace {
using Microsoft::WRL::ComPtr;
using Json = nlohmann::json;
using Clock = std::chrono::steady_clock;
constexpr UINT size = 32, samples = 4;

void check(HRESULT result, const char *operation) {
    if (FAILED(result)) {
        char message[160];
        std::snprintf(message, sizeof message, "%s: HRESULT 0x%08lx", operation, static_cast<unsigned long>(result));
        throw std::runtime_error(message);
    }
}

void require(bool condition, const char *message) {
    if (!condition) throw std::runtime_error(message);
}

constexpr char shaders[] = R"(
struct Vertex { float4 position : SV_Position; float clip : SV_ClipDistance0; };
Vertex vertex(uint id : SV_VertexID) {
    float2 xy = float2((id << 1) & 2, id & 2) * 2 - 1;
    Vertex result;
    result.position = float4(xy, .25, 1);
    result.clip = xy.x;
    return result;
}
float4 fullscreen(uint id : SV_VertexID) : SV_Position {
    return float4(float2((id << 1) & 2, id & 2) * 2 - 1, 0, 1);
}
TextureCube cube : register(t0);
SamplerState nearestSampler : register(s0);
float4 colour() : SV_Target { return cube.SampleLevel(nearestSampler, float3(0, 0, 1), 0); }
Texture2DMS<float, 4> depthSamples : register(t0);
float depthResolve(float4 position : SV_Position) : SV_Depth {
    float result = 1;
    [unroll] for (int i = 0; i < 4; ++i) result = min(result, depthSamples.Load(int2(position.xy), i));
    return result;
}
RWTexture2D<uint> output : register(u0);
[numthreads(8, 8, 1)]
void compute(uint3 id : SV_DispatchThreadID) { output[id.xy] = id.y * 32 + id.x + 17; }
)";

ComPtr<ID3DBlob> compile(const char *entry, const char *profile) {
    ComPtr<ID3DBlob> code, errors;
    const HRESULT result = D3DCompile(shaders, sizeof shaders - 1, "warp-probe", nullptr, nullptr,
                                      entry, profile, D3DCOMPILE_ENABLE_STRICTNESS, 0, &code, &errors);
    if (FAILED(result) && errors) throw std::runtime_error(static_cast<const char *>(errors->GetBufferPointer()));
    check(result, "D3DCompile (d3dcompiler_47)");
    return code;
}

void png(const std::filesystem::path &path, std::vector<uint8_t> &pixels) {
    ComPtr<IWICImagingFactory> factory;
    check(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&factory)), "WIC");
    ComPtr<IWICStream> stream;
    check(factory->CreateStream(&stream), "WIC stream");
    check(stream->InitializeFromFilename(path.c_str(), GENERIC_WRITE), "PNG file");
    ComPtr<IWICBitmapEncoder> encoder;
    check(factory->CreateEncoder(GUID_ContainerFormatPng, nullptr, &encoder), "PNG encoder");
    check(encoder->Initialize(stream.Get(), WICBitmapEncoderNoCache), "PNG initialize");
    ComPtr<IWICBitmapFrameEncode> frame;
    check(encoder->CreateNewFrame(&frame, nullptr), "PNG frame");
    check(frame->Initialize(nullptr), "PNG frame initialize");
    check(frame->SetSize(size, size), "PNG size");
    WICPixelFormatGUID format = GUID_WICPixelFormat32bppRGBA;
    check(frame->SetPixelFormat(&format), "PNG format");
    require(IsEqualGUID(format, GUID_WICPixelFormat32bppRGBA), "WIC changed pixel format");
    check(frame->WritePixels(size, size * 4, UINT(pixels.size()), pixels.data()), "PNG pixels");
    check(frame->Commit(), "PNG frame commit");
    check(encoder->Commit(), "PNG commit");
}

class Probe {
public:
    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11DeviceContext> context;
    Json report = {{"schema", 1}, {"driver", "D3D_DRIVER_TYPE_WARP"}, {"featureLevel", "11_0"}};
    std::filesystem::path output;

    explicit Probe(std::filesystem::path path) : output(std::move(path)) {
        std::filesystem::create_directories(output);
    }

    template<class Function>
    void stage(const char *name, Function function) {
        const auto start = Clock::now();
        try {
            function();
            report["features"][name]["passed"] = true;
        } catch (const std::exception &error) {
            report["features"][name]["passed"] = false;
            report["features"][name]["error"] = error.what();
            throw;
        }
        const double elapsed = std::chrono::duration<double, std::milli>(Clock::now() - start).count();
        report["features"][name]["wallMs"] = elapsed;
        std::cout << name << ": passed, " << elapsed << " ms\n";
    }

    ComPtr<ID3D11Texture2D> texture(DXGI_FORMAT format, UINT bindings, UINT sample_count = 1) {
        D3D11_TEXTURE2D_DESC description{};
        description.Width = description.Height = size;
        description.MipLevels = description.ArraySize = 1;
        description.Format = format;
        description.SampleDesc.Count = sample_count;
        description.BindFlags = bindings;
        ComPtr<ID3D11Texture2D> result;
        check(device->CreateTexture2D(&description, nullptr, &result), "CreateTexture2D");
        return result;
    }

    std::vector<uint32_t> read(ID3D11Texture2D *source) {
        D3D11_TEXTURE2D_DESC description{};
        source->GetDesc(&description);
        description.BindFlags = description.MiscFlags = 0;
        description.Usage = D3D11_USAGE_STAGING;
        description.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
        ComPtr<ID3D11Texture2D> staging;
        check(device->CreateTexture2D(&description, nullptr, &staging), "staging texture");
        context->CopyResource(staging.Get(), source);
        D3D11_MAPPED_SUBRESOURCE mapped{};
        check(context->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped), "staging readback");
        std::vector<uint32_t> result(size * size);
        for (UINT y = 0; y < size; ++y)
            std::memcpy(result.data() + y * size, static_cast<const uint8_t *>(mapped.pData) + y * mapped.RowPitch,
                        size * sizeof(uint32_t));
        context->Unmap(staging.Get(), 0);
        return result;
    }

    void evidence(const char *name, const std::vector<uint32_t> &pixels) {
        std::vector<uint8_t> bytes(pixels.size() * 4);
        std::memcpy(bytes.data(), pixels.data(), bytes.size());
        png(output / name, bytes);
    }

    void create() {
        const D3D_FEATURE_LEVEL requested = D3D_FEATURE_LEVEL_11_0;
        D3D_FEATURE_LEVEL actual{};
        check(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP, nullptr, 0, &requested, 1, D3D11_SDK_VERSION,
                               &device, &actual, &context), "D3D11CreateDevice WARP");
        require(actual == requested, "wrong feature level");
        UINT quality = 0;
        check(device->CheckMultisampleQualityLevels(DXGI_FORMAT_R8G8B8A8_UNORM, samples, &quality), "MSAA quality");
        require(quality > 0, "4x colour MSAA absent");
        check(device->CheckMultisampleQualityLevels(DXGI_FORMAT_D32_FLOAT, samples, &quality), "depth MSAA quality");
        require(quality > 0, "4x depth MSAA absent");
    }

    void render() {
        auto colour = texture(DXGI_FORMAT_R8G8B8A8_UNORM, D3D11_BIND_RENDER_TARGET, samples);
        auto depth = texture(DXGI_FORMAT_R32_TYPELESS, D3D11_BIND_DEPTH_STENCIL | D3D11_BIND_SHADER_RESOURCE, samples);
        ComPtr<ID3D11RenderTargetView> target;
        check(device->CreateRenderTargetView(colour.Get(), nullptr, &target), "MSAA colour view");
        D3D11_DEPTH_STENCIL_VIEW_DESC depth_description{};
        depth_description.Format = DXGI_FORMAT_D32_FLOAT;
        depth_description.ViewDimension = D3D11_DSV_DIMENSION_TEXTURE2DMS;
        ComPtr<ID3D11DepthStencilView> depth_view;
        check(device->CreateDepthStencilView(depth.Get(), &depth_description, &depth_view), "MSAA depth view");
        const float clear[] = {1, 0, 0, 1};
        context->ClearRenderTargetView(target.Get(), clear);
        context->ClearDepthStencilView(depth_view.Get(), D3D11_CLEAR_DEPTH, .75f, 0);
        auto cube = make_cube();
        ComPtr<ID3D11ShaderResourceView> cube_view;
        check(device->CreateShaderResourceView(cube.Get(), nullptr, &cube_view), "cube SRV");
        D3D11_SAMPLER_DESC sampler_description{};
        sampler_description.Filter = D3D11_FILTER_MIN_MAG_MIP_POINT;
        sampler_description.AddressU = sampler_description.AddressV = sampler_description.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP;
        sampler_description.MaxLOD = D3D11_FLOAT32_MAX;
        ComPtr<ID3D11SamplerState> sampler;
        check(device->CreateSamplerState(&sampler_description, &sampler), "sampler");
        const auto vertex_code = compile("vertex", "vs_5_0"), pixel_code = compile("colour", "ps_5_0");
        ComPtr<ID3D11VertexShader> vertex;
        ComPtr<ID3D11PixelShader> pixel;
        check(device->CreateVertexShader(vertex_code->GetBufferPointer(), vertex_code->GetBufferSize(), nullptr, &vertex), "VS");
        check(device->CreatePixelShader(pixel_code->GetBufferPointer(), pixel_code->GetBufferSize(), nullptr, &pixel), "PS");
        D3D11_VIEWPORT viewport{0, 0, float(size), float(size), 0, 1};
        D3D11_RASTERIZER_DESC raster_description{};
        raster_description.FillMode = D3D11_FILL_SOLID;
        raster_description.CullMode = D3D11_CULL_NONE;
        raster_description.DepthClipEnable = TRUE;
        raster_description.MultisampleEnable = TRUE;
        ComPtr<ID3D11RasterizerState> raster;
        check(device->CreateRasterizerState(&raster_description, &raster), "rasterizer state");
        context->RSSetState(raster.Get());
        context->RSSetViewports(1, &viewport);
        context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        context->VSSetShader(vertex.Get(), nullptr, 0);
        context->PSSetShader(pixel.Get(), nullptr, 0);
        context->PSSetShaderResources(0, 1, cube_view.GetAddressOf());
        context->PSSetSamplers(0, 1, sampler.GetAddressOf());
        context->OMSetRenderTargets(1, target.GetAddressOf(), depth_view.Get());
        context->Draw(3, 0);
        context->OMSetRenderTargets(0, nullptr, nullptr);
        auto resolved = texture(DXGI_FORMAT_R8G8B8A8_UNORM, 0);
        context->ResolveSubresource(resolved.Get(), 0, colour.Get(), 0, DXGI_FORMAT_R8G8B8A8_UNORM);
        const auto pixels = read(resolved.Get());
        evidence("colour-cube-clip-msaa.png", pixels);
        report["colourSamples"] = {pixels[8 * size + 8], pixels[8 * size + 24]};
        for (UINT y = 0; y < size; ++y)
            for (UINT x = 0; x < size; ++x)
                require(pixels[y * size + x] == (x < size / 2 ? 0xff0000ffu : 0xffff0000u), "cube/clip/colour resolve pixel mismatch");
        resolve_depth(depth.Get());
        copy_region(resolved.Get());
    }

    ComPtr<ID3D11Texture2D> make_cube() {
        D3D11_TEXTURE2D_DESC description{};
        description.Width = description.Height = description.MipLevels = 1;
        description.ArraySize = 6;
        description.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
        description.SampleDesc.Count = 1;
        description.BindFlags = D3D11_BIND_SHADER_RESOURCE;
        description.MiscFlags = D3D11_RESOURCE_MISC_TEXTURECUBE;
        const std::array<uint32_t, 6> colours = {0xff0000ff, 0xff00ff00, 0xff00ffff, 0xffff00ff, 0xffff0000, 0xffffffff};
        std::array<D3D11_SUBRESOURCE_DATA, 6> data{};
        for (size_t face = 0; face < data.size(); ++face) data[face] = {&colours[face], 4, 4};
        ComPtr<ID3D11Texture2D> cube;
        check(device->CreateTexture2D(&description, data.data(), &cube), "cube texture");
        return cube;
    }

    void resolve_depth(ID3D11Texture2D *source) {
        D3D11_SHADER_RESOURCE_VIEW_DESC view_description{};
        view_description.Format = DXGI_FORMAT_R32_FLOAT;
        view_description.ViewDimension = D3D11_SRV_DIMENSION_TEXTURE2DMS;
        ComPtr<ID3D11ShaderResourceView> view;
        check(device->CreateShaderResourceView(source, &view_description, &view), "MS depth SRV");
        auto resolved = texture(DXGI_FORMAT_R32_TYPELESS, D3D11_BIND_DEPTH_STENCIL);
        D3D11_DEPTH_STENCIL_VIEW_DESC depth_description{};
        depth_description.Format = DXGI_FORMAT_D32_FLOAT;
        depth_description.ViewDimension = D3D11_DSV_DIMENSION_TEXTURE2D;
        ComPtr<ID3D11DepthStencilView> target;
        check(device->CreateDepthStencilView(resolved.Get(), &depth_description, &target), "resolved depth DSV");
        D3D11_DEPTH_STENCIL_DESC state_description{};
        state_description.DepthEnable = TRUE;
        state_description.DepthWriteMask = D3D11_DEPTH_WRITE_MASK_ALL;
        state_description.DepthFunc = D3D11_COMPARISON_ALWAYS;
        ComPtr<ID3D11DepthStencilState> state;
        check(device->CreateDepthStencilState(&state_description, &state), "depth write state");
        const auto vertex_code = compile("fullscreen", "vs_5_0"), pixel_code = compile("depthResolve", "ps_5_0");
        ComPtr<ID3D11VertexShader> vertex;
        ComPtr<ID3D11PixelShader> pixel;
        check(device->CreateVertexShader(vertex_code->GetBufferPointer(), vertex_code->GetBufferSize(), nullptr, &vertex), "depth VS");
        check(device->CreatePixelShader(pixel_code->GetBufferPointer(), pixel_code->GetBufferSize(), nullptr, &pixel), "depth PS");
        context->VSSetShader(vertex.Get(), nullptr, 0);
        context->PSSetShader(pixel.Get(), nullptr, 0);
        context->PSSetShaderResources(0, 1, view.GetAddressOf());
        context->OMSetDepthStencilState(state.Get(), 0);
        context->OMSetRenderTargets(0, nullptr, target.Get());
        context->Draw(3, 0);
        context->OMSetRenderTargets(0, nullptr, nullptr);
        const auto values = read(resolved.Get());
        std::vector<uint32_t> image(values.size());
        for (UINT y = 0; y < size; ++y) {
            for (UINT x = 0; x < size; ++x) {
                float value = 0;
                std::memcpy(&value, &values[y * size + x], sizeof value);
                require(std::abs(value - (x < size / 2 ? .75f : .25f)) < .00001f, "SV_Depth resolve mismatch");
                const uint32_t grey = uint32_t(std::lround(value * 255));
                image[y * size + x] = 0xff000000u | grey | (grey << 8) | (grey << 16);
            }
        }
        evidence("depth-resolve.png", image);
    }

    void copy_region(ID3D11Texture2D *source) {
        auto destination = texture(DXGI_FORMAT_R8G8B8A8_UNORM, D3D11_BIND_RENDER_TARGET);
        ComPtr<ID3D11RenderTargetView> target;
        check(device->CreateRenderTargetView(destination.Get(), nullptr, &target), "copy target");
        const float clear[] = {0, 0, 0, 1};
        context->ClearRenderTargetView(target.Get(), clear);
        const D3D11_BOX region{24, 8, 0, 32, 16, 1};
        context->CopySubresourceRegion(destination.Get(), 0, 0, 0, 0, source, 0, &region);
        const auto pixels = read(destination.Get());
        for (UINT y = 0; y < size; ++y)
            for (UINT x = 0; x < size; ++x)
                require(pixels[y * size + x] == (x < 8 && y < 8 ? 0xffff0000u : 0xff000000u), "copy region mismatch");
        evidence("copy-region.png", pixels);
    }

    void compute() {
        auto destination = texture(DXGI_FORMAT_R32_UINT, D3D11_BIND_UNORDERED_ACCESS);
        ComPtr<ID3D11UnorderedAccessView> view;
        check(device->CreateUnorderedAccessView(destination.Get(), nullptr, &view), "UAV");
        const auto code = compile("compute", "cs_5_0");
        ComPtr<ID3D11ComputeShader> shader;
        check(device->CreateComputeShader(code->GetBufferPointer(), code->GetBufferSize(), nullptr, &shader), "CS");
        context->CSSetShader(shader.Get(), nullptr, 0);
        context->CSSetUnorderedAccessViews(0, 1, view.GetAddressOf(), nullptr);
        context->Dispatch(size / 8, size / 8, 1);
        ID3D11UnorderedAccessView *empty = nullptr;
        context->CSSetUnorderedAccessViews(0, 1, &empty, nullptr);
        const auto values = read(destination.Get());
        std::vector<uint32_t> image(values.size());
        for (size_t index = 0; index < values.size(); ++index) {
            require(values[index] == index + 17, "compute UAV mismatch");
            image[index] = 0xff000000u | uint32_t(index % 256) * 0x010101u;
        }
        evidence("compute-uav.png", image);
    }

    template<class Value>
    Value query(ID3D11Query *query_object) {
        Value value{};
        const auto deadline = Clock::now() + std::chrono::seconds(10);
        HRESULT status = S_FALSE;
        while ((status = context->GetData(query_object, &value, sizeof value, 0)) == S_FALSE) {
            require(Clock::now() < deadline, "timestamp query timeout");
            SwitchToThread();
        }
        check(status, "GetData timestamp");
        return value;
    }

    void timestamp() {
        const auto make = [&](D3D11_QUERY type) {
            ComPtr<ID3D11Query> value;
            const D3D11_QUERY_DESC description{type, 0};
            check(device->CreateQuery(&description, &value), "CreateQuery");
            return value;
        };
        auto disjoint = make(D3D11_QUERY_TIMESTAMP_DISJOINT);
        auto start = make(D3D11_QUERY_TIMESTAMP), end = make(D3D11_QUERY_TIMESTAMP);
        context->Begin(disjoint.Get());
        context->End(start.Get());
        stage("msaa-colour-depth-cube-clip-resolve-copy-readback", [&] { render(); });
        stage("compute-uav-readback", [&] { compute(); });
        context->End(end.Get());
        context->End(disjoint.Get());
        context->Flush();
        const auto frequency = query<D3D11_QUERY_DATA_TIMESTAMP_DISJOINT>(disjoint.Get());
        const auto first = query<UINT64>(start.Get()), last = query<UINT64>(end.Get());
        require(!frequency.Disjoint && frequency.Frequency > 0 && last >= first, "invalid/disjoint timestamps");
        report["timestampMs"] = double(last - first) * 1000 / double(frequency.Frequency);
        report["timestampFrequencyHz"] = frequency.Frequency;
    }

    void flip() {
        const HWND window = CreateWindowExW(0, L"STATIC", L"WARP flip probe", WS_OVERLAPPEDWINDOW,
                                            0, 0, 128, 128, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
        if (!window) {
            report["flip"] = {{"created", false}, {"win32Error", GetLastError()}};
            return;
        }
        ShowWindow(window, SW_SHOW);
        ComPtr<IDXGIDevice> dxgi;
        ComPtr<IDXGIAdapter> adapter;
        ComPtr<IDXGIFactory2> factory;
        check(device.As(&dxgi), "DXGI device");
        check(dxgi->GetAdapter(&adapter), "DXGI adapter");
        check(adapter->GetParent(IID_PPV_ARGS(&factory)), "DXGI factory");
        DXGI_SWAP_CHAIN_DESC1 description{};
        description.Width = description.Height = 128;
        description.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
        description.SampleDesc.Count = 1;
        description.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
        description.BufferCount = 2;
        description.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD;
        ComPtr<IDXGISwapChain1> swapchain;
        const HRESULT created = factory->CreateSwapChainForHwnd(device.Get(), window, &description, nullptr, nullptr, &swapchain);
        report["flip"] = {{"created", SUCCEEDED(created)}, {"createHresult", uint32_t(created)}};
        if (SUCCEEDED(created)) {
            const HRESULT presented = swapchain->Present(0, 0);
            report["flip"]["presentHresult"] = uint32_t(presented);
            report["flip"]["presentSucceeded"] = SUCCEEDED(presented);
            report["flip"]["occluded"] = presented == DXGI_STATUS_OCCLUDED;
        }
        swapchain.Reset();
        DestroyWindow(window);
    }
};
}

int main(int argc, char **argv) {
    const auto start = Clock::now();
    Probe probe(argc > 1 ? argv[1] : "warp-evidence");
    int exit_code = 0;
    const HRESULT com = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    try {
        check(com, "CoInitializeEx");
        probe.stage("warp-feature-level-11_0", [&] { probe.create(); });
        probe.stage("timestamp-query", [&] { probe.timestamp(); });
        try {
            probe.stage("flip-session-probe", [&] { probe.flip(); });
        } catch (const std::exception &error) {
            probe.report["flip"]["error"] = error.what();
        }
    } catch (const std::exception &error) {
        probe.report["error"] = error.what();
        std::cerr << error.what() << '\n';
        exit_code = 1;
    }
    probe.report["passed"] = exit_code == 0;
    probe.report["totalWallMs"] = std::chrono::duration<double, std::milli>(Clock::now() - start).count();
    std::ofstream(probe.output / "report.json") << probe.report.dump(2) << '\n';
    std::cout << probe.report.dump(2) << '\n';
    if (SUCCEEDED(com)) CoUninitialize();
    return exit_code;
}
