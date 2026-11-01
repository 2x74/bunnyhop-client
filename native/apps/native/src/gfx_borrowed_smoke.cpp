#include "gfx_d3d11.hpp"
#include <d3d11.h>
#include <wrl/client.h>
#include <algorithm>
#include <iostream>
#include <stdexcept>

namespace {
using namespace native::gfx;
using Microsoft::WRL::ComPtr;
constexpr int width = 16, height = 8;
constexpr uint64_t timeout_ns = 5'000'000'000;

void require(bool condition, const char *message) {
    if (!condition) throw std::runtime_error(message);
}

void check(HRESULT result) {
    require(SUCCEEDED(result), "Cannot create borrowed WARP fixture");
}

void borrowed(ID3D11Device *device, ID3D11DeviceContext *immediate) {
    D3D11_TEXTURE2D_DESC desc{};
    desc.Width = width;
    desc.Height = height;
    desc.MipLevels = desc.ArraySize = desc.SampleDesc.Count = 1;
    desc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    desc.BindFlags = D3D11_BIND_RENDER_TARGET;
    ComPtr<ID3D11Texture2D> color, depth;
    ComPtr<ID3D11RenderTargetView> rtv;
    ComPtr<ID3D11DepthStencilView> dsv;
    check(device->CreateTexture2D(&desc, nullptr, &color));
    check(device->CreateRenderTargetView(color.Get(), nullptr, &rtv));
    desc.Format = DXGI_FORMAT_R24G8_TYPELESS;
    desc.BindFlags = D3D11_BIND_DEPTH_STENCIL;
    check(device->CreateTexture2D(&desc, nullptr, &depth));
    D3D11_DEPTH_STENCIL_VIEW_DESC depth_view{};
    depth_view.Format = DXGI_FORMAT_D24_UNORM_S8_UINT;
    depth_view.ViewDimension = D3D11_DSV_DIMENSION_TEXTURE2D;
    check(device->CreateDepthStencilView(depth.Get(), &depth_view, &dsv));
    D3D11Context context({device, immediate});
    const auto output =
            D3D11Context::borrow_target(rtv.Get(), {width, height, Format::rgba8, Format::depth24_stencil8}, dsv.Get());
    require(bool(output), "Borrowed output is invalid");
    bool rejected = false;
    try {
        D3D11Context::borrow_target(rtv.Get(), {1, 1});
    } catch (const std::runtime_error &) {
        rejected = true;
    }
    require(rejected, "Borrowed output accepted incorrect dimensions");
    context.prepare_color_copy(output);
    auto floating = context.create_target({width, height, Format::rgba16f});
    auto converted = context.create_target({width, height});
    context.bind_target(output);
    context.clear_color({.25f, .5f, .75f, 1});
    context.clear_depth();
    for (int frame = 0; frame < 4; ++frame) {
        context.bind_target(floating);
        context.clear_color({0, 0, 0, 1});
        context.copy_color(output, {1, 1, width - 2, height - 2}, floating.color, 1, 1);
    }
    context.copy_color(floating, {0, 0, width, height}, converted.color);
    auto readback = context.create_readback(width, height);
    context.enqueue_readback(converted, readback);
    std::vector<std::byte> pixels(D3D11Context::readback_bytes(readback));
    context.collect(readback, pixels, RowOrigin::bottom, timeout_ns);
    for (int y = 0; y < height; ++y)
        for (int x = 0; x < width; ++x) {
            const auto offset = (size_t(y) * width + x) * 4;
            const bool inside = x > 0 && y > 0 && x < width - 1 && y < height - 1;
            require(pixels[offset] == std::byte(inside ? 64 : 0) && pixels[offset + 1] == std::byte(inside ? 128 : 0)
                            && pixels[offset + 2] == std::byte(inside ? 191 : 0),
                    "Borrowed RGBA8-to-RGBA16F refraction copy changed pixels");
        }
    context.destroy(readback);
    auto depth_readback = context.create_readback(width, height, Format::depth32f);
    context.enqueue_readback(output, depth_readback);
    std::vector<float> values(size_t(width) * height);
    context.collect(depth_readback, std::as_writable_bytes(std::span(values)), RowOrigin::bottom, timeout_ns);
    require(std::all_of(values.begin(), values.end(), [](float value) { return value == 1; }),
            "Borrowed core-scene DSV was not cleared");
    context.destroy(depth_readback);
    context.destroy(converted);
    context.destroy(floating);
    context.check_error("Borrowed target diagnostics");
}
}  // namespace

int main() {
    try {
        ComPtr<ID3D11Device> device;
        ComPtr<ID3D11DeviceContext> immediate;
        const D3D_FEATURE_LEVEL level = D3D_FEATURE_LEVEL_11_0;
        check(D3D11CreateDevice(
                nullptr,
                D3D_DRIVER_TYPE_WARP,
                nullptr,
                D3D11_CREATE_DEVICE_DEBUG,
                &level,
                1,
                D3D11_SDK_VERSION,
                &device,
                nullptr,
                &immediate
        ));
        borrowed(device.Get(), immediate.Get());
        std::cout << "Borrowed RTV/DSV metadata and cached refraction conversion passed\n";
        return 0;
    } catch (const std::exception &error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
