#pragma once
#include "bunnyhop_native.h"
#include "hud_scoreboard.hpp"
#include "render_shaders.hpp"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <cmath>
#include <deque>
#include <optional>
#include <unordered_map>
#include <vector>

namespace native {
struct VoteDisplay {
    std::array<HudLabel<128>, 9> options;
    std::array<unsigned, 9> counts{};
    size_t count = 0;
    double ends_at = 0;
    int choice = -1;
};

template <class Hud>
void draw_vote(Hud &hud, int width, int height, float percent, const VoteDisplay &vote, double epoch_ms) {
    if (!vote.count) return;
    const HudGeometry geometry(width, height, percent);
    const float x = 24;
    const float y = geometry.height * .32f;
    const float panel_width = std::min(370.f, geometry.width - 48);
    hud.overlay_begin(width, height, percent);
    hud.overlay_rect(x, y, panel_width, 92 + float(vote.count) * 28, {.025f, .027f, .04f, .94f});
    HudLabel<128> text;
    const int seconds = int(std::clamp(std::ceil((vote.ends_at - epoch_ms) / 1000), 0., 999.));
    text.format("Map vote | %ds", seconds);
    hud.overlay_text(x + 14, y + 12, text.view(), 17, {1, .71f, .24f, 1});
    unsigned total = 0;
    for (size_t i = 0; i < vote.count; ++i)
        total += vote.counts[i];
    for (size_t i = 0; i < vote.count; ++i) {
        const float row_y = y + 46 + float(i) * 28;
        const bool chosen = int(i) == vote.choice;
        hud.overlay_rect(
                x + 10,
                row_y - 2,
                (panel_width - 20) * float(vote.counts[i]) / std::max(1u, total),
                25,
                {.27f, .21f, .09f, chosen ? .9f : .45f}
        );
        text.format(
                "%zu. %.*s  [%u]%s",
                i + 1,
                int(vote.options[i].view().size()),
                vote.options[i].view().data(),
                vote.counts[i],
                chosen ? "  <" : ""
        );
        hud.overlay_text(
                x + 14, row_y, text.view(), 13, chosen ? NameColor{1, .71f, .24f, 1} : NameColor{.94f, .91f, .86f, 1}
        );
    }
    hud.overlay_text(x + 14, y + 58 + float(vote.count) * 28, "Press 1-9 to vote", 12, {.64f, .66f, .70f, 1});
    hud.overlay_end(width, height);
}

class RoomState {
    struct Sample {
        BhGhostFrame frame;
        bool teleport;
        unsigned wire_flags = 0;
        bool silenced = false;
    };

    // A peer's run as the snapshots report it (protocol.ts NetMeta), read once when it arrives.
    struct WireMeta {
        bool known = false;
        unsigned style = 0, timer = 0;
        double timer_ticks = 0;
    };

    struct Peer {
        native_render::Actor actor;
        WireMeta wire;
        std::deque<Sample> samples;
        double arrived = 0, offset = 0, batch = .1, jitter = 0, meta_at = 0;
        bool clock = false, spectator = false;
        uint32_t rendered = 0;
        double rendered_at = -1;
        // The tick drawn, advanced at real time and eased toward the interpolation target (playback_tick).
        double playback = 0, playback_at = -1;
        bool batch_measured = false;
        nlohmann::json info, meta;
    };

    std::unordered_map<unsigned, Peer> peers;
    bool closed_ = false;
    HudScoreboard display_;
    bool decorated_display_ = false;

