#include "low_latency.hpp"
#include "anti_lag_windows.hpp"
#include <windows.h>
#include <d3d11.h>
#include <d3dcompiler.h>
#include <dxgi1_5.h>
#include <wrl/client.h>
#include <SDL3/SDL_opengl.h>
#include "nvapi/nvapi_reflex.h"
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <iterator>

namespace native {
namespace {

using Microsoft::WRL::ComPtr;

constexpr UINT swapchain_buffers = 2;
constexpr UINT max_frame_latency = 1;
constexpr DWORD frame_wait_timeout_ms = 100;
constexpr GLenum wgl_access_write_discard = 0x0002;
constexpr unsigned microseconds_per_second = 1'000'000;
constexpr UINT nvidia_vendor = 0x10de, amd_vendor = 0x1002, intel_vendor = 0x8086;

// The GL frame is bottom-up; D3D reads textures top-down. One triangle covers the back buffer and samples the
// frame upside down, which shows it right side up.
constexpr char blit_shader[] = R"(
Texture2D frame : register(t0);
SamplerState nearest : register(s0);
struct Vertex { float4 position : SV_Position; float2 uv : TEXCOORD0; };
Vertex vs_main(uint id : SV_VertexID) {
    Vertex v;
    v.uv = float2((id << 1) & 2, id & 2);
    v.position = float4(v.uv * float2(2, -2) + float2(-1, 1), 0, 1);
    return v;
}
float4 ps_main(Vertex v) : SV_Target { return frame.Sample(nearest, float2(v.uv.x, 1 - v.uv.y)); }
)";

std::string hresult_text(const char *what, HRESULT result) {
    char text[96];
    std::snprintf(text, sizeof text, "%s failed (0x%08lx)", what, static_cast<unsigned long>(result));
    return text;
}

HWND window_handle(SDL_Window *window) {
    return static_cast<HWND>(
            SDL_GetPointerProperty(SDL_GetWindowProperties(window), SDL_PROP_WINDOW_WIN32_HWND_POINTER, nullptr)
    );
}

// WGL_NV_DX_interop2 and the GL framebuffer calls this file makes, loaded with the game's context current.
struct GlInterop {
    using Open = HANDLE(WINAPI *)(void *);
    using Close = BOOL(WINAPI *)(HANDLE);
    using Register = HANDLE(WINAPI *)(HANDLE, void *, GLuint, GLenum, GLenum);
    using Unregister = BOOL(WINAPI *)(HANDLE, HANDLE);
    using Lock = BOOL(WINAPI *)(HANDLE, GLint, HANDLE *);
    using Extensions = const char *(WINAPI *)(HDC);

    Open open = nullptr;
    Close close = nullptr;
    Register register_object = nullptr;
    Unregister unregister_object = nullptr;
    Lock lock = nullptr;
    Lock unlock = nullptr;
    PFNGLGENFRAMEBUFFERSPROC GenFramebuffers = nullptr;
    PFNGLDELETEFRAMEBUFFERSPROC DeleteFramebuffers = nullptr;
    PFNGLBINDFRAMEBUFFERPROC BindFramebuffer = nullptr;
    PFNGLFRAMEBUFFERTEXTURE2DPROC FramebufferTexture2D = nullptr;
    PFNGLFRAMEBUFFERRENDERBUFFERPROC FramebufferRenderbuffer = nullptr;
    PFNGLCHECKFRAMEBUFFERSTATUSPROC CheckFramebufferStatus = nullptr;
    PFNGLGENRENDERBUFFERSPROC GenRenderbuffers = nullptr;
    PFNGLDELETERENDERBUFFERSPROC DeleteRenderbuffers = nullptr;
    PFNGLBINDRENDERBUFFERPROC BindRenderbuffer = nullptr;
    PFNGLRENDERBUFFERSTORAGEPROC RenderbufferStorage = nullptr;

    template <class Function>
    static void find(Function &function, const char *name) {
        function = reinterpret_cast<Function>(SDL_GL_GetProcAddress(name));
    }

