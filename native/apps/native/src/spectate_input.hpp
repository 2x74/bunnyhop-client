#pragma once
// The watched player's HUD feed in a room (web net/spectate-input.ts, protocol.ts input block and EXT_INPUT). While
// someone spectates you and the room takes input blocks, each tick's keys, moves, view, velocity and the strafe
// trainer's gain band go out with your state batches, with the jump stats your trackers report. The menu turns the
// block into bytes with the website's own encoder. As a spectator, the watched player's records are played into your
// HUD at the tick the camera shows, read with your own HUD settings.
#include "jhud.hpp"
#include "ssj.hpp"
#include "strafe_trainer.hpp"
#include <nlohmann/json.hpp>
#include <cmath>
#include <cstdint>
#include <deque>
#include <optional>
#include <vector>

namespace native::spectate_input {
// protocol.ts IK_*, IS_*, IG_*, IR_* and the block limits.
inline constexpr unsigned key_forward = 1, key_back = 2, key_left = 4, key_right = 8, key_jump = 16, key_duck = 32;
inline constexpr unsigned state_grounded = 1, state_ladder = 2, state_jumped = 4, state_interrupted = 8,
                          state_reset = 16;
inline constexpr unsigned gain_none = 0, gain_zero = 1, gain_loss = 2, gain_ok = 3, gain_good = 4, gain_perfect = 5;
inline constexpr unsigned report_every = 1, report_sixth = 2, report_start_pre = 3;
inline constexpr size_t max_ticks = 40, max_reports = 8;
// Every keyboard move is 0 or this (input.ts MOVE_SPEED); the block carries only its sign.
inline constexpr float move_speed = 450;
// How long after the last block the watched player's feed counts as live (FEED_LIVE_MS).
inline constexpr double feed_live_seconds = 1;
// The most records and reports a spectator keeps waiting: a few seconds of play.
inline constexpr size_t feed_tick_limit = 400, feed_report_limit = 64;

// The core's IN_* buttons that have a key bit, in protocol order.
inline constexpr std::array<std::pair<uint32_t, unsigned>, 6> key_buttons = {{
        {1u << 3, key_forward},
        {1u << 4, key_back},
        {1u << 9, key_left},
        {1u << 10, key_right},
        {1u << 1, key_jump},
        {1u << 2, key_duck},
}};

inline unsigned keys_of(uint32_t buttons) {
    unsigned keys = 0;
    for (const auto &[button, key] : key_buttons)
        if (buttons & button) keys |= key;
    return keys;
}

inline uint32_t buttons_of(unsigned keys) {
    uint32_t buttons = 0;
    for (const auto &[button, key] : key_buttons)
        if (keys & key) buttons |= button;
    return buttons;
}

// The trainer's gain band of a tick from the core's observation (web gainBandOf).
inline unsigned gain_band(double delta, double best) {
    const auto gain = trainer_bar_gain(delta, best);
    if (!gain) return gain_none;
    if (*gain == 0) return gain_zero;
    switch (trainer_bar_band(gain)) {
        case TrainerBarBand::high:
            return gain_loss;
        case TrainerBarBand::perfect:
            return gain_perfect;
        case TrainerBarBand::good:
            return gain_good;
        case TrainerBarBand::ok:
            return gain_ok;
        case TrainerBarBand::low:
            break;
    }
    return gain_zero;
}

// A gain in that band, for the trainer, which only shows the band (web bandGain). NaN is none.
inline double band_gain(unsigned band) {
    switch (band) {
        case gain_zero:
            return 0;
        case gain_loss:
            return -1;
        case gain_ok:
            return .5;
        case gain_good:
            return .95;
        case gain_perfect:
            return 1;
        default:
            return std::numeric_limits<double>::quiet_NaN();
    }
}

struct Settings {
    double tick_interval = .01;
    float max_speed = 260, air_accelerate = 1000;

    bool operator==(const Settings &) const = default;
};

struct Tick {
    uint32_t tick = 0;
    unsigned keys = 0;
    float forward = 0, side = 0;
    unsigned gain = gain_none, state = 0;
    float yaw = 0, vx = 0, vy = 0;
};

// A jump's report as the sender's trackers made it (protocol.ts NetSsjReport): SsjReport and the JHUD's JSS.
struct Jump {
    SsjReport ssj;
    std::optional<double> jss;
};

struct Report {
    uint32_t tick = 0;
    unsigned kind = report_every;
    Jump jump;
    std::optional<int> start_pre;
};

struct Block {
    Settings settings;
    std::vector<Tick> ticks;
    std::vector<Report> reports;
};

// Sender: what the HUD was fed each tick, kept at that tick's net tick, with the jump stats of the same tick. take()
// hands out the block for the next state batch. Nothing is kept unless `on` (someone watches, the room takes blocks).
class Recorder {
public:
    bool on = false;

    // The HUD's per-tick history started over (a restart): the next record says so.
    void reset() { reset_next_ = true; }

