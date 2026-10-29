#pragma once
// Cutout textures (leaves, fences, grates) keep whatever colour the artist left under the mask, often white. Bilinear
// filtering and the mipmaps the client generates blend that colour into the visible edge, which drew a pale halo
// around every leaf. Fully transparent texels take the colour of the opaque texels nearest them instead (a push-pull
// fill: average the opaque texels down a pyramid, then fill each hole from the level above); they stay invisible.
#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <span>
#include <vector>

namespace native_render {
struct BleedLevel {
    uint32_t width = 0, height = 0;
    std::vector<std::array<float, 3>> colour;
    std::vector<uint8_t> known;
};

inline bool has_transparent_texels(std::span<const uint8_t> rgba) {
    for (size_t at = 3; at < rgba.size(); at += 4)
        if (rgba[at] == 0) return true;
    return false;
}

inline BleedLevel bleed_base_level(std::span<const uint8_t> rgba, uint32_t width, uint32_t height) {
    BleedLevel level{
            width,
            height,
            std::vector<std::array<float, 3>>(size_t(width) * height),
            std::vector<uint8_t>(size_t(width) * height)
    };
    for (size_t texel = 0; texel < level.known.size(); texel++) {
        level.known[texel] = rgba[texel * 4 + 3] != 0;
        for (int k = 0; k < 3; k++)
            level.colour[texel][k] = rgba[texel * 4 + k];
    }
    return level;
}

// Each texel of the next level is the mean of the known texels among the (up to) four it covers.
inline BleedLevel bleed_downsample(const BleedLevel &from) {
    BleedLevel to{std::max(1u, (from.width + 1) / 2), std::max(1u, (from.height + 1) / 2), {}, {}};
    to.colour.resize(size_t(to.width) * to.height);
    to.known.resize(to.colour.size());
    for (uint32_t y = 0; y < to.height; y++)
        for (uint32_t x = 0; x < to.width; x++) {
            std::array<float, 3> sum{};
            int count = 0;
            for (uint32_t sy = y * 2; sy < std::min(y * 2 + 2, from.height); sy++)
                for (uint32_t sx = x * 2; sx < std::min(x * 2 + 2, from.width); sx++) {
                    const size_t source = size_t(sy) * from.width + sx;
                    if (!from.known[source]) continue;
                    for (int k = 0; k < 3; k++)
                        sum[k] += from.colour[source][k];
                    count++;
                }
            const size_t texel = size_t(y) * to.width + x;
            to.known[texel] = count > 0;
            for (int k = 0; k < 3; k++)
                to.colour[texel][k] = count ? sum[k] / count : 0;
        }
    return to;
}

// Unknown texels take the colour of the coarser texel covering them.
inline void bleed_fill_from(BleedLevel &level, const BleedLevel &coarser) {
    for (uint32_t y = 0; y < level.height; y++)
        for (uint32_t x = 0; x < level.width; x++) {
            const size_t texel = size_t(y) * level.width + x;
            if (level.known[texel]) continue;
            const size_t parent = size_t(y / 2) * coarser.width + x / 2;
            level.colour[texel] = coarser.colour[parent];
            level.known[texel] = coarser.known[parent];
        }
}

inline void bleed_transparent_texels(std::span<uint8_t> rgba, uint32_t width, uint32_t height) {
    if (!width || !height || rgba.size() < size_t(width) * height * 4) return;
    std::vector<BleedLevel> levels;
    levels.push_back(bleed_base_level(rgba, width, height));
    while (levels.back().width > 1 || levels.back().height > 1)
        levels.push_back(bleed_downsample(levels.back()));
    for (size_t i = levels.size() - 1; i-- > 0;)
        bleed_fill_from(levels[i], levels[i + 1]);
    const auto &base = levels.front();
    for (size_t texel = 0; texel < base.known.size(); texel++) {
        if (rgba[texel * 4 + 3] != 0 || !base.known[texel]) continue;
        for (int k = 0; k < 3; k++)
            rgba[texel * 4 + k] = uint8_t(std::clamp(base.colour[texel][k] + .5f, 0.f, 255.f));
    }
}
}  // namespace native_render
