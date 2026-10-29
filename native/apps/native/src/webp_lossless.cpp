#include "webp_lossless.hpp"

#include <algorithm>
#include <array>
#include <cstdlib>
#include <queue>
#include <stdexcept>
#include <vector>

namespace native {
namespace {

constexpr int max_dimension = 16384;
constexpr uint8_t vp8l_signature = 0x2f;
constexpr int dimension_bits = 14;
constexpr int version_bits = 3;
constexpr int transform_type_bits = 2;
constexpr uint32_t predictor_transform = 0;
constexpr uint32_t subtract_green_transform = 2;
// 16x16 tiles each pick their own predictor.
constexpr int predictor_tile_bits = 4;
constexpr int predictor_tile_bits_offset = 2;
constexpr int predictor_tile_bits_width = 3;

constexpr int literal_symbols = 256;
constexpr int length_prefix_symbols = 24;
constexpr int distance_prefix_symbols = 40;
constexpr int green_symbols = literal_symbols + length_prefix_symbols;
constexpr int max_code_length = 15;
constexpr int max_code_length_code_length = 7;
constexpr int code_length_symbols = 19;
constexpr int code_length_length_bits = 3;
constexpr int min_code_length_codes = 4;
constexpr int code_length_count_bits = 4;
constexpr std::array<int, code_length_symbols> code_length_order = {
        17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15
};
constexpr int repeat_zeros_short = 17;
constexpr int repeat_zeros_long = 18;
constexpr int repeat_zeros_short_min = 3;
constexpr int repeat_zeros_short_bits = 3;
constexpr int repeat_zeros_long_min = 11;
constexpr int repeat_zeros_long_max = 138;
constexpr int repeat_zeros_long_bits = 7;

// Distance codes 1..120 are the short 2D neighbourhood; a plain pixel distance is sent as distance + 120.
constexpr uint32_t plane_code_offset = 120;
constexpr int min_match_pixels = 3;
constexpr int max_match_pixels = 4096;
constexpr int hash_bits = 15;
constexpr int max_chain = 32;

constexpr uint32_t opaque_black = 0xff000000u;

class BitWriter {
    std::string bytes_;
    uint64_t pending_ = 0;
    int pending_bits_ = 0;

public:
    void put(uint32_t value, int count) {
        pending_ |= uint64_t(value) << pending_bits_;
        pending_bits_ += count;
        while (pending_bits_ >= 8) {
            bytes_.push_back(char(pending_ & 0xff));
            pending_ >>= 8;
            pending_bits_ -= 8;
        }
    }

