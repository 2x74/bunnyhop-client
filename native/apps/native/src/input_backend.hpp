#pragma once
#include "raw_mouse.hpp"
#include "input_backend_choice.hpp"
#include <SDL3/SDL.h>
#include <memory>
#include <string_view>
#include <thread>

namespace native {

class InputBackend {
public:
    explicit InputBackend(std::string_view video_driver);
    // An external producer permits headless event injection without opening OS devices or requesting access.
    InputBackend(std::string_view video_driver, RawMousePipe &source);
    ~InputBackend();
    InputBackend(const InputBackend &) = delete;
    InputBackend &operator=(const InputBackend &) = delete;

    // Called before pumping. A backend switch is an input barrier, just like changing capture or sensitivity.
    bool begin(InputBackendChoice choice, bool captured);
    void capture(bool captured);
    void barrier();
    bool poll(SDL_Event &event);

    bool native_event() const { return native_event_; }

    bool native_active() const { return native_active_; }

    const char *name() const;
    const char *timestamp_kind() const;
    const char *fallback_reason() const;

    uint64_t dropped() const { return pipe_->dropped.load(std::memory_order_relaxed); }

private:
    bool raw_available() const;
    std::string_view video_driver_;
    std::unique_ptr<RawMousePipe> owned_pipe_;
    RawMousePipe *pipe_;
    std::unique_ptr<RawMouseBatch> batch_;
    std::jthread worker_;
    InputBackendChoice choice_ = InputBackendChoice::automatic;
    bool native_active_ = false;
    bool native_event_ = false;
    bool draining_native_ = false;
};

}  // namespace native
