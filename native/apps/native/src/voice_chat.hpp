#pragma once
// Voice chat in rooms, the game side: push to talk (the voiceRecord bind, X by default), everyone in the room hears
// everyone, guests listen only. The room socket lives in the menu, which hands VOICE_DOWN frames over and sends the
// VOICE_UP packets this returns (ui/voice-relay.ts); the audio work happens in voice::Engine.
//
// In a room that relays voice the push to talk key is voice's, even where it shares a key with another bind (X is
// also the checkpoint teleport): the same rule as the website. Outside such a room the key does its other job.
#include "voice_engine.hpp"
#include "voice_wire.hpp"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <array>
#include <cmath>
#include <memory>
#include <span>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace native {

class RoomState;

namespace voice {

constexpr size_t hud_row_count = 5;
constexpr double line_ms = 3500;
constexpr double hud_refresh_ms = 16;
constexpr size_t max_talkers_at_once = 6;
// The settings slider's curve, as every volume slider on the website (audio/engine.ts sliderGain).
constexpr float slider_exponent = 1.7f;

inline float slider_gain(float value) {
    return value <= 0 ? 0 : std::pow(std::min(1.f, value), slider_exponent);
}

enum class Line { none, guest, muted, blocked, failed, limit, busy, asking };

std::string_view line_text(Line line);

struct HudRow {
    unsigned slot = 0;
    bool self = false;
    std::string_view name;
    float level = 0;
    Bands bands{};
};

struct Person {
    bool present = false, guest = false, room_muted = false;
    std::string id, name;
};

struct PersonChoice {
    bool muted = false;
    float volume = 1;
};

class VoiceChat {
public:
    explicit VoiceChat(std::unique_ptr<Engine> engine) : engine_(std::move(engine)) {}

    // Settings changed: voiceEnabled, voiceVolume and the voiceRecord bind.
    void settings(const nlohmann::json &preferences);
    // Your mutes and volumes per account id, from the menu ({id: {m: 1, v: 1.5}}, as voice-people on the website).
    void people(const nlohmann::json &choices);
    // After every room event: whether the room relays voice, who you are, who is in it.
    void room(const RoomState &room);
    // A VOICE_DOWN from the menu, base64.
    void receive(std::string_view base64_frame);
    // A game key. True when it was the push to talk key in a voice room (nothing else should act on it).
    bool key(const std::string &code, bool down, bool repeat);
    // Once a frame. `keys_free` false (menu, chat, focus lost) lets go of the key.
    void frame(double now_ms, float master_volume, bool keys_free);
    // VOICE_UP packets that are due, base64, within the room's budget.
    std::vector<std::string> outgoing(double now_ms);

    bool active() const { return active_; }

    bool enabled() const { return enabled_; }

    // Talking now (the speaker mark on a name tag or scoreboard row).
    bool talking(unsigned slot) const { return slot < slot_count && talking_[slot]; }

    std::span<const bool> talking_slots() const { return talking_; }

    std::span<const HudRow> rows() const { return std::span(rows_).first(row_count_); }

    // The plain line under the talker list while it shows, else empty.
    std::string_view line(double now_ms) const { return now_ms < line_until_ms_ ? line_text(line_) : ""; }

    Engine &engine() { return *engine_; }

private:
    std::unique_ptr<Engine> engine_;
    bool enabled_ = true, active_ = false, held_ = false;
    float volume_ = .8f, master_ = 1;
    std::vector<std::string> keys_{"KeyX"};
    std::string room_id_;
    uint64_t room_generation_ = 0;
    unsigned self_ = slot_count;
    std::array<Person, slot_count> people_{};
    std::unordered_map<std::string, PersonChoice> choices_;
    std::array<TalkerView, slot_count> views_{};
    std::array<bool, slot_count> talking_{};
    std::array<double, slot_count> talking_since_{};
    std::array<HudRow, hud_row_count> rows_{};
    size_t row_count_ = 0;
    Line line_ = Line::none;
    double line_until_ms_ = 0, now_ms_ = 0, refreshed_ms_ = -hud_refresh_ms;
    RelayBudget budget_;

    void say(Line line);
    void press();
    void release();
    void apply_gains();
    void set_active(bool active);
    void refresh();
    void take_events();
};

}  // namespace voice
}  // namespace native
