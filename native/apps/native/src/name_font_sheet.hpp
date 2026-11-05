#pragma once
// The supporter name fonts as the host draws them: name-fonts.json (src/export-name-fonts.ts) holds each font's
// printable ASCII as a small alpha atlas, and a name is laid out letter by letter from it. A name the font can't draw
// whole (a letter outside printable ASCII, or one the font lacks) keeps the default font, as does a font missing from
// the sheet.
#include "base64.hpp"
#include "name_fonts.hpp"
#include <nlohmann/json.hpp>
#include <zlib.h>
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <optional>
#include <string_view>
#include <vector>

namespace native {
inline constexpr unsigned char name_font_first_letter = ' ';
inline constexpr unsigned char name_font_last_letter = '~';
inline constexpr size_t name_font_letter_count = name_font_last_letter - name_font_first_letter + 1;

// One letter: its advance, its ink in the atlas, and where that ink sits from the pen on the baseline (y down). All
// in atlas pixels, drawn at the sheet's em.
struct NameFontGlyph {
    bool present = false;
    float advance = 0;
    uint16_t x = 0, y = 0, width = 0, height = 0;
    float left = 0, top = 0;
};

struct NameFontFace {
    // The website's size-adjust: the font scaled to the default font's width and cap height, never above 1.
    float size = 1;
    int width = 0, height = 0;
    std::array<NameFontGlyph, name_font_letter_count> glyphs{};
    // The atlas, one byte of coverage per pixel. The HUD uploads it and lets it go.
    std::vector<uint8_t> alpha;

    bool loaded() const { return width > 0; }
};

struct NameFontSheet {
    float em = 0;
    std::array<NameFontFace, name_font_ids.size()> faces;