    void player(const nlohmann::json &p, bool patch = false) {
        const unsigned slot = p.at("slot").get<unsigned>();
        if (slot >= 256) return;
        auto &peer = peers[slot];
        if (!patch || !peer.info.is_object())
            peer.info = p;
        else
            for (auto it = p.begin(); it != p.end(); ++it)
                peer.info[it.key()] = it.value();
        if (p.contains("name")) peer.actor.name = p.at("name").get<std::string>().substr(0, 128);
        peer.actor.id = std::to_string(slot);
        peer.actor.opacity = 1;
        if (!patch || p.contains("playerGlow"))
            peer.actor.playerGlow =
                    p.contains("playerGlow") ? native_render::parse_glow(p["playerGlow"]) : std::nullopt;
        if (p.contains("outfit"))
            peer.actor.outfit =
                    p.value("outfit", nlohmann::json()).is_string() ? p.at("outfit").get<std::string>() : "";
        if (p.contains("loadout")) {
            if (p["loadout"].is_object()) {
                const auto &l = p["loadout"];
                peer.actor.loadout = "2;" + l.value("knife", std::string("knife-carrot")) + ";"
                                     + l.value("finish", std::string("finish-default")) + ";"
                                     + l.value("glove", std::string("glove-default")) + ";";
                if (l.contains("crown") && l["crown"].is_number_integer())
                    peer.actor.loadout += std::to_string(l["crown"].get<int>());
                peer.actor.loadout += ";"
                                      + (l.contains("hat") && l["hat"].is_string() ? l["hat"].get<std::string>() : "")
                                      + ";" + l.value("body", std::string("body-a"));
                if (peer.actor.loadout.size() > 200) peer.actor.loadout.clear();
            } else
                peer.actor.loadout.clear();
        }
        if (!patch || p.contains("spec")) {
            peer.spectator = p.contains("spec") && !p["spec"].is_null();
            if (slot == self) {
                spectator_target.reset();
                if (peer.spectator && p["spec"].is_number_unsigned()) {
                    const auto target = p["spec"].get<unsigned>();
                    if (target < 256 && target != self) spectator_target = target;
                } else if (peer.spectator && p["spec"].is_number_integer()) {
                    const auto target = p["spec"].get<int>();
                    if (target >= 0 && target < 256 && unsigned(target) != self) spectator_target = unsigned(target);
                }
            }
        }
    }

    static WireMeta wire_meta(const nlohmann::json &meta) {
        WireMeta wire;
        wire.known = meta.is_object();
        if (!wire.known) return wire;
        wire.style = meta.value("style", 0u);
        wire.timer = meta.value("timer", 0u);
        wire.timer_ticks = meta.value("timerTicks", 0.);
        return wire;
    }

    std::string change_map(const std::string &next) {
        if (map == next) return "";
        map = next;
        return map;
    }

public:
    NameAppearance appearance(unsigned slot) const {
        for (size_t i = 0; i < display_.count; ++i) {
            if (display_.rows[i].slot == slot) return display_.rows[i].look;
        }
        return {};
    }

    const HudScoreboard &display() const { return display_; }

    VoteDisplay vote_display;
    HudLabel<128> changing_map;
    double changing_at = 0;

    template <class Extras>
    void refresh_spectators(Extras &extras) const {
        extras.spectator_count = 0;
        const unsigned target = spectator_target.value_or(self);
        for (const auto &[slot, peer] : peers) {
            const auto spec = peer.info.find("spec");
            if (spec == peer.info.end() || !spec->is_number_integer() || spec->get<unsigned>() != target) continue;
            if (extras.spectator_count == extras.spectators.size()) break;
            extras.spectators[extras.spectator_count++].assign(peer.actor.name);
        }
    }

    void spectator_run(BhRunState &run, std::string &style, unsigned target, double now, double epoch_ms) const {
        run = {};
        for (size_t i = 0; i < display_.count; ++i) {
            const auto &row = display_.rows[i];
            if (row.slot != target) continue;
            style = row.style;
            run.track = row.track;
            run.seconds = row.seconds
                          + (row.host_running ? std::max(0., (epoch_ms - row.running_at_ms) / 1000)
                             : row.timer == 2 ? std::max(0., now - row.sampled_at)
                                              : 0);
            run.status = row.timer == 3 ? 2 : row.timer == 2 ? 1 : 0;
            run.in_start = row.timer == 1;
            return;
        }
    }

