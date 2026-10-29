#include "texture_bleed.hpp"
#include <cassert>
#include <iostream>

namespace {
constexpr uint32_t size = 8;

// Left half opaque red, right half transparent white: a cutout edge down the middle.
std::vector<uint8_t> cutout() {
    std::vector<uint8_t> rgba(size * size * 4);
    for (uint32_t y = 0; y < size; y++)
        for (uint32_t x = 0; x < size; x++) {
            uint8_t *texel = &rgba[(y * size + x) * 4];
            const bool opaque = x < size / 2;
            texel[0] = 255;
            texel[1] = texel[2] = opaque ? 0 : 255;
            texel[3] = opaque ? 255 : 0;
        }
    return rgba;
}
}  // namespace

int main() {
    auto rgba = cutout();
    assert(native_render::has_transparent_texels(rgba));
    native_render::bleed_transparent_texels(rgba, size, size);
    for (size_t at = 0; at < rgba.size(); at += 4) {
        assert(rgba[at] == 255 && rgba[at + 1] == 0 && rgba[at + 2] == 0);
        assert(rgba[at + 3] == (at / 4 % size < size / 2 ? 255 : 0));
    }
    std::vector<uint8_t> empty(4 * 4 * 4, 0);
    empty[0] = 9;
    native_render::bleed_transparent_texels(empty, 4, 4);
    assert(empty[0] == 9 && empty[4] == 0);
    std::vector<uint8_t> odd(3 * 1 * 4, 0);
    odd[3] = 255;
    odd[1] = 200;
    native_render::bleed_transparent_texels(odd, 3, 1);
    assert(odd[5] == 200 && odd[9] == 200 && odd[11] == 0);
    assert(!native_render::has_transparent_texels(std::vector<uint8_t>{1, 2, 3, 255}));
    std::cout << "Native texture bleed: cutout edges, empty and odd-sized textures passed\n";
}
