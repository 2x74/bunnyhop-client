#pragma once
#include <cstdint>
#include <string>

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

}  // namespace native
