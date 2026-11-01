#include "renderer_prompt.hpp"
#include <windows.h>
#include <commctrl.h>
#include <cassert>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <thread>
#include <vector>

namespace {
void capture(HWND window, const std::filesystem::path &path) {
    RECT bounds{};
    GetWindowRect(window, &bounds);
    const int width = bounds.right - bounds.left, height = bounds.bottom - bounds.top;
    const auto screen = GetDC(window);
    const auto context = CreateCompatibleDC(screen);
    const auto bitmap = CreateCompatibleBitmap(screen, width, height);
    const auto previous = SelectObject(context, bitmap);
    const bool drawn = PrintWindow(window, context, 2);
    SelectObject(context, previous);
    BITMAPINFO info{};
    info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    info.bmiHeader.biWidth = width;
    info.bmiHeader.biHeight = -height;
    info.bmiHeader.biPlanes = 1;
    info.bmiHeader.biBitCount = 32;
    std::vector<unsigned char> pixels(size_t(width) * height * 4);
    const bool copied = GetDIBits(context, bitmap, 0, UINT(height), pixels.data(), &info, DIB_RGB_COLORS) != 0;
    DeleteObject(bitmap);
    DeleteDC(context);
    ReleaseDC(window, screen);
    assert(drawn && copied);
    std::ofstream output(path, std::ios::binary);
    output << "P6\n" << width << ' ' << height << "\n255\n";
    for (size_t pixel = 0; pixel < pixels.size(); pixel += 4) {
        const char rgb[] = {char(pixels[pixel + 2]), char(pixels[pixel + 1]), char(pixels[pixel])};
        output.write(rgb, sizeof(rgb));
    }
    assert(output);
}

void answer(const std::filesystem::path &path, bool d3d11) {
    constexpr auto step = std::chrono::milliseconds(50);
    HWND window = nullptr;
    for (unsigned attempt = 0; attempt < 200 && !window; ++attempt) {
        std::this_thread::sleep_for(step);
        const auto candidate = FindWindowW(L"#32770", L"Bunnyhop Native");
        if (candidate && IsWindowVisible(candidate)) window = candidate;
    }
    if (!window) {
        std::cerr << "Renderer choice dialog did not open\n";
        std::exit(1);
    }
    if (d3d11) SendMessageW(window, TDM_CLICK_RADIO_BUTTON, 101, 0);
    RedrawWindow(window, nullptr, nullptr, RDW_UPDATENOW | RDW_ALLCHILDREN);
    capture(window, path);
    if (d3d11)
        PostMessageW(window, TDM_CLICK_BUTTON, 102, 0);
    else
        PostMessageW(window, WM_CLOSE, 0, 0);
}
}  // namespace

int main(int argc, char **argv) {
    assert(argc == 2);
    assert(AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(), DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2));
    const auto root = std::filesystem::path(argv[1]);
    std::filesystem::create_directories(root);
    for (const bool d3d11 : {false, true}) {
        std::thread responder(answer, root / (d3d11 ? "d3d11.ppm" : "opengl-default.ppm"), d3d11);
        const auto choice = native::ask_renderer();
        responder.join();
        assert(choice == (d3d11 ? native::RendererChoice::d3d11 : native::RendererChoice::opengl));
    }
    std::cout << "Renderer choice dismissal and Direct3D 11 selection passed before graphics initialization\n";
}
