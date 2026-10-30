#include "map_audio_mix.hpp"
#include <cstring>

namespace native {
namespace {
uint32_t little_u32(std::span<const unsigned char> bytes, size_t offset) {
    return uint32_t(bytes[offset]) | uint32_t(bytes[offset + 1]) << 8 | uint32_t(bytes[offset + 2]) << 16
           | uint32_t(bytes[offset + 3]) << 24;
}

bool chunk_is(std::span<const unsigned char> bytes, size_t offset, const char *name) {
    return std::memcmp(bytes.data() + offset, name, 4) == 0;
}
}  // namespace

MapLoop map_wave_loop(std::span<const unsigned char> bytes) {
    MapLoop cue, sample;
    int64_t cue_id = -1;
    int64_t text_length = -1;
    if (bytes.size() < 12 || !chunk_is(bytes, 0, "RIFF") || !chunk_is(bytes, 8, "WAVE")) return {};
    for (size_t at = 12; at + 8 <= bytes.size();) {
        const size_t length = little_u32(bytes, at + 4);
        const size_t body = at + 8;
        const size_t end = std::min(body + length, bytes.size());
        if (chunk_is(bytes, at, "cue ") && end - body >= 28 && little_u32(bytes, body) > 0) {
            cue_id = little_u32(bytes, body + 4);
            cue.start = little_u32(bytes, body + 24);
        } else if (chunk_is(bytes, at, "smpl") && end - body >= 60 && little_u32(bytes, body + 28) > 0) {
            sample.start = little_u32(bytes, body + 44);
            const auto last = little_u32(bytes, body + 48);
            sample.end = last > sample.start ? int64_t(last) + 1 : -1;
        } else if (chunk_is(bytes, at, "LIST") && end - body >= 4 && chunk_is(bytes, body, "adtl")) {
            for (size_t sub = body + 4; sub + 8 <= end;) {
                const size_t size = little_u32(bytes, sub + 4);
                const size_t sub_end = std::min(sub + 8 + size, end);
                if (chunk_is(bytes, sub, "ltxt") && sub_end - sub >= 16 && little_u32(bytes, sub + 8) == cue_id)
                    text_length = little_u32(bytes, sub + 12);
                sub += 8 + size + (size & 1);
            }
        }
        at = body + length + (length & 1);
    }
    if (cue.start < 0) return sample;
    if (text_length > 0) cue.end = cue.start + text_length;
    return cue;
}
}  // namespace native