    template <class Hud>
    void draw_change(Hud &hud, int width, int height, float percent, double now) const {
        if (changing_map.empty()) return;
        HudLabel<192> label;
        const int seconds = int(std::clamp(std::ceil((changing_at - now) / 1000), 0., 999.));
        label.format("Changing to %.*s in %ds", int(changing_map.view().size()), changing_map.view().data(), seconds);
        const HudGeometry geometry(width, height, percent);
        hud.overlay_begin(width, height, percent);
        hud.overlay_text(geometry.width / 2, 65, label.view(), 16, {1, .71f, .24f, 1}, true);
        hud.overlay_end(width, height);
    }

    void voted(int index) { vote_display.choice = index; }

    void refresh_vote() {
        const int choice = vote_display.choice;
        vote_display = {};
        vote_display.choice = choice;
        if (!vote.is_object() || !vote.contains("options") || !vote["options"].is_array()) {
            vote_display.choice = -1;
            return;
        }
        vote_display.ends_at = vote.value("endsAt", 0.) - clock_offset_ms;
        const auto counts = vote.find("counts");
        for (const auto &option : vote["options"]) {
            if (vote_display.count == vote_display.options.size()) break;
            const size_t index = vote_display.count++;
            if (option.contains("map"))
                vote_display.options[index].assign(json_text(option, "map"));
            else
                vote_display.options[index].format("Extend %u minutes", option.value("minutes", 0u));
            if (counts != vote.end() && counts->is_array() && index < counts->size()
                && (*counts)[index].is_number_unsigned())
                vote_display.counts[index] = (*counts)[index].get<unsigned>();
        }
    }

    void display_contract(const nlohmann::json &message) {
        if ((message.contains("generation") && message.at("generation") != generation)
            || (message.contains("id") && message.at("id") != id))
            return;
        display_.contract(message);
        decorated_display_ = message.contains("head") && message["head"].is_object();
    }

    void solo_display(const std::string &map, const std::string &name, const std::string &style) {
        if (!id.empty()) return;
        display_.clear();
        display_.head.room = "Solo";
        display_.head.map = map;
        display_.head.max = 1;
        display_.count = 1;
        auto &row = display_.rows[0];
        row = {};
        row.name = name;
        row.style = style;
        row.you = true;
    }

    void refresh_display(double now) {
        if (decorated_display_) {
            for (size_t i = 0; i < display_.count; ++i) {
                auto &row = display_.rows[i];
                const auto peer = peers.find(row.slot);
                if (peer != peers.end() && peer->second.meta.is_object())
                    row.track = peer->second.meta.value("track", 0u);
            }
            refresh_vote();
            changing_map.assign(change.is_object() ? json_text(change, "map") : "");
            changing_at = change.is_object() ? change.value("at", 0.) - clock_offset_ms : 0;
            return;
        }
        const auto previous_head = display_.head;
        display_.clear();
        display_.head = previous_head;
        refresh_vote();
        changing_map.assign(change.is_object() ? json_text(change, "map") : "");
        changing_at = change.is_object() ? change.value("at", 0.) - clock_offset_ms : 0;
        display_.head.room = room_info.is_object() ? json_text(room_info, "name") : id;
        display_.head.map = map;
        if (room_info.is_object()) display_.head.max = room_info.value("maxPlayers", 0u);
        for (const auto &[slot, peer] : peers) {
            display_.add(peer.info, peer.meta, self, peer.meta_at > 0 ? peer.meta_at : now);
            auto &row = display_.rows[display_.count - 1];
            if (room_info.is_object() && json_flag(room_info, "private"))
                row.host = room_info.value("host", 256u) == slot;
            if (peer.spectator) {
                row.status = "SPEC";
                const auto spec = peer.info.find("spec");
                if (spec != peer.info.end() && spec->is_number_unsigned()) {
                    const auto target = peers.find(spec->get<unsigned>());
                    if (target != peers.end()) row.status += " \u2192 " + target->second.actor.name;
                }
            }
        }
        display_.sort();
    }

    uint64_t generation = 0;
    std::string id, map, notice, status;
    nlohmann::json vote = nullptr, change = nullptr, nominations = nlohmann::json::array(), room_info;
    double clock_offset_ms = 0;
    unsigned self = 256;
    std::optional<unsigned> spectator_target;

