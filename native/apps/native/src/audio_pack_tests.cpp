#include "audio_pack.hpp"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <cmath>
#include <cstring>
#include <fstream>
#include <iostream>
#include <random>

namespace {

std::filesystem::path scratch() {
    // std::random_device rather than a pid: this has to build on Windows too.
    auto dir = std::filesystem::temp_directory_path() /
               ("bunnyhop-audio-pack-tests-" + std::to_string(std::random_device{}()));
    std::filesystem::remove_all(dir);
    std::filesystem::create_directories(dir);
    return dir;
}

void put(const std::filesystem::path &file, const std::vector<unsigned char> &bytes) {
    std::filesystem::create_directories(file.parent_path());
    std::ofstream out(file, std::ios::binary);
    out.write(reinterpret_cast<const char *>(bytes.data()), std::streamsize(bytes.size()));
}

void append_u32(std::vector<unsigned char> &out, std::uint32_t value) {
    for (int shift = 0; shift < 32; shift += 8) out.push_back((unsigned char)((value >> shift) & 0xFF));
}
void append_u16(std::vector<unsigned char> &out, std::uint16_t value) {
    out.push_back((unsigned char)(value & 0xFF));
    out.push_back((unsigned char)(value >> 8));
}
void append_tag(std::vector<unsigned char> &out, const char *tag) {
    while (*tag) out.push_back((unsigned char)*tag++);
}

// A minimal 16-bit PCM WAV, built by hand so the test owns its own fixtures
// rather than depending on a binary checked into the tree.
std::vector<unsigned char> make_wav(const std::vector<std::vector<short>> &channels, std::uint32_t rate) {
    const std::uint16_t channel_count = (std::uint16_t)channels.size();
    const std::uint32_t frames = (std::uint32_t)channels.front().size();
    const std::uint32_t data_bytes = frames * channel_count * 2;
    std::vector<unsigned char> out;
    append_tag(out, "RIFF"); append_u32(out, 36 + data_bytes); append_tag(out, "WAVE");
    append_tag(out, "fmt "); append_u32(out, 16);
    append_u16(out, 1); append_u16(out, channel_count); append_u32(out, rate);
    append_u32(out, rate * channel_count * 2); append_u16(out, (std::uint16_t)(channel_count * 2)); append_u16(out, 16);
    append_tag(out, "data"); append_u32(out, data_bytes);
    for (std::uint32_t frame = 0; frame < frames; ++frame)
        for (const auto &channel : channels) append_u16(out, (std::uint16_t)(std::uint16_t)channel[frame]);
    return out;
}

// Two back-to-back MPEG-1 Layer III headers: 128 kbps, 44100 Hz, no padding,
// which is a 417-byte frame.
std::vector<unsigned char> make_mp3_frames(std::size_t count) {
    std::vector<unsigned char> out;
    for (std::size_t i = 0; i < count; ++i) {
        const std::size_t start = out.size();
        out.insert(out.end(), {0xFF, 0xFB, 0x90, 0x00});
        out.resize(start + 417, 0);
    }
    return out;
}

bool close(double a, double b, double tolerance = 1e-4) { return std::abs(a - b) < tolerance; }

}  // namespace