    bool load() {
        Extensions extensions = nullptr;
        find(extensions, "wglGetExtensionsStringARB");
        const char *list = extensions ? extensions(wglGetCurrentDC()) : nullptr;
        if (!list || !std::strstr(list, "WGL_NV_DX_interop2")) return false;
        find(open, "wglDXOpenDeviceNV");
        find(close, "wglDXCloseDeviceNV");
        find(register_object, "wglDXRegisterObjectNV");
        find(unregister_object, "wglDXUnregisterObjectNV");
        find(lock, "wglDXLockObjectsNV");
        find(unlock, "wglDXUnlockObjectsNV");
        find(GenFramebuffers, "glGenFramebuffers");
        find(DeleteFramebuffers, "glDeleteFramebuffers");
        find(BindFramebuffer, "glBindFramebuffer");
        find(FramebufferTexture2D, "glFramebufferTexture2D");
        find(FramebufferRenderbuffer, "glFramebufferRenderbuffer");
        find(CheckFramebufferStatus, "glCheckFramebufferStatus");
        find(GenRenderbuffers, "glGenRenderbuffers");
        find(DeleteRenderbuffers, "glDeleteRenderbuffers");
        find(BindRenderbuffer, "glBindRenderbuffer");
        find(RenderbufferStorage, "glRenderbufferStorage");
        return open && close && register_object && unregister_object && lock && unlock && GenFramebuffers
               && DeleteFramebuffers && BindFramebuffer && FramebufferTexture2D && FramebufferRenderbuffer
               && CheckFramebufferStatus && GenRenderbuffers && DeleteRenderbuffers && BindRenderbuffer
               && RenderbufferStorage;
    }
};

// NVIDIA Reflex through the driver's nvapi64.dll; nothing is linked, so other cards just don't find it.
class Reflex {
public:
    bool load() {
        if (loaded_) return true;
        module_ = LoadLibraryW(L"nvapi64.dll");
        if (!module_) return false;
        const auto query = reinterpret_cast<Query>(GetProcAddress(module_, "nvapi_QueryInterface"));
        if (!query) return false;
        const auto initialize = reinterpret_cast<Initialize>(query(NVAPI_ID_INITIALIZE));
        set_sleep_mode_ = reinterpret_cast<SetSleepMode>(query(NVAPI_ID_D3D_SET_SLEEP_MODE));
        sleep_ = reinterpret_cast<Sleep>(query(NVAPI_ID_D3D_SLEEP));
        marker_ = reinterpret_cast<Marker>(query(NVAPI_ID_D3D_SET_LATENCY_MARKER));
        loaded_ = initialize && set_sleep_mode_ && sleep_ && marker_ && initialize() == NVAPI_OK;
        return loaded_;
    }

    bool set_mode(IUnknown *device, bool enabled, bool boost, unsigned interval_us) const {
        if (!loaded_) return false;
        NV_SET_SLEEP_MODE_PARAMS params{};
        params.version = NV_SET_SLEEP_MODE_PARAMS_VER;
        params.bLowLatencyMode = enabled;
        params.bLowLatencyBoost = boost;
        params.minimumIntervalUs = interval_us;
        params.bUseMarkersToOptimize = 0;
        return set_sleep_mode_(device, &params) == NVAPI_OK;
    }

    void sleep(IUnknown *device) const { sleep_(device); }

    void marker(IUnknown *device, uint64_t frame, NV_LATENCY_MARKER_TYPE type) const {
        NV_LATENCY_MARKER_PARAMS params{};
        params.version = NV_LATENCY_MARKER_PARAMS_VER;
        params.frameID = frame;
        params.markerType = type;
        marker_(device, &params);
    }

private:
    using Query = void *(__cdecl *)(NvU32);
    using Initialize = NvAPI_Status(__cdecl *)();
    using SetSleepMode = NvAPI_Status(__cdecl *)(IUnknown *, NV_SET_SLEEP_MODE_PARAMS *);
    using Sleep = NvAPI_Status(__cdecl *)(IUnknown *);
    using Marker = NvAPI_Status(__cdecl *)(IUnknown *, NV_LATENCY_MARKER_PARAMS *);

