// Built with /permissive: AMD's header uses an MSVC extension (a pure virtual destructor with a body).
#include "anti_lag_windows.hpp"
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
