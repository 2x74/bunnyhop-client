#pragma once
#include <cstdint>
#include <span>
#include <string>

namespace native {

// Lossless WebP (VP8L, RFC 9649) for avatar pictures: the server stores the bytes as they are and only reads
// the header, so any valid WebP will do. Subtract-green and predictor transforms, LZ77 and Huffman codes; no
// colour cache or meta prefix codes. `rgba` is straight-alpha RGBA8, rows top-down. Throws on bad sizes.
std::string encode_webp_lossless(std::span<const uint8_t> rgba, int width, int height);

}  // namespace native
