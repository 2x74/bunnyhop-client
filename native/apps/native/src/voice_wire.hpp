#pragma once
// Voice chat frames on the room socket, byte for byte as the website's net/voice-wire.ts (docs/client/voice.md).
//
//   VOICE_UP   (client -> room)                     VOICE_DOWN (room -> listeners)
//   0  u8  0x10                                     0  u8  0x11
//   1  u8  flags (start | end)                      1  u8  talker's roster slot
//   2  u16 seq, little endian, +1 per packet        2..    VOICE_UP bytes 1.. unchanged
//   4  u8  frame count n (0..3; 0 only with end)
//   5  n x (u8 len 1..255, len bytes of one 20 ms Opus packet, 48 kHz mono)
//
// Parsing is strict: unknown flag bits, a bad length or a stray byte make the whole frame malformed, as on the room.
#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>
#include <vector>

namespace native::voice {

constexpr uint8_t message_voice_up = 0x10;
constexpr uint8_t message_voice_down = 0x11;
constexpr uint8_t flag_start = 1;
constexpr uint8_t flag_end = 2;
constexpr int frame_ms = 20;
constexpr int sample_rate = 48000;
constexpr int frame_samples = sample_rate * frame_ms / 1000;
constexpr int bitrate_bits_per_second = 24000;
constexpr size_t frames_per_packet = 2;
constexpr size_t max_frames = 3;
constexpr size_t max_opus_frame_bytes = 255;
constexpr size_t voice_up_header_bytes = 5;
constexpr size_t max_voice_up_bytes = voice_up_header_bytes + max_frames * (1 + max_opus_frame_bytes);
constexpr size_t max_voice_down_bytes = max_voice_up_bytes + 1;

// One packet's frames point into the bytes it was parsed from.
struct Packet {
    uint8_t flags = 0;
    uint16_t seq = 0;
    std::array<std::span<const uint8_t>, max_frames> frames{};
    size_t frame_count = 0;
};

struct DownPacket {
    unsigned slot = 0;
    Packet packet;
};

// a comes after b in 16-bit sequence order.
constexpr bool seq_after(uint16_t a, uint16_t b) {
    const uint16_t ahead = uint16_t(a - b);
    return ahead != 0 && ahead < 0x8000;
}

namespace detail {
inline std::optional<Packet> parse_body(std::span<const uint8_t> bytes, size_t at) {
    if (bytes.size() < at + 4) return std::nullopt;
    Packet packet;
    packet.flags = bytes[at];
    if (packet.flags & ~(flag_start | flag_end)) return std::nullopt;
    packet.seq = uint16_t(bytes[at + 1] | (bytes[at + 2] << 8));
    packet.frame_count = bytes[at + 3];
    if (packet.frame_count > max_frames || (packet.frame_count == 0 && !(packet.flags & flag_end))) return std::nullopt;
    size_t offset = at + 4;
    for (size_t i = 0; i < packet.frame_count; ++i) {
        if (offset >= bytes.size()) return std::nullopt;
        const size_t length = bytes[offset++];
        if (length < 1 || offset + length > bytes.size()) return std::nullopt;
        packet.frames[i] = bytes.subspan(offset, length);
        offset += length;
    }
    if (offset != bytes.size()) return std::nullopt;
    return packet;
}
}  // namespace detail

inline std::optional<Packet> parse_voice_up(std::span<const uint8_t> bytes) {
    if (bytes.empty() || bytes.size() > max_voice_up_bytes || bytes[0] != message_voice_up) return std::nullopt;
    return detail::parse_body(bytes, 1);
}

inline std::optional<DownPacket> parse_voice_down(std::span<const uint8_t> bytes) {
    if (bytes.size() < 2 || bytes.size() > max_voice_down_bytes || bytes[0] != message_voice_down) return std::nullopt;
    auto packet = detail::parse_body(bytes, 2);
    if (!packet) return std::nullopt;
    return DownPacket{bytes[1], *packet};
}

// Builds a VOICE_UP. Returns nothing for a packet the room would refuse as malformed (never send those).
inline std::optional<std::vector<uint8_t>> encode_voice_up(
        uint8_t flags, uint16_t seq, std::span<const std::span<const uint8_t>> frames
) {
    if (frames.size() > max_frames || (frames.empty() && !(flags & flag_end))) return std::nullopt;
    if (flags & ~(flag_start | flag_end)) return std::nullopt;
    std::vector<uint8_t> out;
    out.reserve(max_voice_up_bytes);
    out.push_back(message_voice_up);
    out.push_back(flags);
    out.push_back(uint8_t(seq & 0xff));
    out.push_back(uint8_t(seq >> 8));
    out.push_back(uint8_t(frames.size()));
    for (const auto &frame : frames) {
        if (frame.empty() || frame.size() > max_opus_frame_bytes) return std::nullopt;
        out.push_back(uint8_t(frame.size()));
        out.insert(out.end(), frame.begin(), frame.end());
    }
    return out;
}

}  // namespace native::voice
