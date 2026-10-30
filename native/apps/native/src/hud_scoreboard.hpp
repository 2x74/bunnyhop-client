#pragma once
#include "hud_geometry.hpp"
#include "name_tags.hpp"
#include <algorithm>
#include <array>
#include <limits>
#include <optional>
#include <string>

namespace native {
inline size_t hud_message_limit(std::string_view type, size_t fallback) {
    constexpr size_t scoreboard_max_bytes = 128 * 1024;
    return (type == "roomScoreboard" || type == "scoreboard") ? scoreboard_max_bytes : fallback;
}

struct ScoreRow {
    unsigned slot = 256;
    bool you = false;
    bool host = false;
    std::string name;
    std::string rank;
    std::string country;
    std::string style;
    std::string status;
    NameColor rank_color = {.75f, .75f, .77f, 1};
    NameAppearance look;
    std::optional<double> pb;
    std::optional<unsigned> ping;
    unsigned timer = 0;
    unsigned track = 0;
    double seconds = 0;
    double sampled_at = 0;
    bool spectator = false;
    // No input for the room's idle limit: it neither votes nor delays RTV (rooms/room.ts syncAfk).
    bool afk = false;
    bool host_running = false;
    double running_at_ms = 0;
};

struct ScoreHead {
    std::string room;
    std::string map;
    std::string time_left;
    std::string next_map;
    int tier = 0;
    unsigned max = 0;
    double ends_at_ms = 0;
    // You are spectating: the footer lists the spectator's keys instead.
    bool spectating = false;
    // The chat bind's first key for the footer hint ("Y"); empty while chat has no key.
    std::string chat_key;
};

inline void format_hud_time(HudLabel<48> &label, double seconds) {
    if (!std::isfinite(seconds) || seconds < 0) {
        label.assign("--");
        return;
    }
    seconds = std::min(seconds, 999999.);
    const auto milliseconds = uint64_t(std::floor(seconds * 1000 + .5));
    label.format("%02llu:%02llu.%03llu", milliseconds / 60000, (milliseconds / 1000) % 60, milliseconds % 1000);
}

// Reads whole digits only: floating-point std::from_chars is missing from older macOS deployment targets.
inline std::optional<unsigned> parse_hud_digits(std::string_view text) {
    unsigned value = 0;
    const auto end = text.data() + text.size();
    const auto parsed = std::from_chars(text.data(), end, value);
    if (text.empty() || parsed.ec != std::errc() || parsed.ptr != end) return std::nullopt;
    return value;
}

// "M:SS.mmm" (any number of minutes, up to nine fraction digits) as seconds.
inline std::optional<double> parse_hud_time(std::string_view text) {
    constexpr size_t max_fraction_digits = 9;
    const auto colon = text.find(':');
    if (colon == std::string_view::npos) return std::nullopt;
    const auto clock = text.substr(colon + 1);
    const auto dot = clock.find('.');
    const auto minutes = parse_hud_digits(text.substr(0, colon));
    const auto whole_seconds = parse_hud_digits(clock.substr(0, dot));
    if (!minutes || !whole_seconds || *whole_seconds >= 60) return std::nullopt;
    double seconds = *whole_seconds;
    if (dot != std::string_view::npos) {
        const auto fraction_text = clock.substr(dot + 1);
        const auto fraction = parse_hud_digits(fraction_text);
        if (!fraction || fraction_text.size() > max_fraction_digits) return std::nullopt;
        seconds += *fraction / std::pow(10., double(fraction_text.size()));
    }
    return double(*minutes) * 60 + seconds;
}

class HudScoreboard {
public:
    ScoreHead head;
    std::array<ScoreRow, 256> rows;
    size_t count = 0;

    void clear() {
        head = {};
        count = 0;
    }