    std::string finish() {
        if (pending_bits_ > 0) bytes_.push_back(char(pending_ & 0xff));
        pending_ = 0;
        pending_bits_ = 0;
        return std::move(bytes_);
    }
};

uint32_t channel(uint32_t argb, int shift) {
    return (argb >> shift) & 0xff;
}

uint32_t pack(uint32_t a, uint32_t r, uint32_t g, uint32_t b) {
    return (a << 24) | (r << 16) | (g << 8) | b;
}

uint32_t subtract_pixels(uint32_t a, uint32_t b) {
    uint32_t out = 0;
    for (int shift = 0; shift < 32; shift += 8)
        out |= ((channel(a, shift) - channel(b, shift)) & 0xff) << shift;
    return out;
}

uint32_t average2(uint32_t a, uint32_t b) {
    return (((a ^ b) & 0xfefefefeu) >> 1) + (a & b);
}

uint32_t select_predictor(uint32_t left, uint32_t top, uint32_t top_left) {
    int distance_to_left = 0;
    int distance_to_top = 0;
    for (int shift = 0; shift < 32; shift += 8) {
        const int estimate = int(channel(left, shift)) + int(channel(top, shift)) - int(channel(top_left, shift));
        distance_to_left += std::abs(estimate - int(channel(left, shift)));
        distance_to_top += std::abs(estimate - int(channel(top, shift)));
    }
    return distance_to_left < distance_to_top ? left : top;
}

uint32_t clamp_add_subtract_full(uint32_t a, uint32_t b, uint32_t c) {
    uint32_t out = 0;
    for (int shift = 0; shift < 32; shift += 8) {
        const int value = int(channel(a, shift)) + int(channel(b, shift)) - int(channel(c, shift));
        out |= uint32_t(std::clamp(value, 0, 255)) << shift;
    }
    return out;
}

// The predictor modes tried per tile (RFC 9649 section 4.1): left, top, their average, select and gradient.
enum PredictorMode : uint32_t { left_mode = 1, top_mode = 2, average_mode = 7, select_mode = 11, gradient_mode = 12 };

constexpr std::array<uint32_t, 5> predictor_modes = {left_mode, top_mode, average_mode, select_mode, gradient_mode};

uint32_t predict(const std::vector<uint32_t> &pixels, int width, int x, int y, uint32_t mode) {
    const size_t at = size_t(y) * width + x;
    if (x == 0 && y == 0) return opaque_black;
    if (y == 0) return pixels[at - 1];
    if (x == 0) return pixels[at - width];
    const uint32_t left = pixels[at - 1], top = pixels[at - width], top_left = pixels[at - width - 1];
    switch (mode) {
        case left_mode:
            return left;
        case top_mode:
            return top;
        case average_mode:
            return average2(left, top);
        case select_mode:
            return select_predictor(left, top, top_left);
        default:
            return clamp_add_subtract_full(left, top, top_left);
    }
}

uint32_t residual_cost(uint32_t residual) {
    uint32_t cost = 0;
    for (int shift = 0; shift < 32; shift += 8) {
        const uint32_t value = channel(residual, shift);
        cost += std::min(value, 256 - value);
    }
    return cost;
}

struct Tiles {
    int columns = 0, rows = 0;
    std::vector<uint32_t> modes;
};

uint32_t best_tile_mode(const std::vector<uint32_t> &pixels, int width, int height, int tile_x, int tile_y) {
    const int tile = 1 << predictor_tile_bits;
    uint32_t best_mode = predictor_modes[0];
    uint64_t best_cost = UINT64_MAX;
    for (const auto mode : predictor_modes) {
        uint64_t cost = 0;
        for (int y = tile_y * tile; y < std::min(height, (tile_y + 1) * tile); ++y)
            for (int x = tile_x * tile; x < std::min(width, (tile_x + 1) * tile); ++x)
                cost += residual_cost(
                        subtract_pixels(pixels[size_t(y) * width + x], predict(pixels, width, x, y, mode))
                );
        if (cost < best_cost) {
            best_cost = cost;
            best_mode = mode;
        }
    }
    return best_mode;
}

// Replaces `pixels` with prediction residuals and returns the per-tile modes.
Tiles apply_predictor(std::vector<uint32_t> &pixels, int width, int height) {
    const int tile = 1 << predictor_tile_bits;
    Tiles tiles;
    tiles.columns = (width + tile - 1) / tile;
    tiles.rows = (height + tile - 1) / tile;
    tiles.modes.resize(size_t(tiles.columns) * tiles.rows);
    for (int tile_y = 0; tile_y < tiles.rows; ++tile_y)
        for (int tile_x = 0; tile_x < tiles.columns; ++tile_x)
            tiles.modes[size_t(tile_y) * tiles.columns + tile_x] =
                    best_tile_mode(pixels, width, height, tile_x, tile_y);
    std::vector<uint32_t> residuals(pixels.size());
    for (int y = 0; y < height; ++y)
        for (int x = 0; x < width; ++x) {
            const uint32_t mode =
                    tiles.modes[size_t(y >> predictor_tile_bits) * tiles.columns + (x >> predictor_tile_bits)];
            const size_t at = size_t(y) * width + x;
            residuals[at] = subtract_pixels(pixels[at], predict(pixels, width, x, y, mode));
        }
    pixels = std::move(residuals);
    return tiles;
}

void subtract_green(std::vector<uint32_t> &pixels) {
    for (auto &pixel : pixels) {
        const uint32_t green = channel(pixel, 8);
        const uint32_t red = (channel(pixel, 16) - green) & 0xff, blue = (channel(pixel, 0) - green) & 0xff;
        pixel = pack(channel(pixel, 24), red, green, blue);
    }
}

// Huffman code lengths limited to `limit` bits. At least two symbols get a code: a decoder reads a code with
// a single symbol as zero bits, which this writer doesn't model.
std::vector<uint8_t> tree_lengths(const std::vector<uint32_t> &weights) {
    using Node = std::pair<uint64_t, int>;
    std::priority_queue<Node, std::vector<Node>, std::greater<>> queue;
    std::vector<int> parent;
    std::vector<int> leaf_node(weights.size(), -1);
    for (size_t symbol = 0; symbol < weights.size(); ++symbol)
        if (weights[symbol]) {
            leaf_node[symbol] = int(parent.size());
            queue.emplace(weights[symbol], int(parent.size()));
            parent.push_back(-1);
        }
    while (queue.size() > 1) {
        const auto a = queue.top();
        queue.pop();
        const auto b = queue.top();
        queue.pop();
        const int joined = int(parent.size());
        parent.push_back(-1);
        parent[a.second] = joined;
        parent[b.second] = joined;
        queue.emplace(a.first + b.first, joined);
    }
    std::vector<uint8_t> lengths(weights.size(), 0);
    for (size_t symbol = 0; symbol < weights.size(); ++symbol) {
        if (leaf_node[symbol] < 0) continue;
        int depth = 0;
        for (int node = leaf_node[symbol]; parent[node] >= 0; node = parent[node])
            ++depth;
        lengths[symbol] = uint8_t(std::min(depth, 255));
    }
    return lengths;
}

std::vector<uint8_t> limited_lengths(std::vector<uint32_t> weights, int limit) {
    int used = int(std::count_if(weights.begin(), weights.end(), [](uint32_t w) { return w > 0; }));
    for (size_t symbol = 0; used < 2 && symbol < weights.size(); ++symbol)
        if (!weights[symbol]) {
            weights[symbol] = 1;
            ++used;
        }
    for (;;) {
        auto lengths = tree_lengths(weights);
        if (*std::max_element(lengths.begin(), lengths.end()) <= limit) return lengths;
        for (auto &weight : weights)
            if (weight) weight = std::max(1u, weight / 2);
    }
}

uint32_t reverse_bits(uint32_t code, int length) {
    uint32_t out = 0;
    for (int bit = 0; bit < length; ++bit)
        out |= ((code >> bit) & 1) << (length - 1 - bit);
    return out;
}

struct PrefixCode {
    std::vector<uint8_t> lengths;
    // Bit-reversed, ready for the LSB-first writer.
    std::vector<uint32_t> codes;

