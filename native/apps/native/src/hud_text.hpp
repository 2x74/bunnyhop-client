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

inline std::vector<std::string> wrap_text(const std::string &s, unsigned columns) {
    std::vector<std::string> out;
    std::string line;
    unsigned used = 0;
    columns = std::max(1u, columns);
    for (const auto &c : text_clusters(s)) {
        if (c.text == "\n" || c.text == "\r\n") {
            out.push_back(line);
            line.clear();
            used = 0;
            continue;
        }
        if (used + c.columns > columns && !line.empty()) {
            out.push_back(line);
            line.clear();
            used = 0;
        }
        line += c.text;
        used += c.columns;
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