    void clear() {
        decorated_display_ = false;
        display_.clear();
        vote_display = {};
        vote = nullptr;
        change = nullptr;
        nominations = nlohmann::json::array();
        room_info = nullptr;
        status.clear();
        peers.clear();
        id.clear();
        map.clear();
        notice.clear();
        self = 256;
        spectator_target.reset();
    }

    // End the current room lifecycle without rewinding its stale-event fence.
    // A deliberate join uses a newer UI generation; queued callbacks from the
    // closed generation must never resurrect a room or request another map.
    void close() {
        clear();
        closed_ = true;
    }

    // Returns a map name only when the room has actually switched, not on a future vote announcement.
    std::string event(const nlohmann::json &message) {
        const auto next = message.at("generation").get<uint64_t>();
        if (next < generation || (next == generation && closed_)) return "";
        const auto next_id = message.at("id").get<std::string>();
        if (next == generation && !id.empty() && next_id != id) return "";
        if (next > generation) {
            clear();
            generation = next;
            closed_ = false;
        }
        id = next_id;
        const auto &e = message.at("event");
        const auto type = e.at("t").get<std::string>();
        if (type == "welcome" || type == "map" || type == "nativeMap") {
            decorated_display_ = false;
            display_.head.next_map = json_text(e, "nextMap");
            display_.head.ends_at_ms = 0;
            display_.head.tier = 0;
            if (e.contains("map") && e["map"].is_object()) {
                const auto &map = e["map"];
                display_.head.ends_at_ms = map.value("endsAt", 0.) - clock_offset_ms;
                if (map.contains("tier") && map["tier"].is_number_integer())
                    display_.head.tier = map["tier"].get<int>();
            }
        }
        if (type == "nativeLeave") {
            close();
            return "";
        }
        if (e.contains("nativeClockOffsetMs") && e["nativeClockOffsetMs"].is_number())
            clock_offset_ms = e["nativeClockOffsetMs"].get<double>();
        if (type == "nativeStatus") {
            status = e.value("status", std::string());
            if (status == "closed") {
                peers.clear();
                spectator_target.reset();
                vote = nullptr;
                change = nullptr;
            }
            return "";
        }
        if (type == "kicked") {
            notice = e.value("reason", std::string("Removed from room"));
            peers.clear();
            spectator_target.reset();
            status = "closed";
            return "";
        }
        if (e.contains("myVote") && e["myVote"].is_number_integer()) vote_display.choice = e["myVote"].get<int>();
        if (type == "vote")
            vote = e.at("vote");
        else if (type == "voteEnd")
            vote = nullptr;
        else if (type == "change")
            change = e.at("change");
        else if (type == "nominations")
            nominations = e.at("list");
        if (type == "welcome") {
            status = "open";
            room_info = e.value("room", nlohmann::json::object());
            vote = e.value("vote", nlohmann::json(nullptr));
            change = e.value("change", nlohmann::json(nullptr));
            nominations = e.value("nominations", nlohmann::json::array());
            peers.clear();
            spectator_target.reset();
            self = e.at("you").get<unsigned>();
            for (const auto &p : e.at("players"))
                player(p);
            if (e.contains("metas") && e["metas"].is_object())
                for (auto it = e["metas"].begin(); it != e["metas"].end(); ++it) {
                    try {
                        const unsigned slot = unsigned(std::stoul(it.key()));
                        if (slot < 256) {
                            peers[slot].meta = it.value();
                            peers[slot].wire = wire_meta(it.value());
                        }
                    } catch (const std::exception &) {
                    }
                }
            return change_map(e.at("map").at("name").get<std::string>());
        }
        if (type == "join")
            player(e.at("player"));
        else if (type == "leave") {
            const auto slot = e.at("slot").get<unsigned>();
            peers.erase(slot);
            if (spectator_target == slot) spectator_target.reset();
        } else if (type == "player") {
            auto p = e.at("patch");
            p["slot"] = e.at("slot");
            player(p, true);
        } else if (type == "map" || type == "nativeMap") {
            const auto &m = e.at("map");
            const auto next_map = m.is_string() ? m.get<std::string>() : m.at("name").get<std::string>();
            change = nullptr;
            vote = nullptr;
            for (auto &[slot, p] : peers) {
                p.samples.clear();
                p.clock = false;
                p.playback_at = -1;
            }
            return change_map(next_map);
        } else if (type == "chat")
            notice = e.value("name", std::string("Server")) + ": " + e.value("text", std::string());
        return "";
    }

