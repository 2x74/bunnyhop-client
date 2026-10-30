#include "raw_mouse.hpp"
#include <SDL3/SDL.h>
#include <linux/input.h>
#include <sys/ioctl.h>
#include <sys/inotify.h>
#include <dirent.h>
#include <fcntl.h>
#include <poll.h>
#include <time.h>
#include <unistd.h>
#include <cerrno>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <thread>

namespace native {
namespace {
constexpr size_t maximum_mice = 16;
constexpr size_t events_per_read = 256;
constexpr int poll_timeout_ms = 20;
constexpr auto inactive_wait = std::chrono::milliseconds(20);
constexpr uint64_t second_ns = 1'000'000'000;
constexpr uint64_t microsecond_ns = 1000;

uint64_t monotonic_ns() {
    timespec time{};
    clock_gettime(CLOCK_MONOTONIC, &time);
    return uint64_t(time.tv_sec) * second_ns + uint64_t(time.tv_nsec);
}

struct EvdevMouse {
    int descriptor = -1;
    double x = 0;
    double y = 0;
    bool changed = false;
    uint64_t epoch = 0;
};

struct EvdevSession {
    RawMousePipe &pipe;
    std::array<EvdevMouse, maximum_mice> mice{};
    size_t count = 0;
    int notifications = -1;
    InputClockBridge clock;

    explicit EvdevSession(RawMousePipe &source) : pipe(source) {}

