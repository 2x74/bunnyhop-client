#include "window_frame.hpp"
#include <windows.h>
#include <dwmapi.h>
#include <iostream>

namespace native {

void sync_window_frame(SDL_Window *window) {
    const auto properties = SDL_GetWindowProperties(window);
    const auto hwnd =
            static_cast<HWND>(SDL_GetPointerProperty(properties, SDL_PROP_WINDOW_WIN32_HWND_POINTER, nullptr));
    if (!hwnd) return;
    const bool frameless = SDL_GetWindowFlags(window) & (SDL_WINDOW_BORDERLESS | SDL_WINDOW_FULLSCREEN);
    const DWORD policy = frameless ? DWMNCRP_DISABLED : DWMNCRP_ENABLED;
    const HRESULT set = DwmSetWindowAttribute(hwnd, DWMWA_NCRENDERING_POLICY, &policy, sizeof policy);
    BOOL drawn = FALSE;
    const HRESULT read = DwmGetWindowAttribute(hwnd, DWMWA_NCRENDERING_ENABLED, &drawn, sizeof drawn);
    static int last_reported = -1;
    const int report = (frameless ? 0 : 2) + (SUCCEEDED(set) && SUCCEEDED(read) && drawn ? 1 : 0);
    if (report == last_reported) return;
    last_reported = report;
    std::cerr << "Window frame: " << (frameless ? "frameless" : "bordered") << ", drawn by the compositor "
              << (drawn ? "yes" : "no") << ", set " << std::hex << set << ", read " << read << std::dec << '\n';
}

}  // namespace native
