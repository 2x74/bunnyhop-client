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

inline std::optional<double> parse_hud_time(std::string_view text) {
    const auto colon = text.find(':');
    if (colon == std::string_view::npos) return std::nullopt;
    unsigned minutes = 0;
    double seconds = 0;
    const auto first = std::from_chars(text.data(), text.data() + colon, minutes);
    const auto second = std::from_chars(text.data() + colon + 1, text.data() + text.size(), seconds);
    if (first.ec != std::errc() || first.ptr != text.data() + colon || second.ec != std::errc()
        || second.ptr != text.data() + text.size() || !std::isfinite(seconds) || seconds < 0 || seconds >= 60)
        return std::nullopt;
    return double(minutes) * 60 + seconds;
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
        if (meta.is_object()) {
            constexpr std::array<std::string_view, 8> styles = {
                    "autohop", "legit", "wonly", "sideways", "hsw", "autostrafe", "scroll", "lowgrav"
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
};

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
    const HudGeometry geometry(width, height, percent);
    const auto box = scoreboard_bounds(geometry.width, geometry.height, board.count);
    constexpr NameColor cream = {.94f, .91f, .86f, 1};
    constexpr NameColor dim = {.63f, .65f, .70f, 1};
    constexpr NameColor amber = {1, .71f, .24f, 1};
    hud.overlay_begin(width, height, percent);
    hud.overlay_rect(box.x, box.y, box.width, box.height, {.025f, .027f, .04f, .96f});
    hud.overlay_text(box.x + 20, box.y + 14, board.head.room.empty() ? "Solo" : board.head.room, 20, cream);
    HudLabel<64> label;
    label.format("%zu/%u players", board.count, board.head.max);
    hud.overlay_text(box.x + box.width - 170, box.y + 20, label.view(), 13, dim);
    hud.overlay_text(box.x + 20, box.y + 48, board.head.map, 15, cream);
    label.format(board.head.tier >= 7 ? "T7+" : board.head.tier > 0 ? "T%d" : "T?", board.head.tier);
    hud.overlay_rect(box.x + box.width * .39f, box.y + 45, 38, 24, {.22f, .16f, .07f, 1});
    hud.overlay_text(box.x + box.width * .39f + 4, box.y + 48, label.view(), 13, amber);
    if (board.head.ends_at_ms > 0) {
        const unsigned seconds = unsigned(std::clamp(std::ceil((board.head.ends_at_ms - epoch_ms) / 1000), 0., 86400.));
        label.format("%u:%02u left", seconds / 60, seconds % 60);
    } else {
        label.assign(board.head.time_left);
    }
    hud.overlay_text(box.x + box.width * .55f, box.y + 48, label.view(), 13, dim);
    if (!board.head.next_map.empty()) {
        label.assign("Next: ");
        label.append(board.head.next_map);
        hud.overlay_text(box.x + box.width * .73f, box.y + 48, label.view(), 11, dim);
    }
    constexpr std::array<std::string_view, 6> columns = {"#", "Player", "Style", "Time", "PB", "Ping"};
    constexpr std::array<float, 6> offsets = {.02f, .065f, .50f, .66f, .80f, .94f};
    for (size_t i = 0; i < columns.size(); ++i)
        hud.overlay_text(box.x + box.width * offsets[i], box.y + 89, columns[i], 12, dim);
    hud.overlay_rect(box.x + 16, box.y + 112, box.width - 32, 1, {.23f, .23f, .27f, 1});
    const size_t visible = size_t(std::max(0.f, std::floor((box.height - 158) / 36)));
    for (size_t i = 0; i < std::min(board.count, visible); ++i) {
        const auto &row = board.rows[i];
        const float y = box.y + 120 + float(i) * 36;
        if (row.you) hud.overlay_rect(box.x + 8, y - 3, box.width - 16, 33, {.15f, .12f, .065f, .85f});
        label.format("%zu", i + 1);
        hud.overlay_text(box.x + box.width * offsets[0], y, label.view(), 13, dim);
        float x = box.x + box.width * offsets[1];
        hud.overlay_avatar(x, y, row.slot, row.look.color);
        x += 29;
        if (!row.rank.empty()) {
            hud.overlay_text(x, y + 1, row.rank, 10, row.rank_color);
            x += std::min(70.f, float(row.rank.size()) * 6 + 8);
        }
        hud.overlay_flag(x, y + 2, row.country);
        if (!row.country.empty()) x += 24;
        const size_t maximum_name =
                size_t(std::max(2.f, (box.x + box.width * .47f - x - native::name_badge_count(row.look) * 18) / 8.4f));
        const auto name = std::string_view(row.name).substr(0, maximum_name);
        hud.overlay_name(x, y, name, 14, row.look, now);
        if (row.host) hud.overlay_mark(box.x + box.width * .47f, y, NameMark::crown, amber);
        hud.overlay_text(
                box.x + box.width * offsets[2],
                y,
                row.you && !local_style.empty() ? local_style : std::string_view(row.style),
                12,
                dim
        );
        HudLabel<48> time;
        if (row.you && local && !row.spectator) {
            if (local->status)
                format_hud_time(time, local->seconds);
            else
                time.assign("start zone");
        } else if (row.host_running)
            format_hud_time(time, row.seconds + std::max(0., (epoch_ms - row.running_at_ms) / 1000));
        else if (!row.status.empty())
            time.assign(row.status);
        else if (row.spectator)
            time.assign("SPEC");
        else if (row.timer == 2 || row.timer == 3)
            format_hud_time(time, row.seconds + (row.timer == 2 ? std::max(0., now - row.sampled_at) : 0));
        else
            time.assign(row.timer == 1 ? "start zone" : "--");
        hud.overlay_text(box.x + box.width * offsets[3], y, time.view(), 12, row.timer == 3 ? amber : cream);
        if (row.pb)
            format_hud_time(time, *row.pb);
        else
            time.assign("--");
        hud.overlay_text(box.x + box.width * offsets[4], y, time.view(), 12, dim);
        if (row.ping)
            time.format("%u", *row.ping);
        else
            time.assign("--");
        hud.overlay_text(box.x + box.width * offsets[5], y, time.view(), 12, dim);
    }
    hud.overlay_text(
            box.x + 20, box.y + box.height - 25, "Y to chat   N to spectate   rtv / nominate / timeleft", 12, dim
    );
    hud.overlay_end(width, height);
}
}  // namespace native