    // The driver asks applications not to unload NVAPI, so the module stays for the process's life.
    HMODULE module_ = nullptr;
    bool loaded_ = false;
    SetSleepMode set_sleep_mode_ = nullptr;
    Sleep sleep_ = nullptr;
    Marker marker_ = nullptr;
};

Reflex &reflex() {
    static Reflex instance;
    return instance;
}

// The adapter GL draws with, by vendor, so both APIs share one card on laptops with two.
UINT gl_vendor_id() {
    const auto *vendor = reinterpret_cast<const char *>(glGetString(GL_VENDOR));
    if (!vendor) return 0;
    if (std::strstr(vendor, "NVIDIA")) return nvidia_vendor;
    if (std::strstr(vendor, "ATI") || std::strstr(vendor, "AMD")) return amd_vendor;
    if (std::strstr(vendor, "Intel")) return intel_vendor;
    return 0;
}

ComPtr<IDXGIAdapter1> matching_adapter(IDXGIFactory1 *factory, UINT vendor) {
    ComPtr<IDXGIAdapter1> adapter;
    for (UINT index = 0; vendor && factory->EnumAdapters1(index, &adapter) != DXGI_ERROR_NOT_FOUND; ++index) {
        DXGI_ADAPTER_DESC1 description{};
        if (SUCCEEDED(adapter->GetDesc1(&description)) && description.VendorId == vendor) return adapter;
    }
    return nullptr;
}

ComPtr<ID3D11Device> create_device(ComPtr<ID3D11DeviceContext> &context, std::string &error) {
    ComPtr<IDXGIFactory1> factory;
    HRESULT result = CreateDXGIFactory1(IID_PPV_ARGS(&factory));
    if (FAILED(result)) {
        error = hresult_text("CreateDXGIFactory1", result);
        return nullptr;
    }
    const auto adapter = matching_adapter(factory.Get(), gl_vendor_id());
    const D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_10_0};
    ComPtr<ID3D11Device> device;
    result = D3D11CreateDevice(
            adapter.Get(),
            adapter ? D3D_DRIVER_TYPE_UNKNOWN : D3D_DRIVER_TYPE_HARDWARE,
            nullptr,
            0,
            levels,
            UINT(std::size(levels)),
            D3D11_SDK_VERSION,
            &device,
            nullptr,
            &context
    );
    if (FAILED(result)) {
        error = hresult_text("D3D11CreateDevice", result);
        return nullptr;
    }
    return device;
}

ComPtr<ID3DBlob> compile(const char *entry, const char *profile, std::string &error) {
    static const HMODULE compiler = LoadLibraryW(L"d3dcompiler_47.dll");
    const auto function = compiler ? reinterpret_cast<pD3DCompile>(GetProcAddress(compiler, "D3DCompile")) : nullptr;
    if (!function) {
        error = "d3dcompiler_47.dll is missing";
        return nullptr;
    }
    ComPtr<ID3DBlob> code, messages;
    const HRESULT result = function(
            blit_shader, sizeof blit_shader - 1, "blit", nullptr, nullptr, entry, profile, 0, 0, &code, &messages
    );
    if (FAILED(result)) {
        error = messages ? static_cast<const char *>(messages->GetBufferPointer()) : hresult_text("D3DCompile", result);
        return nullptr;
    }
    return code;
}

}  // namespace

// The D3D11 device, swapchain and the texture GL draws into, and the GL framebuffer around that texture.
struct LowLatencyPresenter::Impl {
    GlInterop gl;
    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11DeviceContext> context;
    ComPtr<IDXGISwapChain2> swapchain;
    ComPtr<ID3D11RenderTargetView> back_buffer;
    ComPtr<ID3D11Texture2D> frame;
    ComPtr<ID3D11ShaderResourceView> frame_view;
    ComPtr<ID3D11VertexShader> vertex_shader;
    ComPtr<ID3D11PixelShader> pixel_shader;
    ComPtr<ID3D11SamplerState> sampler;
    HANDLE waitable = nullptr;
    HANDLE interop_device = nullptr;
    HANDLE interop_frame = nullptr;
    GLuint framebuffer = 0, frame_texture = 0, depth = 0;
    UINT width = 0, height = 0, swap_flags = 0;
    bool tearing = false, locked = false, use_reflex = false, use_anti_lag = false, flash_indicator = false;
    unsigned anti_lag_fps = 0;
    uint64_t frame_id = 0;

    ~Impl() { release(); }

    bool create(SDL_Window *window, std::string &error) {
        if (!gl.load()) {
            error = "This graphics driver has no OpenGL–Direct3D interop";
            return false;
        }
        device = create_device(context, error);
        if (!device) return false;
        interop_device = gl.open(device.Get());
        if (!interop_device) {
            error = "The OpenGL driver couldn't open the Direct3D device";
            return false;
        }
        return create_swapchain(window_handle(window), error) && create_blit(error);
    }

