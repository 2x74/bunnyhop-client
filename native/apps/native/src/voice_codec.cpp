#include "voice_codec.hpp"
#include <opus.h>
#include <algorithm>
#include <stdexcept>
#include <string>

namespace native::voice {

void Encoder::Free::operator()(OpusEncoder *encoder) const {
    opus_encoder_destroy(encoder);
}

void Decoder::Free::operator()(OpusDecoder *decoder) const {
    opus_decoder_destroy(decoder);
}

Encoder::Encoder() {
    int error = OPUS_OK;
    encoder_.reset(opus_encoder_create(sample_rate, 1, OPUS_APPLICATION_VOIP, &error));
    if (error != OPUS_OK || !encoder_) throw std::runtime_error("Opus encoder: " + std::string(opus_strerror(error)));
    opus_encoder_ctl(encoder_.get(), OPUS_SET_BITRATE(bitrate_bits_per_second));
    opus_encoder_ctl(encoder_.get(), OPUS_SET_VBR(1));
    opus_encoder_ctl(encoder_.get(), OPUS_SET_COMPLEXITY(encoder_complexity));
}

size_t Encoder::encode(std::span<const float, frame_samples> pcm, std::array<uint8_t, max_opus_frame_bytes> &out) {
    const int bytes = opus_encode_float(encoder_.get(), pcm.data(), frame_samples, out.data(), int(out.size()));
    return bytes > 0 ? size_t(bytes) : 0;
}

void Encoder::reset() {
    opus_encoder_ctl(encoder_.get(), OPUS_RESET_STATE);
}

Decoder::Decoder() {
    int error = OPUS_OK;
    decoder_.reset(opus_decoder_create(sample_rate, 1, &error));
    if (error != OPUS_OK || !decoder_) throw std::runtime_error("Opus decoder: " + std::string(opus_strerror(error)));
}

bool Decoder::decode(std::span<const uint8_t> packet, std::span<float, frame_samples> pcm) {
    const auto *data = packet.empty() ? nullptr : packet.data();
    const int samples =
            opus_decode_float(decoder_.get(), data, opus_int32(packet.size()), pcm.data(), frame_samples, 0);
    if (samples == frame_samples) return true;
    std::fill(pcm.begin(), pcm.end(), 0.f);
    return false;
}

void Decoder::reset() {
    opus_decoder_ctl(decoder_.get(), OPUS_RESET_STATE);
}

}  // namespace native::voice
