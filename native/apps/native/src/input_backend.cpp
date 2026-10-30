#include "input_backend.hpp"

namespace native {

InputBackend::InputBackend(std::string_view video_driver)
    : video_driver_(video_driver)
    , owned_pipe_(std::make_unique<RawMousePipe>())
    , pipe_(owned_pipe_.get())
    , batch_(std::make_unique<RawMouseBatch>()) {
#if defined(__APPLE__) || defined(__linux__)
    worker_ = std::thread(run_raw_mouse, std::ref(*pipe_));
#endif
}

InputBackend::InputBackend(std::string_view video_driver, RawMousePipe &source)
    : video_driver_(video_driver)
    , pipe_(&source)
    , batch_(std::make_unique<RawMouseBatch>()) {
}

InputBackend::~InputBackend() {
    pipe_->stop.store(true, std::memory_order_release);
    if (worker_.joinable()) worker_.join();
}

bool InputBackend::begin(InputBackendChoice choice, bool captured) {
    draining_native_ = false;
    batch_->clear();
    choice_ = choice;
    pipe_->select(choice == InputBackendChoice::raw);
    const bool ready = pipe_->status.load(std::memory_order_acquire) == RawMouseStatus::ready;
    const bool active = choice == InputBackendChoice::raw && ready && captured;
    const bool changed = active != native_active_;
    if (changed) {
        pipe_->capture(false);
        pipe_->discard();
    }
    native_active_ = active;
    capture(captured);
    return changed;
}

void InputBackend::capture(bool captured) {
    pipe_->capture(captured && native_active_, SDL_GetTicksNS());
}

void InputBackend::barrier() {
    const bool captured = pipe_->capture_epoch() & 1;
    pipe_->capture(false);
    pipe_->discard();
    batch_->clear();
    pipe_->capture(captured, SDL_GetTicksNS());
}

bool InputBackend::poll(SDL_Event &event) {
    native_event_ = false;
    while (!draining_native_ && SDL_PollEvent(&event)) {
        if (event.type != SDL_EVENT_MOUSE_MOTION || !native_active_ || !(pipe_->capture_epoch() & 1)) {
            return true;
        }
    }
    if (!draining_native_) batch_->load(*pipe_);
    draining_native_ = true;
    RawMouseReport report;
    while (batch_->pop(report)) {
        if (!native_active_ || report.epoch != pipe_->capture_epoch() || !(report.epoch & 1)) {
            continue;
        }
        event = {};
        event.type = SDL_EVENT_MOUSE_MOTION;
        event.motion.timestamp = report.timestamp;
        event.motion.xrel = float(report.x);
        event.motion.yrel = float(report.y);
        native_event_ = true;
        return true;
    }
    return false;
}

bool InputBackend::raw_available() const {
    return choice_ == InputBackendChoice::raw && pipe_->status.load(std::memory_order_acquire) == RawMouseStatus::ready;
}

const char *InputBackend::name() const {
    if (native_active_ || raw_available()) {
#ifdef __APPLE__
        return "IOHID";
#else
        return "evdev";
#endif
    }
    if (video_driver_ == "windows") return "SDL raw";
    if (video_driver_ == "cocoa") return "SDL NSEvent";
    if (video_driver_ == "x11") return "SDL XI2";
    if (video_driver_ == "wayland") return "SDL relative-pointer";
    return "SDL";
}

const char *InputBackend::timestamp_kind() const {
    if (native_active_ || raw_available()) return "device event";
    if (video_driver_ == "windows") return "batch estimate";
    if (video_driver_ == "x11") return "arrival";
    return "OS event";
}

const char *InputBackend::fallback_reason() const {
    if (choice_ != InputBackendChoice::raw || native_active_) return "";
#if defined(_WIN32)
    return "SDL owns the process raw-input registration";
#else
    switch (pipe_->status.load(std::memory_order_acquire)) {
        case RawMouseStatus::permission:
            return "Mouse access denied; using SDL";
        case RawMouseStatus::unavailable:
            return "No accessible raw mouse; using SDL";
        case RawMouseStatus::overflow:
            return "Raw queue overflow; reselect Raw to retry";
        case RawMouseStatus::ready:
            return "Raw mouse available while playing";
        default:
            return "Starting raw mouse; using SDL";
    }
#endif
}

}  // namespace native
