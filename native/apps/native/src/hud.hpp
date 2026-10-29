#pragma once
#include "renderer.hpp"
#include <array>
#include <cstdio>
#include <map>
#include <optional>
#include <deque>
#include "settings.hpp"
#include "strafe_trainer.hpp"
#include "practice.hpp"
#include "hud_geometry.hpp"
#include "text_raster.hpp"
#include "hud_text.hpp"
#include "native_chat.hpp"
#include "hud_theme.hpp"
#include "movement_hud.hpp"
#include "hud_trainer.hpp"
#include "crosshair_shape.hpp"
#include "hud_result.hpp"
#include "toasts.hpp"

namespace native {
class NativeHud {
    Gl &gl;
    GLuint program = 0, vao = 0, vbo = 0, atlas = 0;
    GLuint glyph_atlas_ = 0;
    std::vector<float> vertices;

    struct Batch {
        GLuint texture;
        size_t first, count;
    };

    std::vector<Batch> batches;

    struct Raster {
        GLuint texture;
        int width, height;
        int pixels;
        bool tabular;
        uint64_t batch;
        float origin_x, origin_y;
        float advance;
    };

    std::map<std::string, Raster> raster_cache;

    struct CaretEntry {
        std::string value;
        int pixels;
        std::vector<native::TextCaret> carets;
    };

    struct RangeEntry {
        std::string value;
        int pixels;
        size_t begin;
        size_t end;
        std::vector<native::TextRangeBox> ranges;
    };

    std::vector<CaretEntry> caret_cache;
    std::vector<RangeEntry> range_cache;

    struct ChatSpan {
        size_t begin;
        size_t end;
        std::optional<native::ChatTarget> target;
        std::array<float, 4> color;
    };

    struct ChatRow {
        std::string text;
        size_t begin;
        uint64_t sequence;
        std::vector<ChatSpan> spans;
        std::array<float, 4> body;
        const native::ChatLine *source;
        size_t flag_begin;
        size_t mark_begin;
        size_t name_begin;
        size_t name_end;
    };

    std::vector<ChatRow> chat_rows_;
    uint64_t chat_layout_hash_ = ~uint64_t(0);
    GLuint current_texture = 0;
    size_t raster_bytes = 0;
    uint64_t raster_batch_ = 0;
    uint64_t rasterizations_ = 0;

    void begin_batch() {
        vertices.clear();
        batches.clear();
        current_texture = atlas;
        ++raster_batch_;
    }

    bool evict_raster() {
        const auto stale = std::min_element(raster_cache.begin(), raster_cache.end(), [](const auto &a, const auto &b) {
            return a.second.batch < b.second.batch;
        });
        if (stale == raster_cache.end() || stale->second.batch == raster_batch_) return false;
        raster_bytes -= size_t(stale->second.width) * stale->second.height * 4;
        gl.DeleteTextures(1, &stale->second.texture);
        raster_cache.erase(stale);
        return true;
    }

    const Raster *raster(std::string_view value, float size, bool tabular = false) {
        if (value.empty()) return nullptr;
        const int pixels = std::max(1, int(std::round(size * 1.3f * scale * element_scale)));
        for (auto &[key, cached] : raster_cache) {
            const auto separator = key.find(':');
            if (cached.pixels == pixels && cached.tabular == tabular
                && std::string_view(key).substr(separator + 1) == value) {
                cached.batch = raster_batch_;
                return &cached;
            }
        }
        const auto key = std::to_string(pixels) + (tabular ? "t:" : "p:") + std::string(value);
        if (raster_cache.size() >= 256 && !evict_raster()) return nullptr;
        ++rasterizations_;
        const auto bitmap = native::raster_text(std::string(value), float(pixels), tabular);
        if (bitmap.width <= 0 || bitmap.height <= 0 || bitmap.rgba.size() != size_t(bitmap.width) * bitmap.height * 4)
            return nullptr;
        constexpr size_t raster_limit_bytes = 16u * 1024 * 1024;
        while (raster_bytes + bitmap.rgba.size() > raster_limit_bytes) {
            if (!evict_raster()) return nullptr;
        }
        raster_bytes += bitmap.rgba.size();
        Raster result{
                0,
                bitmap.width,
                bitmap.height,
                pixels,
                tabular,
                raster_batch_,
                bitmap.origin_x,
                bitmap.origin_y,
                bitmap.advance
        };
        gl.GenTextures(1, &result.texture);
        gl.BindTexture(GL_TEXTURE_2D, result.texture);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
        gl.PixelStorei(GL_UNPACK_ALIGNMENT, 1);
        gl.TexImage2D(
                GL_TEXTURE_2D,
                0,
                GL_RGBA8,
                bitmap.width,
                bitmap.height,
                0,
                GL_RGBA,
                GL_UNSIGNED_BYTE,
                bitmap.rgba.data()
        );
        return &raster_cache.emplace(key, result).first->second;
    }

    const std::vector<native::TextCaret> &carets(const std::string &value, float pixels) {
        for (const auto &entry : caret_cache) {
            if (entry.pixels == int(pixels) && entry.value == value) return entry.carets;
        }
        if (caret_cache.size() == 512) caret_cache.erase(caret_cache.begin());
        caret_cache.push_back({value, int(pixels), native::text_carets(value, pixels)});
        return caret_cache.back().carets;
    }

    const std::vector<native::TextRangeBox> &ranges(const std::string &value, float pixels, size_t begin, size_t end) {
        for (const auto &entry : range_cache) {
            if (entry.pixels == int(pixels) && entry.begin == begin && entry.end == end && entry.value == value)
                return entry.ranges;
        }
        if (range_cache.size() == 1024) range_cache.erase(range_cache.begin());
        range_cache.push_back({value, int(pixels), begin, end, native::text_range_boxes(value, pixels, begin, end)});
        return range_cache.back().ranges;
    }

    native::ChatLinkHits chat_hits_;
    std::vector<native::TextCaret> chat_input_carets_;
    std::string chat_input_identity_;
    float chat_input_left_ = 0, chat_input_top_ = 0, chat_input_width_ = 0, chat_input_height_ = 0;

    void
    shaped(float x,
           float y,
           std::string_view value,
           float size,
           std::array<float, 4> color,
           float from = 0,
           float until = 1e9f,
           bool tabular = false) {
        const auto *glyphs = raster(value, size, tabular);
        if (!glyphs) {
            text(x, y, value, size, color);
            return;
        }
        const float ratio = scale * element_scale;
        const float width = glyphs->width / ratio, height = glyphs->height / ratio;
        const float left = std::clamp(from, 0.f, width), right = std::clamp(until, 0.f, width);
        if (right <= left) return;
        current_texture = glyphs->texture;
        quad(x + left, y, right - left, height, left / width, 0, (right - left) / width, 1, color);
        current_texture = atlas;
    }

    float scale = 1;
    native::HudPreferences prefs_ = native::HudPreferences::from(native::default_settings());
    std::array<native::HudElementStyle, native::hud_ids.size()> element_styles_;
    std::array<uint32_t, 8> key_until_{};
    uint32_t keys_tick_ = 0;
    uint32_t keys_latest_ = 0;
    uint32_t keys_edges_ = 0;
    float keys_yaw_ = 0;
    bool have_keys_yaw_ = false;
    bool hidden_ = false;
    float element_shift_x_ = 0;
    float element_shift_y_ = 0;

    float element_x(float x) const { return pivot_x + (x - pivot_x) * element_scale + element_shift_x_; }

    float element_y(float y) const { return pivot_y + (y - pivot_y) * element_scale + element_shift_y_; }

    bool element_visible = true;
    float element_scale = 1, pivot_x = 0, pivot_y = 0;
    static constexpr size_t speed_history_capacity = 250;
    native::HudSamples<std::pair<uint32_t, float>, speed_history_capacity> speed_history;
    std::string split_line, delta_line;
    bool delta_good = false;

    void element(std::string_view id, float x, float y) {
        element_visible = true;
        element_scale = 1;
        pivot_x = x;
        pivot_y = y;
        const size_t index = native::hud_index(id);
        drawn_index_ = index;
        if (const auto &place = prefs_.layout[index]) {
            element_visible = place->visible;
            element_scale = place->scale;
        }
        if (hidden_ && (!prefs_.hidden_speed_keys || (id != "speed" && id != "keys"))) element_visible = false;
        const auto &style = element_styles_[index];
        element_alpha = style.opacity;
        element_color = style.color;
        // The layout editor shows every element, the hidden ones faint, so each can be picked and switched on.
        if (editing_ && !element_visible) element_alpha *= hidden_while_editing_alpha;
        if (editing_) element_visible = true;
    }

    void clear_element_style() {
        element_alpha = 1;
        element_color.reset();
        drawn_index_ = untracked_element;
    }

    using Color = std::array<float, 4>;
    // The HUD's own colours; Custom CSS may replace them (set_theme).
    static constexpr Color kCream{.94f, .91f, .86f, 1};
    static constexpr Color kAmber{1, .71f, .24f, 1};
    static constexpr Color kDim{.75f, .75f, .77f, 1};
    Color cream = kCream;
    Color amber = kAmber;
    Color dim = kDim;
    native::HudTheme theme_;
    // The current element's Custom CSS opacity and text colour.
    float element_alpha = 1;
    std::optional<Color> element_color;

    // An element's CSS colour replaces its plain text colours; gain/loss and
    // other meaningful colours stay.
    Color themed_text(Color color) const {
        const bool plain = color == cream || color == dim || color == amber;
        return element_color && plain ? *element_color : color;
    }

    Color jump_stats_color(std::optional<float> gain) const {
        return native::ssj_gain_color(gain, prefs_.ssj_fields, prefs_.palette).value_or(native::semantic_rgb(0xffffff));
    }

