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
        Raster result{0, bitmap.width, bitmap.height, pixels, tabular, raster_batch_};
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
    int turn_direction_ = 1;
    bool hidden_ = false;
    float element_shift_x_ = 0;
    float element_shift_y_ = 0;

    float element_x(float x) const { return pivot_x + (x - pivot_x) * element_scale + element_shift_x_; }

    float element_y(float y) const { return pivot_y + (y - pivot_y) * element_scale + element_shift_y_; }

    bool element_visible = true;
    float element_scale = 1, pivot_x = 0, pivot_y = 0;
    native::HudSamples<std::pair<uint32_t, float>, 250> speed_history;
    float jump_speed = 0, gain_delta = 0;
    uint32_t gain_tick = 0;
    bool have_jump = false;
    std::string split_line, delta_line;
    bool delta_good = false;

    void element(std::string_view id, float x, float y) {
        element_visible = true;
        element_scale = 1;
        pivot_x = x;
        pivot_y = y;
        const size_t index = native::hud_index(id);
        if (const auto &place = prefs_.layout[index]) {
            element_visible = place->visible;
            element_scale = place->scale;
        }
        if (hidden_ && (!prefs_.hidden_speed_keys || (id != "speed" && id != "keys"))) element_visible = false;
        const auto &style = element_styles_[index];
        element_alpha = style.opacity;
        element_color = style.color;
    }

    void clear_element_style() {
        element_alpha = 1;
        element_color.reset();
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
        if (!gain) return dim;
        if (!prefs_.jump_stats_colors) return *gain >= native::good_gain ? amber : dim;
        switch (native::gain_band(*gain)) {
            case native::GainBand::red:
                return {1, 0, 0, 1};  // #FF0000
            case native::GainBand::orange:
                return {1, 165.f / 255, 0, 1};  // #FFA500
            case native::GainBand::green:
                return {0, 1, 0, 1};  // #00FF00
            case native::GainBand::blue:
                return {0, 1, 1, 1};  // #00FFFF
            case native::GainBand::white:
                return {1, 1, 1, 1};  // #FFFFFF
        }
        return dim;
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
        if (batches.empty() || batches.back().texture != current_texture)
            batches.push_back({current_texture, vertices.size() / 8, 0});
        batches.back().count += 6;
        for (const auto &p : points)
            vertices.insert(vertices.end(), {p[0] * scale, p[1] * scale, p[2], p[3], c[0], c[1], c[2], c[3]});
    }

    // u = -2 marks a solid fill. The shader tests u < -1 so a text quad whose u lands a hair below 0 at its left edge
    // still samples the texture.
    void rect(float x, float y, float w, float h, Color c) { quad(x, y, w, h, -2, -2, 0, 0, c); }

    void text(float x, float y, std::string_view value, float size, Color color, bool center = false) {
        if (!element_visible) return;
        color = themed_text(color);
        if (const auto *glyphs = raster(value, size, true)) {
            const float ratio = scale * element_scale;
            const float width = glyphs->width / ratio, height = glyphs->height / ratio;
            if (center) x -= width * .5f;
            current_texture = glyphs->texture;
            quad(x + 1, y + 1, width, height, 0, 0, 1, 1, {0, 0, 0, .85f});
            quad(x, y, width, height, 0, 0, 1, 1, color);
            current_texture = atlas;
            return;
        }
        // The small atlas is ASCII. Fold common UI punctuation and emit one
        // fallback per unsupported code point, not one per UTF-8 byte.
        const float advance = size * .6f;
        if (center) x -= float(value.size()) * advance * .5f;
        for (size_t i = 0; i < value.size();) {
            unsigned char character = value[i++];
            if (character >= 128) {
                while (i < value.size() && (uint8_t(value[i]) & 0xc0) == 0x80)
                    ++i;
                character = '?';
            }
            if (character < 32 || character > 126) character = ' ';
            const unsigned index = character - 32;
            const float u = (index % 16) * 40.f / 640;
            const float v = (index / 16) * 52.f / 312;
            quad(x + 1, y + 1, size, size * 1.3f, u, v, 40.f / 640, 52.f / 312, {0, 0, 0, .85f});
            quad(x, y, size, size * 1.3f, u, v, 40.f / 640, 52.f / 312, color);
            x += advance;
        }
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
        const auto &fields = prefs_.ssj_fields;
        native::HudLabel<128> part;
        ssj_line_.format("Jump %u", report.jump);
        if (fields.speed) {
            part.format(" | %d u/s", report.speed);
            ssj_line_.append(part.view());
        }
        if (fields.diff && report.diff) {
            part.format(" (%+d)", *report.diff);
            ssj_line_.append(part.view());
        }
        ssj_line_.append("\n");
        if (fields.gain && report.gain) {
            part.format("Gain %.1f%%  ", std::trunc(double(*report.gain) * 10) / 10);
            ssj_line_.append(part.view());
        }
        if (fields.sync && report.sync) {
            part.format("Sync %.0f%%  ", std::trunc(*report.sync));
            ssj_line_.append(part.view());
        }
        if (fields.strafes && report.strafes) {
            part.format("%u str  ", *report.strafes);
            ssj_line_.append(part.view());
        }
        if (fields.eff && report.eff) {
            part.format("Eff %.0f%%  ", std::trunc(*report.eff));
            ssj_line_.append(part.view());
        }
        if (fields.height && report.height) {
            part.format("Height %+d  ", *report.height);
            ssj_line_.append(part.view());
        }
        if (fields.time && report.time) {
            part.format("%.3fs  ", *report.time);
            ssj_line_.append(part.view());
        }
        if (fields.start_pre && !movement.start_pre.empty()) ssj_line_.append(movement.start_pre.view());
        ssj_chat_line_ = ssj_line_;
        for (char &character : ssj_chat_line_.bytes) {
            if (character == '\n') character = ' ';
        }
        ssj_pending_ = prefs_.ssj_chat;
    }

    void publish_movement_chat(native::Chat &chat, double now) {
        if (ssj_pending_) chat.push(std::string(ssj_chat_line_.view()), "", "system", now);
        if (movement.new_first && prefs_.first_jump_chat)
            chat.push(std::string(movement.first_jump.view()), "", "system", now);
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
                turn_direction_ = -1;
            }
            if (delta < 0) {
                key_until_[7] = tick + 3;
                turn_direction_ = 1;
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

    void reset_history() {
        ssj_line_.assign("");
        ssj_pending_ = false;
        movement.reset();
        result.reset();
        keys_latest_ = keys_edges_ = 0;
        have_keys_yaw_ = false;
        speed_history.clear();
        have_jump = false;
        gain_tick = 0;
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
        if (s.events & native::teleported) {
            have_jump = false;
            gain_tick = 0;
        }
        if ((s.events & native::jump) && (speed_history.empty() || s.tick != speed_history.back().first)) {
            const float speed = std::hypot(s.velocity[0], s.velocity[1]);
            if (have_jump) {
                gain_delta = speed - jump_speed;
                gain_tick = s.tick;
            }
            jump_speed = speed;
            have_jump = true;
        }
        if (speed_history.empty() || s.tick != speed_history.back().first)
            speed_history.emplace_back(s.tick, std::hypot(s.velocity[0], s.velocity[1]));
        while (speed_history.size() > 250)
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
        const float advance = size * .6f;
        const auto *bitmap = raster(value, size, true);
        const float name_width = bitmap ? bitmap->width / (scale * element_scale) : float(value.size()) * advance;
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
            // Clip the shaped name to preserve joining and ligatures across gradient slices.
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
        const float h = height / scale, w = width / scale, box = std::min(680.f, w - 40), font = 14, step = 30;
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
            const size_t maximum = size_t(std::max(1.f, std::min(14.f, (h - 230) / step)));
            if (rows.size() > maximum) rows.erase(rows.begin(), rows.end() - maximum);
        }
        const float top = h - 110 - float(rows.size()) * step - (typing ? 70.f : 0.f);
        const auto &place = prefs_.layout[native::hud_index("chat")];
        if (place) {
            const float box_height = float(rows.size()) * step + (typing ? 75.f : 0.f) + 18;
            const auto bounds = place->rect(w, h, box, box_height);
            pivot_x = 16;
            pivot_y = top - 10;
            element_scale = place->scale;
            element_shift_x_ = bounds.x - pivot_x;
            element_shift_y_ = bounds.y - pivot_y;
            element_visible = typing || place->visible;
        }
        if (!rows.empty() || typing)
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
        const native::HudGeometry geometry(width, height, hud_percent);
        scale = geometry.scale;
        const float w = geometry.width, h = geometry.height;
        // HUD units are 1/900 of the screen height (above 540 px), so the
        // built-in places below are the same fraction of the screen at any size.
        if (visible && prefs_.edge_glow) {
            const float speed = std::hypot(s.player.velocity[0], s.player.velocity[1]);
            const float intensity = std::clamp((speed - 600) / 800, 0.f, 1.f);
            for (unsigned strip = 0; strip < 8; ++strip) {
                const float inset = float(strip) * 5;
                const Color glow = {.3f, .65f, 1, intensity * .05f * (1 - float(strip) / 8)};
                rect(inset, 0, 5, h, glow);
                rect(w - inset - 5, 0, 5, h, glow);
                rect(0, inset, w, 5, glow);
                rect(0, h - inset - 5, w, 5, glow);
            }
        }
        auto at = [&](const char *id, float x, float y) -> std::array<float, 2> {
            const auto &place = prefs_.layout[native::hud_index(id)];
            if (place) {
                const bool centered = std::string_view(id) != "map" && std::string_view(id) != "fps"
                                      && std::string_view(id) != "keys" && std::string_view(id) != "health"
                                      && std::string_view(id) != "speedGraph" && std::string_view(id) != "spectators";
                const auto size = native::hud_element_size(id);
                const auto bounds = place->rect(w, h, size[0], size[1]);
                x = bounds.x + (centered ? size[0] * place->scale / 2 : 0);
                y = bounds.y;
            } else if (layout) {
                const auto found = layout->find(id);
                if (found != layout->end()) {
                    x = found->second[0] / 100 * w;
                    y = found->second[1] / 100 * h;
                }
            }
            element(id, x, y);
            return {x, y};
        };
        if (crosshair && prefs_.crosshair_style != "none") {
            const auto [x, y] = at("crosshair", w / 2, h / 2);
            const Color color = prefs_.crosshair_color;
            const auto &style = prefs_.crosshair_style;
            const float n = prefs_.crosshair_size;
            const float gap = prefs_.crosshair_gap;
            const float t = prefs_.crosshair_thickness;
            auto stroke = [&](float a, float b, float c, float d) {
                if (prefs_.crosshair_outline) rect(a - 1, b - 1, c + 2, d + 2, {0, 0, 0, color[3]});
                rect(a, b, c, d, color);
            };
            if (style == "circle") {
                for (int i = 0; i < 64; ++i) {
                    const double a = i * 6.283185307 / 64;
                    stroke(
                            x + float(std::cos(a)) * (gap + n) - t / 2, y + float(std::sin(a)) * (gap + n) - t / 2, t, t
                    );
                }
            } else if (style != "dot") {
                stroke(x - gap - n, y - t / 2, n, t);
                stroke(x + gap, y - t / 2, n, t);
                if (style != "t") stroke(x - t / 2, y - gap - n, t, n);
                stroke(x - t / 2, y + gap, t, n);
            }
            if (style == "dot" || style == "cross-dot") stroke(x - t / 2, y - t / 2, t, t);
        }
        if (leave_progress >= 0) {
            const auto [x, y] = at("crosshair", w / 2, h / 2);
            for (int i = 0; i < 48; ++i) {
                const float a = float(i) / 48 * 6.2831853f - 1.5707963f;
                rect(x + std::cos(a) * 26 - 2,
                     y + std::sin(a) * 26 - 2,
                     4,
                     4,
                     float(i) / 48 <= leave_progress ? amber : dim);
            }
        }
        if (visible || prefs_.hidden_speed_keys) {
            auto palette = prefs_.palette;
            theme_.apply(palette);
            {
                const auto [x, y] = at("map", 26, 18);
                text(x, y, map, 17, cream);
                native::HudLabel<128> label;
                label.assign(style);
                if (run.track) {
                    native::HudLabel<32> bonus;
                    bonus.format(" / BONUS %u", run.track);
                    label.append(bonus.view());
                }
                text(x, y + 24, label.view(), 14, amber);
            }
            char buf[160];
            {
                const auto [x, y] = at("fps", w - 135, 20);
                std::snprintf(buf, sizeof(buf), "%.0f FPS", fps);
                text(x, y, buf, 14, dim);
            }
            {
                const auto [x, y] = at("timer", w / 2, h - 154);
                native::HudLabel<48> time;
                native::format_hud_time(time, run.seconds);
                text(x, y, time.view(), 20, (run.status == 2 || (practice && practice->active)) ? amber : cream, true);
            }
            {
                const auto [x, y] = at("speed", w / 2, h - 105);
                std::snprintf(buf, sizeof(buf), "%.0f u/s", std::hypot(s.player.velocity[0], s.player.velocity[1]));
                const double speed = std::hypot(s.player.velocity[0], s.player.velocity[1]);
                const Color speedColor = !prefs_.speed_colors ? cream
                                         : speed > 800        ? palette.loss
                                         : speed > 500        ? palette.sync
                                         : speed > 270        ? palette.gain
                                                              : cream;
                text(x, y, buf, 25, speedColor, true);
                if (prefs_.gain_ticks && gain_tick && s.player.tick >= gain_tick && s.player.tick - gain_tick < 70) {
                    char gain[32];
                    std::snprintf(gain, sizeof(gain), "%+.0f", gain_delta);
                    text(x + 100,
                         y - 10 - float(s.player.tick - gain_tick) * .25f,
                         gain,
                         16,
                         gain_delta >= 0 ? palette.gain : palette.loss);
                }
                if (native::scroll_style(style) && prefs_.perfect_indicator && run.last_perfect_tick >= 0
                    && s.player.tick >= uint32_t(run.last_perfect_tick)
                    && s.player.tick - uint32_t(run.last_perfect_tick) < 35)
                    text(x - 160, y + 5, "PERFECT", 12, amber);
            }
            {
                const auto [x, y] = at("runStats", w / 2, h - 68);
                if (native::scroll_style(style) && prefs_.perf_hud)
                    std::snprintf(
                            buf,
                            sizeof(buf),
                            "%u jumps  %u strafes  %.1f%% sync  %.1f%% perf",
                            run.jumps,
                            run.strafes,
                            run.sync_percent,
                            run.perf_percent
                    );
                else
                    std::snprintf(
                            buf,
                            sizeof(buf),
                            "%u jumps  %u strafes  %.1f%% sync",
                            run.jumps,
                            run.strafes,
                            run.sync_percent
                    );
                text(x, y, buf, 13, dim, true);
            }
            // Jump stats sit above the run status, clear of the timer and speed.
            // The accent marks a gain the plugin would call good.
            if (!jump_stats.empty()) {
                const auto [x, y] = at("jumpStats", w / 2, h - 222);
                const auto newline = jump_stats.find('\n');
                text(x, y, jump_stats.substr(0, newline), 14, jump_stats_color(jump_stats_gain), true);
                if (newline != std::string_view::npos)
                    text(x, y + 21, jump_stats.substr(newline + 1), 12, jump_stats_color(jump_stats_gain), true);
            }
            // Strafe trainer above that: the percentage, a bar whose centre line
            // is 100% (either end being 0% and 200%), and a hint under the bar.
            if (strafe) {
                const auto [x, y] = at("strafeTrainer", w / 2, h - 276);
                native::draw_trainer(*this, x, y, *strafe, prefs_.trainer, strafe_hints, palette, turn_direction_);
            }
            {
                const auto [x, y] = at("status", w / 2, h - 186);
                if (run.status == 0) text(x, y, run.in_start ? "IN START" : "READY", 13, amber, true);
                if (run.status == 2) text(x, y, "FINISHED", 15, amber, true);
            }
            if (prefs_.keys_overlay) {
                const auto [x, y] = at("keys", 26, h - 138);
                draw_keys(x, y);
            }
            if (weapon.clip_size) {
                const auto [x, y] = at("health", w - 160, h - 62);
                std::snprintf(buf, sizeof(buf), "%u / %u", weapon.clip, weapon.clip_size);
                text(x, y, buf, 18, cream);
            }
            if (!notice.empty()) {
                const auto [x, y] = at("notice", w / 2, 70);
                text(x, y, std::string_view(notice).substr(0, 100), 15, amber, true);
            }
            const std::string_view shown_delta = delta_line.empty() ? extras.ghost_delta.view() : delta_line;
            if (!split_line.empty() || !shown_delta.empty()) {
                const auto [x, y] = at("splits", w / 2, h - 330);
                if (!split_line.empty()) text(x, y, split_line, 14, cream, true);
                if (!shown_delta.empty()) {
                    const bool good = delta_line.empty() ? shown_delta.front() == '-' : delta_good;
                    text(x, split_line.empty() ? y : y + 22, shown_delta, 13, good ? palette.gain : palette.loss, true);
                }
            }
            if (prefs_.speed_graph && !speed_history.empty()) {
                const auto [x, y] = at("speedGraph", w - 300, h - 180);
                rect(x, y, 260, 80, {.03f, .03f, .05f, .6f});
                float peak = 500;
                for (const auto &[tick, v] : speed_history)
                    peak = std::max(peak, v);
                for (size_t i = 0; i < speed_history.size(); ++i) {
                    const float bar = speed_history[i].second / peak * 65;
                    rect(x + float(i) * 260 / 250, y + 75 - bar, 1.2f, bar, amber);
                }
            }
            element_visible = true;
            element_scale = 1;
            clear_element_style();
            native::draw_movement_widgets(
                    *this,
                    at,
                    prefs_,
                    movement,
                    extras,
                    run,
                    w,
                    h,
                    practice && practice->active,
                    practice ? practice->number() : 0
            );
            if (visible && practice && practice->menu_open) {
                element_visible = true;
                element_scale = 1;
                clear_element_style();
                native::draw_checkpoint_menu(*this, w, h, *practice, keep_velocity);
            }
            if (visible && !gauntlet_line.empty()) {
                text(w / 2, h - 32, gauntlet_line, 13, cream, true);
                if (!gauntlet_delta.empty())
                    text(w / 2, h - 15, gauntlet_delta, 12, gauntlet_good ? Color{.47f, .9f, .47f, 1} : amber, true);
            }
            if (visible && playback) {
                const auto [x, y] = at("replay", w / 2, 22);
                text(x, y, "REPLAY - ESC FOR PLAYBACK CONTROLS", 14, amber, true);
            }
        }
        hidden_ = false;
        flush(width, height);
    }

