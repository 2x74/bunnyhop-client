#pragma once
#include <SDL3/SDL.h>
#include <memory>
#include <optional>
#include <string>
#include <string_view>

namespace native {

// Settings → Display → Low latency mode. Off presents with the OpenGL swap. On presents through a DXGI flip-model
// swapchain (Windows): independent flip in borderless, VRR, and NVIDIA Reflex or AMD Anti-Lag 2 where the card has
// it. Boost also keeps an NVIDIA card's clocks up.
enum class LowLatencyMode { off, on, boost };

inline bool valid_low_latency_mode(std::string_view value) {
    return value == "off" || value == "on" || value == "boost";
}

inline LowLatencyMode low_latency_mode(std::string_view value) {
    if (value == "boost") return LowLatencyMode::boost;
    return value == "on" ? LowLatencyMode::on : LowLatencyMode::off;
}

// What this computer offers, found once at startup with the game's GL context current.
struct LowLatencySupport {
    bool dxgi = false;
    bool reflex = false;
    bool anti_lag = false;
};

// Presents GL frames through DXGI. The game draws as before into the framebuffer bound by render_start(), a
// D3D11 texture shared with GL (WGL_NV_DX_interop2); present() copies it into the swapchain right side up and
// presents. Any failure turns it off with error() and the game goes back to the OpenGL swap. The markers follow
// the Reflex order: frame_start (the sleep, simulation start and input sample, before input is pumped),
// render_start (simulation end, render submit start) and present (render submit end, present).
class LowLatencyPresenter {
public:
    LowLatencyPresenter();
    ~LowLatencyPresenter();

    LowLatencyPresenter(const LowLatencyPresenter &) = delete;
    LowLatencyPresenter &operator=(const LowLatencyPresenter &) = delete;

    // Probes once; later calls return the first answer.
    const LowLatencySupport &support(SDL_Window *window);

    // Turns presenting through DXGI on or off for `mode`. `fps_limit` (0 for none) is passed to Reflex and
    // Anti-Lag 2 so their limiter and the game's agree. False with error() when it couldn't be turned on.
    bool configure(SDL_Window *window, LowLatencyMode mode, int fps_limit, bool flash_indicator);

    bool active() const;

    const std::string &error() const { return error_; }

    // The technique in use, for the menu: "Reflex", "Anti-Lag 2", "DXGI" or "".
    std::string_view technique() const;

    void frame_start();
    void render_start(int width, int height);
    // Presents the frame drawn since render_start (nothing when render_start didn't run). Call only while
    // active(); a failure turns it off.
    void present(bool vsync);

    // Why it turned itself off since the last call, once, for a toast.
    std::optional<std::string> take_failure() {
        auto failure = std::move(failure_);
        failure_.reset();
        return failure;
    }

    // A left click: the Reflex flash indicator shows it to a latency analyzer.
    void trigger_flash();

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
    LowLatencySupport support_;
    bool probed_ = false;
    std::string error_;
    std::optional<std::string> failure_;

    void fail(std::string reason);
};

// Applies Settings → Display → Low latency mode when it, the FPS limit or the flash indicator change. Checked once
// a frame; it compares three values and calls the presenter only on a change.
class LowLatencyControl {
public:
    // A reason to show the player when turning it on failed.
    std::optional<std::string>
    update(LowLatencyPresenter &presenter,
           SDL_Window *window,
           std::string_view mode_setting,
           int fps_limit,
           bool flash_indicator,
           bool scripted) {
        const auto mode = scripted ? LowLatencyMode::off : low_latency_mode(mode_setting);
        if (applied_ && mode == mode_ && fps_limit == fps_limit_ && flash_indicator == flash_) return std::nullopt;
        applied_ = true;
        mode_ = mode;
        fps_limit_ = fps_limit;
        flash_ = flash_indicator;
        if (presenter.configure(window, mode, fps_limit, flash_indicator)) return std::nullopt;
        return "Low latency mode is off: " + presenter.error();
    }

private:
    bool applied_ = false;
    LowLatencyMode mode_ = LowLatencyMode::off;
    int fps_limit_ = 0;
    bool flash_ = false;
};

#ifndef _WIN32
struct LowLatencyPresenter::Impl {};

inline LowLatencyPresenter::LowLatencyPresenter() = default;
inline LowLatencyPresenter::~LowLatencyPresenter() = default;

inline const LowLatencySupport &LowLatencyPresenter::support(SDL_Window *) {
    probed_ = true;
    return support_;
}

inline bool LowLatencyPresenter::configure(SDL_Window *, LowLatencyMode mode, int, bool) {
    error_ = mode == LowLatencyMode::off ? "" : "Low latency mode is for Windows";
    return mode == LowLatencyMode::off;
}

inline bool LowLatencyPresenter::active() const {
    return false;
}

inline std::string_view LowLatencyPresenter::technique() const {
    return {};
}

inline void LowLatencyPresenter::frame_start() {
}

inline void LowLatencyPresenter::render_start(int, int) {
}

inline void LowLatencyPresenter::present(bool) {
}

inline void LowLatencyPresenter::trigger_flash() {
}
#endif

}  // namespace native
