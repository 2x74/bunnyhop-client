#pragma once

namespace native_render {

enum class PlayerMaterial { solid, ghost, gun, world_gun };

// The player program cache packs every #define that tells two programs apart into one int. Each field has its own
// bits, so two looks share a program only when they compile the same source. A camo code past its field would land
// in the next one and draw with another look's program: export-viewmodels.ts refuses codes that don't fit.
inline constexpr int program_finish_bits = 6, program_camo_bits = 4, program_stamp_bits = 3, program_sheen_bits = 2;
// Camo kinds are stored plus one (0: no camo).
inline constexpr int program_camo_kinds = (1 << program_camo_bits) - 1;
inline constexpr int program_camo_stamps = 1 << program_stamp_bits;

inline int player_program_key(
        int finish, bool glove, bool detail, bool hilt, int camo, int stamp, int sheen, PlayerMaterial material
) {
    constexpr int glove_shift = program_finish_bits, detail_shift = glove_shift + 1, hilt_shift = detail_shift + 1;
    constexpr int camo_shift = hilt_shift + 1, stamp_shift = camo_shift + program_camo_bits;
    constexpr int sheen_shift = stamp_shift + program_stamp_bits, material_shift = sheen_shift + program_sheen_bits;
    constexpr auto field = [](int value, int bits) {
        return value & ((1 << bits) - 1);
    };
    return field(finish, program_finish_bits) | (glove ? 1 << glove_shift : 0) | (detail ? 1 << detail_shift : 0)
           | (hilt ? 1 << hilt_shift : 0) | field(camo + 1, program_camo_bits) << camo_shift
           | field(stamp, program_stamp_bits) << stamp_shift | field(sheen, program_sheen_bits) << sheen_shift
           | int(material) << material_shift;
}

}  // namespace native_render
