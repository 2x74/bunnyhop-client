#pragma once
// Map tiers T1–T10 as the website shows them (web tiers.ts): label, name and colour. A raw tier above 10 shows as
// T10, and 0 or less is unrated ("T?"), as clampTier does. ui/host-tables.test.ts checks these against tiers.ts.
#include "hud_text.hpp"
#include <algorithm>
#include <array>
#include <cstdint>
#include <string_view>

namespace native {

inline constexpr int max_map_tier = 10;

// TIER_COLORS: green, teal, yellow, orange, red, violet, indigo, pink, azure, white.
inline constexpr std::array<uint32_t, max_map_tier> tier_rgb = {
        0x5ee08a, 0x3fd0c9, 0xffd84d, 0xff9a3c, 0xff5468, 0xc477ff, 0x7c83ff, 0xff6ec7, 0x4fb8ff, 0xf2f4ff
};
inline constexpr uint32_t tier_unknown_rgb = 0x8a93a6;

inline constexpr std::array<std::string_view, max_map_tier> tier_names = {
        "Very easy", "Easy", "Medium", "Hard", "Very hard", "Extreme", "Insane", "Brutal", "Nightmare", "Impossible"
};

// 1..10, or 0 for unrated.
constexpr int clamp_map_tier(int raw) {
    return raw < 1 ? 0 : std::min(raw, max_map_tier);
}

constexpr std::array<float, 4> tier_color(int raw) {
    const int tier = clamp_map_tier(raw);
    const uint32_t rgb = tier ? tier_rgb[size_t(tier - 1)] : tier_unknown_rgb;
    return {float(rgb >> 16) / 255, float((rgb >> 8) & 255) / 255, float(rgb & 255) / 255, 1};
}

constexpr std::string_view tier_name(int raw) {
    const int tier = clamp_map_tier(raw);
    return tier ? tier_names[size_t(tier - 1)] : std::string_view("Unrated");
}

// "T3", "T10", "T?".
template <size_t Capacity>
void format_tier_label(HudLabel<Capacity> &label, int raw) {
    const int tier = clamp_map_tier(raw);
    if (tier)
        label.format("T%d", tier);
    else
        label.assign("T?");
}

}  // namespace native