    void report(Report report) {
        if (!on) return;
        waiting_.push_back(std::move(report));
        if (waiting_.size() > max_reports) waiting_.erase(waiting_.begin());
    }

    // The tick at net tick `net_tick`, with its trainer settings.
    void record(Tick tick, uint32_t net_tick, const Settings &settings) {
        if (!on) return;
        tick.tick = net_tick;
        if (reset_next_) tick.state |= state_reset;
        reset_next_ = false;
        // A block has one set of trainer settings: a restart into another style starts a new one.
        const bool continues = !ticks_.empty() && settings_ == settings && ticks_.back().tick + 1 == net_tick;
        if (!continues) ticks_.clear();
        settings_ = settings;
        ticks_.push_back(tick);
        if (ticks_.size() > max_ticks) ticks_.erase(ticks_.begin());
        for (auto &report : waiting_) {
            report.tick = net_tick;
            reports_.push_back(std::move(report));
        }
        waiting_.clear();
        if (reports_.size() > max_reports) reports_.erase(reports_.begin(), reports_.end() - max_reports);
    }

    // The block for the next batch, if there are records. Reports before its first record move to that one.
    std::optional<Block> take() {
        if (ticks_.empty()) return std::nullopt;
        Block block{settings_, std::move(ticks_), std::move(reports_)};
        ticks_.clear();
        reports_.clear();
        for (auto &report : block.reports)
            report.tick = std::max(report.tick, block.ticks.front().tick);
        return block;
    }

    // Nobody watches: keep nothing (the reset mark stays for the next record).
    void clear() {
        ticks_.clear();
        reports_.clear();
        waiting_.clear();
    }

private:
    Settings settings_;
    std::vector<Tick> ticks_;
    std::vector<Report> reports_, waiting_;
    bool reset_next_ = false;
};

// Spectator: the watched player's blocks, played out by net tick.
class Feed {
public:
    void push(const Block &block, double now) {
        for (const auto &tick : block.ticks) {
            const bool newer = !last_ || tick.tick > *last_;
            if (newer && (ticks_.empty() || tick.tick > ticks_.back().first.tick))
                ticks_.emplace_back(tick, block.settings);
        }
        reports_.insert(reports_.end(), block.reports.begin(), block.reports.end());
        while (ticks_.size() > feed_tick_limit)
            ticks_.pop_front();
        while (reports_.size() > feed_report_limit)
            reports_.pop_front();
        received_ = now;
    }

    // Records up to net tick `up_to` in order, each followed by the reports of its tick and before.
    template <class OnTick, class OnReport>
    void take(uint32_t up_to, OnTick &&on_tick, OnReport &&on_report) {
        while (!ticks_.empty() && ticks_.front().first.tick <= up_to) {
            const auto [tick, settings] = ticks_.front();
            ticks_.pop_front();
            on_tick(tick, settings);
            last_ = tick.tick;
            for (auto it = reports_.begin(); it != reports_.end();) {
                if (it->tick > tick.tick) {
                    ++it;
                    continue;
                }
                on_report(*it);
                it = reports_.erase(it);
            }
        }
    }

    bool live(double now) const { return now - received_ < feed_live_seconds; }