    bool create_swapchain(HWND hwnd, std::string &error) {
        ComPtr<IDXGIDevice> dxgi_device;
        ComPtr<IDXGIAdapter> adapter;
        ComPtr<IDXGIFactory2> factory;
        if (!hwnd || FAILED(device.As(&dxgi_device)) || FAILED(dxgi_device->GetAdapter(&adapter))
            || FAILED(adapter->GetParent(IID_PPV_ARGS(&factory)))) {
            error = "No DXGI factory for the window";
            return false;
        }
        ComPtr<IDXGIFactory5> factory5;
        BOOL allow_tearing = FALSE;
        if (SUCCEEDED(factory.As(&factory5)))
            factory5->CheckFeatureSupport(DXGI_FEATURE_PRESENT_ALLOW_TEARING, &allow_tearing, sizeof allow_tearing);
        tearing = allow_tearing == TRUE;
        swap_flags = DXGI_SWAP_CHAIN_FLAG_FRAME_LATENCY_WAITABLE_OBJECT
                     | (tearing ? DXGI_SWAP_CHAIN_FLAG_ALLOW_TEARING : 0u);
        DXGI_SWAP_CHAIN_DESC1 description{};
        description.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
        description.SampleDesc.Count = 1;
        description.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
        description.BufferCount = swapchain_buffers;
        description.Scaling = DXGI_SCALING_NONE;
        description.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD;
        description.AlphaMode = DXGI_ALPHA_MODE_IGNORE;
        description.Flags = swap_flags;
        ComPtr<IDXGISwapChain1> created;
        const HRESULT result =
                factory->CreateSwapChainForHwnd(device.Get(), hwnd, &description, nullptr, nullptr, &created);
        if (FAILED(result)) {
            error = result == E_ACCESSDENIED ? "The window is already presented by OpenGL; restart the game to use it"
                                             : hresult_text("CreateSwapChainForHwnd", result);
            return false;
        }
        // Alt+Enter is the game's own (borderless and exclusive go through SDL).
        factory->MakeWindowAssociation(hwnd, DXGI_MWA_NO_ALT_ENTER);
        if (FAILED(created.As(&swapchain))) {
            error = "DXGI 1.3 is needed";
            return false;
        }
        swapchain->SetMaximumFrameLatency(max_frame_latency);
        waitable = swapchain->GetFrameLatencyWaitableObject();
        return true;
    }

    bool create_blit(std::string &error) {
        const auto vertex = compile("vs_main", "vs_4_0", error);
        const auto pixel = vertex ? compile("ps_main", "ps_4_0", error) : nullptr;
        if (!pixel) return false;
        D3D11_SAMPLER_DESC nearest{};
        nearest.Filter = D3D11_FILTER_MIN_MAG_MIP_POINT;
        nearest.AddressU = nearest.AddressV = nearest.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP;
        nearest.MaxLOD = D3D11_FLOAT32_MAX;
        if (FAILED(device->CreateVertexShader(
                    vertex->GetBufferPointer(), vertex->GetBufferSize(), nullptr, &vertex_shader
            ))
            || FAILED(
                    device->CreatePixelShader(pixel->GetBufferPointer(), pixel->GetBufferSize(), nullptr, &pixel_shader)
            )
            || FAILED(device->CreateSamplerState(&nearest, &sampler))) {
            error = "Creating the present shaders failed";
            return false;
        }
        return true;
    }

    // The back buffer and the frame texture at the window's size, and the GL framebuffer drawing into it.
    bool resize(UINT new_width, UINT new_height, std::string &error) {
        release_frame();
        HRESULT result = swapchain->ResizeBuffers(0, new_width, new_height, DXGI_FORMAT_UNKNOWN, swap_flags);
        ComPtr<ID3D11Texture2D> buffer;
        if (SUCCEEDED(result)) result = swapchain->GetBuffer(0, IID_PPV_ARGS(&buffer));
        if (SUCCEEDED(result)) result = device->CreateRenderTargetView(buffer.Get(), nullptr, &back_buffer);
        D3D11_TEXTURE2D_DESC description{};
        description.Width = new_width;
        description.Height = new_height;
        description.MipLevels = description.ArraySize = 1;
        description.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
        description.SampleDesc.Count = 1;
        description.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
        if (SUCCEEDED(result)) result = device->CreateTexture2D(&description, nullptr, &frame);
        if (SUCCEEDED(result)) result = device->CreateShaderResourceView(frame.Get(), nullptr, &frame_view);
        if (FAILED(result)) {
            error = hresult_text("Resizing the swapchain", result);
            return false;
        }
        width = new_width;
        height = new_height;
        return create_framebuffer(error);
    }