    static constexpr float hidden_while_editing_alpha = .35f;
    bool editing_ = false;
    // Each element's box (element_size at its place and scale), in pixels, from the last frame.
    std::array<native::HudRect, native::hud_ids.size()> layout_boxes_{};
    // Where each element was drawn last frame, in pixels. The layout smoke checks that no two overlap.
    static constexpr size_t untracked_element = native::hud_ids.size();
    // The board place shares the split's layout entry but has its own place, so it has its own box.
    static constexpr size_t board_place_slot = native::hud_ids.size() + 1;
    std::array<native::HudRect, native::hud_ids.size() + 2> drawn_{};
    size_t drawn_index_ = untracked_element;

    bool noting_drawn_ = true;

    void note_drawn(float x, float y, float w, float h) {
        if (!noting_drawn_) return;
        auto &box = drawn_[drawn_index_];
        const float left = x * scale, top = y * scale, right = (x + w) * scale, bottom = (y + h) * scale;
        if (box.width <= 0 && box.height <= 0) {
            box = {left, top, right - left, bottom - top};
            return;
        }
        const float box_right = std::max(box.x + box.width, right), box_bottom = std::max(box.y + box.height, bottom);
        box.x = std::min(box.x, left);
        box.y = std::min(box.y, top);
        box.width = box_right - box.x;
        box.height = box_bottom - box.y;
    }

    void quad(float x, float y, float w, float h, float u, float v, float uw, float vh, Color c) {
        if (!element_visible) return;
        c[3] *= element_alpha;
        x = element_x(x);
        y = element_y(y);
        w *= element_scale;
        h *= element_scale;
        const float points[6][4] = {
                {x, y, u, v},
                {x + w, y, u + uw, v},
                {x + w, y + h, u + uw, v + vh},
                {x, y, u, v},
                {x + w, y + h, u + uw, v + vh},
                {x, y + h, u, v + vh}
        };
        note_drawn(x, y, w, h);
        if (batches.empty() || batches.back().texture != current_texture)
            batches.push_back({current_texture, vertices.size() / 8, 0});
        batches.back().count += 6;
        for (const auto &p : points)
            vertices.insert(vertices.end(), {p[0] * scale, p[1] * scale, p[2], p[3], c[0], c[1], c[2], c[3]});
    }

    // u = -2 marks a solid fill. The shader tests u < -1 so a text quad whose u lands a hair below 0 at its left edge
    // still samples the texture.
    void rect(float x, float y, float w, float h, Color c) { quad(x, y, w, h, -2, -2, 0, 0, c); }

    static constexpr Color text_shadow{0, 0, 0, .85f};
    static constexpr float atlas_advance_per_size = .6f;
    static constexpr float atlas_height_per_size = 1.3f;
    static constexpr unsigned atlas_columns = 16;
    static constexpr float atlas_cell_u = 1.f / atlas_columns;
    static constexpr float atlas_cell_v = 1.f / 6;
    native::HudLabel<512> folded_;

    // A few marks the menu and server use, folded so a line keeps the bitmap font.
    static std::string_view ascii_fold(std::string_view bytes) {
        if (bytes == "\xC2\xB7") return "|";
        if (bytes == "\xE2\x80\x94" || bytes == "\xE2\x80\x93" || bytes == "\xE2\x88\x92") return "-";
        if (bytes == "\xE2\x80\xA6") return "...";
        if (bytes == "\xC3\x97") return "x";
        if (bytes == "\xE2\x80\x98" || bytes == "\xE2\x80\x99") return "'";
        if (bytes == "\xE2\x80\x9C" || bytes == "\xE2\x80\x9D") return "\"";
        return {};
    }

    // v0.5.1's HUD font: printable ASCII from the JetBrains Mono atlas (hud.rgba). It never rasterizes, so a timer
    // or speed that changes every frame costs no font work. Returns false for text only the system font can shape.
    bool fold_to_atlas(std::string_view value) {
        folded_.assign("");
        if (value.size() >= sizeof(folded_.bytes)) return false;
        for (size_t i = 0; i < value.size();) {
            const auto byte = uint8_t(value[i]);
            if (byte >= ' ' && byte <= '~') {
                folded_.append(value.substr(i, 1));
                ++i;
                continue;
            }
            const size_t length = byte >= 0xF0 ? 4 : byte >= 0xE0 ? 3 : byte >= 0xC0 ? 2 : 1;
            const auto fold = ascii_fold(value.substr(i, length));
            if (fold.empty()) return false;
            folded_.append(fold);
            i += length;
        }
        return true;
    }

    void atlas_text(float x, float y, std::string_view value, float size, Color color) {
        const float advance = size * atlas_advance_per_size;
        const float height = size * atlas_height_per_size;
        // A glyph's cell is wider than its advance; the text's box is what it inks, shadow included.
        if (element_visible)
            note_drawn(
                    element_x(x),
                    element_y(y),
                    (float(value.size()) * advance + 1) * element_scale,
                    (height + 1) * element_scale
            );
        noting_drawn_ = false;
        for (const char character : value) {
            const unsigned index = unsigned(character) - ' ';
            const float u = float(index % atlas_columns) * atlas_cell_u;
            const float v = float(index / atlas_columns) * atlas_cell_v;
            quad(x + 1, y + 1, size, height, u, v, atlas_cell_u, atlas_cell_v, text_shadow);
            quad(x, y, size, height, u, v, atlas_cell_u, atlas_cell_v, color);
            x += advance;
        }
        noting_drawn_ = true;
    }

    // Text that needs the system font (other scripts, emoji) as one shaped raster, or one '?' per code point when
    // no platform font can draw it.
    void shaped_text(float x, float y, std::string_view value, float size, Color color, bool center) {
        if (const auto *glyphs = raster(value, size, true)) {
            const float ratio = scale * element_scale;
            const float width = glyphs->width / ratio, height = glyphs->height / ratio;
            if (center) x -= width * .5f;
            current_texture = glyphs->texture;
            quad(x + 1, y + 1, width, height, 0, 0, 1, 1, text_shadow);
            quad(x, y, width, height, 0, 0, 1, 1, color);
            current_texture = atlas;
            return;
        }
        size_t points = 0;
        for (const char byte : value) {
            if ((uint8_t(byte) & 0xc0) != 0x80) ++points;
        }
        folded_.assign("");
        for (size_t i = 0; i < points && i + 1 < sizeof(folded_.bytes); ++i)
            folded_.append("?");
        const float width = float(folded_.view().size()) * size * atlas_advance_per_size;
        atlas_text(center ? x - width / 2 : x, y, folded_.view(), size, color);
    }

    // How wide text() draws `value`, in HUD units at the current element scale.
    float text_width(std::string_view value, float size) {
        if (fold_to_atlas(value)) return float(folded_.view().size()) * size * atlas_advance_per_size;
        const auto *glyphs = raster(value, size, true);
        return glyphs ? glyphs->width / (scale * element_scale) : float(value.size()) * size * atlas_advance_per_size;
    }

    void text(float x, float y, std::string_view value, float size, Color color, bool center = false) {
        if (!element_visible) return;
        color = themed_text(color);
        if (!fold_to_atlas(value)) {
            shaped_text(x, y, value, size, color, center);
            return;
        }
        const auto ascii = folded_.view();
        if (center) x -= float(ascii.size()) * size * atlas_advance_per_size * .5f;
        atlas_text(x, y, ascii, size, color);
    }

    void prepare_glyph_atlas() {
        std::vector<uint8_t> pixels(native::hud_glyph_width * native::hud_glyph_height * 4);
        const auto marks = native::hud_mark_pixels();
        for (unsigned index = 1; index <= native::hud_mark_text.size() && !marks.empty(); ++index) {
            const unsigned left = (index % native::hud_glyph_columns) * native::hud_glyph_cell;
            const unsigned top = (index / native::hud_glyph_columns) * native::hud_glyph_cell;
            for (unsigned y = 0; y < native::hud_glyph_cell; ++y) {
                const size_t from = ((index - 1) * 32 * 32 + y * 32) * 4;
                const size_t to = ((top + y) * native::hud_glyph_width + left) * 4;
                std::copy_n(marks.data() + from, 32 * 4, pixels.data() + to);
            }
        }
        const auto flags = native::hud_flag_pixels();
        for (unsigned country = 0; country < 26 * 26 && !flags.empty(); ++country) {
            const unsigned index = 16 + country;
            const unsigned left = (index % native::hud_glyph_columns) * native::hud_glyph_cell;
            const unsigned top = (index / native::hud_glyph_columns) * native::hud_glyph_cell;
            for (unsigned y = 0; y < native::hud_glyph_cell; ++y) {
                for (unsigned x = 0; x < native::hud_glyph_cell; ++x) {
                    const size_t from = (country * 16 * 12 + (y * 12 / 32) * 16 + x * 16 / 32) * 4;
                    const size_t to = ((top + y) * native::hud_glyph_width + left + x) * 4;
                    std::copy_n(flags.data() + from, 4, pixels.data() + to);
                }
            }
        }
        gl.GenTextures(1, &glyph_atlas_);
        gl.BindTexture(GL_TEXTURE_2D, glyph_atlas_);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
        gl.TexImage2D(
                GL_TEXTURE_2D,
                0,
                GL_RGBA8,
                native::hud_glyph_width,
                native::hud_glyph_height,
                0,
                GL_RGBA,
                GL_UNSIGNED_BYTE,
                pixels.data()
        );
    }

