#include "raw_mouse.hpp"
#include <SDL3/SDL.h>
#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/hid/IOHIDManager.h>
#include <IOKit/hidsystem/IOHIDLib.h>
#include <IOKit/hid/IOHIDUsageTables.h>
#include <mach/mach_time.h>
#include <chrono>
#include <thread>

namespace native {
namespace {
constexpr size_t maximum_mice = 16;
constexpr double run_loop_seconds = .002;
constexpr uint64_t permission_check_ns = 500'000'000;
constexpr uint64_t clock_rebase_ns = 1'000'000;
constexpr uint64_t axis_flush_ns = 1'000'000;
constexpr auto inactive_wait = std::chrono::milliseconds(20);

struct MachClock {
    mach_timebase_info_data_t scale{};
    InputClockBridge bridge;

    uint64_t nanoseconds(uint64_t ticks) const {
        return (ticks / scale.denom) * scale.numer + (ticks % scale.denom) * scale.numer / scale.denom;
    }

    MachClock() { mach_timebase_info(&scale); }

    bool calibrate() {
        if (!scale.denom || !scale.numer) return false;
        InputClockSample sample;
        for (unsigned index = 0; index < InputClockSample::attempts; ++index) {
            const uint64_t before = nanoseconds(mach_absolute_time());
            const uint64_t target = SDL_GetTicksNS();
            const uint64_t after = nanoseconds(mach_absolute_time());
            sample.consider(before, target, after);
        }
        if (!sample.valid()) return false;
        bridge = sample.bridge;
        return true;
    }

    uint64_t stamp(uint64_t ticks) {
        const uint64_t source = nanoseconds(mach_absolute_time());
        const uint64_t target = SDL_GetTicksNS();
        const uint64_t mapped = bridge.map(source);
        const uint64_t difference = mapped > target ? mapped - target : target - mapped;
        // Some SDL builds use a clock that includes sleep. Detect a changed epoch when the machine resumes.
        if (difference > clock_rebase_ns && !calibrate()) return target;
        return bridge.map(nanoseconds(ticks));
    }
};

struct HidMouse {
    IOHIDDeviceRef device = nullptr;
    RawMouseAccumulator motion;
};

struct HidSession {
    RawMousePipe &pipe;
    IOHIDManagerRef manager = nullptr;
    MachClock clock;
    std::array<HidMouse, maximum_mice> mice{};

    explicit HidSession(RawMousePipe &source) : pipe(source) {}

    ~HidSession() {
        if (!manager) return;
        IOHIDManagerUnscheduleFromRunLoop(manager, CFRunLoopGetCurrent(), kCFRunLoopDefaultMode);
        IOHIDManagerClose(manager, kIOHIDOptionsTypeNone);
        CFRelease(manager);
    }