    bool create_framebuffer(std::string &error) {
        glGenTextures(1, &frame_texture);
        interop_frame =
                gl.register_object(interop_device, frame.Get(), frame_texture, GL_TEXTURE_2D, wgl_access_write_discard);
        if (!interop_frame) {
            error = "The OpenGL driver couldn't share the frame texture";
            return false;
        }
        gl.GenRenderbuffers(1, &depth);
        gl.BindRenderbuffer(GL_RENDERBUFFER, depth);
        gl.RenderbufferStorage(GL_RENDERBUFFER, GL_DEPTH24_STENCIL8, GLsizei(width), GLsizei(height));
        gl.GenFramebuffers(1, &framebuffer);
        gl.BindFramebuffer(GL_FRAMEBUFFER, framebuffer);
        if (!lock_frame()) {
            error = "The OpenGL driver couldn't lock the frame texture";
            return false;
        }
        gl.FramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, frame_texture, 0);
        gl.FramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_STENCIL_ATTACHMENT, GL_RENDERBUFFER, depth);
        const bool complete = gl.CheckFramebufferStatus(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE;
        unlock_frame();
        gl.BindFramebuffer(GL_FRAMEBUFFER, 0);
        if (!complete) error = "The shared frame isn't a complete framebuffer";
        return complete;
    }

    bool lock_frame() {
        locked = interop_frame && gl.lock(interop_device, 1, &interop_frame);
        return locked;
    }

    void unlock_frame() {
        if (locked) gl.unlock(interop_device, 1, &interop_frame);
        locked = false;
    }

    // The GL frame into the back buffer, right side up.
    void blit() {
        const D3D11_VIEWPORT viewport{0, 0, float(width), float(height), 0, 1};
        ID3D11RenderTargetView *target = back_buffer.Get();
        ID3D11ShaderResourceView *source = frame_view.Get();
        ID3D11SamplerState *nearest = sampler.Get();
        ID3D11ShaderResourceView *none = nullptr;
        context->OMSetRenderTargets(1, &target, nullptr);
        context->RSSetViewports(1, &viewport);
        context->IASetInputLayout(nullptr);
        context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        context->VSSetShader(vertex_shader.Get(), nullptr, 0);
        context->PSSetShader(pixel_shader.Get(), nullptr, 0);
        context->PSSetShaderResources(0, 1, &source);
        context->PSSetSamplers(0, 1, &nearest);
        context->Draw(3, 0);
        context->PSSetShaderResources(0, 1, &none);
    }

    void release_frame() {
        unlock_frame();
        if (interop_frame) gl.unregister_object(interop_device, interop_frame);
        interop_frame = nullptr;
        if (framebuffer) gl.DeleteFramebuffers(1, &framebuffer);
        if (depth) gl.DeleteRenderbuffers(1, &depth);
        if (frame_texture) glDeleteTextures(1, &frame_texture);
        framebuffer = depth = frame_texture = 0;
        frame_view.Reset();
        frame.Reset();
        back_buffer.Reset();
        if (context) context->ClearState();
        width = height = 0;
    }

    void release() {
        if (use_reflex && device) reflex().set_mode(device.Get(), false, false, 0);
        if (use_anti_lag) anti_lag::shutdown();
        if (gl.BindFramebuffer) gl.BindFramebuffer(GL_FRAMEBUFFER, 0);
        release_frame();
        if (interop_device) gl.close(interop_device);
        interop_device = nullptr;
        if (waitable) CloseHandle(waitable);
        waitable = nullptr;
        swapchain.Reset();
        if (context) context->Flush();
    }
};

LowLatencyPresenter::LowLatencyPresenter() = default;

void LowLatencyPresenter::fail(std::string reason) {
    std::cerr << "Low latency mode: " << reason << '\n';
    impl_.reset();
    error_ = reason;
    failure_ = std::move(reason);
}

LowLatencyPresenter::~LowLatencyPresenter() = default;

