#include "display_scaling.hpp"
#include <windows.h>
#include <iostream>

namespace native {
namespace {

// MONITORINFOEXW's device name ("\\.\DISPLAY1") for the monitor the window is on.
bool window_device_name(SDL_Window *window, MONITORINFOEXW &info) {
    const auto hwnd = static_cast<HWND>(
            SDL_GetPointerProperty(SDL_GetWindowProperties(window), SDL_PROP_WINDOW_WIN32_HWND_POINTER, nullptr)
    );
    if (!hwnd) return false;
    const HMONITOR monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
    info = {};
    info.cbSize = sizeof(info);
    return monitor && GetMonitorInfoW(monitor, &info);
}

}  // namespace

bool request_display_scaling(SDL_Window *window, DisplayScaling scaling) {
    MONITORINFOEXW info;
    if (!window_device_name(window, info)) return false;
    DEVMODEW mode{};
    mode.dmSize = sizeof(mode);
    if (!EnumDisplaySettingsExW(info.szDevice, ENUM_CURRENT_SETTINGS, &mode, 0)) return false;
    const DWORD wanted = scaling == DisplayScaling::stretch ? DMDFO_STRETCH : DMDFO_DEFAULT;
    if ((mode.dmFields & DM_DISPLAYFIXEDOUTPUT) && mode.dmDisplayFixedOutput == wanted) return true;
    // Only the scaling changes; the size and rate SDL just set stay as they are.
    mode.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT | DM_DISPLAYFREQUENCY | DM_DISPLAYFIXEDOUTPUT;
    mode.dmDisplayFixedOutput = wanted;
    const LONG result = ChangeDisplaySettingsExW(info.szDevice, &mode, nullptr, CDS_FULLSCREEN, nullptr);
    if (result != DISP_CHANGE_SUCCESSFUL) {
        std::cerr << "Display scaling request refused (" << result << ")\n";
        return false;
    }
    return true;
}

}  // namespace native