    void snapshot(const nlohmann::json &message, double now) {
        if (closed_ || message.at("generation") != generation || message.at("id") != id) return;
        const auto &blocks = message.at("snapshot").at("blocks");
        if (!blocks.is_array() || blocks.size() > 64) throw std::runtime_error("Invalid room snapshot");
        for (const auto &block : blocks) {
            const unsigned slot = block.at("slot").get<unsigned>();
            if (slot == self || slot >= 256) continue;
            auto &p = peers[slot];
            if (block.contains("meta") && block["meta"].is_object()) {
                p.meta = block["meta"];
                p.wire = wire_meta(p.meta);
                p.meta_at = now;
            }
            p.actor.id = std::to_string(slot);
            p.actor.opacity = 1;
            const auto &samples = block.at("samples");
            if (!samples.is_array() || samples.size() > 8) continue;
            const uint32_t newest_before = p.samples.empty() ? 0 : p.samples.back().frame.tick;
            bool appended = false;
            for (const auto &raw : samples) {
                BhGhostFrame f{};
                f.tick = raw.at("tick").get<uint32_t>();
                bool valid = true;
                for (int i = 0; i < 3; i++) {
                    const char *pos[] = {"x", "y", "z"}, *vel[] = {"vx", "vy", "vz"};
                    f.position[i] = raw.at(pos[i]).get<float>();
                    f.velocity[i] = raw.at(vel[i]).get<float>();
                    valid &= std::isfinite(f.position[i]) && std::abs(f.position[i]) <= 16896
                             && std::isfinite(f.velocity[i]) && std::abs(f.velocity[i]) <= 32768;
                }
                f.yaw = raw.at("yaw").get<float>();
                f.pitch = raw.at("pitch").get<float>();
                valid &= std::isfinite(f.yaw) && std::isfinite(f.pitch);
                if (!valid) continue;
                const unsigned flags = raw.at("flags").get<unsigned>();
                f.flags = (flags & 2 ? 1 : 0) | (flags & 1 ? 2 : 0);
                f.view_offset_z = f.flags & 1 ? 46 : 64;
                const auto previous_weapon = p.samples.empty() ? p.actor.frame.weapon : p.samples.back().frame.weapon;
                f.weapon = block.value("weapon", previous_weapon ? previous_weapon : 1u);
                if (f.weapon > 31) f.weapon = 1;
                if (!p.samples.empty() && f.tick <= p.samples.back().frame.tick) continue;
                if (flags & 8) {
                    p.samples.clear();
                    p.clock = false;
                    p.rendered = 0;
                    p.rendered_at = -1;
                    p.playback_at = -1;
                }
                appended = true;
                p.samples.push_back({f, bool(flags & 8), flags, block.value("silenced", false)});
                while (p.samples.size() > 96)
                    p.samples.pop_front();
            }
            if (appended && !p.samples.empty() && now > p.arrived) update_clock(p, now, newest_before);
        }
    }

    // Maps a sender's ticks onto local time (net/interp.ts RemoteTrack.push): the offset follows the fastest arrivals,
    // jitter is how late the others come, and the batch interval is measured from the ticks a batch covers, not from
    // arrival times, which jitter.
    static void update_clock(Peer &p, double now, uint32_t newest_before) {
        constexpr double longest_batch_seconds = .4;
        const uint32_t newest = p.samples.back().frame.tick;
        if (newest_before && newest > newest_before) {
            const double span = (newest - newest_before) * .01;
            if (span <= longest_batch_seconds) {
                p.batch = p.batch_measured ? .8 * p.batch + .2 * span : span;
                p.batch_measured = true;
            }
        }
        const double offset = now - newest * .01;
        if (!p.clock) {
            p.offset = offset;
            p.clock = true;
        } else {
            const double late = std::max(0., offset - p.offset);
            p.jitter = .9 * p.jitter + .1 * std::min(late, .12);
            p.offset = std::min(offset, p.offset + .0002);
        }
        p.arrived = now;
    }