    void reset() {
        ticks_.clear();
        reports_.clear();
        last_.reset();
        received_ = -std::numeric_limits<double>::infinity();
    }

private:
    std::deque<std::pair<Tick, Settings>> ticks_;
    std::deque<Report> reports_;
    std::optional<uint32_t> last_;
    double received_ = -std::numeric_limits<double>::infinity();
};

// The block as the menu's encoder takes it (protocol.ts NetInput). Absent fields are null.
inline nlohmann::json to_json(const Block &block) {
    using Json = nlohmann::json;
    const auto optional = [](const auto &value) {
        return value ? Json(*value) : Json(nullptr);
    };
    Json ticks = Json::array(), reports = Json::array();
    for (const auto &t : block.ticks)
        ticks.push_back(
                {{"tick", t.tick},
                 {"keys", t.keys},
                 {"forward", t.forward},
                 {"side", t.side},
                 {"gain", t.gain},
                 {"state", t.state},
                 {"yaw", t.yaw},
                 {"vx", t.vx},
                 {"vy", t.vy}}
        );
    for (const auto &r : block.reports) {
        if (r.kind == report_start_pre) {
            reports.push_back({{"tick", r.tick}, {"kind", r.kind}, {"speed", optional(r.start_pre)}});
            continue;
        }
        const auto &s = r.jump.ssj;
        reports.push_back(
                {{"tick", r.tick},
                 {"kind", r.kind},
                 {"ssj",
                  {{"jump", s.jump},
                   {"speed", s.speed},
                   {"diff", optional(s.diff)},
                   {"height", optional(s.height)},
                   {"gain", optional(s.gain)},
                   {"sync", optional(s.sync)},
                   {"eff", optional(s.eff)},
                   {"strafes", optional(s.strafes)},
                   {"time", optional(s.time)},
                   {"jss", optional(r.jump.jss)}}}}
        );
    }
    return {{"tickInterval", block.settings.tick_interval},
            {"maxSpeed", block.settings.max_speed},
            {"airAccelerate", block.settings.air_accelerate},
            {"ticks", ticks},
            {"reports", reports}};
}

namespace detail {
template <class T>
std::optional<T> number(const nlohmann::json &object, const char *key) {
    const auto it = object.find(key);
    if (it == object.end() || !it->is_number()) return std::nullopt;
    const double value = it->get<double>();
    return std::isfinite(value) ? std::optional{T(value)} : std::nullopt;
}

inline bool read_tick(const nlohmann::json &raw, Tick &t) {
    const auto tick = number<double>(raw, "tick");
    const auto keys = number<double>(raw, "keys"), gain = number<double>(raw, "gain"),
               state = number<double>(raw, "state");
    const auto forward = number<float>(raw, "forward"), side = number<float>(raw, "side");
    const auto yaw = number<float>(raw, "yaw"), vx = number<float>(raw, "vx"), vy = number<float>(raw, "vy");
    if (!tick || !keys || !gain || !state || !forward || !side || !yaw || !vx || !vy) return false;
    if (*tick < 0 || *tick > UINT32_MAX) return false;
    t = {uint32_t(*tick),
         unsigned(*keys) & 0x3f,
         *forward,
         *side,
         unsigned(*gain) & 7,
         unsigned(*state),
         *yaw,
         *vx,
         *vy};
    return true;
}

inline std::optional<Report> read_report(const nlohmann::json &raw) {
    const auto tick = number<double>(raw, "tick"), kind = number<double>(raw, "kind");
    if (!tick || !kind || *tick < 0 || *tick > UINT32_MAX) return std::nullopt;
    Report r;
    r.tick = uint32_t(*tick);
    r.kind = unsigned(*kind);
    if (r.kind == report_start_pre) {
        r.start_pre = number<int>(raw, "speed");
        return r;
    }
    const auto it = raw.find("ssj");
    if ((r.kind != report_every && r.kind != report_sixth) || it == raw.end() || !it->is_object()) return std::nullopt;
    const auto &s = *it;
    const auto jump = number<unsigned>(s, "jump");
    const auto speed = number<int>(s, "speed");
    if (!jump || !speed) return std::nullopt;
    r.jump.ssj = {
            *jump,
            *speed,
            number<int>(s, "diff"),
            number<int>(s, "height"),
            number<float>(s, "gain"),
            number<float>(s, "sync"),
            number<float>(s, "eff"),
            number<unsigned>(s, "strafes"),
            number<double>(s, "time")
    };
    r.jump.jss = number<double>(s, "jss");
    return r;
}
}  // namespace detail

// A block the menu decoded from a snapshot's EXT_INPUT. Records that don't read are a refused block.
inline std::optional<Block> from_json(const nlohmann::json &raw) {
    if (!raw.is_object()) return std::nullopt;
    const auto interval = detail::number<double>(raw, "tickInterval");
    const auto max_speed = detail::number<float>(raw, "maxSpeed"),
               accelerate = detail::number<float>(raw, "airAccelerate");
    const auto ticks = raw.find("ticks"), reports = raw.find("reports");
    if (!interval || *interval <= 0 || !max_speed || !accelerate || ticks == raw.end() || !ticks->is_array()
        || ticks->empty() || ticks->size() > max_ticks || reports == raw.end() || !reports->is_array()
        || reports->size() > max_reports)
        return std::nullopt;
    Block block{{*interval, *max_speed, *accelerate}, {}, {}};
    for (const auto &item : *ticks) {
        Tick tick;
        if (!detail::read_tick(item, tick)) return std::nullopt;
        block.ticks.push_back(tick);
    }
    for (const auto &item : *reports)
        if (auto report = detail::read_report(item)) block.reports.push_back(*report);
    return block;
}

// The jump stats report your Jumps setting shows from a watched player's reports (web shownSsj): every jump from the
// every-jump stream, the 6th or every Nth from the every-6th one.
inline std::optional<SsjReport> shown_jump(const Report &report, SsjMode mode) {
    if (report.kind == report_start_pre) return std::nullopt;
    const bool shown = mode == SsjMode::every ? report.kind == report_every
                                              : report.kind == report_sixth
                                                        && (mode == SsjMode::every_nth || report.jump.ssj.jump == 6);
    return shown ? std::optional{report.jump.ssj} : std::nullopt;
}

// The JHUD's report of a jump (every-jump reports carry it).
inline std::optional<JhudReport> jhud_of(const Report &report) {
    if (report.kind != report_every) return std::nullopt;
    const auto &ssj = report.jump.ssj;
    return JhudReport{ssj.jump, ssj.speed, ssj.gain, ssj.sync, report.jump.jss};
}
}  // namespace native::spectate_input