    void add(const nlohmann::json &player, const nlohmann::json &meta, unsigned self, double now) {
        if (count == rows.size()) return;
        auto &row = rows[count++];
        row = {};
        row.slot = player.value("slot", 256u);
        row.you = row.slot == self;
        row.name = json_text(player, "name");
        row.style = json_text(player, "style");
        row.look = name_appearance(player);
        if (player.contains("look") || player.contains("marks"))
            row.look = host_name_appearance(
                    player.value("look", nlohmann::json()), player.value("marks", nlohmann::json()), row.look
            );
        row.country = json_text(player, "country", 2);
        row.host = json_flag(player, "host");
        const auto rank = player.find("rank");
        if (rank != player.end() && rank->is_object()) {
            row.rank = json_text(*rank, "name", 32);
            row.rank_color = name_color(json_text(*rank, "color"));
        }
        const auto spec = player.find("spec");
        row.spectator = spec != player.end() && !spec->is_null();
        row.afk = json_flag(player, "afk");
        if (meta.is_object()) {
            constexpr std::array<std::string_view, 9> styles = {
                    "autohop", "legit", "wonly", "sideways", "hsw", "autostrafe", "scroll", "lowgrav", "segmented"
            };
            if (meta.contains("style") && meta["style"].is_number_unsigned()) {
                const unsigned index = meta["style"].get<unsigned>();
                if (index < styles.size()) row.style = styles[index];
            }
            row.track = meta.value("track", 0u);
            row.timer = meta.value("timer", 0u);
            row.seconds = meta.value("timerTicks", 0.) * .01;
            if (row.timer == 3 && meta.contains("timeMs") && meta["timeMs"].is_number_integer())
                row.seconds = meta["timeMs"].get<double>() / 1000;
            const auto ping = meta.find("ping");
            if (ping != meta.end() && ping->is_number_unsigned()) row.ping = ping->get<unsigned>();
        }
        row.sampled_at = now;
        const auto pb = player.find("pb");
        if (pb != player.end()) {
            const nlohmann::json *value = &*pb;
            if (pb->is_object()) {
                const auto found = pb->find(row.style);
                value = found == pb->end() ? nullptr : &*found;
            }
            if (value && value->is_number()) {
                const double seconds = value->get<double>();
                if (std::isfinite(seconds) && seconds > 0) row.pb = seconds;
            }
        }
        row.status = json_text(player, "status", 128);
    }

    void sort() {
        std::sort(rows.begin(), rows.begin() + count, [](const ScoreRow &a, const ScoreRow &b) {
            if (a.spectator != b.spectator) return !a.spectator;
            const double first = a.pb.value_or(std::numeric_limits<double>::infinity());
            const double second = b.pb.value_or(std::numeric_limits<double>::infinity());
            const double first_ms = std::round(first * 1000);
            const double second_ms = std::round(second * 1000);
            return first_ms != second_ms ? first_ms < second_ms : a.name < b.name;
        });
    }

