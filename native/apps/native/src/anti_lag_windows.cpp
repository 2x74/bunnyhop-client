// Built with /permissive, and with AMD's header only when CMake found that the compiler takes it
// (BUNNYHOP_ANTI_LAG); without it there is no Anti-Lag 2 and low latency mode uses the waitable swapchain.
#include "anti_lag_windows.hpp"

#ifdef BUNNYHOP_ANTI_LAG
#include <windows.h>
#include <d3d11.h>
#pragma warning(push, 0)
#include "amd/ffx_antilag2_dx11.h"
#pragma warning(pop)

namespace native::anti_lag {
namespace {

AMD::AntiLag2DX11::Context context = {};

}  // namespace

bool initialize() {
    if (context.m_pAntiLagAPI) return true;
    return AMD::AntiLag2DX11::Initialize(&context) == S_OK;
}

void update(bool enabled, unsigned max_fps) {
    if (context.m_pAntiLagAPI) AMD::AntiLag2DX11::Update(&context, enabled, max_fps);
}

void shutdown() {
    if (context.m_pAntiLagAPI) {
        AMD::AntiLag2DX11::Update(&context, false, 0);
        AMD::AntiLag2DX11::DeInitialize(&context);
    }
}

}  // namespace native::anti_lag
#else
namespace native::anti_lag {

bool initialize() {
    return false;
}

void update(bool, unsigned) {
}

void shutdown() {
}

}  // namespace native::anti_lag
#endif
