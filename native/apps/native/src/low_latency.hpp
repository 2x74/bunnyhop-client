#pragma once
#include <SDL3/SDL.h>
#include "gfx_types.hpp"
#include "window_presenter.hpp"
#include <memory>
#include <optional>
#include <string>
#include <string_view>

namespace native {

// OpenGL uses DXGI interop only when enabled. Native D3D11 always uses flip-model DXGI; this setting controls
// Reflex/Anti-Lag markers and pacing there. Boost also requests NVIDIA's clock boost.
enum class LowLatencyMode { off, on, boost };

inline bool valid_low_latency_mode(std::string_view value) {
    return value == "off" || value == "on" || value == "boost";
}

inline LowLatencyMode low_latency_mode(std::string_view value) {
    if (value == "boost") return LowLatencyMode::boost;
    return value == "on" ? LowLatencyMode::on : LowLatencyMode::off;
}

// Probed once with the active renderer; native D3D11 never probes WGL interop.
struct LowLatencySupport {
    bool dxgi = false;
    bool reflex = false;
    bool anti_lag = false;
};

// Owns the only D3D11 device, immediate context and swapchain. Native D3D11 borrows a scene RTV/DSV;
// OpenGL interop borrows a shared framebuffer. Present supplies the final vertical flip for either path.
// Marker order is frame_start (sleep, simulation start, input sample), render_start (simulation end,
// render submit start), present (render submit end, present start/end). A native device failure retains
// borrowed objects until the caller can unwind and exit cleanly; interop failures return to the GL swap.
class LowLatencyPresenter : public WindowPresenter {
public:
    LowLatencyPresenter();
    ~LowLatencyPresenter() override;

    LowLatencyPresenter(const LowLatencyPresenter &) = delete;
    LowLatencyPresenter &operator=(const LowLatencyPresenter &) = delete;

    // Probes once; later calls return the first answer.
    const LowLatencySupport &support(SDL_Window *window);

    // Turns presenting through DXGI on or off for `mode`. `fps_limit` (0 for none) is passed to Reflex and
    // Anti-Lag 2 so their limiter and the game's agree. False with error() when it couldn't be turned on.
    bool configure(SDL_Window *window, LowLatencyMode mode, int fps_limit, bool flash_indicator);

    bool initialize_native(SDL_Window *window, bool warp = false);
    bool exclusive(bool enabled) override;

    bool native_mode() const { return native_; }

    bool failed() const { return native_ && !error_.empty(); }

    void *device() const;
    void *immediate_context() const;
    gfx::TargetView native_target() const;
    std::string adapter_description() const;
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
    bool native_ = false;
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

inline bool LowLatencyPresenter::initialize_native(SDL_Window *, bool) {
    return false;
}

inline bool LowLatencyPresenter::exclusive(bool) {
    return true;
}

inline void *LowLatencyPresenter::device() const {
    return nullptr;
}

inline void *LowLatencyPresenter::immediate_context() const {
    return nullptr;
}

inline gfx::TargetView LowLatencyPresenter::native_target() const {
    return {};
}

inline std::string LowLatencyPresenter::adapter_description() const {
    return {};
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