    void glyph(float x, float y, unsigned index, float width, float height, Color color, bool colored = false) {
        if (!index) return;
        current_texture = glyph_atlas_;
        const float u = float(index % native::hud_glyph_columns) / native::hud_glyph_columns;
        const float v = float(index / native::hud_glyph_columns) * native::hud_glyph_cell / native::hud_glyph_height;
        quad(x,
             y,
             width,
             height,
             u,
             v + (colored ? 3 : 0),
             1.f / native::hud_glyph_columns,
             float(native::hud_glyph_cell) / native::hud_glyph_height,
             color);
        current_texture = atlas;
    }

public:
    void preferences(const native::Json &value) {
        prefs_ = native::HudPreferences::from(value);
        rebuild_crosshair();
        if (ssj_last_) {
            const auto labels = native::ssj_labels(*ssj_last_, prefs_.ssj_fields);
            ssj_line_ = labels.hud;
            ssj_chat_line_ = labels.chat;
        }
        chat_layout_hash_ = ~uint64_t(0);
        const auto &restart = value.at("binds").at("restart");
        result.restart_bind(restart.empty() ? "" : restart[0].get_ref<const std::string &>());
    }

    const native::HudPreferences &preferences() const { return prefs_; }

    native::HudResult result;
    native::Toasts toasts;
    native::MovementHud movement;
    native::HudExtras extras;

private:
    std::string context_map_;
    std::string context_style_;
    unsigned context_track_ = ~0u;
    native::HudLabel<512> ssj_line_;
    native::HudLabel<512> ssj_chat_line_;
    bool ssj_pending_ = false;
    std::optional<native::SsjReport> ssj_last_;

public:
    std::string_view ssj_line() const { return ssj_line_.view(); }

    void context(const native::Json &entries, const std::string &map, const std::string &style, unsigned track) {
        if (context_map_ != map || context_style_ != style || context_track_ != track) {
            extras.personal_best.reset();
            extras.pb.assign("");
            extras.place.assign("");
            context_map_ = map;
            context_style_ = style;
            context_track_ = track;
        }
        extras.local_pb(entries, map, style, track);
    }

    void configure_feedback(native::MovementFeedback &feedback) const {
        feedback.ssj.set_mode(prefs_.ssj_mode);
        feedback.ssj.set_interval(prefs_.ssj_interval);
    }

    void ssj_report(const native::SsjReport &report) {
        ssj_last_ = report;
        const auto labels = native::ssj_labels(report, prefs_.ssj_fields);
        ssj_line_ = labels.hud;
        ssj_chat_line_ = labels.chat;
        ssj_pending_ = prefs_.ssj_chat;
    }

    void publish_movement_chat(native::Chat &chat, double now) {
        if (ssj_pending_) chat.push(std::string(ssj_chat_line_.view()), "", "system", now);
        if (movement.new_first && prefs_.first_jump_chat)
            chat.push(std::string(movement.first_jump_chat.view()), "", "system", now);
        if (movement.new_long_jump && prefs_.long_jump && prefs_.long_jump_chat)
            chat.push(
                    std::string(movement.long_jump.view()) + " | " + std::string(movement.long_jump_details.view()),
                    "",
                    "system",
                    now
            );
        ssj_pending_ = false;
        movement.new_first = false;
        movement.new_long_jump = false;
    }

    void scoreboard(
            int width,
            int height,
            float percent,
            const native::HudScoreboard &board,
            double now,
            double epoch_ms,
            const BhRunState &run,
            std::string_view style
    ) {
        const native::ScoreLocal local{run.status, run.seconds};
        native::draw_scoreboard(*this, width, height, percent, board, now, epoch_ms, &local, style);
    }

    void repeat_long_jump(native::Chat &chat, double now) const {
        if (!movement.long_jump.empty())
            chat.push(
                    std::string(movement.long_jump.view()) + " | " + std::string(movement.long_jump_details.view()),
                    "",
                    "system",
                    now
            );
    }

    void receive_data(
            const native::Json &message,
            uint64_t generation,
            const std::string &map,
            const std::string &style,
            unsigned track
    ) {
        if (message.value("generation", ~uint64_t(0)) != generation || message.value("map", std::string()) != map
            || message.value("style", std::string()) != style || message.value("track", ~0u) != track)
            return;
        extras.contract(message);
    }

    void receive_toast(const native::Json &message, double now) {
        const auto tone = native::json_text(message, "tone");
        toasts.push(
                native::json_text(message, "text", 191),
                now,
                message.value("ms", 3000.) / 1000,
                tone == "error"     ? native::ToastTone::error
                : tone == "unlock"  ? native::ToastTone::unlock
                : tone == "whisper" ? native::ToastTone::whisper
                                    : native::ToastTone::notice,
                native::json_text(message, "title", 79)
        );
    }

    bool auto_restart_due(
            native::AutoRestart &restart,
            uint64_t attempt,
            const BhRunState &run,
            std::optional<double> wr,
            std::optional<double> ghost,
            bool blocked
    ) const {
        if (prefs_.auto_restart_when == "off") return false;
        const auto target = prefs_.auto_restart_when == "pb"   ? extras.personal_best
                            : prefs_.auto_restart_when == "wr" ? wr
                                                               : ghost;
        return restart.check(attempt, run, target, blocked);
    }

    void command_tick(const BhCmd &command, uint32_t tick) {
        if (have_keys_yaw_) {
            const float delta = std::remainder(command.yaw - keys_yaw_, 360.f);
            if (delta > 0) {
                key_until_[6] = tick + 3;
            }
            if (delta < 0) {
                key_until_[7] = tick + 3;
            }
        }
        keys_yaw_ = command.yaw;
        have_keys_yaw_ = true;
        keys_tick_ = tick;
        const uint32_t edges = command.buttons & ~keys_latest_;
        constexpr std::array<uint32_t, 6> bits = {
                native::forward, native::left, native::back, native::right, native::duck, native::jump
        };
        constexpr unsigned flash_ticks = 11;
        for (size_t i = 0; i < bits.size(); ++i) {
            if (edges & bits[i]) key_until_[i] = tick + flash_ticks;
        }
        keys_edges_ |= edges;
        keys_latest_ = command.buttons;
    }

    void set_theme(native::HudTheme theme) {
        theme_ = std::move(theme);
        for (size_t i = 0; i < native::hud_ids.size(); ++i) {
            const auto *style = theme_.element(std::string(native::hud_ids[i]));
            element_styles_[i] = style ? *style : native::HudElementStyle{};
        }
        cream = theme_.text.value_or(kCream);
        dim = theme_.secondary.value_or(kDim);
        amber = theme_.accent.value_or(kAmber);
    }

    void reset_history(bool keep_jump_stats = false) {
        if (!keep_jump_stats) {
            ssj_last_.reset();
            ssj_line_.assign("");
        }
        ssj_pending_ = false;
        movement.reset();
        result.reset();
        keys_latest_ = keys_edges_ = 0;
        have_keys_yaw_ = false;
        speed_history.clear();
        split_line.clear();
        delta_line.clear();
    }

    void set_run_comparison(const std::string &split, const std::string &delta, bool good = false) {
        split_line = split;
        delta_line = delta;
        delta_good = good;
    }

    void tick(const BhState &s) {
        if (!speed_history.empty()
            && (s.tick < speed_history.back().first || s.tick > speed_history.back().first + 100))
            speed_history.clear();
        if (speed_history.empty() || s.tick != speed_history.back().first)
            speed_history.emplace_back(s.tick, std::hypot(s.velocity[0], s.velocity[1]));
        while (speed_history.size() > speed_history_capacity)
            speed_history.pop_front();
    }

    uint64_t rasterizations() const { return rasterizations_; }

    // Gameplay and overlays use cached system-shaped sans text.
    // Failed or unavailable platform fonts retain one fallback per code point.
    void overlay_begin(int width, int height, float percent = 100) {
        begin_batch();
        scale = native::HudGeometry(width, height, percent).scale;
        element_visible = true;
        element_scale = 1;
        pivot_x = pivot_y = 0;
        element_shift_x_ = element_shift_y_ = 0;
        clear_element_style();
    }

    void overlay_text(
            float x, float y, std::string_view value, float size, std::array<float, 4> color, bool center = false
    ) {
        text(x, y, value, size, color, center);
    }

    void overlay_rect(float x, float y, float w, float h, std::array<float, 4> color) { rect(x, y, w, h, color); }

    // How wide overlay_text draws `value` (bitmap-font text is exact; shaped text is rasterized once to measure).
    float overlay_text_width(std::string_view value, float size) { return text_width(value, size); }

    void overlay_mark(float x, float y, native::NameMark mark, Color color) {
        glyph(x,
              y,
              unsigned(mark) + 1,
              18,
              18,
              mark == native::NameMark::crown ? color : Color{1, 1, 1, color[3]},
              true);
    }

    void overlay_flag(float x, float y, std::string_view country) {
        glyph(x, y, native::flag_glyph(country), 22, 18, {1, 1, 1, 1}, true);
    }

    void overlay_avatar(float x, float y, unsigned /*slot*/, Color color) {
        // The room protocol has no avatar image. Keep the website's bunny silhouette as the fallback.
        rect(x, y, 23, 25, {.12f, .13f, .16f, 1});
        rect(x + 5, y + 3, 4, 9, color);
        rect(x + 14, y + 3, 4, 9, color);
        rect(x + 4, y + 11, 15, 11, color);
        rect(x + 7, y + 14, 2, 2, {0, 0, 0, 1});
        rect(x + 14, y + 14, 2, 2, {0, 0, 0, 1});
    }

    void overlay_badge(float x, float y, const native::NameBadge &badge, double seconds) {
        glyph(x, y, unsigned(badge.glyph) + 1, 18, 18, native::name_badge_color(badge, seconds), true);
    }

