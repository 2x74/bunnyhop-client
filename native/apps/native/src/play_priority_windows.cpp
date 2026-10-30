#include "play_priority.hpp"
// SetProcessInformation is Windows 8+; the game needs Windows 10.
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#include <windows.h>
#include <avrt.h>
#include <timeapi.h>
#include <iostream>

namespace native {
namespace {

constexpr UINT timer_period_ms = 1;
// Windows 11's flag for honouring timer resolution requests while throttled; older SDKs don't name it.
#ifndef PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION
constexpr ULONG PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION = 0x4;
#endif

// ControlMask names the policies set; a zero bit in StateMask turns that policy off for this process. An empty
// ControlMask hands both back to the system.
bool set_power_throttling(bool allowed) {
    PROCESS_POWER_THROTTLING_STATE state{};
    state.Version = PROCESS_POWER_THROTTLING_CURRENT_VERSION;
    state.ControlMask =
            allowed ? 0 : PROCESS_POWER_THROTTLING_EXECUTION_SPEED | PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION;
    state.StateMask = 0;
    return SetProcessInformation(GetCurrentProcess(), ProcessPowerThrottling, &state, sizeof(state)) != 0;
}

}  // namespace

void PlayPriority::begin() {
    timer_ = timeBeginPeriod(timer_period_ms) == TIMERR_NOERROR;
    if (!timer_) std::cerr << "Play priority: timer resolution refused\n";
    if (!set_power_throttling(false)) std::cerr << "Play priority: power throttling opt-out refused\n";
    DWORD task_index = 0;
    mmcss_ = AvSetMmThreadCharacteristicsW(L"Games", &task_index);
    if (!mmcss_) std::cerr << "Play priority: MMCSS Games refused (" << GetLastError() << ")\n";
}

void PlayPriority::end() {
    if (mmcss_) AvRevertMmThreadCharacteristics(mmcss_);
    mmcss_ = nullptr;
    set_power_throttling(true);
    if (timer_) timeEndPeriod(timer_period_ms);
    timer_ = false;
}

}  // namespace native