const LowLatencySupport &LowLatencyPresenter::support(SDL_Window *) {
    if (probed_) return support_;
    probed_ = true;
    GlInterop gl;
    if (!gl.load()) return support_;
    std::string error;
    ComPtr<ID3D11DeviceContext> context;
    const auto device = create_device(context, error);
    if (!device) return support_;
    const HANDLE interop = gl.open(device.Get());
    if (!interop) return support_;
    gl.close(interop);
    support_.dxgi = true;
    support_.reflex = reflex().load() && reflex().set_mode(device.Get(), false, false, 0);
    support_.anti_lag = !support_.reflex && anti_lag::initialize();
    if (support_.anti_lag) anti_lag::shutdown();
    return support_;
}

bool LowLatencyPresenter::configure(SDL_Window *window, LowLatencyMode mode, int fps_limit, bool flash_indicator) {
    error_.clear();
    if (mode == LowLatencyMode::off) {
        impl_.reset();
        return true;
    }
    if (!support(window).dxgi) {
        error_ = "Low latency mode needs OpenGL–Direct3D interop, which this graphics driver doesn't have";
        return false;
    }
    if (!impl_) {
        auto created = std::make_unique<Impl>();
        if (!created->create(window, error_)) return false;
        impl_ = std::move(created);
    }
    const unsigned interval_us = fps_limit > 0 ? microseconds_per_second / unsigned(fps_limit) : 0;
    impl_->use_reflex =
            support_.reflex && reflex().set_mode(impl_->device.Get(), true, mode == LowLatencyMode::boost, interval_us);
    impl_->use_anti_lag = !impl_->use_reflex && support_.anti_lag && anti_lag::initialize();
    impl_->anti_lag_fps = fps_limit > 0 ? unsigned(fps_limit) : 0;
    impl_->flash_indicator = flash_indicator;
    return true;
}

bool LowLatencyPresenter::active() const {
    return bool(impl_);
}

std::string_view LowLatencyPresenter::technique() const {
    if (!impl_) return {};
    if (impl_->use_reflex) return "Reflex";
    return impl_->use_anti_lag ? "Anti-Lag 2" : "DXGI";
}

void LowLatencyPresenter::frame_start() {
    if (!impl_) return;
    auto &state = *impl_;
    ++state.frame_id;
    if (state.use_reflex) {
        reflex().sleep(state.device.Get());
        reflex().marker(state.device.Get(), state.frame_id, SIMULATION_START);
        reflex().marker(state.device.Get(), state.frame_id, INPUT_SAMPLE);
    } else if (state.use_anti_lag) {
        anti_lag::update(true, state.anti_lag_fps);
    } else if (state.waitable) {
        WaitForSingleObjectEx(state.waitable, frame_wait_timeout_ms, TRUE);
    }
}

void LowLatencyPresenter::render_start(int width, int height) {
    if (!impl_ || width <= 0 || height <= 0) return;
    auto &state = *impl_;
    if (state.use_reflex) {
        reflex().marker(state.device.Get(), state.frame_id, SIMULATION_END);
        reflex().marker(state.device.Get(), state.frame_id, RENDERSUBMIT_START);
    }
    std::string error;
    if ((UINT(width) != state.width || UINT(height) != state.height) && !state.resize(UINT(width), UINT(height), error))
        return fail(error);
    if (!state.lock_frame()) return fail("The OpenGL driver couldn't lock the frame texture");
    state.gl.BindFramebuffer(GL_FRAMEBUFFER, state.framebuffer);
}

void LowLatencyPresenter::present(bool vsync) {
    if (!impl_ || !impl_->locked) return;
    auto &state = *impl_;
    state.gl.BindFramebuffer(GL_FRAMEBUFFER, 0);
    state.unlock_frame();
    state.blit();
    if (state.use_reflex) {
        reflex().marker(state.device.Get(), state.frame_id, RENDERSUBMIT_END);
        reflex().marker(state.device.Get(), state.frame_id, PRESENT_START);
    }
    const UINT flags = !vsync && state.tearing ? DXGI_PRESENT_ALLOW_TEARING : 0;
    const HRESULT result = state.swapchain->Present(vsync ? 1 : 0, flags);
    if (state.use_reflex) reflex().marker(state.device.Get(), state.frame_id, PRESENT_END);
    if (FAILED(result)) fail(hresult_text("Present", result));
}

void LowLatencyPresenter::trigger_flash() {
    if (impl_ && impl_->use_reflex && impl_->flash_indicator)
        reflex().marker(impl_->device.Get(), impl_->frame_id, TRIGGER_FLASH);
}

}  // namespace native