    void overlay_badges(float x, float y, const native::NameAppearance &look, double seconds) {
        if (look.badge_count) {
            for (size_t i = 0; i < look.badge_count; ++i) {
                overlay_badge(x, y, look.badges[i], seconds);
                x += 18;
            }
            return;
        }
        for (unsigned mark = 0; mark < native::hud_mark_text.size(); ++mark) {
            if (look.marks & (1u << mark)) {
                overlay_mark(x, y, native::NameMark(mark), look.color);
                x += 18;
            }
        }
    }

    void overlay_name(
            float x,
            float y,
            std::string_view value,
            float size,
            const native::NameAppearance &look,
            double seconds,
            bool center = false
    ) {
        const float advance = size * atlas_advance_per_size;
        const bool bitmap_font = fold_to_atlas(value);
        const auto *bitmap = bitmap_font ? nullptr : raster(value, size, true);
        const float name_width = text_width(value, size);
        if (center) x -= name_width / 2;
        if (look.effect == native::NameEffect::glow) {
            auto halo = look.color;
            halo[3] *= .25f;
            text(x - 1, y, value, size, halo);
            text(x + 1, y, value, size, halo);
            text(x, y - 1, value, size, halo);
            text(x, y + 1, value, size, halo);
        }
        if (look.effect == native::NameEffect::plain || look.effect == native::NameEffect::glow) {
            text(x, y, value, size, look.color);
            x += name_width;
        } else {
            // A shaped name is clipped into slices to keep joining and ligatures; a bitmap one goes letter by letter.
            if (bitmap) {
                constexpr unsigned slices = 16;
                for (unsigned i = 0; i < slices; ++i) {
                    const float left = name_width * float(i) / slices;
                    const float right = name_width * float(i + 1) / slices;
                    shaped(x, y, value, size, native::name_ink(look, float(i) / slices, seconds), left, right, true);
                }
                x += name_width;
            } else {
                for (size_t i = 0; i < value.size(); ++i) {
                    text(x,
                         y,
                         value.substr(i, 1),
                         size,
                         native::name_ink(look, float(i) / std::max(1.f, float(value.size() - 1)), seconds));
                    x += advance;
                }
            }
        }
        overlay_badges(x + 3, y, look, seconds);
    }

    void overlay_end(int width, int height) { flush(width, height); }

    void draw_overlay(
            int width,
            int height,
            const std::vector<std::string> &lines,
            const std::string &input,
            const std::string &composition,
            const std::vector<std::string> &suggestions,
            bool typing,
            float percent = 100
    ) {
        overlay_begin(width, height, percent);
        const float h = height / scale, w = width / scale;
        const float box = std::min(680.f, w - 40);
        const unsigned columns = unsigned(std::max(4.f, (box - 25) / 8.4f));
        std::vector<std::string> wrapped;
        for (const auto &line : lines) {
            auto parts = native::wrap_text(line, columns);
            wrapped.insert(wrapped.end(), parts.begin(), parts.end());
        }
        const size_t max_lines = size_t(std::max(1.f, std::min(14.f, (h - 230) / 21)));
        if (wrapped.size() > max_lines) wrapped.erase(wrapped.begin(), wrapped.end() - max_lines);
        const float bottom = h - 110, top = bottom - float(wrapped.size()) * 21 - (typing ? 60.f : 0.f);
        if (!wrapped.empty() || typing)
            rect(16,
                 top - 10,
                 box,
                 float(wrapped.size()) * 21 + (typing ? 60.f : 0.f) + 18,
                 {.02f, .02f, .035f, typing ? .9f : .65f});
        float y = top;
        for (const auto &line : wrapped) {
            text(25, y, line, 14, cream);
            y += 21;
        }
        if (typing) {
            const unsigned input_columns = unsigned(std::max(4.f, (box - 25) / 9.f));
            const auto cursor = input.find('|');
            std::string display;
            if (cursor == std::string::npos)
                display = native::text_tail(input + composition, input_columns - 2);
            else {
                const auto before = native::text_tail(input.substr(0, cursor), input_columns / 2);
                const auto pre = native::text_tail(before + composition, input_columns - 3);
                const auto used = native::text_columns(pre);
                display = pre + "|"
                          + native::text_prefix(
                                  input.substr(cursor + 1), unsigned(std::max(0, int(input_columns) - int(used) - 3))
                          );
            }
            text(25, y + 5, "> " + display, 15, amber);
            if (!suggestions.empty()) {
                std::string list;
                for (size_t i = 0; i < std::min(size_t(4), suggestions.size()); ++i)
                    list += (i ? "   " : "") + suggestions[i];
                text(25, y + 29, native::text_prefix(list, columns), 12, dim);
            }
        }
        flush(width, height);
    }

    // At most 680 wide, and clear of the run column's widest lines (jump stats, the stage beside the timer).
    static float chat_box_width(float width) {
        constexpr float widest = 680;
        constexpr float narrowest = 260;
        constexpr float column_half_width = 240;
        constexpr float left = 16;
        return std::clamp(width / 2 - column_half_width - left, narrowest, widest);
    }

    static constexpr float max_chat_rows = 8;
    static constexpr float max_chat_rows_typing = 14;

    std::optional<native::ChatTarget> chat_hit(float xPixels, float yPixels, uint64_t viewportHash) const {
        return chat_hits_.hit(xPixels, yPixels, viewportHash);
    }

    void chat_invalidate_hits() {
        chat_hits_.clear();
        chat_input_carets_.clear();
    }

    bool chat_input_contains(float xPixels, float yPixels) const {
        return !chat_input_carets_.empty() && xPixels >= chat_input_left_
               && xPixels < chat_input_left_ + chat_input_width_ && yPixels >= chat_input_top_
               && yPixels < chat_input_top_ + chat_input_height_;
    }

    std::optional<native::TextCaret> chat_input_byte(float xPixels, float yPixels, std::string_view current) const {
        if (!chat_input_contains(xPixels, yPixels) || current != chat_input_identity_) return std::nullopt;
        const auto at = std::min_element(
                chat_input_carets_.begin(), chat_input_carets_.end(), [&](const auto &a, const auto &b) {
                    return std::abs(a.x - xPixels) < std::abs(b.x - xPixels);
                }
        );
        return *at;
    }

    std::vector<native::TextCaret> chat_carets() const { return chat_input_carets_; }

    std::vector<native::TextCaret> chat_carets(std::string_view current) const {
        return current == chat_input_identity_ ? chat_input_carets_ : std::vector<native::TextCaret>{};
    }