    // The tick to draw a peer at. The target moves whenever the offset or the jitter estimate changes; drawing it
    // directly makes the player jump a little each time, which shows at high frame rates. The drawn tick runs at real
    // time and eases toward the target at most a tenth faster or slower, and snaps when it is far off.
    static double playback_tick(Peer &p, double target, double now) {
        constexpr double ticks_per_second = 100;
        constexpr double resync_ticks = 30;
        constexpr double max_rate_change = .1;
        constexpr double settle_per_second = 4;
        if (p.playback_at < 0 || std::abs(target - p.playback) > resync_ticks) {
            p.playback = target;
            p.playback_at = now;
            return target;
        }
        const double elapsed = now - p.playback_at;
        if (elapsed <= 0) return p.playback;
        const double step = elapsed * ticks_per_second;
        const double error = target - (p.playback + step);
        const double limit = step * max_rate_change;
        p.playback += step + std::clamp(error * std::min(1., elapsed * settle_per_second), -limit, limit);
        p.playback_at = now;
        return p.playback;
    }

    std::vector<native_render::Actor> actors(double now) {
        std::vector<native_render::Actor> out;
        for (auto &[slot, p] : peers) {
            if (slot == self || p.spectator || p.samples.empty() || now - p.arrived > 10) continue;
            const double delay = std::clamp(p.batch + p.jitter, .1, .52);
            const double target = playback_tick(p, (now - p.offset - delay) * 100, now) + 1e-7;
            auto frame = p.samples.front().frame;
            for (size_t i = 1; i < p.samples.size(); i++) {
                const auto &a = p.samples[i - 1].frame, &b = p.samples[i].frame;
                if (target >= b.tick) {
                    frame = b;
                    continue;
                }
                if (target < a.tick) break;
                const float t = float(std::clamp((target - a.tick) / double(b.tick - a.tick), 0., 1.));
                frame = b;
                const float dt = float(b.tick - a.tick) * .01f;
                bool smooth = dt > 0 && dt <= .12f;
                for (int k = 0; k < 3; k++) {
                    const float avg = (b.position[k] - a.position[k]) / dt,
                                mean = (a.velocity[k] + b.velocity[k]) * .5f;
                    if (std::abs(avg - mean) > std::abs(avg) * .15f + 60) smooth = false;
                }
                for (int k = 0; k < 3; k++) {
                    const float linear = a.position[k] + (b.position[k] - a.position[k]) * t;
                    frame.position[k] = smooth && !(k == 2 && (a.flags & 2) && (b.flags & 2))
                                                ? (2 * t * t * t - 3 * t * t + 1) * a.position[k]
                                                          + (t * t * t - 2 * t * t + t) * dt * a.velocity[k]
                                                          + (-2 * t * t * t + 3 * t * t) * b.position[k]
                                                          + (t * t * t - t * t) * dt * b.velocity[k]
                                                : linear;
                    frame.velocity[k] = a.velocity[k] + (b.velocity[k] - a.velocity[k]) * t;
                }
                const float dy = std::remainder(b.yaw - a.yaw, 360.f);
                frame.yaw = a.yaw + dy * t;
                frame.pitch = a.pitch + (b.pitch - a.pitch) * t;
                break;
            }
            if (target > p.samples.back().frame.tick) {
                const float extra = float(std::clamp((target - p.samples.back().frame.tick) * .01, 0., .1));
                for (int k = 0; k < 3; k++)
                    frame.position[k] += frame.velocity[k] * extra;
            }
            if (p.rendered_at != now) {
                p.actor.jumped = false;
                p.actor.attack = 0;
                p.actor.inspect = 0;
                p.actor.snapped = false;
                for (const auto &sample : p.samples)
                    if (sample.frame.tick <= target || (sample.teleport && p.rendered == 0)) {
                        if (sample.frame.tick > p.rendered) {
                            p.actor.jumped |= bool(sample.wire_flags & 4);
                            p.actor.attack = sample.wire_flags & 32 ? 2 : sample.wire_flags & 16 ? 1 : p.actor.attack;
                            const auto inspect = (sample.wire_flags >> 6) & 3;
                            if (inspect == 1 || inspect == 2) p.actor.inspect = inspect;
                            p.actor.snapped |= sample.teleport;
                        }
                        p.actor.silenced = sample.silenced;
                        if (((sample.wire_flags >> 6) & 3) == 0)
                            p.actor.inspectHeld = false;
                        else if (((sample.wire_flags >> 6) & 3) == 3)
                            p.actor.inspectHeld = true;
                    }
                p.rendered = std::max(
                        p.rendered, uint32_t(std::max(0., std::min(target, double(p.samples.back().frame.tick))))
                );
                p.rendered_at = now;
            }
            p.actor.frame = frame;
            out.push_back(p.actor);
        }
        return out;
    }

