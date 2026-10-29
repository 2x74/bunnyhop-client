// Lossless WebP encoder: the header the avatar server reads (apps/api/src/bunny-avatar.ts webpSize, ported), and,
// when libwebp's dwebp is given, a pixel-exact round trip through a real decoder.
#include "webp_lossless.hpp"

#include <cassert>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <optional>
#include <string>
#include <vector>

namespace {

struct Size {
    int width = 0, height = 0;
};

uint32_t u32(const std::string &b, size_t at) {
    return uint32_t(uint8_t(b[at])) | uint32_t(uint8_t(b[at + 1])) << 8 | uint32_t(uint8_t(b[at + 2])) << 16
           | uint32_t(uint8_t(b[at + 3])) << 24;
}

// The server's check: RIFF size matches the length, WEBP, a VP8L chunk with the 0x2f signature, its dimensions.
std::optional<Size> server_webp_size(const std::string &b) {
    if (b.size() < 30 || b.compare(0, 4, "RIFF") || b.compare(8, 4, "WEBP")) return std::nullopt;
    if (u32(b, 4) + 8 != b.size()) return std::nullopt;
    if (b.compare(12, 4, "VP8L") || uint8_t(b[20]) != 0x2f) return std::nullopt;
    const uint32_t bits = u32(b, 21);
    return Size{int(1 + (bits & 0x3fff)), int(1 + ((bits >> 14) & 0x3fff))};
}

using Image = std::vector<uint8_t>;

Image studio_gradient(int size) {
    Image out(size_t(size) * size * 4);
    for (int y = 0; y < size; ++y)
        for (int x = 0; x < size; ++x) {
            const double t = double(y) / size, glow = std::exp(-std::hypot(x - size * .5, y - size * .28) / size * 3);
            uint8_t *p = out.data() + (size_t(y) * size + x) * 4;
            p[0] = uint8_t(std::lround(34 - 20 * t + 120 * glow));
            p[1] = uint8_t(std::lround(34 - 20 * t + 80 * glow));
            p[2] = uint8_t(std::lround(42 - 24 * t + 20 * glow));
            p[3] = 255;
        }
    return out;
}

Image disc_on_clear(int size) {
    Image out(size_t(size) * size * 4, 0);
    for (int y = 0; y < size; ++y)
        for (int x = 0; x < size; ++x) {
            const double d = std::hypot(x - size * .5, y - size * .55) / (size * .3);
            if (d > 1.02) continue;
            uint8_t *p = out.data() + (size_t(y) * size + x) * 4;
            p[0] = uint8_t(200 - 60 * d);
            p[1] = uint8_t(120 + 40 * d);
            p[2] = uint8_t(90);
            p[3] = uint8_t(d > 1 ? 128 : 255);
        }
    return out;
}

Image noise(int width, int height) {
    Image out(size_t(width) * height * 4);
    uint32_t state = 12345;
    for (auto &v : out) {
        state = state * 1664525u + 1013904223u;
        v = uint8_t(state >> 24);
    }
    return out;
}

std::string read_file(const std::filesystem::path &path) {
    std::ifstream in(path, std::ios::binary);
    return {std::istreambuf_iterator<char>(in), {}};
}

// dwebp -pam writes a PAM with an RGBA payload after its header.
void check_round_trip(const std::string &dwebp, const std::string &webp, const Image &rgba, const char *name) {
    const auto dir = std::filesystem::temp_directory_path();
    const auto in = dir / (std::string("bh-webp-") + name + ".webp"),
               out = dir / (std::string("bh-webp-") + name + ".pam");
    std::ofstream(in, std::ios::binary).write(webp.data(), std::streamsize(webp.size()));
    const std::string command = "\"" + dwebp + "\" -quiet -pam \"" + in.string() + "\" -o \"" + out.string() + "\"";
    if (std::system(command.c_str()) != 0) {
        std::cerr << name << ": dwebp rejected the file\n";
        std::exit(1);
    }
    const auto pam = read_file(out);
    const auto header_end = pam.find("ENDHDR\n");
    assert(header_end != std::string::npos);
    const auto pixels = pam.substr(header_end + 7);
    if (pixels.size() != rgba.size()
        || pixels.compare(0, pixels.size(), reinterpret_cast<const char *>(rgba.data()), rgba.size())) {
        std::cerr << name << ": decoded pixels differ\n";
        std::exit(1);
    }
    std::filesystem::remove(in);
    std::filesystem::remove(out);
}

void check(const Image &rgba, int width, int height, const char *name, const char *dwebp) {
    const auto webp = native::encode_webp_lossless(rgba, width, height);
    const auto size = server_webp_size(webp);
    assert(size && size->width == width && size->height == height);
    std::cout << name << ": " << width << "x" << height << " -> " << webp.size() << " bytes\n";
    if (dwebp) check_round_trip(dwebp, webp, rgba, name);
}

}  // namespace

int main(int argc, char **argv) {
    const char *dwebp = argc > 1 ? argv[1] : nullptr;
    check(studio_gradient(256), 256, 256, "gradient", dwebp);
    check(disc_on_clear(256), 256, 256, "clear", dwebp);
    check(noise(37, 19), 37, 19, "noise", dwebp);
    check(Image(4, 255), 1, 1, "pixel", dwebp);
    check(Image(size_t(300) * 7 * 4, 0), 300, 7, "empty", dwebp);
    // Avatar pictures stay well under the server's 96 KiB limit.
    assert(native::encode_webp_lossless(studio_gradient(256), 256, 256).size() < 96 * 1024);
    bool threw = false;
    try {
        native::encode_webp_lossless(Image(8), 3, 3);
    } catch (const std::exception &) {
        threw = true;
    }
    assert(threw);
    if (!dwebp) std::cout << "dwebp not found: header checks only\n";
    return 0;
}