    void draw_chat_overlay(
            int width,
            int height,
            const std::vector<native::ChatLine> &lines,
            const std::string &input,
            const std::string &composition,
            const std::vector<std::string> &suggestions,
            bool typing,
            size_t scroll_offset = 0,
            float percent = 100,
            const native::Chat *editor = nullptr,
            uint64_t viewportHash = 0
    ) {
        overlay_begin(width, height, percent);
        chat_input_carets_.clear();
        drawn_index_ = native::hud_index("chat");
        drawn_[drawn_index_] = {};
        const float h = height / scale, w = width / scale, box = chat_box_width(w), font = 14, step = 30;
        const float pixels = float(std::max(1, int(std::round(font * 1.3f * scale))));
        using Span = ChatSpan;
        auto &rows = chat_rows_;
        const uint64_t layout_hash = viewportHash ^ uint64_t(width) << 32 ^ uint64_t(height) << 16
                                     ^ uint64_t(percent * 100) ^ uint64_t(typing) << 63;
        const bool layout_changed = layout_hash != chat_layout_hash_;
        if (layout_changed) {
            chat_layout_hash_ = layout_hash;
            rows.clear();
            chat_hits_.clear();
            for (const auto &line : lines) {
                Color name = amber, body = line.kind == "error"     ? Color{1, .45f, .4f, 1}
                                           : line.kind == "private" ? Color{.8f, .7f, 1, 1}
                                           : line.kind == "system" || line.kind == "announcement" ? amber
                                                                                                  : cream;
                const auto &d = line.decoration;
                name = d.appearance.color;
                if (d.color.size() == 7) {
                    try {
                        const auto rgb = std::stoul(d.color.substr(1), nullptr, 16);
                        name = {
                                float((rgb >> 16) & 255) / 255, float((rgb >> 8) & 255) / 255, float(rgb & 255) / 255, 1
                        };
                    } catch (...) {
                    }
                }
                std::string prefix;
                if (!d.rank.empty()) prefix += d.rank + " ";
                const size_t flag_begin = prefix.size();
                if (!d.country.empty()) prefix += "      ";
                const size_t nameBegin = prefix.size();
                if (!line.name.empty()) prefix += line.name;
                const size_t name_end = prefix.size();
                const size_t mark_begin = prefix.size();
                for (size_t mark = 0; mark < native::name_badge_count(d.appearance); ++mark)
                    prefix += "     ";
                if (!line.name.empty()) prefix += ": ";
                const std::string full = prefix + line.text;
                std::vector<Span> spans;
                if (!prefix.empty()) spans.push_back({0, prefix.size(), std::nullopt, name});
                if (!d.rank.empty())
                    spans.push_back({0, d.rank.size(), std::nullopt, native::name_color(d.rank_color, dim)});
                if (!line.name.empty())
                    if (const auto target = native::chat_profile_target(d.profile))
                        spans.push_back({nameBegin, nameBegin + line.name.size(), target, name});
                for (const auto &link : native::chat_links(line.text))
                    spans.push_back(
                            {prefix.size() + link.begin, prefix.size() + link.end, link.target, {.45f, .75f, 1, 1}}
                    );
                size_t offset = 0;
                for (const auto &part : native::wrap_text(full, unsigned(std::max(4.f, (box - 28) / 10.f)))) {
                    // Split unusually wide shaped text at an actual grapheme boundary.
                    size_t used = 0;
                    while (used < part.size()) {
                        std::string section = part.substr(used);
                        const auto bounds = native::grapheme_boundaries(section);
                        size_t take = section.size();
                        if (const auto r = raster(section, font); r && r->width / scale > box - 28) {
                            size_t lo = 1, hi = bounds.size() - 1;
                            while (lo < hi) {
                                const auto mid = (lo + hi + 1) / 2;
                                const auto probe = raster(section.substr(0, bounds[mid]), font);
                                if (probe && probe->width / scale <= box - 28)
                                    lo = mid;
                                else
                                    hi = mid - 1;
                            }
                            take = bounds[lo];
                        }
                        rows.push_back(
                                {section.substr(0, take),
                                 offset + used,
                                 line.sequence,
                                 spans,
                                 body,
                                 &line,
                                 flag_begin,
                                 mark_begin,
                                 nameBegin,
                                 name_end}
                        );
                        used += take;
                    }
                    offset += part.size();
                }
            }
            const float most_rows = typing ? max_chat_rows_typing : max_chat_rows;
            const size_t maximum = size_t(std::max(1.f, std::min(most_rows, (h - 230) / step)));
            if (rows.size() > maximum) rows.erase(rows.begin(), rows.end() - maximum);
        }
        const float top = h - 110 - float(rows.size()) * step - (typing ? 70.f : 0.f);
        const auto &place = prefs_.layout[native::hud_index("chat")];
        const float box_height =
                float(std::max<size_t>(rows.size(), editing_ ? 1 : 0)) * step + (typing ? 75.f : 0.f) + 18;
        pivot_x = 16;
        pivot_y = top - 10;
        if (place) {
            element_scale = place->scale;
            element_visible = typing || editing_ || place->visible;
            if (editing_ && !place->visible) element_alpha = hidden_while_editing_alpha;
        }
        if (place && place->placed) {
            const auto bounds = place->rect(w, h, box, box_height);
            element_shift_x_ = bounds.x - pivot_x;
            element_shift_y_ = bounds.y - pivot_y;
        }
        layout_boxes_[native::hud_index("chat")] = {
                element_x(16) * scale,
                element_y(top - 10) * scale,
                box * element_scale * scale,
                box_height * element_scale * scale
        };
        const bool has_text =
                std::any_of(rows.begin(), rows.end(), [](const ChatRow &row) { return !row.text.empty(); });
        if (has_text || typing || editing_)
            rect(16,
                 top - 10,
                 box,
                 float(rows.size()) * step + (typing ? 75.f : 0.f) + 18,
                 {.02f, .02f, .035f, typing ? .94f : .7f});
        float y = top;
        std::vector<native::ChatHitBox> hitboxes;
        if (typing && scroll_offset) {
            native::HudLabel<96> label;
            label.format("SCROLLBACK +%zu | End: latest", scroll_offset);
            text(25, y - 23, label.view(), 12, amber);
        }
        for (const auto &row : rows) {
            shaped(25, y, row.text, font, row.body);
            for (const auto &span : row.spans) {
                const auto begin = std::max(span.begin, row.begin),
                           end = std::min(span.end, row.begin + row.text.size());
                if (begin >= end) continue;
                for (const auto &range : ranges(row.text, pixels, begin - row.begin, end - row.begin)) {
                    const float x = 25 + range.x / scale, rw = range.width / scale;
                    shaped(25, y, row.text, font, span.color, range.x / scale, (range.x + range.width) / scale);
                    if (span.target) {
                        rect(x, y + step - 4, rw, 1, span.color);
                        if (typing && layout_changed)
                            hitboxes.push_back(
                                    {element_x(x) * scale,
                                     element_y(y) * scale,
                                     rw * element_scale * scale,
                                     step * element_scale * scale,
                                     *span.target,
                                     row.sequence}
                            );
                    }
                }
            }
            const auto &look = row.source->decoration.appearance;
            const auto region = [&](size_t begin, size_t end, const auto &paint) {
                begin = std::max(begin, row.begin);
                end = std::min(end, row.begin + row.text.size());
                if (begin >= end) return;
                for (const auto &range : ranges(row.text, pixels, begin - row.begin, end - row.begin))
                    paint(range);
            };
            region(row.name_begin, row.name_end, [&](const auto &range) {
                if (look.effect == native::NameEffect::glow) {
                    auto halo = look.color;
                    halo[3] = .25f;
                    shaped(24, y, row.text, font, halo, range.x / scale, (range.x + range.width) / scale);
                    shaped(26, y, row.text, font, halo, range.x / scale, (range.x + range.width) / scale);
                }
                const unsigned slices =
                        look.effect == native::NameEffect::paint || look.effect == native::NameEffect::sparkle ? 16 : 1;
                for (unsigned i = 0; i < slices; ++i) {
                    const float left = (range.x + range.width * float(i) / slices) / scale;
                    const float right = (range.x + range.width * float(i + 1) / slices) / scale;
                    shaped(25,
                           y,
                           row.text,
                           font,
                           native::name_ink(look, float(i) / slices, double(SDL_GetTicksNS()) / 1e9),
                           left,
                           right);
                }
            });
            if (row.begin == 0) {
                if (!row.source->decoration.country.empty()) {
                    region(row.flag_begin, row.flag_begin + 6, [&](const auto &range) {
                        overlay_flag(25 + range.x / scale, y + 2, row.source->decoration.country);
                    });
                }
                region(row.mark_begin, row.mark_begin + native::name_badge_count(look) * 5, [&](const auto &range) {
                    overlay_badges(25 + range.x / scale, y + 2, look, double(SDL_GetTicksNS()) / 1e9);
                });
            }
            y += step;
        }
        if (typing) {
            const std::string &value = editor ? editor->input : input;
            const size_t cursor = editor ? editor->cursor : value.size();
            const float inputFont = 15, inputPixels = float(std::max(1, int(std::round(inputFont * 1.3f * scale))));
            const auto &inputCarets = carets(value, inputPixels);
            float caretX = 4;
            for (const auto &c : inputCarets)
                if (c.byte == cursor && c.secondary == (editor && editor->cursor_secondary)) {
                    caretX = c.x;
                    break;
                }
            const float available = (box - 45) * scale, shift = std::max(0.f, caretX - available + 12 * scale);
            const float origin = 40 - shift / scale;
            text(25, y + 5, ">", 15, amber);
            rect(37, y + 2, box - 32, 32, {.015f, .015f, .025f, 1});
            if (editor && editor->selected) {
                const auto [a, b] = editor->selection();
                for (const auto &range : ranges(value, inputPixels, a, b)) {
                    const float left = std::max(40.f, origin + range.x / scale),
                                right = std::min(16 + box - 10, origin + (range.x + range.width) / scale);
                    if (right > left) rect(left, y + 3, right - left, 29, {.25f, .38f, .65f, .75f});
                }
            }
            shaped(origin, y + 3, value, inputFont, amber, (40 - origin), 16 + box - 10 - origin);
            rect(std::clamp(origin + caretX / scale, 40.f, 16 + box - 11), y + 5, 1, 24, cream);
            if (!composition.empty())
                shaped(std::clamp(origin + caretX / scale, 40.f, 16 + box - 11),
                       y + 3,
                       composition,
                       inputFont,
                       cream,
                       0,
                       box / 2);
            chat_input_identity_ = value;
            chat_input_left_ = element_x(40) * scale;
            chat_input_top_ = element_y(y + 2) * scale;
            chat_input_width_ = (box - 45) * element_scale * scale;
            chat_input_height_ = 32 * element_scale * scale;
            for (auto c : inputCarets) {
                c.x = element_x(c.x / scale + origin) * scale;
                chat_input_carets_.push_back(c);
            }
            if (!suggestions.empty()) {
                native::HudLabel<1024> list;
                for (size_t i = 0; i < std::min(size_t(4), suggestions.size()); ++i) {
                    if (i) list.append("   ");
                    list.append(suggestions[i]);
                }
                text(25, y + 40, list.view().substr(0, size_t(std::max(4.f, (box - 25) / 8))), 12, dim);
            }
        }
        if (layout_changed) chat_hits_.set(std::move(hitboxes), viewportHash);
        flush(width, height);
    }

    void draw_panel(
            int width, int height, const std::string &title, const std::vector<std::string> &lines, float percent = 100
    ) {
        overlay_begin(width, height, percent);
        const float w = width / scale, h = height / scale, bw = std::min(950.f, w - 40),
                    bh = std::min(h - 60, 70.f + lines.size() * 23);
        const float x = (w - bw) / 2, y = (h - bh) / 2;
        rect(x, y, bw, bh, {.02f, .02f, .035f, .92f});
        text(x + 20, y + 14, title, 22, amber);
        for (size_t i = 0; i < lines.size() && i * 23 + 62 < bh; ++i)
            text(x + 20, y + 55 + i * 23, lines[i], 14, cream);
        flush(width, height);
    }

