#include "audio_pack.hpp"

#include <algorithm>
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
#include "stb/stb_vorbis.c"

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
    static const unsigned kV1L1[15] = {0,32,64,96,128,160,192,224,256,288,320,352,384,416,448};
    static const unsigned kV1L2[15] = {0,32,48,56,64,80,96,112,128,160,192,224,256,320,384};
    static const unsigned kV1L3[15] = {0,32,40,48,56,64,80,96,112,128,160,192,224,256,320};
    static const unsigned kV2L1[15] = {0,32,48,56,64,80,96,112,128,144,160,176,192,224,256};
    static const unsigned kV2L23[15] = {0,8,16,24,32,40,48,56,64,80,96,112,128,144,160};
    const bool mpeg1 = version == 3;
    unsigned sample_rate = kRates[rate_index];
    if (version == 2) sample_rate /= 2;       // MPEG 2
    else if (version == 0) sample_rate /= 4;  // MPEG 2.5
    const unsigned bitrate = 1000 * (layer == 3 ? (mpeg1 ? kV1L1[bitrate_index] : kV2L1[bitrate_index])
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
    if (ec) { *error = "cannot be read"; return false; }
    if (size == 0) { *error = "is empty"; return false; }
    if (size > max_pack_file_bytes) { *error = "is larger than 64 MB"; return false; }
    std::ifstream stream(file, std::ios::binary);
    out->resize(std::size_t(size));
    if (!stream.read(reinterpret_cast<char *>(out->data()), std::streamsize(size))) {
        *error = "could not be read to the end";
        return false;
    }
    return true;
}

// Ogg carries more than one codec. Vorbis is overwhelmingly the common case, so
// it is tried first and FLAC-in-Ogg is the fallback rather than a second sniff.
bool decode_ogg_f32(const std::vector<unsigned char> &bytes, DecodedAudio *out) {
    int channels = 0, rate = 0;
    // stb_vorbis only decodes a whole file to int16, so the widening happens
    // here rather than in the decoder.
    short *interleaved = nullptr;
    const int frames = stb_vorbis_decode_memory(bytes.data(), int(bytes.size()), &channels, &rate, &interleaved);
    if (frames <= 0 || !interleaved || channels <= 0) { if (interleaved) free(interleaved); return false; }
    const std::size_t count = std::size_t(frames) * std::size_t(channels);
    if (count > max_sfx_samples) { free(interleaved); return false; }
    out->channels = channels;
    out->rate = rate;
    out->samples.resize(count);
    for (std::size_t i = 0; i < count; ++i) out->samples[i] = float(interleaved[i]) / 32768.0f;
    free(interleaved);
    return true;
}

template <typename T>
bool too_many(std::uint64_t frames, std::uint64_t channels, std::uint64_t cap) {
    return channels == 0 || frames > cap / channels;
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
        case AudioFormat::wav: return "WAV";
        case AudioFormat::mp3: return "MP3";
        case AudioFormat::flac: return "FLAC";
        case AudioFormat::ogg: return "Ogg";
        default: return "unrecognised";
    }
}