private:
    void draw_keys(float x, float y) {
        constexpr std::array<uint32_t, 8> bits = {
                native::forward, native::left, native::back, native::right, native::duck, native::jump, 0, 0
        };
        constexpr std::array<float, 8> horizontal = {26, 0, 26, 52, 0, 40, 0, 40};
        constexpr std::array<float, 8> vertical = {0, 23, 23, 23, 46, 46, 69, 69};
        for (size_t i = 0; i < bits.size(); ++i) {
            const size_t row = i < 4 ? 0 : i < 6 ? 1 : 2;
            if (!prefs_.keys_rows[row]) continue;
            const bool pressed = i < 6 ? (((keys_latest_ | keys_edges_) & bits[i]) || key_until_[i] > keys_tick_)
                                       : key_until_[i] > keys_tick_;
            auto color = pressed ? prefs_.keys_pressed : prefs_.keys_idle;
            color[3] *= prefs_.keys_opacity;
            const float left = x + horizontal[i];
            const float top = y + vertical[i];
            const float width = i < 4 ? 22 : 38;
            if (prefs_.keys_style != "minimal") {
                rect(left, top, width, 19, {.04f, .045f, .06f, .75f * prefs_.keys_opacity});
                if (pressed) rect(left + 1, top + 1, width - 2, 16, {color[0], color[1], color[2], .25f * color[3]});
                if (prefs_.keys_style == "keycaps") rect(left + 2, top + 17, width - 4, 1, color);
            }
            const std::string_view label = i < 6 ? std::string_view(prefs_.key_labels[i]) : i == 6 ? "<" : ">";
            text(left + width / 2, top + 3, label, i < 4 ? 11 : 8.5f, color, true);
        }
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
