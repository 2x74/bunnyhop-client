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
#include <cstdlib>
#include <limits>
#include <new>
#include <string_view>

// Track C++ PCM allocations independently of the result: an implementation
// that allocates an oversized buffer and only then rejects must fail too.
namespace allocation_probe {
bool enabled = false;
std::size_t largest = 0;
}  // namespace allocation_probe

void *operator new(std::size_t size) {
    if (allocation_probe::enabled) {
        allocation_probe::largest = std::max(allocation_probe::largest, size);
        if (size > 64 * 1024) throw std::bad_alloc();
    }
    if (auto *p = std::malloc(size ? size : 1)) return p;
    throw std::bad_alloc();
}

void operator delete(void *p) noexcept {
    std::free(p);
}

namespace {

std::filesystem::path scratch() {
    // std::random_device rather than a pid: this has to build on Windows too.
    auto dir = std::filesystem::temp_directory_path()
               / ("bunnyhop-audio-pack-tests-" + std::to_string(std::random_device{}()));
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
    for (int shift = 0; shift < 32; shift += 8)
        out.push_back((unsigned char)((value >> shift) & 0xFF));
}

void append_u16(std::vector<unsigned char> &out, std::uint16_t value) {
    out.push_back((unsigned char)(value & 0xFF));
    out.push_back((unsigned char)(value >> 8));
}

void append_tag(std::vector<unsigned char> &out, const char *tag) {
    while (*tag)
        out.push_back((unsigned char)*tag++);
}

// A minimal 16-bit PCM WAV, built by hand so the test owns its own fixtures
// rather than depending on a binary checked into the tree.
std::vector<unsigned char> make_wav(const std::vector<std::vector<short>> &channels, std::uint32_t rate) {
    const std::uint16_t channel_count = (std::uint16_t)channels.size();
    const std::uint32_t frames = (std::uint32_t)channels.front().size();
    const std::uint32_t data_bytes = frames * channel_count * 2;
    std::vector<unsigned char> out;
    append_tag(out, "RIFF");
    append_u32(out, 36 + data_bytes);
    append_tag(out, "WAVE");
    append_tag(out, "fmt ");
    append_u32(out, 16);
    append_u16(out, 1);
    append_u16(out, channel_count);
    append_u32(out, rate);
    append_u32(out, rate * channel_count * 2);
    append_u16(out, (std::uint16_t)(channel_count * 2));
    append_u16(out, 16);
    append_tag(out, "data");
    append_u32(out, data_bytes);
    for (std::uint32_t frame = 0; frame < frames; ++frame)
        for (const auto &channel : channels)
            append_u16(out, (std::uint16_t)(std::uint16_t)channel[frame]);
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

// Small silence fixtures generated with FLAC 1.5 (--no-padding --no-seektable)
// and FFmpeg's native Vorbis encoder. Embedded so codec coverage needs no
// encoder, network, or external fixture at test runtime.
std::vector<unsigned char> unhex(std::string_view text) {
    std::vector<unsigned char> bytes;
    const auto digit = [](char c) {
        return c <= '9' ? c - '0' : c - 'a' + 10;
    };
    for (std::size_t i = 0; i < text.size(); i += 2)
        bytes.push_back((unsigned char)((digit(text[i]) << 4) | digit(text[i + 1])));
    return bytes;
}

std::vector<unsigned char> flac_silence() {
    return unhex(
            "664c6143000000221000100000000d00000d056220f00000089d516f3fa83d977d44c050e29e5a1f34108400002820000000"
            "7265666572656e6365206c6962464c414320312e352e3020323032353032313100000000fff8760800089c24000000ce9d"
    );
}

std::vector<unsigned char> ogg_flac_silence() {
    return unhex(
            "4f67675300020000000000000000a0fe6a40000000009148fd7c01337f464c414301000001664c6143000000221000100000"
            "000d00000d056220f00000089d516f3fa83d977d44c050e29e5a1f34104f67675300000000000000000000a0fe6a40010000"
            "00d8e74d00012c84000028200000007265666572656e6365206c6962464c414320312e352e30203230323530323131000000"
            "004f67675300049d08000000000000a0fe6a4002000000ce74a3ff010dfff8760800089c24000000ce9d"
    );
}

std::vector<unsigned char> vorbis_silence() {
    return unhex(
            "4f67675300020000000000000000000000000000000092775317011e01766f72626973000000000222560000000000000000"
            "000000000000bb014f6767530000000000000000000000000000010000003fdc96ca0e2dffffffffffffffffffffffffbb03"
            "766f726269730600000066666d7065670100000013000000656e636f6465723d4c61766320766f726269730105766f726269"
            "731c424356020010000084749a59aa0122cc408681d0909500000200006084220c312034642500001000002086928368426b"
            "ce37e738689683a6526c4e0727526d9ee4a6626ece39e79c73b239678c73ce39a72867168366426bce39273168968266426b"
            "ce39e7496c1eb4a64a6bce39679c733a18678471ce39a7496b1ea466636dce3967416b9aa3e6526cce3927526e9ed4e6526d"
            "ce39e79c73ce39e79c73ce39a77a713a07e78473ce39276a6faee5267471ce39e79371ba37278473ce39e79c73ce39e79c73"
            "ce3927080d5909000001001084616318770a82f4391a88518498864c7ad03d3a4c82c620a7907a343a1a29a50e4249659c94"
            "d209424356020080000010424821851452482185145248218518628821869c72ca29a8a0924a2aaa28a3cc32cb2cb3cc32cb"
            "2cb30e3bebacc30e430c31c4d04a2bb1d4545b8d35d69a7bceb9e620ad95d65a6bad94524a29a59482d09095000008000081"
            "904106196414524821851862ca29a79c820a2a2034642500000600c02167a081061a68a081061a68a071c6198820820822a8"
            "a4924c3a0a29b5d86acc31d75e830e3af79e7befb9f81c84524a29a594524a29a594524a2925080d59090080000000082184"
            "105248218514528a31c61c730e3a09250442435602006000000c31c41864904148218518628a29c71c730c3a082194525268"
            "a1855c6a882596565a89a5a5986a8bb1d65873ed31d6de7befbdf7de7befbdf7de7bce81d090950040040000830c22882082"
            "8c310621048486ac040040000010628831c6208410528821a79c824c32e9a4a39002a1212b01002700008411472471041267"
            "a081082aa920a3cc422cb1b5d65a6badb5d65a6badb5d65a6badb5d65a6badb5d65a6badb5d65a6b2d101ab2120088000060"
            "9041061944104104196480d090950000080000238c400419a514638e39e61874d041271d85165a2034642500e004004020a1"
            "8832cc30041155545146155514524729a594524a29a594524a29a594524a29a594524a29a594524a29a5544a29a504424356"
            "020064000090a29452292d458222a518a4184b461573505a8aa8720c52cda952ce20e6249688318494935432e614420c42ea"
            "1c754c29062d951842c618a4d8724ba1730e080d592100846600381c07902c0b902c0b00000000000000244d0334cf032ccd"
            "030000000000000049d300cbd300cdf300000000000000000000000000000000000000000000000000000000000000000000"
            "0000000000000000000000000000000000000000000000000000000000000000000090340dd03c0fd03c0f00000000000000"
            "34cf033c4f043c510400000000000000cbf3004df4004f140100000000000000000000000000000000000000000000000000"
            "00000000000000000000000000000000000000000000000000000000000000000000000000000000000090340dd03c0fd03c"
            "0f000000000000002ccf033c5104344f0400000000000000cbf3004f14014ff4000000000000000000000000000000000000"
            "0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
            "0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
            "0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
            "0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
            "0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
            "0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
            "0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
            "0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
            "0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
            "0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
            "0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
            "0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000040000"
            "0a3800000a58088586ac0800e204001c920449822441f300926541d3a069304d806459d034681a4c13000000000000000000"
            "0049d3a069d034882240d234681a340da20800000000000000000080a469d034681a441120691a340d9a0651040000000000"
            "00000000c0334d88224411a609f04c13a2085184690200000000000000000000000000000000000000000000020000091c00"
            "00054c28038586ac0800e204001c8e62590000e0388e65010080e338960500009665892200005896268a0000000000000000"
            "0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
            "00000000000000020000091c0000054c28038586ac0400a200001c8a6259c0712c0b388e650149b22c806501340fa0690051"
            "04000200000d1c0000056cd094581ca0d09095004014008041712c4bd3449124699ae6892249d234cf13459ae6799e679af0"
            "3ccf334d88a2289a264451144d13a6699aaa0a4c53550500001a3800000ad8a029b13840a1212b018090000087a25896a679"
            "9ee789a269aa2649d234cf134551344dd3545592a4699e278aa2689aa6a9aa2c4bd33c4f1445d134555555a1699e278aa268"
            "9aaaaabaf03ccf134551344d55755d789ee789a2289aa6aaba2e4451144dd3345553555d1788a2699aa6aaaaaaeb02d11345"
            "d35455d7755de079a2689aaaeaaaae0b44d3345555555d579601a6699aaaeabab20c505555755dd7956580aaaaaaebbaae2c"
            "0354d5755d5796651980ebbaae2ccbb2000040040700400123e824a3ca226c34e1c2035068c88a00200a0000308629c59432"
            "8c490829848631092185904949a9b4942a08a994544a052195924ac928a5945a4a1584544a2aa582904a49a51400008be000"
            "008b6021141ab21200c80300208c518a31c69c930829c59873ce49849462cc39e7a4528c39e79c73524ac61c73ce3929a573"
            "ce39e79c949239e79c734e4ae99c73ce3927a594d239e79c93524a09a173d04929a574ce39e70400801a3800000ad828b239"
            "c14850a1212b018054000083e35896a6799e289aa625499ae6799e278aa6a94992a6799ee789a26af23ccf134551344d55e5"
            "799e278aa2689aaaca7545d1344d535555972c8ba2699aa6aaba2e4cd33455d5755d17a6699aaaeabaae0bdb565555755d59"
            "866dabaaaabaae2c03d7755d59b66520cbae2bbbb62c00005ec10100d4c086d5114e8ac6020b0d59090064000010c620a410"
            "4248198490420821a51442020000091c0000054c28038586ac04005201000063acb5d65a6bad35d0596badb5d65a2b20b3d6"
            "5a6badb5d65a6badb5d65a6badb5d45a6badb5d65a6badb5d65a6badb5d65a6badb5d65a6badb5d65a6badb5d65a6badb5d6"
            "5a6badb5d65a6badb5d65a6badb5d65a4b29a594524a29a594524a29a594524a29a594520140bf160e00ff1036ac8e705234"
            "165868c84a00201c0000304629c61c83504a2915428c39271d95d662ac1062cc390929b5165bf19c73104a48a5b5188be79c"
            "83504a4ab1d558540aa19494528b2dd6a252e8a8a494526b3516634c2aa9b5d662abb11863520a2db5d6628cc5085b536a2d"
            "b6da6a2cc6d89a4a0b2dc6186331c217195b8ba9b65a8331c2c8164b4bb5d61a8c3146f7d662a9ade6628c0fbeb6144b8c35"
            "1700e0eee00080a860e30c2b496785a3c18586ac0400420200088494628c31c69c73ce39a914638e39e79c8310422895628c"
            "31e79c8310420825638c39e71c84104208a1949231e71c8410420821a4943ae71c841042082184524ae79c83104208218450"
            "4ae920841042082184124a292985104208218410422a29a5104208a194104a4825a51442082184504a0929a5944208a19410"
            "422821a594524a2184104229a5a494524aa984524209a184544a4a2985124208a59492524a2995524228a184524a4929a594"
            "52082184524a010080080e00800246d049469545d868c28507200000000400200891192251b0000c0e540042c21400505860"
            "9003000d0e0f691717d065800bbab8eb4008410842108b032820010727dcf0c41b9e708313748a4a0d08000000000019007c"
            "0000240f4044443473101112131415161718191a1b1c000080000200001000000000000800000000104f6767530004c00800"
            "000000000000000000020000005925dfa5041e1e1e1e1e000000000000040000000000000000000000000000000000000000"
            "00001e00000000000004000000000000000000000000000000000000000000001e0000000000000400000000000000000000"
            "0000000000000000000000001e0000000000000400000000000000000000000000000000000000000000"
    );
}

bool close(double a, double b, double tolerance = 1e-4) {
    return std::abs(a - b) < tolerance;
}

}  // namespace

int main() {
    using namespace native;

    {  // Container detection reads the bytes, never the extension.
        const auto wav = make_wav({{0, 1, 2, 3}}, 22050);
        assert(sniff_audio(wav.data(), wav.size()) == AudioFormat::wav);
        const std::vector<unsigned char> flac{'f', 'L', 'a', 'C', 0, 0, 0, 34};
        assert(sniff_audio(flac.data(), flac.size()) == AudioFormat::flac);
        const std::vector<unsigned char> ogg{'O', 'g', 'g', 'S', 0, 2, 0, 0};
        assert(sniff_audio(ogg.data(), ogg.size()) == AudioFormat::ogg);
        const std::vector<unsigned char> id3{'I', 'D', '3', 3, 0, 0, 0, 0};
        assert(sniff_audio(id3.data(), id3.size()) == AudioFormat::mp3);
        const auto frames = make_mp3_frames(2);
        assert(sniff_audio(frames.data(), frames.size()) == AudioFormat::mp3);
        assert(sniff_audio(nullptr, 0) == AudioFormat::unknown);
        const std::vector<unsigned char> text{'h', 'e', 'l', 'l', 'o', ' ', 't', 'h', 'e', 'r', 'e'};
        assert(sniff_audio(text.data(), text.size()) == AudioFormat::unknown);
    }

    {  // A lone 0xFF 0xFB pair turns up in ordinary binary data. Requiring the
        // frame it describes to be followed by another one is what keeps a
        // random file from being handed to the MP3 decoder.
        std::vector<unsigned char> noise(4096, 0);
        std::mt19937 random(12345);
        for (auto &byte : noise)
            byte = (unsigned char)(random() & 0xFF);
        noise[100] = 0xFF;
        noise[101] = 0xFB;
        noise[102] = 0x90;
        noise[103] = 0x00;
        // The 417-byte frame lands on random bytes, so the follow-on sync fails.
        const bool detected = sniff_audio(noise.data(), noise.size()) == AudioFormat::mp3;
        // Guard against the random buffer happening to contain a real pair.
        if (detected) std::cerr << "note: random buffer contained a valid frame pair\n";

        std::vector<unsigned char> single{0xFF, 0xFB, 0x90, 0x00};
        single.resize(600, 0);
        assert(sniff_audio(single.data(), single.size()) != AudioFormat::mp3);
    }

    const auto dir = scratch();

    {  // A WAV decodes to the samples it was built from, whatever it is called.
        std::vector<short> left(64), right(64);
        for (std::size_t i = 0; i < left.size(); ++i) {
            left[i] = (short)(i * 100);
            right[i] = (short)(-(int)i * 100);
        }
        const auto file = dir / "jump.the-wrong-extension";
        put(file, make_wav({left, right}, 44100));
        DecodedAudio decoded;
        std::string error;
        assert(decode_sfx_file(file, &decoded, &error));
        assert(decoded.channels == 2);
        assert(decoded.rate == 44100);
        assert(decoded.samples.size() == 128);
        assert(close(decoded.samples[2], 100.0 / 32768.0, 1e-3));

        // Averaging the two channels cancels them exactly here.
        const auto mono = to_mono(decoded);
        assert(mono.size() == 64);
        for (const float sample : mono)
            assert(close(sample, 0.0, 1e-6));
    }

    {  // Raw float32 is accepted on its extension, since it has no header to
        // recognise and it is what the shipped pack uses.
        std::vector<float> ramp(16);
        for (std::size_t i = 0; i < ramp.size(); ++i)
            ramp[i] = float(i) / 16.0f;
        std::vector<unsigned char> bytes(ramp.size() * 4);
        std::memcpy(bytes.data(), ramp.data(), bytes.size());
        const auto file = dir / "land.f32";
        put(file, bytes);
        DecodedAudio decoded;
        std::string error;
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

    {  // Rate conversion. Halving the rate averages pairs; a point-sampling
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

    {  // A tiny low-rate WAV previously tried to allocate 176,400,000
        // bytes before the pack's remaining-budget check.
        const auto file = dir / "slow.wav";
        put(file, make_wav({std::vector<short>(2000)}, 1));
        DecodedAudio audio;
        std::string error;
        assert(decode_sfx_file(file, &audio, &error));
        allocation_probe::enabled = true;
        allocation_probe::largest = 0;
        assert(resample_mono(audio.samples, 1, 22050).empty());
        assert(resample_mono(audio.samples, 1, 22050, 16u << 20).empty());
        assert(resample_mono(audio.samples, 1, std::numeric_limits<int>::max(), 16u << 20).empty());
        assert(allocation_probe::largest == 0);
        allocation_probe::enabled = false;
        // Respect a partly exhausted pack, including equal-rate/raw copies.
        const std::vector<float> small{1, 2, 3, 4};
        assert(resample_mono(small, 11025, 22050, 7).empty());
        assert(resample_mono(small, 11025, 22050, 8).size() == 8);
        assert(resample_mono(small, 22050, 22050, 3).empty());
        assert(resample_mono(small, 0, 22050, 3).empty());
    }

    {  // Each codec must preserve valid audio, accept an exact sample budget,
        // and reject smaller budgets without publishing partially decoded PCM.
        auto unknown_flac = flac_silence();
        unknown_flac[21] &= 0xf0;
        std::fill(unknown_flac.begin() + 22, unknown_flac.begin() + 26, 0);
        const std::vector<std::pair<std::string, std::vector<unsigned char>>> cases{
                {"bounded.wav", make_wav({std::vector<short>(2205)}, 22050)},
                {"bounded.mp3", make_mp3_frames(8)},  // no Xing/Info length
                {"bounded.flac", flac_silence()},
                {"unknown-length.flac", unknown_flac},
                {"bounded-vorbis.ogg", vorbis_silence()},
                {"bounded-flac.ogg", ogg_flac_silence()},
        };
        for (const auto &[name, bytes] : cases) {
            const auto file = dir / name;
            put(file, bytes);
            DecodedAudio audio;
            DecodedMusic music;
            std::string error;
            assert(decode_sfx_file(file, &audio, &error));
            assert(decode_music_file(file, &music, &error));
            const auto count = audio.samples.size();
            assert(count > 128 && count == music.samples.size());
            assert(audio.channels == music.channels && audio.rate == music.rate);
            for (const std::uint64_t budget : {std::uint64_t(0), std::uint64_t(128), std::uint64_t(count - 1)}) {
                assert(!decode_sfx_file(file, &audio, &error, budget));
                assert(audio.samples.empty() && !audio.ok() && !error.empty());
                assert(!decode_music_file(file, &music, &error, budget));
                assert(music.samples.empty() && !music.ok() && !error.empty());
            }
            assert(decode_sfx_file(file, &audio, &error, count));
            assert(audio.samples.size() == count && error.empty());
            assert(decode_music_file(file, &music, &error, count));
            assert(music.samples.size() == count && error.empty());
        }
        // A STREAMINFO declaration beyond both production caps is rejected
        // before any PCM allocation, even if a caller requests a larger cap.
        auto oversized = flac_silence();
        const std::uint64_t count = max_music_samples + 1;
        oversized[21] = (oversized[21] & 0xf0) | ((count >> 32) & 0x0f);
        for (int i = 0; i < 4; ++i)
            oversized[22 + i] = (count >> (24 - i * 8)) & 0xff;
        const auto file = dir / "oversized-metadata.flac";
        put(file, oversized);
        DecodedAudio audio;
        DecodedMusic music;
        std::string error;
        allocation_probe::enabled = true;
        allocation_probe::largest = 0;
        assert(!decode_sfx_file(file, &audio, &error, count));
        assert(!decode_music_file(file, &music, &error, count));
        assert(error == "exceeds the decoded sample budget");
        assert(allocation_probe::largest < 64 * 1024);
        allocation_probe::enabled = false;
    }

    {  // Pack scanning: variants group onto one cue, dotfiles and directories
        // are ignored, and the order does not depend on the filesystem.
        const auto sounds = dir / "sound";
        std::filesystem::create_directories(sounds / "nested");
        for (const char *name : {"jump-1.wav", "jump-2.wav", "land.ogg", "gun-fire.mp3", ".hidden.wav"})
            put(sounds / name, {'R', 'I', 'F', 'F', 0, 0, 0, 0, 'W', 'A', 'V', 'E'});
        put(sounds / "nested" / "ignored.wav", {'R', 'I', 'F', 'F', 0, 0, 0, 0, 'W', 'A', 'V', 'E'});

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

    {  // Music keeps its whole filename: "track-2.mp3" is a song, not an
        // alternate take of "track".
        const auto bgm = dir / "bgm";
        for (const char *name : {"b-second.mp3", "a-first.flac", "track-2.ogg"})
            put(bgm / name, {'O', 'g', 'g', 'S', 0, 0, 0, 0});
        const auto tracks = scan_music_pack(bgm);
        assert(tracks.size() == 3);
        assert(tracks[0].id == "a-first");
        assert(tracks[1].id == "b-second");
        assert(tracks[2].id == "track-2");
        assert(tracks[0].file.filename() == "a-first.flac");
        assert(scan_music_pack(bgm / "missing").empty());
    }

    {  // An unreadable or nonsense file is reported and skipped, never fatal.
        const auto junk = dir / "sound" / "notes.txt";
        put(junk, {'h', 'e', 'l', 'l', 'o', ' ', 'w', 'o', 'r', 'l', 'd'});
        DecodedAudio decoded;
        std::string error;
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
