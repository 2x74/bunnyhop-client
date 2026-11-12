// Voice chat: the wire format against vectors from the website's voice-wire.ts, real Opus through it, the playout
// queue, talking (spurts, release tail, the 59 s stop, the room's budgets), listening (concealment, gains) and the
// game side's rules (the key only belongs to voice in a voice room, guests and room mutes).
#include "room_state.hpp"
#include "settings.hpp"
#include "voice_chat.hpp"
#include "voice_codec.hpp"
#include "voice_engine.hpp"
#include "voice_playout.hpp"
#include "voice_receiver.hpp"
#include "voice_sender.hpp"
#include "voice_hud.hpp"
#include "voice_wire.hpp"
#include <cassert>
#include <chrono>
#include <cmath>
#include <fstream>
#include <iostream>
#include <thread>

using Json = nlohmann::json;
namespace voice = native::voice;
namespace voice_hud = native::voice_hud;
using native::HudGeometry;
using native::HudRect;

namespace {

constexpr float tone_amplitude = .3f;
constexpr double two_pi = 6.283185307179586;

std::vector<uint8_t> from_hex(const std::string &text) {
    std::vector<uint8_t> out;
    for (size_t i = 0; i + 1 < text.size(); i += 2)
        out.push_back(uint8_t(std::stoul(text.substr(i, 2), nullptr, 16)));
    return out;
}

std::array<float, voice::frame_samples> tone_frame(double frequency_hz, uint64_t frame_index) {
    std::array<float, voice::frame_samples> pcm{};
    for (int i = 0; i < voice::frame_samples; ++i) {
        const double t = double(frame_index * voice::frame_samples + uint64_t(i)) / voice::sample_rate;
        pcm[size_t(i)] = tone_amplitude * float(std::sin(two_pi * frequency_hz * t));
    }
    return pcm;
}

double rms(std::span<const float> pcm) {
    double energy = 0;
    for (const float sample : pcm)
        energy += double(sample) * sample;
    return std::sqrt(energy / double(pcm.size()));
}

// Goertzel power at `frequency_hz`.
double power_at(std::span<const float> pcm, double frequency_hz) {
    const double k = 2 * std::cos(two_pi * frequency_hz / voice::sample_rate);
    double s1 = 0, s2 = 0;
    for (const float sample : pcm) {
        const double s = sample + k * s1 - s2;
        s2 = s1;
        s1 = s;
    }
    return s1 * s1 + s2 * s2 - k * s1 * s2;
}

void test_wire_matches_the_website(const Json &vectors) {
    const auto &constants = vectors.at("constants");
    assert(constants.at("voiceUp") == voice::message_voice_up);
    assert(constants.at("voiceDown") == voice::message_voice_down);
    assert(constants.at("start") == voice::flag_start && constants.at("end") == voice::flag_end);
    assert(constants.at("frameSamples") == voice::frame_samples);
    assert(constants.at("bitrate") == voice::bitrate_bits_per_second);
    assert(constants.at("framesPerPacket") == voice::frames_per_packet);
    assert(constants.at("maxFrames") == voice::max_frames);
    assert(constants.at("maxOpusFrame") == voice::max_opus_frame_bytes);
    assert(constants.at("maxVoiceUpBytes") == voice::max_voice_up_bytes);
    assert(constants.at("maxVoiceDownBytes") == voice::max_voice_down_bytes);
    for (const auto &c : vectors.at("up")) {
        std::vector<std::vector<uint8_t>> frames;
        for (const auto &frame : c.at("frames"))
            frames.push_back(from_hex(frame.get<std::string>()));
        std::vector<std::span<const uint8_t>> views(frames.begin(), frames.end());
        const auto encoded = voice::encode_voice_up(c.at("flags").get<uint8_t>(), c.at("seq").get<uint16_t>(), views);
        assert(encoded && *encoded == from_hex(c.at("up").get<std::string>()));
        const auto parsed = voice::parse_voice_up(*encoded);
        assert(parsed && parsed->flags == c.at("flags") && parsed->seq == c.at("seq"));
        assert(parsed->frame_count == frames.size());
        const auto down_bytes = from_hex(c.at("down").at("bytes").get<std::string>());
        const auto down = voice::parse_voice_down(down_bytes);
        assert(down && down->slot == c.at("down").at("slot") && down->packet.seq == c.at("seq"));
        for (size_t i = 0; i < frames.size(); ++i)
            assert(std::equal(
                    frames[i].begin(), frames[i].end(), down->packet.frames[i].begin(), down->packet.frames[i].end()
            ));
    }
    for (const auto &bytes : vectors.at("malformedUp"))
        assert(!voice::parse_voice_up(from_hex(bytes.get<std::string>())));
    for (const auto &bytes : vectors.at("malformedDown"))
        assert(!voice::parse_voice_down(from_hex(bytes.get<std::string>())));
    for (const auto &c : vectors.at("seqAfter"))
        assert(voice::seq_after(c.at("a").get<uint16_t>(), c.at("b").get<uint16_t>()) == c.at("after").get<bool>());
}

void test_never_builds_what_the_room_refuses() {
    const std::vector<uint8_t> big(voice::max_opus_frame_bytes + 1, 1), tiny(10, 1);
    assert(!voice::encode_voice_up(0, 1, std::vector<std::span<const uint8_t>>{}));
    assert(!voice::encode_voice_up(0, 1, std::vector<std::span<const uint8_t>>{big}));
    assert(!voice::encode_voice_up(0, 1, std::vector<std::span<const uint8_t>>{tiny, tiny, tiny, tiny}));
    assert(!voice::encode_voice_up(4, 1, std::vector<std::span<const uint8_t>>{tiny}));
    assert(voice::encode_voice_up(voice::flag_end, 1, std::vector<std::span<const uint8_t>>{}));
}

void test_opus_round_trip_through_the_wire() {
    voice::Encoder encoder;
    voice::Decoder decoder;
    size_t bytes = 0;
    std::vector<std::vector<uint8_t>> packets;
    for (uint64_t f = 0; f < 50; ++f) {
        const auto pcm = tone_frame(440, f);
        std::array<uint8_t, voice::max_opus_frame_bytes> packet{};
        const size_t size = encoder.encode(pcm, packet);
        assert(size > 0 && size <= voice::max_opus_frame_bytes);
        bytes += size;
        packets.emplace_back(packet.begin(), packet.begin() + std::ptrdiff_t(size));
    }
    const double kbps = double(bytes) * 8 / 1000;
    assert(kbps > 12 && kbps < 40);
    std::array<float, voice::frame_samples> last{};
    for (size_t i = 0; i < packets.size(); i += 2) {
        std::vector<std::span<const uint8_t>> pair{packets[i], packets[i + 1]};
        const auto up = voice::encode_voice_up(i ? 0 : voice::flag_start, uint16_t(i / 2), pair);
        assert(up);
        std::vector<uint8_t> down{voice::message_voice_down, 4};
        down.insert(down.end(), up->begin() + 1, up->end());
        const auto parsed = voice::parse_voice_down(down);
        assert(parsed && parsed->slot == 4);
        for (size_t k = 0; k < parsed->packet.frame_count; ++k)
            assert(decoder.decode(parsed->packet.frames[k], last));
    }
    assert(std::abs(rms(last) - tone_amplitude / std::sqrt(2.)) < .03);
    assert(power_at(last, 440) > 100 * power_at(last, 660));
    // Concealment of a lost frame gives a frame, quieter or not, never garbage.
    assert(decoder.decode({}, last));
    assert(rms(last) < tone_amplitude);
    std::cout << "opus: " << kbps << " kbit/s, level " << voice::level_of(last) << '\n';
}

void push_frames(voice::Playout &playout, int count) {
    for (int i = 0; i < count; ++i)
        playout.push().pcm.fill(.1f);
}

int mix_ms(voice::Playout &playout, int milliseconds) {
    std::vector<float> out(size_t(milliseconds * voice::sample_rate / 1000));
    playout.mix(out, 1);
    return int(std::count_if(out.begin(), out.end(), [](float v) { return v != 0; }) * 1000 / voice::sample_rate);
}

void test_playout_queue() {
    voice::Playout playout;
    playout.start_spurt();
    push_frames(playout, 3);
    assert(mix_ms(playout, 10) == 0);  // 60 ms queued, the spurt starts at 80
    push_frames(playout, 1);
    assert(playout.depth_ms() == 80);
    assert(mix_ms(playout, 80) == 80);
    // Dry in the middle of a spurt: a pause, and 20 ms more margin from then on.
    assert(mix_ms(playout, 20) == 0 && playout.stats.dry == 1 && playout.target_ms() == 100);
    push_frames(playout, 4);
    assert(mix_ms(playout, 10) == 0);
    push_frames(playout, 1);
    assert(mix_ms(playout, 100) == 100);
    // A burst after a stall: past target + 80 ms the oldest frames go, back to the target.
    push_frames(playout, 9);
    assert(playout.depth_ms() == 180 && playout.stats.dropped == 0);
    push_frames(playout, 1);
    assert(playout.depth_ms() == playout.target_ms() && playout.stats.dropped > 0);
    // The end plays out what's left, then the talker is quiet.
    playout.end_spurt();
    assert(mix_ms(playout, 200) == 100 && !playout.audible());
    // A short spurt that ends before 80 ms are queued still plays.
    playout.start_spurt();
    push_frames(playout, 2);
    playout.end_spurt();
    assert(mix_ms(playout, 60) == 40 && !playout.audible());
    // A calm connection brings the target down, never under 60 ms.
    voice::Playout calm;
    calm.start_spurt();
    for (int i = 0; i < 2000; ++i) {
        push_frames(calm, 1);
        mix_ms(calm, 20);
    }
    assert(calm.target_ms() >= voice::playout_min_ms && calm.target_ms() <= voice::playout_max_ms);
}

std::vector<uint8_t> down_of(const voice::Bytes &up, unsigned slot) {
    std::vector<uint8_t> down{voice::message_voice_down, uint8_t(slot)};
    down.insert(down.end(), up.begin() + 1, up.end());
    return down;
}

std::vector<voice::Bytes> talk(voice::Sender &sender, int frames, double frequency_hz, uint64_t &frame_index) {
    std::vector<voice::Bytes> out;
    for (int i = 0; i < frames; ++i)
        sender.frame(tone_frame(frequency_hz, frame_index++), out);
    return out;
}

void test_sender_spurts() {
    voice::Sender sender;
    uint64_t frame_index = 0;
    std::vector<voice::Bytes> out;
    assert(!sender.transmitting());
    sender.press();
    out = talk(sender, 10, 440, frame_index);
    assert(out.size() == 5);
    for (size_t i = 0; i < out.size(); ++i) {
        const auto packet = voice::parse_voice_up(out[i]);
        assert(packet && packet->frame_count == 2 && packet->seq == i + 1);
        assert(packet->flags == (i == 0 ? voice::flag_start : 0));
    }
    sender.release();
    out = talk(sender, voice::release_tail_frames, 440, frame_index);
    assert(!sender.transmitting());
    const auto last = voice::parse_voice_up(out.back());
    assert(last && last->flags == voice::flag_end && last->frame_count == voice::release_tail_frames % 2);
    // A press inside the tail carries on the same spurt.
    sender.press();
    talk(sender, 4, 440, frame_index);
    sender.release();
    talk(sender, 3, 440, frame_index);
    sender.press();
    out = talk(sender, 20, 440, frame_index);
    assert(sender.transmitting());
    for (const auto &bytes : out)
        assert(!(voice::parse_voice_up(bytes)->flags & voice::flag_end));
    // The 59 s stop.
    std::vector<voice::Bytes> rest;
    voice::Sender::Stop stop = voice::Sender::Stop::none;
    for (unsigned i = 0; i < voice::client_spurt_frames && stop == voice::Sender::Stop::none; ++i)
        stop = sender.frame(tone_frame(440, frame_index++), rest);
    assert(stop == voice::Sender::Stop::limit && !sender.transmitting() && !sender.held());
    assert(voice::parse_voice_up(rest.back())->flags & voice::flag_end);
    // Stopping at once sends an END.
    sender.press();
    out.clear();
    sender.stop_now(out);
    assert(out.size() == 1 && voice::parse_voice_up(out[0])->flags == (voice::flag_start | voice::flag_end));
}

void test_relay_budget() {
    voice::RelayBudget budget;
    // Real time: a packet of two 60-byte frames every 40 ms always fits.
    for (int i = 0; i < 2000; ++i)
        assert(budget.spend(2, 130, i * 40.));
    // A stall that bunches 20 packets up: the room's burst of 8 packets lets 8 through, the rest would earn strikes.
    voice::RelayBudget bunched;
    int passed = 0;
    for (int i = 0; i < 20; ++i)
        passed += bunched.spend(2, 130, 1000);
    assert(passed == 8);
    // One frame per packet at 50 a second is over the room's packet rate (one per 30 ms) and must not all go.
    voice::RelayBudget single;
    int sent = 0;
    for (int i = 0; i < 500; ++i)
        sent += single.spend(1, 70, i * 20.);
    assert(sent < 350);
}

void test_receiver_conceals_and_mixes() {
    voice::Receiver receiver;
    voice::Sender sender;
    uint64_t frame_index = 0;
    sender.press();
    auto packets = talk(sender, 20, 440, frame_index);
    assert(packets.size() == 10);
    // Your own voice never comes back, and a malformed frame is refused.
    receiver.receive(down_of(packets[0], 2), 0, 2);
    receiver.receive(std::vector<uint8_t>{voice::message_voice_down, 3, 0}, 0, 2);
    assert(receiver.stats.packets == 0 && receiver.stats.refused == 1 && receiver.stats.malformed == 1);
    for (size_t i = 0; i < packets.size(); ++i)
        if (i != 4) receiver.receive(down_of(packets[i], 5), double(i) * .04, 2);
    assert(receiver.stats.packets == 9 && receiver.stats.concealed == 2 && receiver.stats.frames == 20);
    std::array<voice::TalkerView, voice::slot_count> views{};
    receiver.snapshot(views);
    assert(views[5].audible && !views[2].audible);
    std::vector<float> out(voice::sample_rate / 10);
    receiver.mix(out, 1);
    assert(rms(out) > .1);
    // Your mute: nothing plays and the talker doesn't show as talking.
    receiver.set_gain(5, 0);
    std::fill(out.begin(), out.end(), 0.f);
    receiver.mix(out, 1);
    assert(rms(out) == 0);
    receiver.snapshot(views);
    assert(!views[5].audible);
    // No END and no packet for 0.6 s: the spurt is over.
    receiver.end_silent(10);
    receiver.set_gain(5, 1);
    std::vector<float> rest(voice::sample_rate);
    receiver.mix(rest, 1);
    receiver.snapshot(views);
    assert(!views[5].audible);
}

Json welcome(unsigned you, bool voice_room, const std::string &provider, bool muted = false) {
    Json you_player{{"slot", you}, {"id", "me"}, {"name", "Me"}, {"provider", provider}, {"style", "autohop"}};
    if (muted) you_player["voiceMuted"] = true;
    Json other{{"slot", 4}, {"id", "u4"}, {"name", "Other"}, {"provider", "discord"}, {"style", "autohop"}};
    Json room{{"id", "voice-bhop"}, {"name", "Voice"}};
    if (voice_room) room["voice"] = 1;
    return {{"generation", 1},
            {"id", "voice-bhop"},
            {"event",
             {{"t", "welcome"},
              {"you", you},
              {"room", room},
              {"map", {{"name", "bhop_eazy"}}},
              {"players", Json::array({you_player, other})}}}};
}

std::unique_ptr<voice::Engine> test_engine() {
    return std::make_unique<voice::Engine>([] { return voice::tone_source(440, .2f); }, false);
}

// Runs frames at a steady clock until `ready` holds.
template <class Ready>
bool frames_until(voice::VoiceChat &chat, double &now_ms, Ready ready) {
    for (int i = 0; i < 400 && !ready(); ++i) {
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
        chat.frame(now_ms += 20, 1, true);
    }
    return ready();
}

template <class Ready>
bool wait_for(Ready ready) {
    for (int i = 0; i < 400 && !ready(); ++i)
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    return ready();
}

void test_the_key_belongs_to_voice_only_in_voice_rooms() {
    native::RoomState room;
    voice::VoiceChat chat(test_engine());
    chat.settings(native::default_settings());
    assert(!chat.key("KeyX", true, false));
    room.event(welcome(2, false, "discord"));
    chat.room(room);
    assert(!chat.active() && !chat.key("KeyX", true, false));
    room.event(welcome(2, true, "discord"));
    chat.room(room);
    assert(chat.active() && chat.key("KeyX", true, false) && !chat.key("KeyW", true, false));
    assert(wait_for([&] { return chat.engine().transmitting(); }));
    assert(chat.key("KeyX", false, false));
    // Off in settings: the key goes back to its other bind and nothing is heard.
    auto off = native::default_settings();
    off["voiceEnabled"] = false;
    chat.settings(off);
    assert(!chat.active() && !chat.key("KeyX", true, false));
    // Rebound: the old key is free again.
    auto rebound = native::default_settings();
    rebound["binds"]["voiceRecord"] = {"Mouse4"};
    chat.settings(rebound);
    chat.room(room);
    assert(chat.key("Mouse4", true, false) && !chat.key("KeyX", true, false));
}

void test_saved_binds_get_push_to_talk_on_x() {
    // A player who saved binds before voice: X stays the teleport and is push to talk too.
    const Json saved{{"binds", {{"cpTeleport", {"KeyX"}}, {"jump", {"Space"}}}}};
    auto out = native::default_settings();
    native::fill_new_binds(saved, out);
    assert(out["binds"]["voiceRecord"] == Json::array({"KeyX"}));
}

void test_guests_and_room_mutes_send_nothing() {
    native::RoomState room;
    voice::VoiceChat guest(test_engine());
    guest.settings(native::default_settings());
    room.event(welcome(2, true, "guest"));
    guest.room(room);
    guest.frame(1000, 1, true);
    assert(guest.key("KeyX", true, false));
    assert(guest.line(1000) == "You need an account to talk.");
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    assert(!guest.engine().transmitting() && guest.outgoing(1100).empty());
    native::RoomState muted_room;
    voice::VoiceChat muted(test_engine());
    muted.settings(native::default_settings());
    muted_room.event(welcome(2, true, "discord", true));
    muted.room(muted_room);
    assert(muted.key("KeyX", true, false));
    assert(muted.line(0) == "You're muted from voice in this room.");
    assert(!muted.engine().transmitting());
}

void test_talking_sends_packets_and_marks_you() {
    native::RoomState room;
    voice::VoiceChat chat(test_engine());
    chat.settings(native::default_settings());
    room.event(welcome(2, true, "discord"));
    chat.room(room);
    chat.key("KeyX", true, false);
    std::this_thread::sleep_for(std::chrono::milliseconds(300));
    chat.frame(300, 1, true);
    assert(chat.talking(2) && chat.rows().size() == 1 && chat.rows()[0].self && chat.rows()[0].name == "Me");
    const auto sent = chat.outgoing(300);
    assert(sent.size() >= 5);
    chat.key("KeyX", false, false);
    assert(wait_for([&] { return !chat.engine().transmitting(); }));
    const auto tail = chat.outgoing(700);
    assert(!tail.empty());
    const auto last = native::base64_decode(tail.back());
    assert(last
           && voice::parse_voice_up(std::span(reinterpret_cast<const uint8_t *>(last->data()), last->size()))->flags
                      & voice::flag_end);
}

void test_your_mutes_and_volumes() {
    native::RoomState room;
    voice::VoiceChat chat(test_engine());
    chat.settings(native::default_settings());
    room.event(welcome(2, true, "discord"));
    chat.room(room);
    voice::Sender talker;
    uint64_t frame_index = 0;
    talker.press();
    for (const auto &packet : talk(talker, 10, 660, frame_index)) {
        const auto down = down_of(packet, 4);
        chat.receive(native::base64(std::string(down.begin(), down.end())));
    }
    double now = 0;
    assert(frames_until(chat, now, [&] { return chat.talking(4); }));
    assert(chat.rows().size() == 1 && chat.rows()[0].slot == 4 && chat.rows()[0].name == "Other");
    chat.people(Json{{"u4", {{"m", 1}, {"t", 1}}}});
    chat.frame(now += 20, 1, true);
    assert(!chat.talking(4));
    chat.people(Json{{"u4", {{"v", 1.5}, {"t", 1}}}});
    chat.frame(now += 20, 1, true);
    assert(chat.talking(4));
}

void test_player_leaving_stops_their_voice() {
    native::RoomState room;
    voice::VoiceChat chat(test_engine());
    chat.settings(native::default_settings());
    room.event(welcome(2, true, "discord"));
    chat.room(room);
    voice::Sender talker;
    uint64_t frame_index = 0;
    talker.press();
    for (const auto &packet : talk(talker, 10, 660, frame_index)) {
        const auto down = down_of(packet, 4);
        chat.receive(native::base64(std::string(down.begin(), down.end())));
    }
    double now = 0;
    assert(frames_until(chat, now, [&] { return chat.talking(4); }));
    room.event({{"generation", 1}, {"id", "voice-bhop"}, {"event", {{"t", "leave"}, {"slot", 4}}}});
    chat.room(room);
    assert(frames_until(chat, now, [&] { return !chat.talking(4); }));
}

// The talker list starts at the bottom left and moves above the key row (and the chat) where it would cover them.
void test_talker_list_clears_the_key_row_and_chat() {
    const HudGeometry geometry(1920, 1080, 100);
    const float list = 4 * voice_hud::row_height_px;
    const float free_top = voice_hud::list_top(geometry, list, {});
    assert(free_top == geometry.height - voice_hud::bottom_gap_px - list);
    const float s = geometry.scale;
    const HudRect keys{26 * s, (geometry.height - 65) * s, 380 * s, 27 * s};
    const std::array<HudRect, 1> only_keys{keys};
    const float over_keys = voice_hud::list_top(geometry, list, only_keys);
    assert(over_keys + list <= geometry.height - 65);
    const HudRect chat{20 * s, (geometry.height - 65 - 150) * s, 500 * s, 140 * s};
    const std::array<HudRect, 2> keys_and_chat{keys, chat};
    const float over_both = voice_hud::list_top(geometry, list, keys_and_chat);
    assert(over_both + list <= geometry.height - 65 - 150);
    const std::array<HudRect, 1> elsewhere{HudRect{900 * s, (geometry.height - 65) * s, 300 * s, 27 * s}};
    assert(voice_hud::list_top(geometry, list, elsewhere) == free_top);
}

}  // namespace

int main(int argc, char **argv) {
    if (argc < 2) {
        std::cerr << "usage: bunnyhop-native-voice-tests voice_wire_vectors.json\n";
        return 2;
    }
    std::ifstream file(argv[1]);
    const auto vectors = Json::parse(file);
    test_wire_matches_the_website(vectors);
    test_never_builds_what_the_room_refuses();
    test_opus_round_trip_through_the_wire();
    test_playout_queue();
    test_sender_spurts();
    test_relay_budget();
    test_receiver_conceals_and_mixes();
    test_the_key_belongs_to_voice_only_in_voice_rooms();
    test_saved_binds_get_push_to_talk_on_x();
    test_guests_and_room_mutes_send_nothing();
    test_talking_sends_packets_and_marks_you();
    test_your_mutes_and_volumes();
    test_player_leaving_stops_their_voice();
    test_talker_list_clears_the_key_row_and_chat();
    std::cout << "voice tests passed\n";
    return 0;
}