    // What a player's tag shows after the name (net/players.ts): their time while running or finished, "start" in the
    // start zone, preceded by the style's short name unless it is Normal.
    void tag_detail(unsigned slot, double now, HudLabel<48> &out) const {
        constexpr std::array<std::string_view, 8> short_styles = {"NM", "EZ", "W", "SW", "HSW", "AS", "SCR", "LG"};
        constexpr unsigned timer_start = 1, timer_running = 2, timer_finished = 3;
        out.assign("");
        const auto found = peers.find(slot);
        if (found == peers.end() || !found->second.wire.known) return;
        const auto &peer = found->second;
        const auto &wire = peer.wire;
        if (wire.style != 0 && wire.style < short_styles.size()) out.assign(short_styles[wire.style]);
        if (wire.timer == timer_running || wire.timer == timer_finished) {
            const double running =
                    wire.timer == timer_running && peer.meta_at > 0 ? std::max(0., now - peer.meta_at) : 0;
            HudLabel<48> time;
            format_hud_time(time, wire.timer_ticks * .01 + running);
            if (!out.empty()) out.append(" · ");
            out.append(time.view());
        } else if (wire.timer == timer_start) {
            if (!out.empty()) out.append(" · ");
            out.append("start");
        }
    }

    std::optional<std::pair<unsigned, double>> timer(unsigned slot, double now) const {
        const auto it = peers.find(slot);
        if (it == peers.end() || !it->second.meta.is_object()) return std::nullopt;
        const auto &p = it->second;
        const unsigned state = p.meta.value("timer", 0u);
        const double seconds = p.meta.value("timerTicks", 0.) * .01
                               + (state == 2 && p.meta_at > 0 ? std::max(0., now - p.meta_at) : 0.);
        return std::pair<unsigned, double>{state, seconds};
    }

    nlohmann::json scoreboard(double now) const {
        auto rows = nlohmann::json::array();
        for (const auto &[slot, p] : peers) {
            auto row = p.info.is_object() ? p.info : nlohmann::json::object();
            row["slot"] = slot;
            row["name"] = p.actor.name;
            row["meta"] = p.meta;
            if (p.meta.is_object()) {
                row["track"] = p.meta.value("track", 0);
                row["ping"] = p.meta.value("ping", 0);
            }
            const auto time = timer(slot, now);
            if (time) {
                row["timer"] = time->first;
                row["seconds"] = time->second;
            }
            rows.push_back(row);
        }
        return rows;
    }

    std::string change_notice(double epoch_ms) const {
        if (!change.is_object() || !change.contains("at") || !change["at"].is_number()) return {};
        const auto left = std::max(0., std::ceil((change["at"].get<double>() - clock_offset_ms - epoch_ms) / 1000));
        return "Changing to " + change.value("map", std::string()) + " in " + std::to_string(int(std::min(left, 999.)))
               + "s";
    }

    std::optional<native_render::Actor> spectated(double now) {
        if (!spectator_target) return std::nullopt;
        for (auto &actor : actors(now))
            if (actor.id == std::to_string(*spectator_target)) return actor;
        return std::nullopt;
    }
};
}  // namespace native