    NativeHud(Gl &g, const std::filesystem::path &assets) : gl(g) {
        std::ifstream f(assets / "hud.rgba", std::ios::binary);
        std::vector<uint8_t> data{std::istreambuf_iterator<char>(f), {}};
        if (data.size() != 640 * 312 * 4)
            throw std::runtime_error("Native HUD atlas is absent; build presentation assets");
        program = link_program(
                gl,
                R"(#version 330 core
layout(location=0)in vec2 pos;layout(location=1)in vec2 coord;layout(location=2)in vec4 tint;
uniform vec3 viewport;out vec2 uv;out vec4 ink;
void main(){uv=coord;ink=tint;gl_Position=vec4(pos.x/viewport.x*2.-1.,1.-pos.y/viewport.y*2.,0,1);})",
                R"(#version 330 core
in vec2 uv;in vec4 ink;uniform sampler2D font;out vec4 color;
void main(){if(uv.y>2.){color=texture(font,vec2(uv.x,uv.y-3.))*ink;}
else{color=vec4(ink.rgb,ink.a*(uv.x<-1.?1.:texture(font,uv).a));}})"
        );
        gl.GenVertexArrays(1, &vao);
        gl.BindVertexArray(vao);
        gl.GenBuffers(1, &vbo);
        gl.BindBuffer(GL_ARRAY_BUFFER, vbo);
        gl.EnableVertexAttribArray(0);
        gl.VertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 8 * sizeof(float), nullptr);
        gl.EnableVertexAttribArray(1);
        gl.VertexAttribPointer(
                1, 2, GL_FLOAT, GL_FALSE, 8 * sizeof(float), reinterpret_cast<void *>(2 * sizeof(float))
        );
        gl.EnableVertexAttribArray(2);
        gl.VertexAttribPointer(
                2, 4, GL_FLOAT, GL_FALSE, 8 * sizeof(float), reinterpret_cast<void *>(4 * sizeof(float))
        );
        vertices.reserve(512 * 1024);
        batches.reserve(8192);
        caret_cache.reserve(512);
        range_cache.reserve(1024);
        chat_rows_.reserve(128);
        chat_input_carets_.reserve(1024);
        chat_input_identity_.reserve(512);
        prepare_glyph_atlas();
        gl.GenTextures(1, &atlas);
        gl.BindTexture(GL_TEXTURE_2D, atlas);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
        gl.TexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, 640, 312, 0, GL_RGBA, GL_UNSIGNED_BYTE, data.data());
    }

    ~NativeHud() {
        gl.DeleteTextures(1, &glyph_atlas_);
        for (const auto &[key, raster] : raster_cache)
            gl.DeleteTextures(1, &raster.texture);
        gl.DeleteTextures(1, &atlas);
        gl.DeleteBuffers(1, &vbo);
        gl.DeleteVertexArrays(1, &vao);
        gl.DeleteProgram(program);
    }

    // Where each element goes: element id -> {x, y} in percent of the screen.
    // An element that isn't listed stays at its built-in place (see draw()).
    // ui/hud-layout.ts mirrors the ids and built-in places for the settings
    // screen; keep the two in step.
    using Layout = std::map<std::string, std::array<float, 2>>;

    void
    draw(int width,
         int height,
         const BhSnapshot &s,
         const BhRunState &run,
         const BhCmd & /*cmd*/,
         const std::string &map,
         const std::string &style,
         const std::string &notice,
         double fps,
         bool visible,
         bool crosshair,
         bool playback,
         const BhWeaponReport &weapon,
         std::string_view jump_stats = "",
         std::optional<float> jump_stats_gain = std::nullopt,
         std::optional<native::StrafeReading> strafe = std::nullopt,
         bool strafe_hints = true,
         const Layout *layout = nullptr,
         float hud_percent = 100,
         const native::Practice *practice = nullptr,
         bool keep_velocity = false,
         const std::string &gauntlet_line = "",
         const std::string &gauntlet_delta = "",
         bool gauntlet_good = false,
         float leave_progress = -1) {
        if (width <= 0 || height <= 0) return;
        hidden_ = !visible;
        element_shift_x_ = element_shift_y_ = 0;
        begin_batch();
        drawn_.fill({});
        const native::HudGeometry geometry(width, height, hud_percent);
        scale = geometry.scale;
        frame_width_ = geometry.width;
        frame_height_ = geometry.height;
        legacy_layout_ = layout;
        const float speed = std::hypot(s.player.velocity[0], s.player.velocity[1]);
        if (visible && prefs_.edge_glow) draw_edge_glow(speed);
        if (crosshair && prefs_.crosshair_style != "none") draw_crosshair(width, height);
        if (leave_progress >= 0) draw_leave_progress(width, height, leave_progress);
        if (visible || prefs_.hidden_speed_keys) {
            palette_ = prefs_.palette;
            theme_.apply(palette_);
            const bool practising = practice && practice->active;
            draw_map_line(map, style, run.track);
            draw_fps_and_pb(fps);
            draw_timer(run, practising);
            draw_speed(s.player.tick, speed, run, style, practising);
            draw_run_stats(run, style);
            draw_jump_stats(jump_stats, jump_stats_gain);
            if (strafe) draw_strafe_trainer(*strafe, strafe_hints);
            if (prefs_.keys_overlay || editing_) draw_keys();
            draw_health(s.health, weapon);
            if (!notice.empty()) {
                const auto [x, y] = place("notice", frame_width_ / 2, notice_top);
                text(x, y, std::string_view(notice).substr(0, max_notice_bytes), 15, amber, true);
            }
            draw_splits();
            draw_board_place();
            draw_speed_graph();
            element_visible = true;
            element_scale = 1;
            clear_element_style();
            native::draw_movement_widgets(
                    *this,
                    [this](const char *id, float x, float y) { return place(id, x, y); },
                    prefs_,
                    movement,
                    extras,
                    run,
                    frame_width_,
                    frame_height_,
                    practising || editing_,
                    practice ? practice->number() : 0,
                    editing_
            );
            element_visible = true;
            element_scale = 1;
            clear_element_style();
            if (visible && practice && practice->menu_open)
                native::draw_checkpoint_menu(*this, frame_width_, frame_height_, *practice, keep_velocity);
            if (visible) draw_gauntlet(gauntlet_line, gauntlet_delta, gauntlet_good);
            if (visible && playback) {
                const auto [x, y] = place("replay", frame_width_ / 2, replay_banner_top);
                text(x, y, "REPLAY - ESC FOR PLAYBACK CONTROLS", 14, amber, true);
            }
        }
        hidden_ = false;
        flush(width, height);
    }

    // Each element's box, in pixels, from the last draw(); an element that drew nothing has an empty box. The chat
    // box is the "chat" entry after draw_chat_overlay.
    const native::HudRect &drawn_bounds(std::string_view id) const {
        return id == "boardPlace" ? drawn_[board_place_slot] : drawn_[native::hud_index(id)];
    }

    // Each element's box in pixels as last placed: what the layout editor outlines, picks and moves.
    const native::HudRect &layout_box(std::string_view id) const { return layout_boxes_[native::hud_index(id)]; }

    std::array<float, 2> layout_size(std::string_view id) const { return element_size(id); }

    // The layout editor's view: every element drawn, the hidden ones faint.
    void set_editing(bool on) { editing_ = on; }

    bool editing() const { return editing_; }

    // Puts the layout editor's sample values in place of the run's (hud_demo.hpp), and back.
    template <class Demo>
    void swap_demo(Demo &demo) {
        std::swap(extras, demo.extras);
        std::swap(movement, demo.movement);
        std::swap(split_line, demo.split_line);
        std::swap(delta_line, demo.delta_line);
    }

    // The display's scale (CSS pixels to screen pixels), for the crosshair.
    void set_display_scale(float value) {
        if (value == display_scale_) return;
        display_scale_ = value;
        rebuild_crosshair();
    }