bool decode_sfx_file(const std::filesystem::path &file, DecodedAudio *out, std::string *error) {
    std::vector<unsigned char> bytes;
    if (!read_file(file, &bytes, error)) return false;
    *out = {};
    const auto format = sniff_audio(bytes.data(), bytes.size());

    // Raw float32 has no header to recognise, so it is accepted on its
    // extension alone. It is the format the shipped pack uses, which makes it
    // the one way to supply a file that is already at the mixer's own rate.
    if (format == AudioFormat::unknown && file.extension() == ".f32") {
        if (bytes.size() % 4 || bytes.size() / 4 > max_sfx_samples) { *error = "is not a whole number of float samples"; return false; }
        out->channels = 1;
        out->rate = 0;  // caller's mixer rate; no resampling
        out->samples.resize(bytes.size() / 4);
        std::memcpy(out->samples.data(), bytes.data(), bytes.size());
        return true;
    }

    switch (format) {
        case AudioFormat::wav: {
            unsigned channels = 0, rate = 0;
            drwav_uint64 frames = 0;
            float *samples = drwav_open_memory_and_read_pcm_frames_f32(bytes.data(), bytes.size(), &channels, &rate, &frames, nullptr);
            if (!samples) { *error = "is not a WAV file this build can decode"; return false; }
            if (too_many<float>(frames, channels, max_sfx_samples)) { drwav_free(samples, nullptr); *error = "is too long for a sound effect"; return false; }
            out->channels = int(channels); out->rate = int(rate);
            out->samples.assign(samples, samples + std::size_t(frames) * channels);
            drwav_free(samples, nullptr);
            break;
        }
        case AudioFormat::flac: {
            unsigned channels = 0, rate = 0;
            drflac_uint64 frames = 0;
            float *samples = drflac_open_memory_and_read_pcm_frames_f32(bytes.data(), bytes.size(), &channels, &rate, &frames, nullptr);
            if (!samples) { *error = "is not a FLAC file this build can decode"; return false; }
            if (too_many<float>(frames, channels, max_sfx_samples)) { drflac_free(samples, nullptr); *error = "is too long for a sound effect"; return false; }
            out->channels = int(channels); out->rate = int(rate);
            out->samples.assign(samples, samples + std::size_t(frames) * channels);
            drflac_free(samples, nullptr);
            break;
        }
        case AudioFormat::mp3: {
            drmp3_config config{};
            drmp3_uint64 frames = 0;
            float *samples = drmp3_open_memory_and_read_pcm_frames_f32(bytes.data(), bytes.size(), &config, &frames, nullptr);
            if (!samples) { *error = "is not an MP3 file this build can decode"; return false; }
            if (too_many<float>(frames, config.channels, max_sfx_samples)) { drmp3_free(samples, nullptr); *error = "is too long for a sound effect"; return false; }
            out->channels = int(config.channels); out->rate = int(config.sampleRate);
            out->samples.assign(samples, samples + std::size_t(frames) * config.channels);
            drmp3_free(samples, nullptr);
            break;
        }
        case AudioFormat::ogg: {
            if (decode_ogg_f32(bytes, out)) break;
            unsigned channels = 0, rate = 0;
            drflac_uint64 frames = 0;
            float *samples = drflac_open_memory_and_read_pcm_frames_f32(bytes.data(), bytes.size(), &channels, &rate, &frames, nullptr);
            if (!samples) { *error = "is an Ogg file in a codec this build cannot decode"; return false; }
            out->channels = int(channels); out->rate = int(rate);
            out->samples.assign(samples, samples + std::size_t(frames) * channels);
            drflac_free(samples, nullptr);
            break;
        }
        default:
            *error = "is not WAV, MP3, FLAC or Ogg";
            return false;
    }
    if (out->samples.size() > max_sfx_samples) { *out = {}; *error = "is too long for a sound effect"; return false; }
    if (!out->ok()) { *out = {}; *error = "decoded to no audio"; return false; }
    return true;
}

