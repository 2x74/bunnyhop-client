#pragma once
#include <algorithm>
#include <limits>
#include <cstdint>

namespace native {
// Timed attempts keep the leave guard even when practice or local-only. Only
// spectators and attempts before start/after finish can leave immediately.
inline bool leave_requires_confirmation(uint32_t timer_status, bool spectating) {
    return timer_status == 1 && !spectating;
}

struct LeaveHold {
    enum class Result { none, ask, leave, tap };
    double started = -1, armed = -std::numeric_limits<double>::infinity();

    void cancel() { started = -1; }

    Result press(double now, bool timed, bool holdable) {
        if (!timed) {
            cancel();
            armed = -std::numeric_limits<double>::infinity();
            return Result::leave;
        }
        if (holdable) {
            started = now;
            return Result::none;
        }
        if (now - armed <= 2000) {
            armed = -std::numeric_limits<double>::infinity();
            return Result::leave;
        }
        armed = now;
        return Result::ask;
    }

    Result frame(double now, bool held, bool suspended) {
        if (started < 0) return Result::none;
        if (suspended) {
            cancel();
            return Result::none;
        }
        if (!held) {
            cancel();
            return Result::tap;
        }
        if (now - started >= 600) {
            cancel();
            return Result::leave;
        }
        return Result::none;
    }

    float progress(double now) const { return started < 0 ? -1.f : float(std::clamp((now - started) / 600., 0., 1.)); }
};
}  // namespace native
