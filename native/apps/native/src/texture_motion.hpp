#pragma once
// Source's TextureScroll proxy on `$basetexturetransform` (scrolling stars, conveyor arrows, waterfalls) and its
// AnimatedTexture proxy on `$basetexture` (flipbook signs, fire, screens), as the website's texture-scroll.ts draws
// them. The core reads the proxies and decodes the frames (bh_material_motion); this moves the texture each frame on
// the world's visual time, so replays and video exports show the same frame at the same tick. Render only.
#include "bunnyhop_native.h"
#include <array>
#include <cmath>
#include <cstdint>
#include <numbers>
#include <span>
#include <vector>

namespace native_render {

constexpr double degrees_to_radians = std::numbers::pi / 180;

// texture-scroll.ts scrollOffset: (s, t) at `seconds`, each wrapped into 0..1.
inline std::array<double, 2> scroll_offset(double rate, double angle_degrees, double seconds) {
    const double angle = angle_degrees * degrees_to_radians;
    const auto wrap = [](double value) {
        return value - std::floor(value);
    };
    return {wrap(seconds * std::cos(angle) * rate), wrap(seconds * std::sin(angle) * rate)};
}

// texture-scroll.ts animationFrame (CBaseAnimatedTextureProxy::OnBind): int(rate * time) mod frames, or the last frame
// once it is reached without wrap.
inline uint32_t animation_frame(double frame_rate, uint32_t frames, bool no_wrap, double seconds) {
    if (frames <= 1) return 0;
    const double frame = std::floor(frame_rate * std::max(0., seconds));
    if (no_wrap) return uint32_t(std::min(frame, double(frames - 1)));
    return uint32_t(std::fmod(frame, double(frames)));
}

}  // namespace native_render

namespace native {

// The world's visual time for moving textures and animated props, as the website keeps it: in play the newest tick
// plus the frame's blend (main.ts), in a replay the tick shown (viewer.ts), so a video export of the replay agrees.
inline double
world_visual_seconds(uint32_t previous_tick, uint32_t tick, float blend, double tick_interval, bool replay) {
    if (!replay) return (double(tick) + blend) * tick_interval;
    return (double(previous_tick) + (double(tick) - double(previous_tick)) * blend) * tick_interval;
}

}  // namespace native

namespace native_render {

class TextureMotion {
public:
    struct Shown {
        std::array<float, 2> offset{};
        // The flipbook frame's texture, or 0 for the material's own.
        uint32_t texture = 0;
    };

    // `motion` is parallel to the materials. A flipbook's frame textures are added with `add_frame` afterwards.
    void load(std::span<const BhMaterialMotion> motion) {
        shown_.assign(motion.size(), {});
        moving_.clear();
        for (size_t index = 0; index < motion.size(); ++index) {
            const auto &m = motion[index];
            if (m.scroll_rate == 0 && m.frames <= 1) continue;
            moving_.push_back({uint32_t(index), m, {}});
            if (m.frames > 1) moving_.back().frames.assign(m.frames, 0);
        }
    }

    size_t moving_count() const { return moving_.size(); }

    size_t flipbook_count() const {
        size_t count = 0;
        for (const auto &m : moving_)
            count += m.frames.empty() ? 0 : 1;
        return count;
    }

    // Visits every flipbook material: (material, frames).
    template <class Visit>
    void each_flipbook(Visit &&visit) const {
        for (const auto &m : moving_)
            if (!m.frames.empty()) visit(m.material, uint32_t(m.frames.size()));
    }

    void add_frame(uint32_t material, uint32_t frame, uint32_t texture) {
        for (auto &m : moving_)
            if (m.material == material && frame < m.frames.size()) m.frames[frame] = texture;
    }

    // A flipbook missing a frame's texture shows its first frame, as the website does when a book can't load.
    void drop_flipbook(uint32_t material) {
        for (auto &m : moving_)
            if (m.material == material) m.frames.clear();
    }

    void update(double seconds) {
        for (auto &m : moving_) {
            auto &shown = shown_[m.material];
            if (m.motion.scroll_rate != 0) {
                const auto offset = scroll_offset(m.motion.scroll_rate, m.motion.scroll_angle, seconds);
                shown.offset = {float(offset[0]), float(offset[1])};
            }
            if (m.frames.empty()) continue;
            const auto frame =
                    animation_frame(m.motion.frame_rate, uint32_t(m.frames.size()), m.motion.no_wrap != 0, seconds);
            shown.texture = m.frames[frame];
        }
    }

    const Shown &shown(uint32_t material) const { return material < shown_.size() ? shown_[material] : none_; }

private:
    struct Moving {
        uint32_t material;
        BhMaterialMotion motion;
        // Frame textures; frame 0 is the material's own texture (0).
        std::vector<uint32_t> frames;
    };

    std::vector<Shown> shown_;
    std::vector<Moving> moving_;
    Shown none_{};
};

}  // namespace native_render
