// Player program keys: two looks share a cached program only when they compile the same #defines. The garden camos
// brought stamps 4 to 6 (leaf, tracks, firefly); with two stamp bits, a leaf stamp keyed the same as a carrot stamp
// with the metal sheen, so whichever was drawn first would have drawn both. No two of today's camos met that way.
#include "player_program_key.hpp"
#include <algorithm>
#include <cassert>
#include <cstdio>
#include <vector>

namespace {
using native_render::player_program_key;
using native_render::PlayerMaterial;

constexpr int finish_codes = 1 << native_render::program_finish_bits, sheens = 3;
constexpr PlayerMaterial materials[] = {
        PlayerMaterial::solid, PlayerMaterial::ghost, PlayerMaterial::gun, PlayerMaterial::world_gun
};

void test_every_look_has_its_own_key() {
    std::vector<int> keys;
    for (int finish = 0; finish < finish_codes; finish++)
        for (int flags = 0; flags < 8; flags++)
            for (int camo = -1; camo < native_render::program_camo_kinds; camo++)
                for (int stamp = 0; stamp < native_render::program_camo_stamps; stamp++)
                    for (int sheen = 0; sheen < sheens; sheen++)
                        for (const auto material : materials)
                            keys.push_back(player_program_key(
                                    finish, flags & 1, flags & 2, flags & 4, camo, stamp, sheen, material
                            ));
    std::sort(keys.begin(), keys.end());
    assert(std::adjacent_find(keys.begin(), keys.end()) == keys.end());
    assert(keys.front() >= 0);
}

void test_garden_stamps_keep_their_programs() {
    constexpr int stamps = 5, matte = 0, metal = 1, leaf = 4, carrot = 0;
    assert(player_program_key(0, false, true, false, stamps, leaf, matte, PlayerMaterial::gun)
           != player_program_key(0, false, true, false, stamps, carrot, metal, PlayerMaterial::gun));
}
}  // namespace

int main() {
    test_every_look_has_its_own_key();
    test_garden_stamps_keep_their_programs();
    std::puts("Player program keys passed");
}
