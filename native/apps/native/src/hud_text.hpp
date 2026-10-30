#pragma once
#include <algorithm>
#include <array>
#include <cstdio>
#include <string_view>
#include <cstdint>
#include <string>
#include <vector>
#include "graphemes.hpp"

namespace native {
struct TextCluster {
    std::string text;
    unsigned columns;
};

// A bounded display helper: never split UTF-8 bytes, combining sequences,
// emoji modifiers, regional-indicator pairs or a ZWJ emoji sequence.
inline std::vector<TextCluster> text_clusters(const std::string &s) {
    std::vector<TextCluster> out;
    const auto boundaries = grapheme_boundaries(s);
    for (size_t i = 1; i < boundaries.size(); i++) {
        const auto bytes = s.substr(boundaries[i - 1], boundaries[i] - boundaries[i - 1]);
        unsigned width = 0;
        for (const auto &point : unicode_points(bytes)) {
            const auto cp = point.cp, g = unicode_grapheme::property(cp);
            if (g == 4 || g == 5 || g == 8) continue;
            const unsigned columns =
                    cp >= 0x1100
                                    && ((cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf)
                                        || (cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0xf900 && cp <= 0xfaff)
                                        || (cp >= 0xff01 && cp <= 0xff60) || (cp >= 0x1f000))
                            ? 2
                            : 1;
            width = std::max(width, columns);
        }
        out.push_back({bytes, width});
    }
    return out;
}

inline unsigned text_columns(const std::string &s) {
    unsigned total = 0;
    for (const auto &cluster : text_clusters(s))
        total += cluster.columns;
    return total;
}

inline std::string text_prefix(const std::string &s, unsigned columns) {
    std::string out;
    unsigned used = 0;
    for (const auto &c : text_clusters(s)) {
        if (used + c.columns > columns) break;
        out += c.text;
        used += c.columns;
    }
    return out;
}

inline std::string text_tail(const std::string &s, unsigned columns) {
    const auto clusters = text_clusters(s);
    std::string out;
    unsigned used = 0;
    size_t first = clusters.size();
    while (first && used + clusters[first - 1].columns <= columns) {
        --first;
        used += clusters[first].columns;
    }
    for (size_t i = first; i < clusters.size(); ++i)
        out += clusters[i].text;
    return out;
}

// Breaks after the last space that fits, or inside a word longer than a line. Spaces stay at the end of their line,
// so the lines put together are `s` without its line breaks.
inline std::vector<std::string> wrap_text(const std::string &s, unsigned columns) {
    std::vector<std::string> out;
    std::string line;
    unsigned used = 0;
    size_t after_space = 0;
    unsigned used_after_space = 0;
    columns = std::max(1u, columns);
    for (const auto &c : text_clusters(s)) {
        if (c.text == "\n" || c.text == "\r\n") {
            out.push_back(line);
            line.clear();
            used = after_space = used_after_space = 0;
            continue;
        }
        if (used + c.columns > columns && !line.empty() && c.text != " ") {
            const size_t cut = after_space ? after_space : line.size();
            out.push_back(line.substr(0, cut));
            line.erase(0, cut);
            used = after_space ? used - used_after_space : 0;
            after_space = used_after_space = 0;
        }
        line += c.text;
        used += c.columns;
        if (c.text == " ") {
            after_space = line.size();
            used_after_space = used;
        }
    }
    if (!line.empty() || out.empty()) out.push_back(line);
    return out;
}
}  // namespace native

namespace native {
// Fixed storage for changing numeric HUD labels. Formatting never enters the allocator.
template <size_t Capacity = 256>
struct HudLabel {
    std::array<char, Capacity> bytes{};

    void assign(std::string_view text) {
        const size_t count = std::min(text.size(), Capacity - 1);
        std::copy_n(text.data(), count, bytes.data());
        bytes[count] = '\0';
    }

    void append(std::string_view text) {
        const size_t used = view().size();
        const size_t count = std::min(text.size(), Capacity - used - 1);
        std::copy_n(text.data(), count, bytes.data() + used);
        bytes[used + count] = '\0';
    }

    template <class... Args>
    void format(const char *pattern, Args... args) {
        std::snprintf(bytes.data(), bytes.size(), pattern, args...);
    }

    std::string_view view() const { return bytes.data(); }

    bool empty() const { return bytes[0] == '\0'; }
};
}  // namespace native

namespace native {
// Numeric HUD text (timer, speed, FPS, run stats) changes every frame, and shaping a new string
// means a system-font rasterization. Such strings are drawn from cached pieces instead: one
// piece per digit and one per run of other characters. Tabular figures have equal advances and
// no kerning, so the pieces line up like the shaped string.
struct HudTextPiece {
    size_t begin = 0;
    size_t length = 0;
};

template <size_t Capacity>
struct HudTextPieces {
    std::array<HudTextPiece, Capacity> pieces{};
    size_t count = 0;
};

inline bool hud_digit(char character) {
    return character >= '0' && character <= '9';
}

inline bool hud_printable_ascii(char character) {
    return character >= ' ' && character <= '~';
}

// Returns false for text that should be shaped whole: no digits, anything outside printable
// ASCII (scripts that join or reorder), or more pieces than fit.
template <size_t Capacity>
bool split_numeric_text(std::string_view text, HudTextPieces<Capacity> &out) {
    out.count = 0;
    if (!std::any_of(text.begin(), text.end(), hud_digit)) return false;
    if (!std::all_of(text.begin(), text.end(), hud_printable_ascii)) return false;
    size_t begin = 0;
    while (begin < text.size()) {
        size_t end = begin + 1;
        if (!hud_digit(text[begin])) {
            while (end < text.size() && !hud_digit(text[end]))
                ++end;
        }
        if (out.count == Capacity) return false;
        out.pieces[out.count] = {begin, end - begin};
        ++out.count;
        begin = end;
    }
    return true;
}
}  // namespace native