private:
    // v0.5.1's places, in HUD units from the screen's edges: the map line at the top left, FPS at the top right, the
    // run column at the bottom centre (timer, speed, stats with the run status above), keys at the bottom left and
    // health at the bottom right. Feedback the player turns on stacks above the run column.
    static constexpr float edge_margin = 26;
    static constexpr float map_top = 18;
    static constexpr float style_below_map = 24;
    static constexpr float fps_from_right = 135;
    static constexpr float fps_top = 20;
    static constexpr float pb_below_fps = 22;
    static constexpr float timer_from_bottom = 154;
    static constexpr float status_above_timer = 32;
    static constexpr float speed_from_bottom = 105;
    static constexpr float run_stats_from_bottom = 68;
    static constexpr float jump_stats_from_bottom = 232;
    static constexpr float jump_stats_line_gap = 21;
    static constexpr float trainer_bottom_from_bottom = 250;
    static constexpr float splits_from_bottom = 350;
    static constexpr float split_line_gap = 22;
    static constexpr float keys_from_bottom = 65;
    static constexpr float health_from_right = 275;
    static constexpr float health_from_bottom = 62;
    static constexpr float graph_from_right = 300;
    static constexpr float graph_from_bottom = 180;
    static constexpr float graph_width = 260;
    static constexpr float graph_height = 80;
    static constexpr float graph_bar_height = 65;
    static constexpr float notice_top = 70;
    static constexpr float replay_banner_top = 22;
    static constexpr float gauntlet_from_bottom = 32;
    static constexpr float gauntlet_delta_from_bottom = 15;
    static constexpr size_t max_notice_bytes = 100;
    static constexpr float timer_size = 34;

    float frame_width_ = 0;
    float frame_height_ = 0;
    const Layout *legacy_layout_ = nullptr;
    native::SemanticPalette palette_;
    native::CrosshairShape crosshair_shape_;
    float display_scale_ = 1;

    // The keys row and the strafe trainer are as big as their settings make them; every other element has a fixed box.
    std::array<float, 2> element_size(std::string_view id) const {
        id = native::canonical_hud_id(id);
        if (id == "keys") return {keys_row_width(), keys_row_height};
        if (id == "strafeTrainer") return {native::TrainerLayout::width, native::trainer_height(prefs_.trainer)};
        return native::hud_element_size(id);
    }

    const std::optional<native::HudPlace> &layout_place(std::string_view id) const {
        return prefs_.layout[native::hud_index(id)];
    }

    bool placed(std::string_view id) const {
        const auto &entry = layout_place(id);
        return entry && entry->placed;
    }

    // Where element `id` goes: its built-in point (x, y) unless the player placed it, then sets it up for drawing.
    std::array<float, 2> place(std::string_view id, float x, float y) {
        if (const auto &entry = layout_place(id); entry && entry->placed) {
            if (entry->anchored) {
                const auto size = element_size(id);
                const auto bounds = entry->rect(frame_width_, frame_height_, size[0], size[1]);
                x = bounds.x + (native::hud_centred(id) ? bounds.width / 2 : 0);
                y = bounds.y + (id == "crosshair" ? bounds.height / 2 : 0);
            } else {
                // v0.5.1's editor: the element's own point, in percent of the screen.
                x = entry->x / 100 * frame_width_;
                y = entry->y / 100 * frame_height_;
            }
        } else if (legacy_layout_) {
            const auto found = legacy_layout_->find(std::string(id));
            if (found != legacy_layout_->end()) {
                x = found->second[0] / 100 * frame_width_;
                y = found->second[1] / 100 * frame_height_;
            }
        }
        element(id, x, y);
        note_layout_box(id, x, y);
        return {x, y};
    }

    void note_layout_box(std::string_view id, float x, float y) {
        const auto size = element_size(id);
        const float width = size[0] * element_scale, height = size[1] * element_scale;
        const float left = native::hud_centred(id) ? x - width / 2 : x;
        layout_boxes_[native::hud_index(id)] = {left * scale, y * scale, width * scale, height * scale};
    }

    void draw_edge_glow(float speed) {
        constexpr float glow_from_speed = 600;
        constexpr float glow_full_speed_span = 800;
        constexpr unsigned strips = 8;
        constexpr float strip_width = 5;
        constexpr float strip_alpha = .05f;
        const float intensity = std::clamp((speed - glow_from_speed) / glow_full_speed_span, 0.f, 1.f);
        const float w = frame_width_, h = frame_height_;
        for (unsigned strip = 0; strip < strips; ++strip) {
            const float inset = float(strip) * strip_width;
            const Color glow = {.3f, .65f, 1, intensity * strip_alpha * (1 - float(strip) / strips)};
            rect(inset, 0, strip_width, h, glow);
            rect(w - inset - strip_width, 0, strip_width, h, glow);
            rect(0, inset, w, strip_width, glow);
            rect(0, h - inset - strip_width, w, strip_width, glow);
        }
    }

    void rebuild_crosshair() {
        crosshair_shape_.build(
                prefs_.crosshair_style,
                prefs_.crosshair_size,
                prefs_.crosshair_gap,
                prefs_.crosshair_thickness,
                prefs_.crosshair_outline,
                display_scale_
        );
    }

    // The crosshair's middle in whole pixels: the screen's middle, or the middle of the place the player gave it.
    std::array<int, 2> crosshair_centre_px(int width, int height) {
        const auto [x, y] = place("crosshair", frame_width_ / 2, frame_height_ / 2);
        if (!placed("crosshair") && !legacy_layout_)
            return {native::CrosshairShape::centre_px(width), native::CrosshairShape::centre_px(height)};
        return {int(std::floor(x * scale)), int(std::floor(y * scale))};
    }

    // Drawn in screen pixels, not HUD units: the crosshair keeps the website's size at any HUD scale. The runs
    // never overlap, so the opacity setting fades the whole crosshair the way the website's does.
    void draw_crosshair(int width, int height) {
        constexpr float outline_alpha = .85f;
        const auto [centre_x, centre_y] = crosshair_centre_px(width, height);
        element_scale = 1;
        Color fill = prefs_.crosshair_color;
        const Color outline = {0, 0, 0, outline_alpha * fill[3]};
        for (const auto &run : crosshair_shape_.runs()) {
            rect(float(centre_x + run.x) / scale,
                 float(centre_y + run.y) / scale,
                 float(run.width) / scale,
                 1 / scale,
                 run.outline ? outline : fill);
        }
    }

    void draw_leave_progress(int width, int height, float progress) {
        constexpr int ring_dots = 48;
        constexpr float ring_radius = 26;
        constexpr float dot_size = 4;
        constexpr float full_turn = 6.2831853f;
        constexpr float start_at_top = -1.5707963f;
        const auto [centre_x, centre_y] = crosshair_centre_px(width, height);
        const float x = float(centre_x) / scale, y = float(centre_y) / scale;
        for (int i = 0; i < ring_dots; ++i) {
            const float angle = float(i) / ring_dots * full_turn + start_at_top;
            const Color color = float(i) / ring_dots <= progress ? amber : dim;
            rect(x + std::cos(angle) * ring_radius - dot_size / 2,
                 y + std::sin(angle) * ring_radius - dot_size / 2,
                 dot_size,
                 dot_size,
                 color);
        }
    }

    // v0.5.1: the map, and under it the style in the accent colour.
    void draw_map_line(std::string_view map, std::string_view style, unsigned track) {
        const auto [x, y] = place("map", edge_margin, map_top);
        native::HudLabel<128> label;
        label.assign(style);
        if (track) {
            native::HudLabel<32> bonus;
            bonus.format(" / BONUS %u", track);
            label.append(bonus.view());
        }
        text(x, y, map, 17, cream);
        text(x, y + style_below_map, label.view(), 14, amber);
    }

    void draw_fps_and_pb(double fps) {
        const float w = frame_width_;
        const auto &fps_place = layout_place("fps");
        const bool fps_shown = !fps_place || fps_place->visible || editing_;
        {
            const auto [x, y] = place("fps", w - fps_from_right, fps_top);
            native::HudLabel<32> label;
            label.format("%.0f FPS", fps);
            text(x, y, label.view(), 14, dim);
        }
        if (extras.pb.empty()) return;
        // The best time sits under the FPS counter, or in its place when the counter is off.
        const auto [x, y] = place("pb", w - fps_from_right, fps_top + (fps_shown ? pb_below_fps : 0));
        text(x, y, extras.pb.view(), 13, dim);
    }

    // The run status ("IN START", "READY") sits over the timer, as in v0.5.1, and follows it unless it has a place
    // of its own.
    void draw_timer(const BhRunState &run, bool practising) {
        const float w = frame_width_, h = frame_height_;
        const auto [x, y] = place("timer", w / 2, h - timer_from_bottom);
        native::HudLabel<48> time;
        native::format_hud_time(time, run.seconds);
        const Color color = (run.status == 2 || practising) ? amber : cream;
        text(x, y, time.view(), timer_size, color, true);
        draw_status(run, x, y - status_above_timer);
    }

    void draw_status(const BhRunState &run, float x, float y) {
        if (run.status == 1 && !editing_) return;
        const auto [status_x, status_y] = place("status", x, y);
        if (run.status != 2) text(status_x, status_y, run.in_start ? "IN START" : "READY", 13, amber, true);
        if (run.status == 2) text(status_x, status_y, "FINISHED", 15, amber, true);
    }

    void draw_speed(uint32_t tick, float speed, const BhRunState &run, std::string_view style, bool practising) {
        constexpr double gain_shown_seconds = .45;
        constexpr float gain_left = 100;
        constexpr float gain_rise_per_tick = .25f;
        constexpr float perfect_left = 75;
        constexpr float perfect_below = 14;
        const auto [x, y] = place("speed", frame_width_ / 2, frame_height_ - speed_from_bottom);
        native::HudLabel<32> label;
        label.format("%.0f u/s", speed);
        const Color color = !prefs_.speed_colors ? cream
                            : speed > 800        ? palette_.loss
                            : speed > 500        ? palette_.sync
                            : speed > 270        ? palette_.gain
                                                 : cream;
        text(x, y, label.view(), 25, color, true);
        if (prefs_.gain_ticks && movement.gain_tick && tick >= movement.gain_tick
            && (tick - movement.gain_tick) * movement.tick_interval < gain_shown_seconds) {
            const float rise = float(tick - movement.gain_tick) * gain_rise_per_tick;
            text(x + gain_left,
                 y - 10 - rise,
                 native::jump_gain_text(movement.gain_delta).view(),
                 16,
                 movement.gain_delta > 0 ? palette_.gain : palette_.loss);
        }
        if (prefs_.perfect_indicator
            && native::perfect_hop_visible(std::string(style), run, tick, movement.tick_interval, practising))
            text(x + perfect_left, y + perfect_below, "Perfect", 12, native::semantic_rgb(0xffffff, .7f));
    }

    void draw_run_stats(const BhRunState &run, std::string_view style) {
        const auto [x, y] = place("runStats", frame_width_ / 2, frame_height_ - run_stats_from_bottom);
        native::HudLabel<160> label;
        if (native::scroll_style(std::string(style)) && prefs_.perf_hud)
            label.format(
                    "%u jumps  %u strafes  %.1f%% sync  %s",
                    run.jumps,
                    run.strafes,
                    run.sync_percent,
                    native::perf_text(run).bytes.data()
            );
        else
            label.format("%u jumps  %u strafes  %.1f%% sync", run.jumps, run.strafes, run.sync_percent);
        text(x, y, label.view(), 13, dim, true);
    }

    // Jump stats sit above the run status, clear of the timer and speed. The colour follows the gain bands.
    void draw_jump_stats(std::string_view stats, std::optional<float> gain) {
        if (stats.empty()) return;
        const auto [x, y] = place("jumpStats", frame_width_ / 2, frame_height_ - jump_stats_from_bottom);
        const auto newline = stats.find('\n');
        const Color color = jump_stats_color(gain);
        text(x, y, stats.substr(0, newline), 14, color, true);
        if (newline != std::string_view::npos)
            text(x, y + jump_stats_line_gap, stats.substr(newline + 1), 12, color, true);
    }

    // Above the jump stats; its bottom stays put whatever style and height the trainer has.
    void draw_strafe_trainer(const native::StrafeReading &reading, bool hints) {
        const float height = native::trainer_height(prefs_.trainer);
        const float bottom = frame_height_ - trainer_bottom_from_bottom;
        const auto [x, y] = place("strafeTrainer", frame_width_ / 2, bottom - height);
        native::draw_trainer(*this, x, y, reading, prefs_.trainer, hints, palette_);
    }

    void draw_splits() {
        const std::string_view shown_delta = delta_line.empty() ? extras.ghost_delta.view() : delta_line;
        if (split_line.empty() && shown_delta.empty()) return;
        const auto [x, y] = place("splits", frame_width_ / 2, frame_height_ - splits_from_bottom);
        if (!split_line.empty()) text(x, y, split_line, 14, cream, true);
        if (shown_delta.empty()) return;
        const bool good = delta_line.empty() ? shown_delta.front() == '-' : delta_good;
        text(x,
             split_line.empty() ? y : y + split_line_gap,
             shown_delta,
             13,
             good ? palette_.gain : palette_.loss,
             true);
    }

    // "#4 | top 3%" right of the timer, as the website puts it beside the split.
    void draw_board_place() {
        constexpr float beside_timer = 175;
        constexpr float timer_line_from_bottom = 141;
        if (prefs_.place == "off" || extras.place.empty()) return;
        auto shown = extras.place.view();
        if (prefs_.place == "place") shown = shown.substr(0, shown.find(" \xC2\xB7"));
        const float x = frame_width_ / 2 + beside_timer, y = frame_height_ - timer_line_from_bottom;
        // The split's box is the split's: the place line only borrows its visibility and placement.
        const auto split_box = layout_boxes_[native::hud_index("splits")];
        const auto [place_x, place_y] = place("splits", x, y);
        layout_boxes_[native::hud_index("splits")] = split_box;
        drawn_index_ = board_place_slot;
        // Placed, it goes under the split's two lines, as the website shows it with the split.
        text(place_x, placed("splits") ? place_y + 2 * split_line_gap : place_y, shown, 13, dim, true);
    }

    // Nothing to draw while standing still: an empty graph would just be a dark box.
    void draw_speed_graph() {
        if (!(prefs_.speed_graph || editing_)) return;
        constexpr float slowest_peak = 500;
        constexpr float bar_width = 1.2f;
        constexpr float still_speed = 1;
        float fastest = 0;
        for (const auto &[tick, value] : speed_history)
            fastest = std::max(fastest, value);
        if (fastest < still_speed && !editing_) return;
        const auto [x, y] = place("speedGraph", frame_width_ - graph_from_right, frame_height_ - graph_from_bottom);
        rect(x, y, graph_width, graph_height, {.03f, .03f, .05f, .6f});
        const float peak = std::max(slowest_peak, fastest);
        const float step = graph_width / float(speed_history_capacity);
        constexpr float graph_floor = 75;
        const float floor_y = y + graph_floor;
        for (size_t i = 0; i < speed_history.size(); ++i) {
            const float bar = speed_history[i].second / peak * graph_bar_height;
            rect(x + float(i) * step, floor_y - bar, bar_width, bar, amber);
        }
    }

    // v0.5.1: "HP 100  AMMO 12/36" at the bottom right.
    void draw_health(float health, const BhWeaponReport &weapon) {
        const auto [x, y] = place("health", frame_width_ - health_from_right, frame_height_ - health_from_bottom);
        native::HudLabel<64> label;
        if (weapon.clip_size)
            label.format("HP %.0f  AMMO %u/%u", health, weapon.clip, weapon.clip_size);
        else
            label.format("HP %.0f", health);
        text(x, y, label.view(), 14, cream);
    }

    void draw_gauntlet(const std::string &line, const std::string &delta, bool good) {
        if (line.empty()) return;
        constexpr Color gauntlet_ahead{.47f, .9f, .47f, 1};
        const float x = frame_width_ / 2;
        text(x, frame_height_ - gauntlet_from_bottom, line, 13, cream, true);
        if (!delta.empty())
            text(x, frame_height_ - gauntlet_delta_from_bottom, delta, 12, good ? gauntlet_ahead : amber, true);
    }

    static constexpr std::array<uint32_t, 8> key_bits = {
            native::forward, native::left, native::back, native::right, native::jump, native::duck, 0, 0
    };
    // key_until_ slots: the six keys in prefs_.key_labels order (forward, left, back, right, duck, jump), then the
    // two turn arrows.
    static constexpr std::array<size_t, 8> key_flash_slot = {0, 1, 2, 3, 5, 4, 6, 7};

    bool key_pressed(size_t i) const {
        const size_t slot = key_flash_slot[i];
        if (i >= 6) return key_until_[slot] > keys_tick_;
        return ((keys_latest_ | keys_edges_) & key_bits[i]) || key_until_[slot] > keys_tick_;
    }

    bool key_row_shown(size_t i) const {
        const size_t row = i < 4 ? 0 : i < 6 ? 1 : 2;
        return prefs_.keys_rows[row];
    }

    std::string_view key_text(size_t i) const {
        if (i == 6) return "<";
        if (i == 7) return ">";
        return prefs_.key_labels[key_flash_slot[i]];
    }

    struct KeyLook {
        Color box;
        Color label;
        std::optional<Color> cap;
    };

    KeyLook key_look(bool pressed) const {
        constexpr Color idle_box{.05f, .05f, .07f, .6f};
        constexpr Color pressed_label{.08f, .07f, .06f, 1};
        constexpr Color idle_cap{.4f, .4f, .43f, 1};
        constexpr float pressed_box_alpha = .85f;
        constexpr float pressed_cap_shade = .6f;
        const float opacity = prefs_.keys_opacity;
        const bool minimal = prefs_.keys_style == "minimal";
        auto pressed_color = prefs_.keys_pressed;
        KeyLook look;
        look.box = pressed ? Color{pressed_color[0], pressed_color[1], pressed_color[2], pressed_box_alpha * opacity}
                           : Color{idle_box[0], idle_box[1], idle_box[2], idle_box[3] * opacity};
        look.label = minimal   ? (pressed ? pressed_color : prefs_.keys_idle)
                     : pressed ? pressed_label
                               : prefs_.keys_idle;
        look.label[3] *= opacity;
        if (minimal) look.box[3] = 0;
        if (prefs_.keys_style == "keycaps") {
            Color cap = pressed ? Color{pressed_color[0] * pressed_cap_shade,
                                        pressed_color[1] * pressed_cap_shade,
                                        pressed_color[2] * pressed_cap_shade,
                                        opacity}
                                : Color{idle_cap[0], idle_cap[1], idle_cap[2], opacity};
            look.cap = cap;
        }
        return look;
    }

    void draw_key(float left, float top, float width, float height, std::string_view label, float size, bool pressed) {
        constexpr float cap_inset = 2;
        constexpr float cap_height = 2;
        const KeyLook look = key_look(pressed);
        if (look.box[3] > 0) rect(left, top, width, height, look.box);
        if (look.cap)
            rect(left + cap_inset, top + height - cap_height - 1, width - 2 * cap_inset, cap_height, *look.cap);
        const float label_top = top + (height - size * atlas_height_per_size) / 2;
        text(left + width / 2, label_top, label, size, look.label, true);
    }

    static constexpr float keys_row_height = 27;
    static constexpr float key_gap = 4;
    static constexpr float key_label_size = 14;

    float key_width(size_t i) const {
        constexpr float narrowest_key = 28;
        constexpr float label_padding = 10;
        const float label = float(key_text(i).size()) * key_label_size * atlas_advance_per_size;
        return std::max(narrowest_key, label + label_padding);
    }

    float keys_row_width() const {
        float width = 0;
        for (size_t i = 0; i < key_bits.size(); ++i) {
            if (key_row_shown(i)) width += key_width(i) + key_gap;
        }
        return std::max(key_gap, width - key_gap);
    }

    // v0.5.1: one row of keys at the bottom left, W A S D then jump and duck, then the turn arrows.
    void draw_keys_row(float x, float y) {
        for (size_t i = 0; i < key_bits.size(); ++i) {
            if (!key_row_shown(i)) continue;
            const float width = key_width(i);
            draw_key(x, y, width, keys_row_height, key_text(i), key_label_size, key_pressed(i));
            x += width + key_gap;
        }
    }

    void draw_keys() {
        const auto [x, y] = place("keys", edge_margin, frame_height_ - keys_from_bottom);
        draw_keys_row(x, y);
        keys_edges_ = 0;
    }

    void flush(int width, int height) {
        gl.Disable(GL_DEPTH_TEST);
        gl.DepthMask(GL_FALSE);
        gl.Disable(GL_CULL_FACE);
        gl.Enable(GL_BLEND);
        gl.BlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
        gl.UseProgram(program);
        const float viewport[3] = {float(width), float(height), 0};
        gl.Uniform3fv(gl.GetUniformLocation(program, "viewport"), 1, viewport);
        gl.Uniform1i(gl.GetUniformLocation(program, "font"), 0);
        gl.ActiveTexture(GL_TEXTURE0);
        gl.BindTexture(GL_TEXTURE_2D, atlas);
        gl.BindVertexArray(vao);
        gl.BindBuffer(GL_ARRAY_BUFFER, vbo);
        gl.BufferData(GL_ARRAY_BUFFER, vertices.size() * sizeof(float), vertices.data(), GL_STREAM_DRAW);
        for (const auto &batch : batches) {
            gl.BindTexture(GL_TEXTURE_2D, batch.texture);
            gl.DrawArrays(GL_TRIANGLES, GLint(batch.first), GLsizei(batch.count));
        }
        gl.DepthMask(GL_TRUE);
        gl.Enable(GL_DEPTH_TEST);
    }
};
}  // namespace native