    void flush_old() {
        const uint64_t now = SDL_GetTicksNS();
        for (auto &mouse : mice) {
            const uint64_t stamp = mouse.motion.pending.timestamp;
            if (stamp && now >= stamp && now - stamp >= axis_flush_ns) {
                mouse.motion.flush(pipe);
            }
        }
    }
};

bool relative_mouse(IOHIDDeviceRef device) {
    CFArrayRef elements = IOHIDDeviceCopyMatchingElements(device, nullptr, kIOHIDOptionsTypeNone);
    if (!elements) return false;
    bool relative_x = false;
    bool relative_y = false;
    for (CFIndex index = 0; index < CFArrayGetCount(elements); ++index) {
        const auto element = static_cast<IOHIDElementRef>(const_cast<void *>(CFArrayGetValueAtIndex(elements, index)));
        if (!IOHIDElementIsRelative(element) || IOHIDElementGetUsagePage(element) != kHIDPage_GenericDesktop) continue;
        relative_x = relative_x || IOHIDElementGetUsage(element) == kHIDUsage_GD_X;
        relative_y = relative_y || IOHIDElementGetUsage(element) == kHIDUsage_GD_Y;
    }
    CFRelease(elements);
    return relative_x && relative_y;
}

void matched_mouse(void *context, IOReturn result, void *, IOHIDDeviceRef device) noexcept {
    auto &session = *static_cast<HidSession *>(context);
    if (result != kIOReturnSuccess || session.pipe.status.load() == RawMouseStatus::overflow) return;
    if (!relative_mouse(device)) return;
    for (auto &mouse : session.mice) {
        if (!mouse.device) {
            mouse.device = device;
            session.pipe.status.store(RawMouseStatus::ready, std::memory_order_release);
            return;
        }
    }
}

void removed_mouse(void *context, IOReturn, void *, IOHIDDeviceRef device) noexcept {
    auto &session = *static_cast<HidSession *>(context);
    bool remaining = false;
    for (auto &mouse : session.mice) {
        if (mouse.device == device) mouse = {};
        remaining = remaining || mouse.device;
    }
    if (!remaining && session.pipe.status.load() != RawMouseStatus::overflow) {
        session.pipe.status.store(RawMouseStatus::unavailable, std::memory_order_release);
    }
}

void mouse_value(void *context, IOReturn result, void *, IOHIDValueRef value) noexcept {
    auto &session = *static_cast<HidSession *>(context);
    if (result != kIOReturnSuccess || session.pipe.status.load() == RawMouseStatus::overflow) return;
    const IOHIDElementRef element = IOHIDValueGetElement(value);
    if (!IOHIDElementIsRelative(element) || IOHIDElementGetUsagePage(element) != kHIDPage_GenericDesktop) return;
    const uint32_t usage = IOHIDElementGetUsage(element);
    if (usage != kHIDUsage_GD_X && usage != kHIDUsage_GD_Y) return;
    const double counts = double(IOHIDValueGetIntegerValue(value));
    const uint64_t stamp = session.clock.stamp(IOHIDValueGetTimeStamp(value));
    for (auto &mouse : session.mice) {
        if (mouse.device == IOHIDElementGetDevice(element)) {
            mouse.motion.value(
                    session.pipe, stamp, usage == kHIDUsage_GD_X ? counts : 0, usage == kHIDUsage_GD_Y ? counts : 0
            );
            return;
        }
    }
}

bool match_mice(IOHIDManagerRef manager) {
    const int page = kHIDPage_GenericDesktop;
    const int usage = kHIDUsage_GD_Mouse;
    CFNumberRef page_number = CFNumberCreate(nullptr, kCFNumberIntType, &page);
    CFNumberRef usage_number = CFNumberCreate(nullptr, kCFNumberIntType, &usage);
    if (!page_number || !usage_number) {
        if (page_number) CFRelease(page_number);
        if (usage_number) CFRelease(usage_number);
        return false;
    }
    const void *keys[] = {CFSTR(kIOHIDDeviceUsagePageKey), CFSTR(kIOHIDDeviceUsageKey)};
    const void *values[] = {page_number, usage_number};
    CFDictionaryRef matching = CFDictionaryCreate(
            nullptr, keys, values, 2, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks
    );
    if (matching) IOHIDManagerSetDeviceMatching(manager, matching);
    if (matching) CFRelease(matching);
    CFRelease(page_number);
    CFRelease(usage_number);
    return matching != nullptr;
}

void read_mice(RawMousePipe &pipe, uint64_t selection) {
    HidSession session{pipe};
    if (!session.clock.calibrate()) {
        pipe.status.store(RawMouseStatus::unavailable, std::memory_order_release);
        return;
    }
    session.manager = IOHIDManagerCreate(nullptr, kIOHIDOptionsTypeNone);
    if (!session.manager || !match_mice(session.manager)) {
        pipe.status.store(RawMouseStatus::unavailable, std::memory_order_release);
        return;
    }
    IOHIDManagerRegisterDeviceMatchingCallback(session.manager, matched_mouse, &session);
    IOHIDManagerRegisterDeviceRemovalCallback(session.manager, removed_mouse, &session);
    IOHIDManagerRegisterInputValueCallback(session.manager, mouse_value, &session);
    IOHIDManagerScheduleWithRunLoop(session.manager, CFRunLoopGetCurrent(), kCFRunLoopDefaultMode);
    pipe.status.store(RawMouseStatus::unavailable, std::memory_order_release);
    const IOReturn opened = IOHIDManagerOpen(session.manager, kIOHIDOptionsTypeNone);
    if (opened != kIOReturnSuccess) {
        pipe.status.store(RawMouseStatus::permission, std::memory_order_release);
        return;
    }
    uint64_t permission_checked = SDL_GetTicksNS();
    while (!pipe.stop.load() && pipe.selected(selection) && pipe.status.load() != RawMouseStatus::overflow) {
        CFRunLoopRunInMode(kCFRunLoopDefaultMode, run_loop_seconds, false);
        session.flush_old();
        const uint64_t now = SDL_GetTicksNS();
        if (now - permission_checked >= permission_check_ns) {
            permission_checked = now;
            if (IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) != kIOHIDAccessTypeGranted) {
                pipe.status.store(RawMouseStatus::permission, std::memory_order_release);
                return;
            }
        }
    }
}

void wait_for_deselection(RawMousePipe &pipe, uint64_t selection) {
    while (!pipe.stop.load() && pipe.selected(selection)) {
        std::this_thread::sleep_for(inactive_wait);
    }
}
}  // namespace

void run_raw_mouse(RawMousePipe &pipe) noexcept {
    while (!pipe.stop.load()) {
        if (!pipe.requested.load()) {
            std::this_thread::sleep_for(inactive_wait);
            continue;
        }
        const uint64_t selection = pipe.selection.load(std::memory_order_acquire);
        pipe.status.store(RawMouseStatus::starting, std::memory_order_release);
        if (IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) != kIOHIDAccessTypeGranted) {
            // Only the explicit Raw setting reaches here. Auto and SDL never request Input Monitoring access.
            IOHIDRequestAccess(kIOHIDRequestTypeListenEvent);
        }
        if (IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) == kIOHIDAccessTypeGranted) {
            read_mice(pipe, selection);
        } else {
            pipe.status.store(RawMouseStatus::permission, std::memory_order_release);
        }
        wait_for_deselection(pipe, selection);
        pipe.status.store(RawMouseStatus::idle, std::memory_order_release);
    }
}
}  // namespace native
