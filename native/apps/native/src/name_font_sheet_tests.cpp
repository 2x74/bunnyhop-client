#include "name_font_sheet.hpp"
#include "native_chat.hpp"
#undef NDEBUG
#include <cassert>
#include <cmath>
#include <iostream>
#include <string>

namespace {
using native::NameFont;

constexpr float sheet_em = 40;
constexpr size_t letter_a = 'A' - ' ';
constexpr size_t letter_b = 'b' - ' ';
constexpr size_t letter_space = 0;

std::string packed_alpha(size_t bytes) {
    std::string alpha(bytes, '\x7f');
    uLongf size = compressBound(uLong(alpha.size()));
    std::string packed(size, '\0');
    compress2(
            reinterpret_cast<Bytef *>(packed.data()),
            &size,
            reinterpret_cast<const Bytef *>(alpha.data()),
            uLong(alpha.size()),
            Z_BEST_COMPRESSION
    );
    packed.resize(size);
    return native::base64(packed);
}

// A 4 x 2 atlas with "A" (advance 20), "b" (advance 10) and the space (advance 8, no ink); every other letter absent.
nlohmann::json small_face() {
    auto glyphs = nlohmann::json::array();
    for (size_t i = 0; i < native::name_font_letter_count; ++i)
        glyphs.push_back(nullptr);
    glyphs[letter_a] = {20, 0, 0, 2, 2, 1, -30};
    glyphs[letter_b] = {10, 2, 0, 2, 2, 0, -28};
    glyphs[letter_space] = {8, 0, 0, 0, 0, 0, 0};
    return {{"size", .5}, {"width", 4}, {"height", 2}, {"alpha", packed_alpha(8)}, {"glyphs", glyphs}};
}

void reads_font_ids() {
    for (size_t i = 0; i < native::name_font_ids.size(); ++i)
        assert(native::name_font_of(native::name_font_ids[i]) == NameFont(i + 1));
    for (const char *unknown : {"", "comic", "GROTESK", "grotesk ", "none"})
        assert(native::name_font_of(unknown) == NameFont::none);
}

void reads_sheets() {
    const auto sheet = native::read_name_font_sheet({{"em", sheet_em}, {"fonts", {{"pixel", small_face()}}}});
    const auto *face = sheet.face(NameFont::pixel);
    assert(face && face->width == 4 && face->height == 2 && face->alpha.size() == 8 && face->alpha[7] == 0x7f);
    assert(face->glyphs[letter_a].present && face->glyphs[letter_a].advance == 20);
    assert(!face->glyphs['c' - ' '].present && face->glyphs[letter_space].present);
    assert(!sheet.face(NameFont::grotesk) && !sheet.face(NameFont::none));

    // A newer export's font is skipped; a malformed font is left out alone.
    auto outside = small_face();
    outside["glyphs"][letter_a] = {20, 3, 0, 2, 2, 0, 0};
    auto oversized = small_face();
    oversized["size"] = 1.5;
    auto short_list = small_face();
    short_list["glyphs"].erase(0);
    auto wrong_pixels = small_face();
    wrong_pixels["alpha"] = packed_alpha(9);
    auto not_base64 = small_face();
    not_base64["alpha"] = "%%%";
    const auto mixed = native::read_name_font_sheet(
            {{"em", sheet_em},
             {"fonts",
              {{"comic", small_face()},
               {"grotesk", outside},
               {"round", oversized},
               {"mono", short_list},
               {"serif", wrong_pixels},
               {"wide", not_base64},
               {"block", small_face()}}}}
    );
    for (const auto font : {NameFont::grotesk, NameFont::round, NameFont::mono, NameFont::serif, NameFont::wide})
        assert(!mixed.face(font));
    assert(mixed.face(NameFont::block));

    assert(!native::read_name_font_sheet({{"em", 2}, {"fonts", {{"pixel", small_face()}}}}).face(NameFont::pixel));
    assert(!native::read_name_font_sheet(nlohmann::json::array()).face(NameFont::pixel));
    assert(native::load_name_font_sheet("missing-name-fonts.json").em == 0);
}

void fits_names() {
    const auto sheet = native::read_name_font_sheet({{"em", sheet_em}, {"fonts", {{"pixel", small_face()}}}});
    const auto &face = *sheet.face(NameFont::pixel);
    // At em 16 the font's size-adjust (.5) gives 0.2 units per atlas pixel: "Ab A" (58 px) is 11.6 wide.
    const auto fit = native::fit_name_font(face, sheet_em, "Ab A", 16, 100);
    assert(fit && std::abs(fit->scale - .2f) < 1e-6f && std::abs(fit->width - 11.6f) < 1e-5f);
    // Never wider than the default font: it shrinks to the width that name has there.
    const auto narrow = native::fit_name_font(face, sheet_em, "Ab A", 16, 5.8f);
    assert(narrow && std::abs(narrow->width - 5.8f) < 1e-5f && narrow->scale < fit->scale);
    // Anything it can't draw whole stays in the default font.
    assert(!native::fit_name_font(face, sheet_em, "Abc", 16, 100));
    assert(!native::fit_name_font(face, sheet_em, "A\xC3\xA9", 16, 100));
    assert(!native::fit_name_font(face, sheet_em, "", 16, 100));
    assert(!native::fit_name_font(face, sheet_em, "A", 16, 0));

    std::vector<native::NameFontQuad> quads;
    native::name_font_quads(face, "Ab A", 10, 50, *fit, [&](const native::NameFontQuad &quad) {
        quads.push_back(quad);
    });
    assert(quads.size() == 3);
    assert(std::abs(quads[0].x - 10.2f) < 1e-5f && std::abs(quads[0].y - 44) < 1e-5f && quads[0].along == 0);
    assert(std::abs(quads[1].x - 14) < 1e-5f && quads[1].u == .5f && quads[1].u_width == .5f);
    // The space only moves the pen: the last "A" starts after 20 + 10 + 8 atlas pixels.
    assert(std::abs(quads[2].x - (10 + 38 * .2f + .2f)) < 1e-5f && quads[2].along == 1);
}

void reads_name_looks() {
    const nlohmann::json look = {{"color", "#ffa8cb"}, {"effect", "glow"}, {"font", "script"}};
    assert(native::host_name_appearance(look, nlohmann::json::array()).font == NameFont::script);
    assert(native::host_name_appearance({{"font", "papyrus"}}, nlohmann::json()).font == NameFont::none);
    // Raw room and chat players carry nameFont; the menu's look replaces it.
    assert(native::name_appearance({{"nameFont", "wide"}}).font == NameFont::wide);
    assert(native::name_appearance({{"nameFont", 3}}).font == NameFont::none);
    assert(native::chat_decoration({{"nameFont", "mono"}}).appearance.font == NameFont::mono);
    assert(native::chat_decoration({{"nativeName", look}, {"nameFont", "mono"}}).appearance.font == NameFont::script);
    assert(native::chat_decoration({{"nativeName", {{"color", "#ffa8cb"}}}}).appearance.font == NameFont::none);
}

// The build's sheet: every font is there and draws everyday names no wider than the HUD font does.
void reads_exported_sheet(const std::filesystem::path &assets) {
    if (!std::filesystem::exists(assets / "name-fonts.json")) {
        std::cout << "name-fonts.json absent: the exported sheet is not checked\n";
        return;
    }
    const auto sheet = native::load_name_font_sheet(assets / "name-fonts.json");
    assert(sheet.em == sheet_em);
    constexpr float size = 14;
    constexpr float hud_advance_per_size = .6f;
    for (size_t i = 0; i < native::name_font_ids.size(); ++i) {
        const auto *face = sheet.face(NameFont(i + 1));
        assert(face && face->alpha.size() == size_t(face->width) * size_t(face->height));
        for (const std::string_view name : {"Profile Hopper", "xX_l33t_Xx", "WWWWWWWW", "iiiiiiii", "[bhop] oiwa!"}) {
            const float widest = float(name.size()) * size * hud_advance_per_size;
            const auto fit = native::fit_name_font(*face, sheet.em, name, size, widest);
            assert(fit && fit->width <= widest + 1e-4f && fit->scale <= size * face->size / sheet.em + 1e-6f);
        }
    }
    // Orbitron has no caret, so such a name keeps the default font.
    assert(!native::fit_name_font(*sheet.face(NameFont::wide), sheet.em, "a^b", size, 100));
}
}  // namespace

int main(int argc, char **argv) {
    reads_font_ids();
    reads_sheets();
    fits_names();
    reads_name_looks();
    reads_exported_sheet(argc > 1 ? argv[1] : "target/native-assets");
    std::cout << "name font tests passed\n";
}