    const NameFontFace *face(NameFont font) const {
        if (font == NameFont::none || em <= 0) return nullptr;
        const auto &face = faces[size_t(font) - 1];
        return face.loaded() ? &face : nullptr;
    }
};

namespace name_font_limits {
inline constexpr int atlas_side_pixels = 2048;
inline constexpr float smallest_em_pixels = 8;
inline constexpr float largest_em_pixels = 256;
// Advances and ink offsets stay within a few ems of the pen.
inline constexpr float reach_ems = 4;
inline constexpr uintmax_t sheet_bytes = 4 * 1024 * 1024;
}  // namespace name_font_limits

// [advance, x, y, width, height, left, top] or null for a letter the font lacks; nullopt for anything malformed.
inline std::optional<NameFontGlyph>
read_name_font_glyph(const nlohmann::json &record, const NameFontFace &face, float em) {
    if (record.is_null()) return NameFontGlyph{};
    if (!record.is_array() || record.size() != 7) return std::nullopt;
    std::array<float, 7> values{};
    for (size_t i = 0; i < values.size(); ++i) {
        if (!record[i].is_number()) return std::nullopt;
        values[i] = record[i].get<float>();
        if (!std::isfinite(values[i])) return std::nullopt;
    }
    const float reach = em * name_font_limits::reach_ems;
    const auto &[advance, x, y, width, height, left, top] = values;
    const bool box_fits = x >= 0 && y >= 0 && width >= 0 && height >= 0 && x + width <= float(face.width)
                          && y + height <= float(face.height);
    if (!box_fits || advance < 0 || advance > reach || std::abs(left) > reach || std::abs(top) > reach)
        return std::nullopt;
    return NameFontGlyph{true, advance, uint16_t(x), uint16_t(y), uint16_t(width), uint16_t(height), left, top};
}

inline std::optional<std::vector<uint8_t>> inflate_name_font_atlas(const std::string &packed, size_t expected) {
    std::vector<uint8_t> alpha(expected);
    uLongf size = uLongf(expected);
    const auto *source = reinterpret_cast<const Bytef *>(packed.data());
    if (uncompress(alpha.data(), &size, source, uLong(packed.size())) != Z_OK || size != expected) return std::nullopt;
    return alpha;
}

// One font's entry, or nullopt when any part of it is malformed (that font then draws in the default font).
inline std::optional<NameFontFace> read_name_font_face(const nlohmann::json &value, float em) {
    if (!value.is_object()) return std::nullopt;
    NameFontFace face;
    face.size = value.value("size", 0.f);
    face.width = value.value("width", 0);
    face.height = value.value("height", 0);
    const int side = name_font_limits::atlas_side_pixels;
    if (!(face.size > 0 && face.size <= 1) || face.width <= 0 || face.height <= 0 || face.width > side
        || face.height > side)
        return std::nullopt;
    const auto glyphs = value.find("glyphs");
    const auto alpha = value.find("alpha");
    if (glyphs == value.end() || !glyphs->is_array() || glyphs->size() != name_font_letter_count) return std::nullopt;
    if (alpha == value.end() || !alpha->is_string()) return std::nullopt;
    for (size_t i = 0; i < name_font_letter_count; ++i) {
        const auto glyph = read_name_font_glyph((*glyphs)[i], face, em);
        if (!glyph) return std::nullopt;
        face.glyphs[i] = *glyph;
    }
    const auto packed = base64_decode(alpha->get_ref<const std::string &>());
    if (!packed) return std::nullopt;
    auto pixels = inflate_name_font_atlas(*packed, size_t(face.width) * size_t(face.height));
    if (!pixels) return std::nullopt;
    face.alpha = std::move(*pixels);
    return face;
}

// name-fonts.json: {"em": 40, "fonts": {"grotesk": {...}, ...}}. A font this build doesn't know is skipped, so a newer
// export never breaks an older build.
inline NameFontSheet read_name_font_sheet(const nlohmann::json &sheet) {
    NameFontSheet out;
    if (!sheet.is_object()) return out;
    const float em = sheet.value("em", 0.f);
    const auto fonts = sheet.find("fonts");
    if (!(em >= name_font_limits::smallest_em_pixels && em <= name_font_limits::largest_em_pixels)) return out;
    if (fonts == sheet.end() || !fonts->is_object()) return out;
    out.em = em;
    for (size_t i = 0; i < name_font_ids.size(); ++i) {
        const auto entry = fonts->find(std::string(name_font_ids[i]));
        if (entry == fonts->end()) continue;
        if (auto face = read_name_font_face(*entry, em)) out.faces[i] = std::move(*face);
    }
    return out;
}

// The build's sheet, or none when it is missing or unreadable (every name then draws in the default font).
inline NameFontSheet load_name_font_sheet(const std::filesystem::path &file) {
    std::error_code error;
    const auto size = std::filesystem::file_size(file, error);
    if (error || size > name_font_limits::sheet_bytes) return {};
    std::ifstream stream(file, std::ios::binary);
    return read_name_font_sheet(nlohmann::json::parse(stream, nullptr, false));
}

// How a name is drawn in a face: `scale` maps atlas pixels to the caller's units, `width` is the name's advance.
struct NameFontFit {
    float scale = 0;
    float width = 0;
};

// `em`: the default font's em in the caller's units; `widest`: the name's width in the default font. As on the website
// (ui/name-fit.ts), the face is drawn at its size-adjust and shrinks further when the name would come out wider than in
// the default font, so rows and tags never get longer. nullopt: the face can't draw this name whole.
inline std::optional<NameFontFit>
fit_name_font(const NameFontFace &face, float sheet_em, std::string_view name, float em, float widest) {
    if (name.empty() || !(sheet_em > 0) || !(em > 0) || !(widest > 0)) return std::nullopt;
    float advance = 0;
    for (const char character : name) {
        const auto letter = static_cast<unsigned char>(character);
        if (letter < name_font_first_letter || letter > name_font_last_letter) return std::nullopt;
        const auto &glyph = face.glyphs[letter - name_font_first_letter];
        if (!glyph.present) return std::nullopt;
        advance += glyph.advance;
    }
    if (!(advance > 0)) return std::nullopt;
    const float scale = std::min(em * face.size / sheet_em, widest / advance);
    return NameFontFit{scale, advance * scale};
}

// One inked letter of a laid-out name: its box in the caller's units, its place in the atlas (0 to 1), and how far
// along the name it is (0 to 1, for the paint and sparkle effects).
struct NameFontQuad {
    float x = 0, y = 0, width = 0, height = 0;
    float u = 0, v = 0, u_width = 0, v_height = 0;
    float along = 0;
};

// Calls `emit(NameFontQuad)` for each inked letter of a name that fit_name_font accepted, from the pen at `x` on the
// `baseline`.
template <class Emit>
void name_font_quads(
        const NameFontFace &face, std::string_view name, float x, float baseline, NameFontFit fit, Emit &&emit
) {
    const float last = std::max(1.f, float(name.size()) - 1);
    for (size_t i = 0; i < name.size(); ++i) {
        const auto &glyph = face.glyphs[static_cast<unsigned char>(name[i]) - name_font_first_letter];
        if (glyph.width && glyph.height) {
            emit(NameFontQuad{
                    x + glyph.left * fit.scale,
                    baseline + glyph.top * fit.scale,
                    glyph.width * fit.scale,
                    glyph.height * fit.scale,
                    float(glyph.x) / float(face.width),
                    float(glyph.y) / float(face.height),
                    float(glyph.width) / float(face.width),
                    float(glyph.height) / float(face.height),
                    float(i) / last
            });
        }
        x += glyph.advance * fit.scale;
    }
}
}  // namespace native