int main() {
    using namespace native;

    {   // Container detection reads the bytes, never the extension.
        const auto wav = make_wav({{0, 1, 2, 3}}, 22050);
        assert(sniff_audio(wav.data(), wav.size()) == AudioFormat::wav);
        const std::vector<unsigned char> flac{'f','L','a','C',0,0,0,34};
        assert(sniff_audio(flac.data(), flac.size()) == AudioFormat::flac);
        const std::vector<unsigned char> ogg{'O','g','g','S',0,2,0,0};
        assert(sniff_audio(ogg.data(), ogg.size()) == AudioFormat::ogg);
        const std::vector<unsigned char> id3{'I','D','3',3,0,0,0,0};
        assert(sniff_audio(id3.data(), id3.size()) == AudioFormat::mp3);
        const auto frames = make_mp3_frames(2);
        assert(sniff_audio(frames.data(), frames.size()) == AudioFormat::mp3);
        assert(sniff_audio(nullptr, 0) == AudioFormat::unknown);
        const std::vector<unsigned char> text{'h','e','l','l','o',' ','t','h','e','r','e'};
        assert(sniff_audio(text.data(), text.size()) == AudioFormat::unknown);
    }

    {   // A lone 0xFF 0xFB pair turns up in ordinary binary data. Requiring the
        // frame it describes to be followed by another one is what keeps a
        // random file from being handed to the MP3 decoder.
        std::vector<unsigned char> noise(4096, 0);
        std::mt19937 random(12345);
        for (auto &byte : noise) byte = (unsigned char)(random() & 0xFF);
        noise[100] = 0xFF; noise[101] = 0xFB; noise[102] = 0x90; noise[103] = 0x00;
        // The 417-byte frame lands on random bytes, so the follow-on sync fails.
        const bool detected = sniff_audio(noise.data(), noise.size()) == AudioFormat::mp3;
        // Guard against the random buffer happening to contain a real pair.
        if (detected) std::cerr << "note: random buffer contained a valid frame pair\n";

        std::vector<unsigned char> single{0xFF, 0xFB, 0x90, 0x00};
        single.resize(600, 0);
        assert(sniff_audio(single.data(), single.size()) != AudioFormat::mp3);
    }

    const auto dir = scratch();

    {   // A WAV decodes to the samples it was built from, whatever it is called.
        std::vector<short> left(64), right(64);
        for (std::size_t i = 0; i < left.size(); ++i) {
            left[i] = (short)(i * 100);
            right[i] = (short)(-(int)i * 100);
        }
        const auto file = dir / "jump.the-wrong-extension";
        put(file, make_wav({left, right}, 44100));
        DecodedAudio decoded; std::string error;
        assert(decode_sfx_file(file, &decoded, &error));
        assert(decoded.channels == 2);
        assert(decoded.rate == 44100);
        assert(decoded.samples.size() == 128);
        assert(close(decoded.samples[2], 100.0 / 32768.0, 1e-3));

        // Averaging the two channels cancels them exactly here.
        const auto mono = to_mono(decoded);
        assert(mono.size() == 64);
        for (const float sample : mono) assert(close(sample, 0.0, 1e-6));
    }

    {   // Raw float32 is accepted on its extension, since it has no header to
        // recognise and it is what the shipped pack uses.
        std::vector<float> ramp(16);
        for (std::size_t i = 0; i < ramp.size(); ++i) ramp[i] = float(i) / 16.0f;
        std::vector<unsigned char> bytes(ramp.size() * 4);
        std::memcpy(bytes.data(), ramp.data(), bytes.size());
        const auto file = dir / "land.f32";
        put(file, bytes);
        DecodedAudio decoded; std::string error;
        assert(decode_sfx_file(file, &decoded, &error));
        assert(decoded.channels == 1 && decoded.samples.size() == 16);
        assert(close(decoded.samples[8], 0.5));

        // A truncated one is rejected rather than read past its end.
        bytes.pop_back();
        const auto broken = dir / "broken.f32";
        put(broken, bytes);
        DecodedAudio ignored;
        assert(!decode_sfx_file(broken, &ignored, &error));
        assert(!error.empty());
    }

    {   // Rate conversion. Halving the rate averages pairs; a point-sampling
        // resampler would return the even samples instead.
        const std::vector<float> ramp{0, 1, 2, 3, 4, 5, 6, 7};
        const auto down = resample_mono(ramp, 44100, 22050);
        assert(down.size() == 4);
        assert(close(down[0], 0.5) && close(down[1], 2.5) && close(down[2], 4.5) && close(down[3], 6.5));

        const auto up = resample_mono(ramp, 22050, 44100);
        assert(up.size() == 16);
        assert(close(up[0], 0.0) && close(up[2], 1.0));
        assert(close(up[1], 0.5));

        assert(resample_mono(ramp, 44100, 44100).size() == ramp.size());
        assert(resample_mono({}, 44100, 22050).empty());
    }

    {   // Pack scanning: variants group onto one cue, dotfiles and directories
        // are ignored, and the order does not depend on the filesystem.
        const auto sounds = dir / "sound";
        std::filesystem::create_directories(sounds / "nested");
        for (const char *name : {"jump-1.wav", "jump-2.wav", "land.ogg", "gun-fire.mp3", ".hidden.wav"})
            put(sounds / name, {'R','I','F','F',0,0,0,0,'W','A','V','E'});
        put(sounds / "nested" / "ignored.wav", {'R','I','F','F',0,0,0,0,'W','A','V','E'});

        const auto cues = scan_sfx_pack(sounds);
        assert(cues.size() == 3);
        assert(cues.at("jump").size() == 2);
        assert(cues.at("jump")[0].filename() == "jump-1.wav");
        assert(cues.at("jump")[1].filename() == "jump-2.wav");
        assert(cues.at("land").size() == 1);
        // A dash inside a name is only a variant marker when digits follow it.
        assert(cues.count("gun-fire") == 1);
        assert(cues.count("gun") == 0);
        assert(cues.count("ignored") == 0);
        assert(cues.count(".hidden") == 0 && cues.count("hidden") == 0);

        assert(scan_sfx_pack(dir / "does-not-exist").empty());
    }

    {   // Music keeps its whole filename: "track-2.mp3" is a song, not an
        // alternate take of "track".
        const auto bgm = dir / "bgm";
        for (const char *name : {"b-second.mp3", "a-first.flac", "track-2.ogg"})
            put(bgm / name, {'O','g','g','S',0,0,0,0});
        const auto tracks = scan_music_pack(bgm);
        assert(tracks.size() == 3);
        assert(tracks[0].id == "a-first");
        assert(tracks[1].id == "b-second");
        assert(tracks[2].id == "track-2");
        assert(tracks[0].file.filename() == "a-first.flac");
        assert(scan_music_pack(bgm / "missing").empty());
    }

    {   // An unreadable or nonsense file is reported and skipped, never fatal.
        const auto junk = dir / "sound" / "notes.txt";
        put(junk, {'h','e','l','l','o',' ','w','o','r','l','d'});
        DecodedAudio decoded; std::string error;
        assert(!decode_sfx_file(junk, &decoded, &error));
        assert(!error.empty());
        DecodedMusic music;
        assert(!decode_music_file(junk, &music, &error));
        assert(!error.empty());
        assert(!decode_sfx_file(dir / "nothing-here.wav", &decoded, &error));
    }

    std::filesystem::remove_all(dir);
    std::cout << "Custom audio pack checks passed\n";
}
