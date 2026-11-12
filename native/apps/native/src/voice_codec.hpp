#pragma once
// Opus for voice chat: 48 kHz mono, 20 ms frames, 24 kbit/s VBR, raw packets (no Ogg), the same stream the
// website's WebCodecs and libopus-wasm paths make and read.
#include "voice_wire.hpp"
#include <array>
#include <cstdint>
#include <memory>
#include <span>

struct OpusEncoder;
struct OpusDecoder;

namespace native::voice {

constexpr int encoder_complexity = 5;
// Concealment fills at most this many missing frames in a row; a longer gap starts a new spurt.
constexpr int max_concealed_frames = 4;

class Encoder {
public:
    Encoder();
    // Encodes one frame of frame_samples samples. Returns the packet's size in `out`, or 0 if encoding failed.
    size_t encode(std::span<const float, frame_samples> pcm, std::array<uint8_t, max_opus_frame_bytes> &out);
    void reset();

private:
    struct Free {
        void operator()(OpusEncoder *encoder) const;
    };

    std::unique_ptr<OpusEncoder, Free> encoder_;
};

class Decoder {
public:
    Decoder();
    // One packet into one frame. An empty packet asks for concealment of a lost one. False if the packet was bad.
    bool decode(std::span<const uint8_t> packet, std::span<float, frame_samples> pcm);
    void reset();

private:
    struct Free {
        void operator()(OpusDecoder *decoder) const;
    };

    std::unique_ptr<OpusDecoder, Free> decoder_;
};

}  // namespace native::voice