    void contract(const nlohmann::json &message) {
        if (message.contains("head") && message["head"].is_null()) {
            clear();
            return;
        }
        if (!message.contains("head") || !message["head"].is_object() || !message.contains("rows")
            || !message["rows"].is_array() || message["rows"].size() > 256)
            return;
        HudScoreboard next;
        const auto &value = message["head"];
        next.head.room = json_text(value, "room");
        next.head.map = json_text(value, "map");
        next.head.time_left = json_text(value, "timeLeft");
        next.head.next_map = json_text(value, "nextMap");
        next.head.tier = value.value("tier", nlohmann::json()).is_number_integer() ? value["tier"].get<int>() : 0;
        next.head.max = value.value("max", 0u);
        next.head.spectating = json_flag(value, "spectating");
        next.head.chat_key = json_text(value, "chatKey", 32);
        for (const auto &row : message["rows"]) {
            if (!row.is_object()) continue;
            next.add(row, nullptr, 256, 0);
            auto &stored = next.rows[next.count - 1];
            stored.you = json_flag(row, "you");
            if (row.contains("timeMs") && row["timeMs"].is_number_integer()) {
                stored.seconds = row["timeMs"].get<double>() / 1000;
                stored.timer = 3;
                HudLabel<48> time;
                format_hud_time(time, stored.seconds);
                stored.status = std::string(time.view());
            }
            stored.spectator = json_text(row, "statusKind") == "spec";
            if (json_text(row, "statusKind") == "finished") {
                stored.timer = 3;
                stored.seconds = parse_hud_time(stored.status).value_or(0);
            } else if (stored.status == "start zone") {
                stored.timer = 1;
            }
            const auto running = row.find("running");
            if (json_text(row, "statusKind") == "running" && running != row.end() && running->is_object()) {
                const double seconds = running->value("seconds", -1.);
                const double at = running->value("at", 0.);
                if (std::isfinite(seconds) && seconds >= 0 && std::isfinite(at) && at > 0) {
                    stored.host_running = true;
                    stored.timer = 2;
                    stored.seconds = seconds;
                    stored.running_at_ms = at;
                }
            }
            const auto ping = row.find("ping");
            if (ping != row.end() && ping->is_number_unsigned()) stored.ping = ping->get<unsigned>();
        }
        next.sort();
        *this = std::move(next);
    }
};

struct ScoreLocal {
    unsigned status = 0;
    double seconds = 0;
    bool in_start = false;
};

// The website's style names (styles.ts STYLES), for the Style column.
inline std::string_view score_style_label(std::string_view id) {
    constexpr std::array<std::pair<std::string_view, std::string_view>, 9> labels = {
            {{"autohop", "Normal"},
             {"legit", "EZ Scroll"},
             {"scroll", "Legit Scroll"},
             {"wonly", "W-Only"},
             {"sideways", "Sideways"},
             {"hsw", "Half-Sideways"},
             {"lowgrav", "Low Gravity"},
             {"segmented", "Segmented"},
             {"autostrafe", "Auto-strafe"}}
    };
    for (const auto &[key, label] : labels)
        if (key == id) return label;
    return id;
}

// The longest prefix of `text` within `bytes` that ends on a UTF-8 code point boundary.
inline std::string_view utf8_prefix(std::string_view text, size_t bytes) {
    if (bytes >= text.size()) return text;
    while (bytes > 0 && (uint8_t(text[bytes]) & 0xc0) == 0x80)
        --bytes;
    return text.substr(0, bytes);
}

// The website's Tab board (net/hud.ts Scoreboard, net.css #mp-scoreboard) in the HUD's own type.
namespace scoreboard_look {
constexpr NameColor cream = {.937f, .914f, .867f, 1};
constexpr NameColor dim = {.722f, .694f, .643f, 1};
constexpr NameColor faint = {.498f, .475f, .431f, 1};
constexpr NameColor amber = {1, .706f, .235f, 1};
constexpr NameColor gain = {.302f, 1, .533f, 1};
constexpr NameColor white = {1, 1, 1, 1};
constexpr NameColor panel = {.039f, .047f, .063f, .9f};
constexpr NameColor line = {.937f, .914f, .867f, .08f};
constexpr NameColor row_rule = {1, 1, 1, .05f};
constexpr NameColor you_wash = {1, .706f, .235f, .08f};
constexpr std::array<NameColor, 7> tiers = {
        {{.369f, .878f, .541f, 1},
         {.247f, .816f, .788f, 1},
         {1, .847f, .302f, 1},
         {1, .604f, .235f, 1},
         {1, .329f, .408f, 1},
         {.769f, .467f, 1, 1},
         {.486f, .514f, 1, 1}}
};
constexpr NameColor tier_unknown = {.541f, .576f, .651f, 1};
constexpr float max_width = 860;
constexpr float screen_share = .92f;
constexpr float top_share = .12f;
constexpr float max_height_share = .76f;
constexpr float padding = 18;
constexpr float head_height = 40;
constexpr float column_head_height = 26;
constexpr float row_height = 30;
constexpr float footer_line = 22;
constexpr float text_size = 13;
constexpr float small_size = 11;
constexpr float room_size = 16;
constexpr float avatar_width = 29;
constexpr float flag_width = 24;
constexpr float you_bar_width = 3;
constexpr std::array<float, 5> columns = {.0f, .045f, .53f, .66f, .80f};
}  // namespace scoreboard_look

struct ScoreboardFrame {
    float x = 0, y = 0, width = 0, height = 0;
    size_t players = 0, spectators = 0, visible = 0;
};

inline ScoreboardFrame scoreboard_frame(const HudGeometry &geometry, const HudScoreboard &board) {
    using namespace scoreboard_look;
    ScoreboardFrame frame;
    for (size_t i = 0; i < board.count; ++i)
        ++(board.rows[i].spectator ? frame.spectators : frame.players);
    frame.width = std::min(max_width, geometry.width * screen_share);
    frame.x = (geometry.width - frame.width) / 2;
    frame.y = geometry.height * top_share;
    const float fixed = padding * 2 + head_height + column_head_height + footer_line * (frame.spectators ? 2 : 1);
    const float room_for_rows = geometry.height * max_height_share - fixed;
    frame.visible = std::min(frame.players, size_t(std::max(0.f, std::floor(room_for_rows / row_height))));
    frame.height = fixed + float(frame.visible) * row_height;
    return frame;
}

template <class Hud>
void draw_score_head(Hud &hud, const ScoreboardFrame &frame, const HudScoreboard &board, double epoch_ms) {
    using namespace scoreboard_look;
    const auto &head = board.head;
    const float left = frame.x + padding, right = frame.x + frame.width - padding, y = frame.y + padding;
    const std::string_view room = head.room.empty() ? std::string_view("Solo") : std::string_view(head.room);
    hud.overlay_text(left, y, room, room_size, cream);
    HudLabel<96> label;
    label.format(" · %zu/%u players", frame.players + frame.spectators, head.max);
    hud.overlay_text(left + hud.overlay_text_width(room, room_size), y + 3, label.view(), text_size, dim);
    HudLabel<128> right_text;
    if (head.ends_at_ms > 0) {
        const auto seconds = unsigned(std::clamp(std::ceil((head.ends_at_ms - epoch_ms) / 1000), 0., 86400.));
        if (seconds)
            right_text.format(" · %u:%02u left", seconds / 60, seconds % 60);
        else
            right_text.assign(" · last round");
    } else if (!head.time_left.empty()) {
        right_text.assign(" · ");
        right_text.append(head.time_left);
    }
    if (!head.next_map.empty()) {
        right_text.append(" · next: ");
        right_text.append(head.next_map);
    }
    HudLabel<8> tier;
    tier.format(head.tier >= 7 ? "T7+" : head.tier > 0 ? "T%d" : "T?", head.tier);
    const NameColor tier_color = head.tier > 0 ? tiers[size_t(std::min(head.tier, 7) - 1)] : tier_unknown;
    const float rest_width = hud.overlay_text_width(right_text.view(), text_size);
    const float tier_width = hud.overlay_text_width(tier.view(), small_size) + 10;
    const float map_width = hud.overlay_text_width(head.map, text_size + 1);
    float x = right - rest_width - tier_width - 6 - map_width;
    hud.overlay_text(x, y + 2, head.map, text_size + 1, cream);
    x += map_width + 6;
    hud.overlay_rect(x, y + 2, tier_width, 18, {tier_color[0], tier_color[1], tier_color[2], .14f});
    hud.overlay_text(x + 5, y + 4, tier.view(), small_size, tier_color);
    hud.overlay_text(x + tier_width, y + 3, right_text.view(), text_size, dim);
    hud.overlay_rect(left, frame.y + padding + head_height - 10, frame.width - padding * 2, 1, line);
}

template <class Hud>
void draw_score_columns(Hud &hud, const ScoreboardFrame &frame) {
    using namespace scoreboard_look;
    constexpr std::array<std::string_view, 5> names = {"#", "Player", "Style", "Time", "PB"};
    const float y = frame.y + padding + head_height;
    const float inner = frame.width - padding * 2;
    for (size_t i = 0; i < names.size(); ++i)
        hud.overlay_text(frame.x + padding + inner * columns[i], y, names[i], small_size, faint);
    const float ping_x = frame.x + frame.width - padding - hud.overlay_text_width("Ping", small_size);
    hud.overlay_text(ping_x, y, "Ping", small_size, faint);
}

// The time cell: its text and the website's colour for the row's state (net.css .sb-time).
inline NameColor
score_time(HudLabel<48> &time, const ScoreRow &row, double now, double epoch_ms, const ScoreLocal *local) {
    using namespace scoreboard_look;
    if (row.you && local) {
        if (local->status) {
            format_hud_time(time, local->seconds);
            return local->status == 2 ? gain : white;
        }
        time.assign(row.afk ? "AFK" : local->in_start ? "start zone" : "\u2014");
        return faint;
    }
    if (row.host_running) {
        format_hud_time(time, row.seconds + std::max(0., (epoch_ms - row.running_at_ms) / 1000));
        return white;
    }
    if (row.timer == 2 || row.timer == 3) {
        format_hud_time(time, row.seconds + (row.timer == 2 ? std::max(0., now - row.sampled_at) : 0));
        return row.timer == 3 ? gain : white;
    }
    if (row.afk)
        time.assign("AFK");
    else if (row.timer == 1)
        time.assign("start zone");
    else if (!row.status.empty())
        time.assign(row.status);
    else
        time.assign("—");
    return faint;
}

template <class Hud>
float draw_rank_tag(Hud &hud, float x, float y, const ScoreRow &row) {
    using namespace scoreboard_look;
    if (row.rank.empty()) return x;
    const float width = hud.overlay_text_width(row.rank, small_size - 1) + 8;
    const auto &color = row.rank_color;
    hud.overlay_rect(x, y + 1, width, 17, {0, 0, 0, .35f});
    hud.overlay_rect(x, y + 1, width, 1, {color[0], color[1], color[2], .5f});
    hud.overlay_rect(x, y + 17, width, 1, {color[0], color[1], color[2], .5f});
    hud.overlay_text(x + 4, y + 3, row.rank, small_size - 1, color);
    return x + width + 5;
}

template <class Hud>
void draw_host_tag(Hud &hud, float x, float y) {
    using namespace scoreboard_look;
    const float width = hud.overlay_text_width("HOST", small_size - 2) + 8;
    hud.overlay_rect(x, y + 2, width, 1, amber);
    hud.overlay_rect(x, y + 16, width, 1, amber);
    hud.overlay_rect(x, y + 2, 1, 15, amber);
    hud.overlay_rect(x + width - 1, y + 2, 1, 15, amber);
    hud.overlay_text(x + 4, y + 4, "HOST", small_size - 2, amber);
}

template <class Hud>
void draw_score_player(Hud &hud, float x, float right, float y, const ScoreRow &row, double now) {
    using namespace scoreboard_look;
    hud.overlay_avatar(x, y - 3, row.slot, slot_color(row.slot));
    x += avatar_width;
    x = draw_rank_tag(hud, x, y, row);
    hud.overlay_flag(x, y + 1, row.country);
    if (!row.country.empty()) x += flag_width;
    constexpr float host_room = 44, badge_width = 18;
    const float room = right - x - float(name_badge_count(row.look)) * badge_width - (row.host ? host_room : 0);
    const auto glyphs = size_t(std::max(2.f, room / (text_size * .62f)));
    const auto name = utf8_prefix(row.name, glyphs);
    hud.overlay_name(x, y, name, text_size + 1, row.look, now);
    if (row.host) {
        const float name_end = x + hud.overlay_text_width(name, text_size + 1) + 6;
        draw_host_tag(hud, name_end + float(name_badge_count(row.look)) * badge_width, y);
    }
}

template <class Hud>
void draw_score_row(
        Hud &hud,
        const ScoreboardFrame &frame,
        size_t place,
        const ScoreRow &row,
        double now,
        double epoch_ms,
        const ScoreLocal *local,
        std::string_view local_style
) {
    using namespace scoreboard_look;
    const float inner = frame.width - padding * 2, left = frame.x + padding;
    const float top = frame.y + padding + head_height + column_head_height + float(place) * row_height;
    const float y = top + 7;
    hud.overlay_rect(left - 6, top, inner + 12, 1, row_rule);
    if (row.you) {
        hud.overlay_rect(left - 6, top + 1, inner + 12, row_height - 1, you_wash);
        hud.overlay_rect(left - 6, top + 1, you_bar_width, row_height - 1, amber);
    }
    HudLabel<48> text;
    text.format("%zu", place + 1);
    hud.overlay_text(left + inner * columns[0], y, text.view(), text_size, faint);
    draw_score_player(hud, left + inner * columns[1], left + inner * columns[2] - 10, y, row, now);
    const std::string_view style = row.you && !local_style.empty() ? local_style : std::string_view(row.style);
    hud.overlay_text(left + inner * columns[2], y, score_style_label(style), text_size, dim);
    const auto time_color = score_time(text, row, now, epoch_ms, row.spectator ? nullptr : local);
    hud.overlay_text(left + inner * columns[3], y, text.view(), text_size, time_color);
    if (row.pb)
        format_hud_time(text, *row.pb);
    else
        text.assign("—");
    hud.overlay_text(left + inner * columns[4], y, text.view(), text_size, amber);
    if (row.ping)
        text.format("%u", *row.ping);
    else
        text.assign("—");
    hud.overlay_text(left + inner - hud.overlay_text_width(text.view(), text_size), y, text.view(), text_size, dim);
}

// "Spectating: Glowy → NativeBun, …" under the table, as the website lists them.
template <class Hud>
void draw_score_spectators(Hud &hud, const ScoreboardFrame &frame, const HudScoreboard &board, float y) {
    using namespace scoreboard_look;
    constexpr std::string_view lead = "Spectating: ";
    HudLabel<512> names;
    for (size_t i = 0; i < board.count; ++i) {
        const auto &row = board.rows[i];
        if (!row.spectator) continue;
        if (!names.empty()) names.append(", ");
        names.append(row.name);
        // The status reads "SPEC → name": keep what follows "SPEC".
        const std::string_view status = row.status;
        if (status.starts_with("SPEC")) names.append(status.substr(4));
    }
    const float left = frame.x + padding;
    hud.overlay_text(left, y, lead, small_size + 1, dim);
    hud.overlay_text(left + hud.overlay_text_width(lead, small_size + 1), y, names.view(), small_size + 1, cream);
}

template <class Hud>
void draw_scoreboard(
        Hud &hud,
        int width,
        int height,
        float percent,
        const HudScoreboard &board,
        double now,
        double epoch_ms,
        const ScoreLocal *local = nullptr,
        std::string_view local_style = ""
) {
    using namespace scoreboard_look;
    const HudGeometry geometry(width, height, percent);
    const auto frame = scoreboard_frame(geometry, board);
    hud.overlay_begin(width, height, percent);
    hud.overlay_rect(frame.x, frame.y, frame.width, frame.height, panel);
    draw_score_head(hud, frame, board, epoch_ms);
    draw_score_columns(hud, frame);
    size_t place = 0;
    for (size_t i = 0; i < board.count && place < frame.visible; ++i) {
        if (board.rows[i].spectator) continue;
        draw_score_row(hud, frame, place++, board.rows[i], now, epoch_ms, local, local_style);
    }
    float y = frame.y + padding + head_height + column_head_height + float(frame.visible) * row_height + 8;
    if (frame.spectators) {
        draw_score_spectators(hud, frame, board, y);
        y += footer_line;
    }
    HudLabel<160> hint;
    if (board.head.spectating) {
        hint.assign("Mouse 1 and 2 switch players. Space changes the camera. R respawns you.");
    } else {
        // The website's footer names the chat key (net/hud.ts Scoreboard).
        hint.assign(
                board.head.chat_key.empty() ? std::string_view("Bind a key") : std::string_view(board.head.chat_key)
        );
        hint.append(" to chat, N to spectate. Type rtv, nominate or timeleft. Esc has the server menu.");
    }
    hud.overlay_text(frame.x + padding, y, hint.view(), small_size, faint);
    hud.overlay_end(width, height);
}
}  // namespace native
