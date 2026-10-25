#pragma once
// Custom audio packs: a player's own sound effects and music, read from their
// own folders in any format the decoders understand.
//
// The shipped bunnyhop.lol audio is raw float32 at the device's own rate and
// needs no decoding. Everything here exists for the other pack — files that
// came out of somebody's music library, whose format is whatever it happens to
// be and whose extension may be wrong or missing. The leading bytes decide what
// a file is; the name only supplies the cue id.
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <map>
#include <string>
#include <vector>

namespace native {

enum class AudioFormat { unknown, wav, mp3, flac, ogg };
AudioFormat sniff_audio(const unsigned char *bytes, std::size_t size);
const char *audio_format_name(AudioFormat format);

// Decoded sound effect: interleaved, -1..1.
struct DecodedAudio {
    std::vector<float> samples;
    int channels = 0;
    int rate = 0;
    bool ok() const { return channels > 0 && rate > 0 && !samples.empty(); }
};

// Decoded music. Held as int16 rather than float because a track is three
// orders of magnitude longer than a sound effect: a six minute stereo song is
// 63 MB this way and 127 MB as float, and every decoder can emit int16
// directly, so nothing is gained by widening it only to narrow it again at the
// device. Lossy sources carry well under 16 bits of real precision anyway.
struct DecodedMusic {
    std::vector<std::int16_t> samples;
    int channels = 0;
    int rate = 0;
    bool ok() const { return channels > 0 && rate > 0 && !samples.empty(); }
};

// A file larger than this is not plausibly a game sound or a song, and reading
// it would be the attack surface rather than the feature.
inline constexpr std::uint64_t max_pack_file_bytes = 64ull << 20;
// Caps are counted in decoded samples, never in file bytes: 300 KB of MP3
// expands to 30 MB of PCM, so the compressed size predicts nothing about what
// a decode will cost.
inline constexpr std::uint64_t max_sfx_samples = 8ull << 20;    // 32 MB as float
inline constexpr std::uint64_t max_music_samples = 64ull << 20; // 128 MB as int16

// |error| receives a short reason the file was skipped. A pack is user-supplied
// data, so a bad file is reported and stepped over, never fatal.
bool decode_sfx_file(const std::filesystem::path &file, DecodedAudio *out, std::string *error);
bool decode_music_file(const std::filesystem::path &file, DecodedMusic *out, std::string *error);

// Sound effects mix into one mono stream, so a stereo file is averaged rather
// than having a channel dropped, and resampled to the mixer's rate.
std::vector<float> to_mono(const DecodedAudio &audio);
std::vector<float> resample_mono(const std::vector<float> &samples, int from_rate, int to_rate);

// Files directly inside |dir|; subdirectories, dotfiles and oversized files are
// skipped. Results are sorted so the order does not depend on the filesystem.
//
// A sound effect's cue id is its filename without the extension, with a
// trailing "-<n>" removed so alternates can be supplied the same way the
// shipped pack names them: jump.wav, or jump-1.wav and jump-2.wav together.
std::map<std::string, std::vector<std::filesystem::path>> scan_sfx_pack(const std::filesystem::path &dir);

struct MusicTrack {
    std::string id;                  // filename without extension, or manifest id
    std::string title;               // what the menu shows
    std::filesystem::path file;      // empty for a shipped track that is absent
};
std::vector<MusicTrack> scan_music_pack(const std::filesystem::path &dir);

}  // namespace native