    ~EvdevSession() {
        if (notifications >= 0) close(notifications);
        for (auto &mouse : mice) {
            if (mouse.descriptor >= 0) close(mouse.descriptor);
        }
    }
};

bool relative_mouse(const char *name) {
    char path[256];
    std::snprintf(path, sizeof(path), "/sys/class/input/%s/device/capabilities/rel", name);
    FILE *file = std::fopen(path, "r");
    if (!file) return false;
    unsigned long long axes = 0;
    const bool read = std::fscanf(file, "%llx", &axes) == 1;
    std::fclose(file);
    constexpr unsigned long long relative_xy = (1ull << REL_X) | (1ull << REL_Y);
    return read && (axes & relative_xy) == relative_xy;
}

bool open_mouse(EvdevSession &session, const char *name) {
    if (session.count == maximum_mice) return false;
    char path[256];
    std::snprintf(path, sizeof(path), "/dev/input/%s", name);
    const int descriptor = open(path, O_RDONLY | O_NONBLOCK | O_CLOEXEC);
    if (descriptor < 0) return false;
    const int clock = CLOCK_MONOTONIC;
    if (ioctl(descriptor, EVIOCSCLOCKID, &clock) != 0) {
        close(descriptor);
        return false;
    }
    session.mice[session.count++].descriptor = descriptor;
    return true;
}

bool open_mice(EvdevSession &session) {
    session.notifications = inotify_init1(IN_NONBLOCK | IN_CLOEXEC);
    if (session.notifications < 0
        || inotify_add_watch(session.notifications, "/dev/input", IN_CREATE | IN_DELETE | IN_ATTRIB) < 0)
        return false;
    DIR *directory = opendir("/sys/class/input");
    if (!directory) return false;
    bool accessible = true;
    while (const dirent *entry = readdir(directory)) {
        if (std::strncmp(entry->d_name, "event", 5) != 0 || !relative_mouse(entry->d_name)) continue;
        // Never replace SDL for only a subset of attached relative mice, or silently request elevated access.
        if (!open_mouse(session, entry->d_name)) accessible = false;
    }
    closedir(directory);
    if (!accessible) session.pipe.status.store(RawMouseStatus::permission, std::memory_order_release);
    return accessible && session.count != 0;
}

bool mouse_event(EvdevSession &session, EvdevMouse &mouse, const input_event &event, uint64_t epoch) {
    if (event.type == EV_SYN && event.code == SYN_DROPPED) {
        // Relative counts cannot be reconstructed after a kernel queue overrun. Return to SDL rather than
        // passing an incomplete packet to a tick.
        session.pipe.dropped.fetch_add(1, std::memory_order_relaxed);
        session.pipe.status.store(RawMouseStatus::overflow, std::memory_order_release);
        return false;
    }
    if (event.type == EV_REL && (event.code == REL_X || event.code == REL_Y)) {
        if (mouse.epoch != epoch) {
            mouse.x = mouse.y = 0;
            mouse.epoch = epoch;
        }
        if (event.code == REL_X) mouse.x += event.value;
        if (event.code == REL_Y) mouse.y += event.value;
        mouse.changed = true;
    }
    if (event.type != EV_SYN || event.code != SYN_REPORT || !mouse.changed) return true;
    const uint64_t timestamp = uint64_t(event.time.tv_sec) * second_ns + uint64_t(event.time.tv_usec) * microsecond_ns;
    const bool published = session.pipe.publish(session.clock.map(timestamp), mouse.x, mouse.y, mouse.epoch);
    mouse.x = mouse.y = 0;
    mouse.changed = false;
    return published;
}

bool read_mouse(EvdevSession &session, EvdevMouse &mouse) {
    std::array<input_event, events_per_read> events{};
    const uint64_t epoch = session.pipe.capture_epoch();
    const ssize_t bytes = read(mouse.descriptor, events.data(), sizeof(events));
    if (bytes < 0 && (errno == EAGAIN || errno == EINTR)) return true;
    if (bytes <= 0 || size_t(bytes) % sizeof(input_event) != 0) return false;
    const size_t count = size_t(bytes) / sizeof(input_event);
    for (size_t index = 0; index < count; ++index) {
        if (!mouse_event(session, mouse, events[index], epoch)) return false;
    }
    return true;
}

bool calibrate_clock(EvdevSession &session) {
    // SDL uses MONOTONIC_RAW on Linux; evdev supports MONOTONIC. Refresh the offset every poll so NTP slew
    // cannot accumulate into a different tick over a long session.
    InputClockSample sample;
    for (unsigned index = 0; index < InputClockSample::attempts; ++index) {
        const uint64_t before = monotonic_ns();
        const uint64_t target = SDL_GetTicksNS();
        const uint64_t after = monotonic_ns();
        sample.consider(before, target, after);
    }
    if (!sample.valid()) return false;
    session.clock = sample.bridge;
    return true;
}

void read_mice(EvdevSession &session, uint64_t selection) {
    std::array<pollfd, maximum_mice + 1> descriptors{};
    descriptors[session.count] = {session.notifications, POLLIN, 0};
    for (size_t index = 0; index < session.count; ++index) {
        descriptors[index] = {session.mice[index].descriptor, POLLIN, 0};
    }
    if (!calibrate_clock(session)) return;
    session.pipe.status.store(RawMouseStatus::ready, std::memory_order_release);
    while (!session.pipe.stop.load() && session.pipe.selected(selection)) {
        const int ready = poll(descriptors.data(), session.count + 1, poll_timeout_ms);
        if (ready < 0 && errno == EINTR) continue;
        if (ready < 0) break;
        if (!calibrate_clock(session)) return;
        // A changed device set requires a fresh selection. Keep SDL for every mouse until all nodes reopen.
        if (descriptors[session.count].revents) return;
        for (size_t index = 0; index < session.count; ++index) {
            if (descriptors[index].revents & (POLLERR | POLLHUP | POLLNVAL)) return;
            if ((descriptors[index].revents & POLLIN) && !read_mouse(session, session.mice[index])) return;
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
        {
            EvdevSession session{pipe};
            if (open_mice(session)) read_mice(session, selection);
        }
        const auto status = pipe.status.load();
        if (status != RawMouseStatus::permission && status != RawMouseStatus::overflow) {
            pipe.status.store(RawMouseStatus::unavailable, std::memory_order_release);
        }
        wait_for_deselection(pipe, selection);
        pipe.status.store(RawMouseStatus::idle, std::memory_order_release);
    }
}
}  // namespace native
