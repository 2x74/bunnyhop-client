#pragma once
// Peak marks (the hardest tier a player has cleared: T7 to T10) and the pride flags a player can pick instead of
// a country. Both are drawn from the vendored website's SVGs at build time (export-presentation.ts writes
// hud-glyphs.json). This list fixes each one's cell in the HUD glyph atlas, after the marks and the country flags, so
// a roster entry or chat line resolves its mark or flag once, when it is read. Ids the list doesn't have draw nothing.
// ui/host-tables.test.ts checks the list against creators.ts PEAK_TIERS and countries.ts PRIDE_FLAGS.
#include "base64.hpp"
#include <nlohmann/json.hpp>
#include <array>
#include <cctype>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <string>
#include <string_view>
#include <system_error>
#include <vector>

namespace native {

inline constexpr std::array<std::string_view, 6> sheet_glyph_ids = {
        "peak-7",
        "peak-8",
        "peak-9",
        "peak-10",
        "PRIDE-RAINBOW",
        "PRIDE-TRANS",
};

// After the fifteen marks and the 26 × 26 regional-indicator flags (hud_theme.hpp).
inline constexpr unsigned sheet_glyph_first = 16 + 26 * 26;
inline constexpr unsigned sheet_glyph_cell = 32;
inline constexpr size_t sheet_glyph_bytes = sheet_glyph_cell * sheet_glyph_cell * 4;
inline constexpr std::string_view pride_flag_prefix = "PRIDE-";

// The atlas cell of a peak mark or pride flag, or 0.
constexpr unsigned sheet_glyph(std::string_view id) {
    for (size_t i = 0; i < sheet_glyph_ids.size(); ++i)
        if (sheet_glyph_ids[i] == id) return sheet_glyph_first + unsigned(i);
    return 0;
}

// A country code ("US", any case) or a pride flag ("PRIDE-TRANS"); 0 for anything else, which draws no flag.
inline unsigned flag_glyph(std::string_view code) {
    if (code.starts_with(pride_flag_prefix)) return sheet_glyph(code);
    if (code.size() != 2) return 0;
    const unsigned first = unsigned(std::toupper(static_cast<unsigned char>(code[0])));
    const unsigned second = unsigned(std::toupper(static_cast<unsigned char>(code[1])));
    if (first < 'A' || first > 'Z' || second < 'A' || second > 'Z') return 0;
    return 16 + (first - 'A') * 26 + second - 'A';
}

inline constexpr size_t flag_code_max_bytes = 32;

// A player's flag as it is drawn: the code when it has a flag, else empty (no flag and no gap for it). Read whole:
// cutting "PRIDE-TRANS" to two letters would show Puerto Rico's.
inline std::string flag_code(std::string code) {
    return flag_glyph(code) ? code : std::string();
}

struct SheetGlyph {
    unsigned cell = 0;
    std::vector<uint8_t> rgba;
};

// hud-glyphs.json: {"cell": 32, "glyphs": {"peak-9": "<base64 RGBA, row by row>", ...}}. A glyph this list doesn't
// place, or one of another size, is skipped, so a newer export never breaks an older build.
inline std::vector<SheetGlyph> read_glyph_sheet(const nlohmann::json &sheet) {
    std::vector<SheetGlyph> glyphs;
    if (!sheet.is_object() || sheet.value("cell", 0u) != sheet_glyph_cell) return glyphs;
    const auto found = sheet.find("glyphs");
    if (found == sheet.end() || !found->is_object()) return glyphs;
    for (const auto &[id, encoded] : found->items()) {
        const unsigned cell = sheet_glyph(id);
        if (!cell || !encoded.is_string()) continue;
        const auto bytes = base64_decode(encoded.get_ref<const std::string &>());
        if (!bytes || bytes->size() != sheet_glyph_bytes) continue;
        glyphs.push_back({cell, std::vector<uint8_t>(bytes->begin(), bytes->end())});
    }
    return glyphs;
}

// The build's sheet, or no glyphs when it is missing or unreadable (peak marks and pride flags then draw nothing).
inline std::vector<SheetGlyph> load_glyph_sheet(const std::filesystem::path &file) {
    constexpr uintmax_t sheet_max_bytes = 1024 * 1024;
    std::error_code error;
    const auto size = std::filesystem::file_size(file, error);
    if (error || size > sheet_max_bytes) return {};
    std::ifstream stream(file, std::ios::binary);
    return read_glyph_sheet(nlohmann::json::parse(stream, nullptr, false));
}

}  // namespace native