    void write(BitWriter &out, size_t symbol) const { out.put(codes[symbol], lengths[symbol]); }
};

PrefixCode canonical(std::vector<uint8_t> lengths) {
    std::array<uint32_t, max_code_length + 2> length_count{};
    for (const auto length : lengths)
        if (length) ++length_count[length];
    std::array<uint32_t, max_code_length + 2> next_code{};
    uint32_t code = 0;
    for (int bits = 1; bits <= max_code_length; ++bits) {
        code = (code + length_count[bits - 1]) << 1;
        next_code[bits] = code;
    }
    PrefixCode out;
    out.codes.resize(lengths.size(), 0);
    for (size_t symbol = 0; symbol < lengths.size(); ++symbol)
        if (lengths[symbol]) out.codes[symbol] = reverse_bits(next_code[lengths[symbol]]++, lengths[symbol]);
    out.lengths = std::move(lengths);
    return out;
}

struct LengthToken {
    int symbol = 0;
    int extra = 0;
};

std::vector<LengthToken> run_length_tokens(const std::vector<uint8_t> &lengths) {
    std::vector<LengthToken> tokens;
    for (size_t at = 0; at < lengths.size();) {
        if (lengths[at]) {
            tokens.push_back({lengths[at++], 0});
            continue;
        }
        size_t run = 0;
        while (at + run < lengths.size() && !lengths[at + run])
            ++run;
        at += run;
        while (run >= size_t(repeat_zeros_long_min)) {
            const size_t take = std::min(run, size_t(repeat_zeros_long_max));
            tokens.push_back({repeat_zeros_long, int(take) - repeat_zeros_long_min});
            run -= take;
        }
        if (run >= size_t(repeat_zeros_short_min)) {
            tokens.push_back({repeat_zeros_short, int(run) - repeat_zeros_short_min});
            run = 0;
        }
        for (; run > 0; --run)
            tokens.push_back({0, 0});
    }
    return tokens;
}

// A normal (not simple) prefix code: its lengths, run-length coded with the code length code.
void write_prefix_code(BitWriter &out, const PrefixCode &code) {
    const auto tokens = run_length_tokens(code.lengths);
    std::vector<uint32_t> counts(code_length_symbols, 0);
    for (const auto &token : tokens)
        ++counts[token.symbol];
    const auto length_code = canonical(limited_lengths(counts, max_code_length_code_length));
    int written = code_length_symbols;
    while (written > min_code_length_codes && !length_code.lengths[code_length_order[written - 1]])
        --written;
    out.put(0, 1);
    out.put(uint32_t(written - min_code_length_codes), code_length_count_bits);
    for (int i = 0; i < written; ++i)
        out.put(length_code.lengths[code_length_order[i]], code_length_length_bits);
    // Every symbol of the alphabet follows (no max_symbol).
    out.put(0, 1);
    for (const auto &token : tokens) {
        length_code.write(out, token.symbol);
        if (token.symbol == repeat_zeros_short)
            out.put(uint32_t(token.extra), repeat_zeros_short_bits);
        else if (token.symbol == repeat_zeros_long)
            out.put(uint32_t(token.extra), repeat_zeros_long_bits);
    }
}

// LZ77 prefix coding of a length or distance value (>= 1): a prefix symbol and its extra bits.
struct PrefixValue {
    int symbol = 0;
    int extra_bits = 0;
    uint32_t extra = 0;
};

PrefixValue prefix_value(uint32_t value) {
    const uint32_t d = value - 1;
    if (d < 4) return {int(d), 0, 0};
    int highest = 31;
    while (!((d >> highest) & 1))
        --highest;
    const int second = int((d >> (highest - 1)) & 1);
    const int extra_bits = highest - 1;
    return {2 * highest + second, extra_bits, d & ((1u << extra_bits) - 1)};
}

struct Token {
    uint32_t pixel = 0;
    // 0 for a literal pixel.
    uint32_t length = 0;
    uint32_t distance = 0;
};

uint32_t pair_hash(const std::vector<uint32_t> &pixels, size_t at) {
    const uint64_t key = (uint64_t(pixels[at]) << 32) | pixels[at + 1];
    return uint32_t((key * 0x9e3779b97f4a7c15ull) >> (64 - hash_bits));
}

std::vector<Token> lz77_tokens(const std::vector<uint32_t> &pixels) {
    std::vector<Token> tokens;
    const size_t count = pixels.size();
    std::vector<int> head(size_t(1) << hash_bits, -1);
    std::vector<int> previous(count, -1);
    auto insert = [&](size_t at) {
        if (at + 1 >= count) return;
        const uint32_t hash = pair_hash(pixels, at);
        previous[at] = head[hash];
        head[hash] = int(at);
    };
    for (size_t at = 0; at < count;) {
        size_t best_length = 0, best_distance = 0;
        if (at + 1 < count) {
            int candidate = head[pair_hash(pixels, at)];
            for (int chain = 0; candidate >= 0 && chain < max_chain; ++chain, candidate = previous[candidate]) {
                const size_t limit = std::min(count - at, size_t(max_match_pixels));
                size_t length = 0;
                while (length < limit && pixels[size_t(candidate) + length] == pixels[at + length])
                    ++length;
                if (length > best_length) {
                    best_length = length;
                    best_distance = at - size_t(candidate);
                }
            }
        }
        if (best_length >= size_t(min_match_pixels)) {
            tokens.push_back({0, uint32_t(best_length), uint32_t(best_distance)});
            for (size_t i = 0; i < best_length; ++i)
                insert(at + i);
            at += best_length;
        } else {
            tokens.push_back({pixels[at], 0, 0});
            insert(at);
            ++at;
        }
    }
    return tokens;
}

struct ImageCodes {
    PrefixCode green, red, blue, alpha, distance;
};

ImageCodes image_codes(const std::vector<Token> &tokens) {
    std::vector<uint32_t> green(green_symbols, 0), red(literal_symbols, 0), blue(literal_symbols, 0),
            alpha(literal_symbols, 0), distance(distance_prefix_symbols, 0);
    for (const auto &token : tokens) {
        if (token.length) {
            ++green[literal_symbols + prefix_value(token.length).symbol];
            ++distance[prefix_value(token.distance + plane_code_offset).symbol];
            continue;
        }
        ++green[channel(token.pixel, 8)];
        ++red[channel(token.pixel, 16)];
        ++blue[channel(token.pixel, 0)];
        ++alpha[channel(token.pixel, 24)];
    }
    return {canonical(limited_lengths(green, max_code_length)),
            canonical(limited_lengths(red, max_code_length)),
            canonical(limited_lengths(blue, max_code_length)),
            canonical(limited_lengths(alpha, max_code_length)),
            canonical(limited_lengths(distance, max_code_length))};
}

void write_prefixed(BitWriter &out, const PrefixCode &code, int symbol_offset, uint32_t value) {
    const auto prefix = prefix_value(value);
    code.write(out, size_t(symbol_offset + prefix.symbol));
    if (prefix.extra_bits) out.put(prefix.extra, prefix.extra_bits);
}

// Prefix codes then the LZ77-coded pixels: the part shared by the main image and the predictor sub-image.
void write_coded_pixels(BitWriter &out, const std::vector<uint32_t> &pixels) {
    const auto tokens = lz77_tokens(pixels);
    const auto codes = image_codes(tokens);
    for (const auto *code : {&codes.green, &codes.red, &codes.blue, &codes.alpha, &codes.distance})
        write_prefix_code(out, *code);
    for (const auto &token : tokens) {
        if (token.length) {
            write_prefixed(out, codes.green, literal_symbols, token.length);
            write_prefixed(out, codes.distance, 0, token.distance + plane_code_offset);
            continue;
        }
        codes.green.write(out, channel(token.pixel, 8));
        codes.red.write(out, channel(token.pixel, 16));
        codes.blue.write(out, channel(token.pixel, 0));
        codes.alpha.write(out, channel(token.pixel, 24));
    }
}

std::vector<uint32_t> argb_pixels(std::span<const uint8_t> rgba) {
    std::vector<uint32_t> pixels(rgba.size() / 4);
    for (size_t i = 0; i < pixels.size(); ++i)
        pixels[i] = pack(rgba[i * 4 + 3], rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
    return pixels;
}

void put_u32(std::string &out, uint32_t value) {
    for (int shift = 0; shift < 32; shift += 8)
        out.push_back(char((value >> shift) & 0xff));
}

std::string riff_container(const std::string &vp8l) {
    const bool odd = vp8l.size() % 2 != 0;
    std::string out = "RIFF";
    put_u32(out, uint32_t(4 + 8 + vp8l.size() + (odd ? 1 : 0)));
    out += "WEBPVP8L";
    put_u32(out, uint32_t(vp8l.size()));
    out += vp8l;
    if (odd) out.push_back('\0');
    return out;
}

}  // namespace

std::string encode_webp_lossless(std::span<const uint8_t> rgba, int width, int height) {
    if (width < 1 || height < 1 || width > max_dimension || height > max_dimension)
        throw std::runtime_error("WebP size out of range");
    if (rgba.size() != size_t(width) * size_t(height) * 4) throw std::runtime_error("WebP pixel buffer size");
    auto pixels = argb_pixels(rgba);
    const bool has_alpha = std::any_of(pixels.begin(), pixels.end(), [](uint32_t p) { return channel(p, 24) != 255; });
    BitWriter out;
    out.put(vp8l_signature, 8);
    out.put(uint32_t(width - 1), dimension_bits);
    out.put(uint32_t(height - 1), dimension_bits);
    out.put(has_alpha ? 1 : 0, 1);
    out.put(0, version_bits);
    // The decoder undoes transforms in reverse order: predictor first, then the green is added back.
    out.put(1, 1);
    out.put(subtract_green_transform, transform_type_bits);
    subtract_green(pixels);
    out.put(1, 1);
    out.put(predictor_transform, transform_type_bits);
    out.put(predictor_tile_bits - predictor_tile_bits_offset, predictor_tile_bits_width);
    const auto tiles = apply_predictor(pixels, width, height);
    std::vector<uint32_t> tile_pixels(tiles.modes.size());
    for (size_t i = 0; i < tiles.modes.size(); ++i)
        tile_pixels[i] = tiles.modes[i] << 8;
    // The sub-image: no colour cache.
    out.put(0, 1);
    write_coded_pixels(out, tile_pixels);
    out.put(0, 1);
    // The main image: no colour cache, no meta prefix codes.
    out.put(0, 1);
    out.put(0, 1);
    write_coded_pixels(out, pixels);
    return riff_container(out.finish());
}

}  // namespace native
