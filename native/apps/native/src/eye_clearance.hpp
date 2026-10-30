#pragma once
#include "bunnyhop_native.h"
#include <algorithm>

namespace native {
constexpr float standing_hull_top_units = 62, ducked_hull_top_units = 45;
constexpr float eye_ceiling_gap_units = 12, ceiling_probe_half_size_units = 15;

constexpr float hull_top_units(bool crouched) {
    return crouched ? ducked_hull_top_units : standing_hull_top_units;
}

inline float blended_hull_top_z(const BhState &prev, const BhState &curr, float blend) {
    const float prev_top = prev.position[2] + hull_top_units(prev.crouched);
    const float curr_top = curr.position[2] + hull_top_units(curr.crouched);
    return prev_top + (curr_top - prev_top) * blend;
}

// The eye sits 2 units above the hull, so with the hull against a ceiling it would be through it. CS:S
// (CCSGameMovement::PlayerMove) sweeps a 30x30 box up from the hull's top to 12 units above the eye and keeps the eye
// 12 units under whatever it hits. The core's view offset leaves this out and feeds its own traces, so this only moves
// the rendered camera. top_z is the top of the hull.
inline float clear_eye_z(BhContext *core, float x, float y, float top_z, float eye_z) {
    const float reach = eye_z + eye_ceiling_gap_units - top_z;
    if (!core || reach <= 0) return eye_z;
    const float start[3] = {x, y, top_z - ceiling_probe_half_size_units};
    const float end[3] = {x, y, start[2] + reach};
    float fraction = 1;
    if (!bh_trace_camera(core, start, end, ceiling_probe_half_size_units, &fraction) || fraction >= 1) return eye_z;
    return std::min(eye_z, top_z + fraction * reach - eye_ceiling_gap_units);
}
}  // namespace native
