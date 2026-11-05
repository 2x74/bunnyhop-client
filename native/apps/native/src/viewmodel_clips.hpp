#pragma once
// The baked pose clips of the native asset bundle (export-viewmodels.ts): per rig entry, its meshes and its clips,
// each a run of frames of skinning matrices (12 floats a bone) sampled with linear interpolation.
#include <algorithm>
#include <cmath>
#include <span>
#include <string>
#include <vector>

namespace native_vm {

struct PoseClip {
    std::string name;
    double duration = 0;
    size_t frames = 0, offset = 0;
};

struct PoseEntry {
    size_t bones = 0;
    std::vector<std::string> meshes;
    std::vector<PoseClip> clips;

    const PoseClip *find(std::string_view name) const {
        for (const auto &c : clips)
            if (c.name == name) return &c;
        return nullptr;
    }

    // The named clip, else idle, else the first.
    const PoseClip *clip_or_idle(std::string_view name) const {
        if (const auto *found = find(name)) return found;
        if (const auto *idle = find("idle")) return idle;
        return clips.empty() ? nullptr : &clips.front();
    }
};

// The pose `t` seconds into `clip` (wrapping when `loop`) into `out`, sized to the entry's bones.
inline void sample_clip(
        std::span<const float> data,
        const PoseEntry &entry,
        const PoseClip &clip,
        double t,
        bool loop,
        std::vector<float> &out
) {
    if (loop && clip.duration > 0) t = std::fmod(std::max(0., t), clip.duration);
    const double frame = clip.duration > 0
                                 ? std::clamp(t / clip.duration * double(clip.frames - 1), 0., double(clip.frames - 1))
                                 : 0;
    const size_t a = size_t(frame), b = std::min(a + 1, clip.frames - 1);
    const float f = float(frame - double(a));
    const size_t size = entry.bones * 12;
    out.resize(size);
    const float *from = data.data() + clip.offset + a * size, *to = data.data() + clip.offset + b * size;
    for (size_t i = 0; i < size; i++)
        out[i] = from[i] + (to[i] - from[i]) * f;
}

}  // namespace native_vm