bool decode_music_file(const std::filesystem::path &file, DecodedMusic *out, std::string *error) {
    std::vector<unsigned char> bytes;
    if (!read_file(file, &bytes, error)) return false;
    *out = {};
    switch (sniff_audio(bytes.data(), bytes.size())) {
        case AudioFormat::wav: {
            unsigned channels = 0, rate = 0;
            drwav_uint64 frames = 0;
            drwav_int16 *samples = drwav_open_memory_and_read_pcm_frames_s16(bytes.data(), bytes.size(), &channels, &rate, &frames, nullptr);
            if (!samples) { *error = "is not a WAV file this build can decode"; return false; }
            if (too_many<drwav_int16>(frames, channels, max_music_samples)) { drwav_free(samples, nullptr); *error = "is longer than this build can hold in memory"; return false; }
            out->channels = int(channels); out->rate = int(rate);
            out->samples.assign(samples, samples + std::size_t(frames) * channels);
            drwav_free(samples, nullptr);
            break;
        }
        case AudioFormat::flac: {
            unsigned channels = 0, rate = 0;
            drflac_uint64 frames = 0;
            drflac_int16 *samples = drflac_open_memory_and_read_pcm_frames_s16(bytes.data(), bytes.size(), &channels, &rate, &frames, nullptr);
            if (!samples) { *error = "is not a FLAC file this build can decode"; return false; }
            if (too_many<drflac_int16>(frames, channels, max_music_samples)) { drflac_free(samples, nullptr); *error = "is longer than this build can hold in memory"; return false; }
            out->channels = int(channels); out->rate = int(rate);
            out->samples.assign(samples, samples + std::size_t(frames) * channels);
            drflac_free(samples, nullptr);
            break;
        }
        case AudioFormat::mp3: {
            drmp3_config config{};
            drmp3_uint64 frames = 0;
            drmp3_int16 *samples = drmp3_open_memory_and_read_pcm_frames_s16(bytes.data(), bytes.size(), &config, &frames, nullptr);
            if (!samples) { *error = "is not an MP3 file this build can decode"; return false; }
            if (too_many<drmp3_int16>(frames, config.channels, max_music_samples)) { drmp3_free(samples, nullptr); *error = "is longer than this build can hold in memory"; return false; }
            out->channels = int(config.channels); out->rate = int(config.sampleRate);
            out->samples.assign(samples, samples + std::size_t(frames) * config.channels);
            drmp3_free(samples, nullptr);
            break;
        }
        case AudioFormat::ogg: {
            int channels = 0, rate = 0;
            short *samples = nullptr;
            const int frames = stb_vorbis_decode_memory(bytes.data(), int(bytes.size()), &channels, &rate, &samples);
            if (frames > 0 && samples) {
                if (too_many<short>(std::uint64_t(frames), std::uint64_t(channels), max_music_samples)) {
                    free(samples); *error = "is longer than this build can hold in memory"; return false;
                }
                out->channels = channels; out->rate = rate;
                out->samples.assign(samples, samples + std::size_t(frames) * std::size_t(channels));
                free(samples);
                break;
            }
            if (samples) free(samples);
            unsigned flac_channels = 0, flac_rate = 0;
            drflac_uint64 flac_frames = 0;
            drflac_int16 *flac = drflac_open_memory_and_read_pcm_frames_s16(bytes.data(), bytes.size(), &flac_channels, &flac_rate, &flac_frames, nullptr);
            if (!flac) { *error = "is an Ogg file in a codec this build cannot decode"; return false; }
            out->channels = int(flac_channels); out->rate = int(flac_rate);
            out->samples.assign(flac, flac + std::size_t(flac_frames) * flac_channels);
            drflac_free(flac, nullptr);
            break;
        }
        default:
            *error = "is not WAV, MP3, FLAC or Ogg";
            return false;
    }
    if (!out->ok()) { *out = {}; *error = "decoded to no audio"; return false; }
    return true;
}

std::vector<float> to_mono(const DecodedAudio &audio) {
    if (audio.channels <= 1) return audio.samples;
    const std::size_t channels = std::size_t(audio.channels);
    const std::size_t frames = audio.samples.size() / channels;
    std::vector<float> mono(frames);
    const float scale = 1.0f / float(channels);
    for (std::size_t frame = 0; frame < frames; ++frame) {
        float sum = 0;
        for (std::size_t channel = 0; channel < channels; ++channel) sum += audio.samples[frame * channels + channel];
        mono[frame] = sum * scale;
    }
    return mono;
}

std::vector<float> resample_mono(const std::vector<float> &samples, int from_rate, int to_rate) {
    if (samples.empty() || from_rate <= 0 || to_rate <= 0 || from_rate == to_rate) return samples;
    const double ratio = double(from_rate) / double(to_rate);
    const std::size_t count = std::size_t(double(samples.size()) / ratio);
    if (count == 0) return {};
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
            for (std::size_t at = first; at < last; ++at, ++taken) sum += samples[at];
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
    for (const auto &entry : std::filesystem::directory_iterator(dir, std::filesystem::directory_options::skip_permission_denied, ec)) {
        if (ec) break;
        if (!entry.is_regular_file(ec) || ec) { ec.clear(); continue; }
        const auto name = entry.path().filename().string();
        if (name.empty() || name.front() == '.') continue;
        const auto size = entry.file_size(ec);
        if (ec || size == 0 || size > max_pack_file_bytes) { ec.clear(); continue; }
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
        if (dash != std::string::npos && dash > 0 && dash + 1 < id.size() &&
            id.find_first_not_of("0123456789", dash + 1) == std::string::npos) {
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
