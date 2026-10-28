#include "audio_pack.hpp"

#include <algorithm>
#include <array>
#include <limits>
#include <memory>
#include <type_traits>
#include <cmath>
#include <cstring>
#include <fstream>

// The decoders are compiled here and nowhere else. Each is a single header
// carrying its whole implementation, so including them from a shared header
// would re-emit roughly 1.3 MB of source into every translation unit that
// merely wanted to play a sound.
#define DR_WAV_IMPLEMENTATION
#define DR_WAV_NO_STDIO
#include "dr_libs/dr_wav.h"
#define DR_MP3_IMPLEMENTATION
#define DR_MP3_NO_STDIO
#include "dr_libs/dr_mp3.h"
#define DR_FLAC_IMPLEMENTATION
#define DR_FLAC_NO_STDIO
#include "dr_libs/dr_flac.h"
#define STB_VORBIS_NO_STDIO
#define STB_VORBIS_NO_PUSHDATA_API
// stb_vorbis compares its fixed-size array with null; leave third-party code intact.
#ifdef __clang__
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wtautological-compare"
#endif
#include "stb/stb_vorbis.c"
#ifdef __clang__
#pragma clang diagnostic pop
#endif

namespace native {
namespace {

bool matches(const unsigned char *bytes, std::size_t size, std::size_t at, const char *tag) {
    const std::size_t length = std::strlen(tag);
    return size >= at + length && std::memcmp(bytes + at, tag, length) == 0;
}

// Length in bytes of the MPEG audio frame starting at |b|, or 0 if that is not
// a valid frame header.
std::size_t mp3_frame_length(const unsigned char *b, std::size_t size, std::size_t at) {
    if (size < at + 4) return 0;
    const unsigned char b0 = b[at], b1 = b[at + 1], b2 = b[at + 2];
    if (b0 != 0xFF || (b1 & 0xE0) != 0xE0) return 0;
    const unsigned version = (b1 >> 3) & 3, layer = (b1 >> 1) & 3;
    const unsigned bitrate_index = b2 >> 4, rate_index = (b2 >> 2) & 3;
    // 01 is reserved for the version, 00 for the layer, and the all-ones
    // bitrate and all-ones sample rate are both invalid.
    if (version == 1 || layer == 0 || bitrate_index == 0 || bitrate_index == 15 || rate_index == 3) return 0;
    static const unsigned kRates[3] = {44100, 48000, 32000};
    static const unsigned kV1L1[15] = {0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448};
    static const unsigned kV1L2[15] = {0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384};
    static const unsigned kV1L3[15] = {0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320};
    static const unsigned kV2L1[15] = {0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256};
    static const unsigned kV2L23[15] = {0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160};
    const bool mpeg1 = version == 3;
    unsigned sample_rate = kRates[rate_index];
    if (version == 2)
        sample_rate /= 2;  // MPEG 2
    else if (version == 0)
        sample_rate /= 4;  // MPEG 2.5
    const unsigned bitrate = 1000
                             * (layer == 3   ? (mpeg1 ? kV1L1[bitrate_index] : kV2L1[bitrate_index])
                                : layer == 2 ? (mpeg1 ? kV1L2[bitrate_index] : kV2L23[bitrate_index])
                                             : (mpeg1 ? kV1L3[bitrate_index] : kV2L23[bitrate_index]));
    if (bitrate == 0) return 0;
    const unsigned padding = (b2 >> 1) & 1;
    if (layer == 3) return 4 * (12 * bitrate / sample_rate + padding);  // Layer I counts in slots of 4
    const unsigned samples_per_frame = (layer == 1 && !mpeg1) ? 576 : 1152;
    return samples_per_frame / 8 * bitrate / sample_rate + padding;
}

bool looks_like_mp3(const unsigned char *bytes, std::size_t size) {
    if (matches(bytes, size, 0, "ID3")) return true;
    // A lone valid-looking header appears in plenty of binary files, so require
    // that the frame it describes is followed by another one.
    const std::size_t scan = std::min<std::size_t>(size, 8192);
    for (std::size_t at = 0; at + 4 <= scan; ++at) {
        const std::size_t length = mp3_frame_length(bytes, size, at);
        if (length >= 4 && mp3_frame_length(bytes, size, at + length) >= 4) return true;
    }
    return false;
}

bool read_file(const std::filesystem::path &file, std::vector<unsigned char> *out, std::string *error) {
    std::error_code ec;
    const auto size = std::filesystem::file_size(file, ec);
    if (ec) {
        *error = "cannot be read";
        return false;
    }
    if (size == 0) {
        *error = "is empty";
        return false;
    }
    if (size > max_pack_file_bytes) {
        *error = "is larger than 64 MB";
        return false;
    }
    std::ifstream stream(file, std::ios::binary);
    out->resize(std::size_t(size));
    if (!stream.read(reinterpret_cast<char *>(out->data()), std::streamsize(size))) {
        *error = "could not be read to the end";
        return false;
    }
    return true;
}

// All decoders use the same sample budget, including containers whose length
// is missing or dishonest. The fixed scratch buffer permits one extra frame
// at the limit to distinguish exact fits from oversized streams, without ever
// appending PCM beyond the budget.
template <typename Audio, typename Read>
bool read_bounded(
        Audio *out, int channels, int rate, std::uint64_t frames, std::uint64_t cap, Read read, std::string *error
) {
    using Sample = typename decltype(out->samples)::value_type;
    const auto too_long = [&] {
        *error = "exceeds the decoded sample budget";
        return false;
    };
    if (channels <= 0 || channels > 256 || rate <= 0) {
        *error = "has invalid audio parameters";
        return false;
    }
    if (frames > cap / std::uint64_t(channels)) return too_long();
    std::array<Sample, 4096> chunk;
    Audio decoded;
    decoded.channels = channels;
    decoded.rate = rate;
    const auto capacity = std::size_t(cap);
    // Metadata can reject early but never authorizes reading past the cap.
    if (frames) decoded.samples.reserve(std::size_t(frames) * channels);
    for (;;) {
        const auto remaining = (capacity - decoded.samples.size()) / channels;
        const auto want = std::min(chunk.size() / channels, remaining + 1);
        const std::uint64_t got = read(want, chunk.data());
        if (got > remaining) return too_long();
        if (!got) break;
        const auto count = std::size_t(got) * channels;
        const auto size = decoded.samples.size() + count;
        if (size > decoded.samples.capacity()) {
            // Bound geometric vector growth too, not only its logical size.
            const auto grown =
                    std::min(capacity, decoded.samples.capacity() + std::max(decoded.samples.capacity(), chunk.size()));
            decoded.samples.reserve(std::max(size, grown));
        }
        decoded.samples.insert(decoded.samples.end(), chunk.data(), chunk.data() + count);
    }
    if (!decoded.ok()) {
        *error = "decoded to no audio";
        return false;
    }
    *out = std::move(decoded);
    return true;
}

template <typename Audio>
bool decode_encoded(
        const std::vector<unsigned char> &bytes, AudioFormat format, Audio *out, std::uint64_t cap, std::string *error
) {
    using Sample = typename decltype(out->samples)::value_type;
    constexpr bool floating = std::is_same_v<Sample, float>;
    switch (format) {
        case AudioFormat::wav: {
            drwav wav{};
            if (!drwav_init_memory(&wav, bytes.data(), bytes.size(), nullptr)) break;
            const auto cleanup = [](drwav *p) {
                drwav_uninit(p);
            };
            const std::unique_ptr<drwav, decltype(cleanup)> guard(&wav, cleanup);
            return read_bounded(
                    out,
                    int(wav.channels),
                    int(wav.sampleRate),
                    wav.totalPCMFrameCount,
                    cap,
                    [&](std::size_t frames, Sample *samples) {
                        if constexpr (floating)
                            return drwav_read_pcm_frames_f32(&wav, frames, samples);
                        else
                            return drwav_read_pcm_frames_s16(&wav, frames, samples);
                    },
                    error
            );
        }
        case AudioFormat::mp3: {
            drmp3 mp3{};
            if (!drmp3_init_memory(&mp3, bytes.data(), bytes.size(), nullptr)) break;
            const auto cleanup = [](drmp3 *p) {
                drmp3_uninit(p);
            };
            const std::unique_ptr<drmp3, decltype(cleanup)> guard(&mp3, cleanup);
            // Xing/Info lengths include encoder delay and padding. Without a
            // length tag, decode incrementally rather than scanning twice.
            const auto frames = mp3.totalPCMFrameCount == DRMP3_UINT64_MAX ? 0 : drmp3_get_pcm_frame_count(&mp3);
            return read_bounded(
                    out,
                    int(mp3.channels),
                    int(mp3.sampleRate),
                    frames,
                    cap,
                    [&](std::size_t count, Sample *samples) {
                        if constexpr (floating)
                            return drmp3_read_pcm_frames_f32(&mp3, count, samples);
                        else
                            return drmp3_read_pcm_frames_s16(&mp3, count, samples);
                    },
                    error
            );
        }
        case AudioFormat::ogg: {
            // Vorbis first; FLAC-in-Ogg uses the same bounded FLAC path below.
            int code = 0;
            const std::unique_ptr<stb_vorbis, decltype(&stb_vorbis_close)> vorbis(
                    stb_vorbis_open_memory(bytes.data(), int(bytes.size()), &code, nullptr), stb_vorbis_close
            );
            if (vorbis) {
                const auto info = stb_vorbis_get_info(vorbis.get());
                const auto frames = stb_vorbis_stream_length_in_samples(vorbis.get());
                return read_bounded(
                        out,
                        info.channels,
                        int(info.sample_rate),
                        frames,
                        cap,
                        [&](std::size_t count, Sample *samples) {
                            if constexpr (floating)
                                return stb_vorbis_get_samples_float_interleaved(
                                        vorbis.get(), info.channels, samples, int(count * info.channels)
                                );
                            else
                                return stb_vorbis_get_samples_short_interleaved(
                                        vorbis.get(), info.channels, samples, int(count * info.channels)
                                );
                        },
                        error
                );
            }
            [[fallthrough]];
        }
        case AudioFormat::flac: {
            const auto cleanup = [](drflac *p) {
                drflac_close(p);
            };
            const std::unique_ptr<drflac, decltype(cleanup)> flac(
                    drflac_open_memory(bytes.data(), bytes.size(), nullptr), cleanup
            );
            if (!flac) break;
            return read_bounded(
                    out,
                    int(flac->channels),
                    int(flac->sampleRate),
                    flac->totalPCMFrameCount,
                    cap,
                    [&](std::size_t frames, Sample *samples) {
                        if constexpr (floating)
                            return drflac_read_pcm_frames_f32(flac.get(), frames, samples);
                        else
                            return drflac_read_pcm_frames_s16(flac.get(), frames, samples);
                    },
                    error
            );
        }
        default:
            break;
    }
    *error = "is not a WAV, MP3, FLAC or Ogg file this build can decode";
    return false;
}

}  // namespace

AudioFormat sniff_audio(const unsigned char *bytes, std::size_t size) {
    if (!bytes || size < 4) return AudioFormat::unknown;
    if (matches(bytes, size, 0, "RIFF") && matches(bytes, size, 8, "WAVE")) return AudioFormat::wav;
    if (matches(bytes, size, 0, "fLaC")) return AudioFormat::flac;
    if (matches(bytes, size, 0, "OggS")) return AudioFormat::ogg;
    if (looks_like_mp3(bytes, size)) return AudioFormat::mp3;
    return AudioFormat::unknown;
}

const char *audio_format_name(AudioFormat format) {
    switch (format) {
        case AudioFormat::wav:
            return "WAV";
        case AudioFormat::mp3:
            return "MP3";
        case AudioFormat::flac:
            return "FLAC";
        case AudioFormat::ogg:
            return "Ogg";
        default:
            return "unrecognised";
    }
}

bool decode_sfx_file(
        const std::filesystem::path &file,
        DecodedAudio *out,
        std::string *error,
        std::uint64_t max_samples,
        bool wav_only
) {
    *out = {};
    error->clear();
    const auto cap = std::min(max_samples, max_sfx_samples);
    std::vector<unsigned char> bytes;
    if (!read_file(file, &bytes, error)) return false;
    const auto format = sniff_audio(bytes.data(), bytes.size());
    // Downloaded content (the Classic CS:S group) is only ever WAV. Sniffing
    // must not let a file named .wav reach the Ogg/FLAC/MP3 decoders.
    if (wav_only && format != AudioFormat::wav) {
        *error = "is not a WAV file";
        return false;
    }
    // Raw float32 has no header; its samples already use the mixer's rate.
    if (format == AudioFormat::unknown && file.extension() == ".f32") {
        if (bytes.size() % sizeof(float)) {
            *error = "is not a whole number of float samples";
            return false;
        }
        if (bytes.size() / sizeof(float) > cap) {
            *error = "exceeds the decoded sample budget";
            return false;
        }
        out->channels = 1;
        out->samples.resize(bytes.size() / sizeof(float));
        std::memcpy(out->samples.data(), bytes.data(), bytes.size());
        return true;
    }
    return decode_encoded(bytes, format, out, cap, error);
}

bool decode_music_file(
        const std::filesystem::path &file, DecodedMusic *out, std::string *error, std::uint64_t max_samples
) {
    *out = {};
    error->clear();
    std::vector<unsigned char> bytes;
    if (!read_file(file, &bytes, error)) return false;
    return decode_encoded(
            bytes, sniff_audio(bytes.data(), bytes.size()), out, std::min(max_samples, max_music_samples), error
    );
}

std::vector<float> to_mono(const DecodedAudio &audio) {
    if (audio.channels <= 1) return audio.samples;
    const std::size_t channels = std::size_t(audio.channels);
    const std::size_t frames = audio.samples.size() / channels;
    std::vector<float> mono(frames);
    const float scale = 1.0f / float(channels);
    for (std::size_t frame = 0; frame < frames; ++frame) {
        float sum = 0;
        for (std::size_t channel = 0; channel < channels; ++channel)
            sum += audio.samples[frame * channels + channel];
        mono[frame] = sum * scale;
    }
    return mono;
}

std::vector<float>
resample_mono(const std::vector<float> &samples, int from_rate, int to_rate, std::size_t max_samples) {
    if (samples.empty()) return {};
    if (from_rate <= 0 || to_rate <= 0 || from_rate == to_rate)
        return samples.size() <= max_samples ? samples : std::vector<float>{};
    // Integer quotient/remainder arithmetic avoids overflow and an out-of-range
    // floating-point-to-size_t conversion, even for adversarial sample rates.
    const auto whole = samples.size() / std::size_t(from_rate);
    const auto tail =
            std::uint64_t(samples.size() % std::size_t(from_rate)) * std::uint64_t(to_rate) / std::uint64_t(from_rate);
    const auto limit = std::min(max_samples, std::vector<float>{}.max_size());
    if (tail > limit || whole > (limit - tail) / std::size_t(to_rate)) return {};
    const std::size_t count = whole * std::size_t(to_rate) + std::size_t(tail);
    if (count == 0) return {};
    const double ratio = double(from_rate) / double(to_rate);
    std::vector<float> out(count);
    if (ratio > 1.0) {
        // Going down in rate, every output sample averages the whole input span
        // that collapses into it. Point-sampling instead would read two inputs
        // in every N and fold everything above the new Nyquist rate back down
        // into the audible band as a whistle over the sound.
        for (std::size_t i = 0; i < count; ++i) {
            const double start = double(i) * ratio, end = start + ratio;
            const std::size_t first = std::size_t(start);
            // The span is half-open: [0, 2) is samples 0 and 1, so the end
            // rounds up rather than taking one more sample than it covers.
            std::size_t last = std::min(samples.size(), std::size_t(std::ceil(end)));
            if (last <= first) last = std::min(samples.size(), first + 1);
            double sum = 0;
            std::size_t taken = 0;
            for (std::size_t at = first; at < last; ++at, ++taken)
                sum += samples[at];
            out[i] = taken ? float(sum / double(taken)) : 0.0f;
        }
    } else {
        for (std::size_t i = 0; i < count; ++i) {
            const double at = double(i) * ratio;
            const std::size_t index = std::size_t(at);
            const std::size_t next = std::min(index + 1, samples.size() - 1);
            const float a = samples[index], b = samples[next];
            out[i] = a + (b - a) * float(at - double(index));
        }
    }
    return out;
}

namespace {

// Candidate files inside |dir|: regular files only, no dotfiles, nothing larger
// than a pack file is allowed to be. Missing directories are normal — a player
// who has added no custom audio has no folder — so they yield nothing rather
// than an error.
std::vector<std::filesystem::path> pack_files(const std::filesystem::path &dir) {
    std::vector<std::filesystem::path> found;
    std::error_code ec;
    if (!std::filesystem::is_directory(dir, ec)) return found;
    for (const auto &entry :
         std::filesystem::directory_iterator(dir, std::filesystem::directory_options::skip_permission_denied, ec)) {
        if (ec) break;
        if (!entry.is_regular_file(ec) || ec) {
            ec.clear();
            continue;
        }
        const auto name = entry.path().filename().string();
        if (name.empty() || name.front() == '.') continue;
        const auto size = entry.file_size(ec);
        if (ec || size == 0 || size > max_pack_file_bytes) {
            ec.clear();
            continue;
        }
        found.push_back(entry.path());
    }
    std::sort(found.begin(), found.end());
    return found;
}

}  // namespace

std::map<std::string, std::vector<std::filesystem::path>> scan_sfx_pack(const std::filesystem::path &dir) {
    std::map<std::string, std::vector<std::filesystem::path>> cues;
    for (const auto &file : pack_files(dir)) {
        auto id = file.stem().string();
        // "jump-2.wav" is an alternate for "jump", the same way the shipped
        // pack names its variants. A trailing number is only a variant when
        // something remains in front of it.
        const auto dash = id.find_last_of('-');
        if (dash != std::string::npos && dash > 0 && dash + 1 < id.size()
            && id.find_first_not_of("0123456789", dash + 1) == std::string::npos) {
            id.erase(dash);
        }
        if (!id.empty()) cues[id].push_back(file);
    }
    return cues;
}

std::vector<MusicTrack> scan_music_pack(const std::filesystem::path &dir) {
    std::vector<MusicTrack> tracks;
    for (const auto &file : pack_files(dir)) {
        auto id = file.stem().string();
        if (id.empty()) continue;
        tracks.push_back({id, id, file});
    }
    return tracks;
}

}  // namespace native
