#pragma once
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

namespace native {

inline std::string base64(const std::string &bytes) {
    static constexpr char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve((bytes.size() + 2) / 3 * 4);
    for (size_t i = 0; i < bytes.size(); i += 3) {
        const uint32_t n = (uint32_t(uint8_t(bytes[i])) << 16)
                           | (i + 1 < bytes.size() ? uint32_t(uint8_t(bytes[i + 1])) << 8 : 0)
                           | (i + 2 < bytes.size() ? uint8_t(bytes[i + 2]) : 0);
        out += alphabet[(n >> 18) & 63];
        out += alphabet[(n >> 12) & 63];
        out += i + 1 < bytes.size() ? alphabet[(n >> 6) & 63] : '=';
        out += i + 2 < bytes.size() ? alphabet[n & 63] : '=';
    }
    return out;
}

// Standard padded base64; nullopt for anything else (stray characters, bad length or padding).
inline std::optional<std::string> base64_decode(std::string_view text) {
    if (text.size() % 4) return std::nullopt;
    auto value = [](char c) -> int {
        if (c >= 'A' && c <= 'Z') return c - 'A';
        if (c >= 'a' && c <= 'z') return c - 'a' + 26;
        if (c >= '0' && c <= '9') return c - '0' + 52;
        if (c == '+') return 62;
        if (c == '/') return 63;
        return -1;
    };
    std::string out;
    out.reserve(text.size() / 4 * 3);
    for (size_t i = 0; i < text.size(); i += 4) {
        const bool last = i + 4 == text.size();
        const int padding = last ? (text[i + 3] == '=') + (text[i + 2] == '=') : 0;
        if (padding == 1 && text[i + 2] == '=') return std::nullopt;
        uint32_t n = 0;
        for (int k = 0; k < 4; k++) {
            const int v = k >= 4 - padding ? 0 : value(text[i + size_t(k)]);
            if (v < 0) return std::nullopt;
            n = n << 6 | uint32_t(v);
        }
        out += char(n >> 16);
        if (padding < 2) out += char(n >> 8 & 255);
        if (padding < 1) out += char(n & 255);
    }
    return out;
}

}  // namespace native
