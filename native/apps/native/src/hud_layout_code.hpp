#pragma once
#include "base64.hpp"
#include "capabilities.hpp"
#include "settings.hpp"
#include <optional>
#include <string>
#include <string_view>

namespace native {
// The website's layout code (hud/layout.ts encodeLayout): "bhl1." and base64url of a version byte, then per element
// in the website's order [on << 7 | anchor] [x int16, 1e-4] [y int16] [scale / 50], then the keys overlay's
// [style] [opacity * 100] [rows] [pressed rgb] [idle rgb]. A code copied on either side imports on the other.
inline constexpr std::string_view hud_layout_code_prefix = "bhl1.";
inline constexpr unsigned hud_layout_code_version = 8;
inline constexpr std::array<std::string_view, 3> hud_keys_styles = {"classic", "keycaps", "minimal"};

// Elements each older code version carries, in the website's order; the rest keep their default place.
inline size_t hud_layout_code_elements(unsigned version) {
    constexpr std::array<size_t, 8> counts = {14, 15, 16, 17, 18, 21, 22, web_hud_elements.size()};
    return version >= 1 && version <= counts.size() ? counts[version - 1] : 0;
}

inline std::array<uint8_t, 3> hud_code_rgb(const std::string &hex) {
    unsigned value = 0xffffff;
    if (hex.size() == 7 && hex[0] == '#') value = unsigned(std::stoul(hex.substr(1), nullptr, 16));
    return {uint8_t(value >> 16), uint8_t(value >> 8), uint8_t(value)};
}

inline std::string hud_code_hex(const uint8_t *rgb) {
    char text[8];
    std::snprintf(text, sizeof(text), "#%02x%02x%02x", rgb[0], rgb[1], rgb[2]);
    return text;
}

inline void push_hud_place(std::string &bytes, const Json &place) {
    const bool on = place.value("on", true);
    bytes += char(((on ? 1 : 0) << 7) | (place.value("a", 0u) & 15));
    for (const char *axis : {"x", "y"}) {
        const long scaled = std::lround(place.value(axis, 0.) * 10000);
        const auto value = uint16_t(int16_t(std::clamp(scaled, -32768l, 32767l)));
        bytes += char(value >> 8);
        bytes += char(value & 255);
    }
    bytes += char(std::clamp(std::lround(place.value("s", 1.) * 50), 1l, 255l));
}

inline std::string encode_hud_layout(const Json &settings) {
    std::string bytes(1, char(hud_layout_code_version));
    const auto &layout = settings.at("hudLayoutWeb");
    for (const auto id : web_hud_elements)
        push_hud_place(bytes, layout.at(std::string(id)));
    const auto &keys_style = settings.at("keysStyle").get_ref<const std::string &>();
    const auto style = std::find(hud_keys_styles.begin(), hud_keys_styles.end(), keys_style);
    bytes += char(style == hud_keys_styles.end() ? 1 : style - hud_keys_styles.begin());
    bytes += char(std::lround(settings.at("hudKeysOpacity").get<double>() * 100));
    bytes +=
            char((settings.at("hudKeysRowsWasd").get<bool>() ? 1 : 0)
                 | (settings.at("hudKeysRowsActions").get<bool>() ? 2 : 0)
                 | (settings.at("hudKeysRowsMouse").get<bool>() ? 4 : 0));
    for (const char *key : {"hudKeysPressed", "hudKeysIdle"}) {
        for (const auto channel : hud_code_rgb(settings.at(key).get<std::string>()))
            bytes += char(channel);
    }
    auto text = base64(bytes);
    for (char &c : text)
        c = c == '+' ? '-' : c == '/' ? '_' : c;
    while (!text.empty() && text.back() == '=')
        text.pop_back();
    return std::string(hud_layout_code_prefix) + text;
}

inline std::optional<std::string> decode_base64url(std::string_view text) {
    std::string out;
    uint32_t bits = 0;
    int count = 0;
    for (const char c : text) {
        const int digit = c >= 'A' && c <= 'Z'   ? c - 'A'
                          : c >= 'a' && c <= 'z' ? c - 'a' + 26
                          : c >= '0' && c <= '9' ? c - '0' + 52
                          : c == '-'             ? 62
                          : c == '_'             ? 63
                                                 : -1;
        if (digit < 0) return std::nullopt;
        bits = (bits << 6) | uint32_t(digit);
        count += 6;
        if (count >= 8) {
            count -= 8;
            out += char((bits >> count) & 255);
        }
    }
    return out;
}

inline Json read_hud_code_place(const uint8_t *bytes) {
    const auto axis = [](uint8_t high, uint8_t low) {
        return std::clamp(double(int16_t(uint16_t(high << 8 | low))) / 10000, -1., 1.);
    };
    const double scale = std::clamp(std::round(double(bytes[5]) / 50 * 100) / 100, .4, 3.);
    return {{"on", bool(bytes[0] & 128)},
            {"a", bytes[0] & 15},
            {"x", axis(bytes[1], bytes[2])},
            {"y", axis(bytes[3], bytes[4])},
            {"s", scale}};
}

inline Json read_hud_code_keys(const uint8_t *bytes) {
    constexpr double lowest_opacity = .2;
    const std::string style(bytes[0] < hud_keys_styles.size() ? hud_keys_styles[bytes[0]] : "keycaps");
    return {{"keysStyle", style},
            {"hudKeysOpacity", std::clamp(double(bytes[1]) / 100, lowest_opacity, 1.)},
            {"hudKeysRowsWasd", bool(bytes[2] & 1)},
            {"hudKeysRowsActions", bool(bytes[2] & 2)},
            {"hudKeysRowsMouse", bool(bytes[2] & 4)},
            {"hudKeysPressed", hud_code_hex(bytes + 3)},
            {"hudKeysIdle", hud_code_hex(bytes + 6)}};
}

// A settings patch (hudLayoutWeb and the keys overlay's look) for a layout code, or nothing if it isn't one.
inline std::optional<Json> decode_hud_layout(std::string_view code) {
    constexpr size_t place_bytes = 6;
    constexpr size_t keys_bytes = 9;
    while (!code.empty() && std::isspace(uint8_t(code.front())))
        code.remove_prefix(1);
    while (!code.empty() && std::isspace(uint8_t(code.back())))
        code.remove_suffix(1);
    if (!code.starts_with(hud_layout_code_prefix)) return std::nullopt;
    const auto raw = decode_base64url(code.substr(hud_layout_code_prefix.size()));
    if (!raw || raw->empty()) return std::nullopt;
    const auto *bytes = reinterpret_cast<const uint8_t *>(raw->data());
    const size_t elements = hud_layout_code_elements(bytes[0]);
    if (!elements || raw->size() < 1 + elements * place_bytes) return std::nullopt;
    Json layout = default_hud_layout_web();
    for (size_t i = 0; i < elements; ++i) {
        const auto *place = bytes + 1 + i * place_bytes;
        if ((place[0] & 15) > 8) return std::nullopt;
        layout[std::string(web_hud_elements[i])] = read_hud_code_place(place);
    }
    Json patch = {{"hudLayoutWeb", std::move(layout)}};
    const size_t keys_at = 1 + elements * place_bytes;
    if (raw->size() >= keys_at + keys_bytes) patch.update(read_hud_code_keys(bytes + keys_at));
    return patch;
}
}  // namespace native
