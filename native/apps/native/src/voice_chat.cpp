#include "voice_chat.hpp"
#include "base64.hpp"
#include "room_state.hpp"
#include <algorithm>

namespace native::voice {
namespace {

constexpr unsigned voice_room_flag = 1;
constexpr float max_person_volume = 2;

bool json_true(const nlohmann::json &object, const char *key) {
    const auto found = object.find(key);
    return found != object.end() && found->is_boolean() && found->get<bool>();
}

std::string json_string(const nlohmann::json &object, const char *key) {
    const auto found = object.find(key);
    return found != object.end() && found->is_string() ? found->get<std::string>() : std::string();
}

bool room_relays_voice(const RoomState &room) {
    if (room.id.empty() || room.status != "open" || !room.room_info.is_object()) return false;
    const auto voice = room.room_info.find("voice");
    return voice != room.room_info.end() && voice->is_number_integer() && voice->get<int64_t>() == voice_room_flag;
}

}  // namespace

std::string_view line_text(Line line) {
    switch (line) {
        case Line::guest:
            return "You need an account to talk.";
        case Line::muted:
            return "You're muted from voice in this room.";
        case Line::blocked:
            return "The microphone is blocked. Allow bunnyhop in System Settings → Privacy & Security → Microphone.";
        case Line::failed:
#if defined(_WIN32)
            return "The microphone didn't start. Check Settings → Privacy & security → Microphone, desktop apps.";
#else
            return "The microphone didn't start. Check that one is connected and free.";
#endif
        case Line::limit:
            return "One minute at a time. Press again to keep talking.";
        case Line::busy:
            return "Six people are talking. Wait for a gap.";
        case Line::asking:
            return "Allow the microphone to talk.";
        case Line::none:
            break;
    }
    return "";
}

void VoiceChat::settings(const nlohmann::json &preferences) {
    if (!preferences.is_object()) return;
    const auto enabled = preferences.find("voiceEnabled");
    enabled_ = enabled == preferences.end() || !enabled->is_boolean() || enabled->get<bool>();
    const auto volume = preferences.find("voiceVolume");
    if (volume != preferences.end() && volume->is_number()) volume_ = std::clamp(volume->get<float>(), 0.f, 1.f);
    keys_.clear();
    const auto binds = preferences.find("binds");
    if (binds != preferences.end() && binds->is_object()) {
        const auto codes = binds->find("voiceRecord");
        if (codes != binds->end() && codes->is_array())
            for (const auto &code : *codes)
                if (code.is_string()) keys_.push_back(code.get<std::string>());
    }
    set_active(active_ && enabled_);
}

void VoiceChat::people(const nlohmann::json &choices) {
    choices_.clear();
    if (choices.is_object())
        for (const auto &[id, entry] : choices.items()) {
            if (!entry.is_object()) continue;
            PersonChoice choice;
            const auto muted = entry.find("m");
            choice.muted = muted != entry.end() && muted->is_number() && muted->get<int>() == 1;
            const auto volume = entry.find("v");
            if (volume != entry.end() && volume->is_number())
                choice.volume = std::clamp(volume->get<float>(), 0.f, max_person_volume);
            choices_[id] = choice;
        }
    apply_gains();
}

void VoiceChat::room(const RoomState &room) {
    if (room.id != room_id_ || room.generation != room_generation_) {
        room_id_ = room.id;
        room_generation_ = room.generation;
        budget_ = {};
        engine_->clear_talkers();
    }
    if (room.self != self_) {
        self_ = room.self;
        engine_->set_self(self_);
    }
    std::array<bool, slot_count> seen{};
    room.each_player([&](unsigned slot, const nlohmann::json &info, std::string_view name) {
        if (slot >= slot_count) return;
        seen[slot] = true;
        auto &person = people_[slot];
        person.present = true;
        person.id = json_string(info, "id");
        person.name.assign(name);
        person.guest = json_string(info, "provider") == "guest";
        person.room_muted = json_true(info, "voiceMuted");
    });
    for (unsigned slot = 0; slot < slot_count; ++slot)
        if (people_[slot].present && !seen[slot]) {
            people_[slot] = {};
            engine_->forget(slot);
        }
    if (self_ < slot_count && people_[self_].room_muted && (held_ || engine_->transmitting())) {
        held_ = false;
        engine_->stop_talking();
        say(Line::muted);
    }
    apply_gains();
    set_active(enabled_ && room_relays_voice(room));
}

void VoiceChat::receive(std::string_view base64_frame) {
    if (!active_) return;
    const auto bytes = base64_decode(base64_frame);
    if (!bytes) return;
    engine_->receive(std::span(reinterpret_cast<const uint8_t *>(bytes->data()), bytes->size()));
}

bool VoiceChat::key(const std::string &code, bool down, bool repeat) {
    if (!active_ || std::find(keys_.begin(), keys_.end(), code) == keys_.end()) return false;
    if (down && !repeat)
        press();
    else if (!down)
        release();
    return true;
}

void VoiceChat::press() {
    if (self_ >= slot_count || !people_[self_].present) return;
    const auto &me = people_[self_];
    if (me.guest) return say(Line::guest);
    if (me.room_muted) return say(Line::muted);
    if (!engine_->transmitting()) {
        size_t others = 0;
        for (unsigned slot = 0; slot < slot_count; ++slot)
            others += slot != self_ && talking_[slot];
        if (others >= max_talkers_at_once) return say(Line::busy);
    }
    held_ = true;
    engine_->press();
}

void VoiceChat::release() {
    if (!held_) return;
    held_ = false;
    engine_->release();
}

void VoiceChat::frame(double now_ms, float master_volume, bool keys_free) {
    now_ms_ = now_ms;
    if (!keys_free) release();
    master_ = master_volume;
    engine_->set_bus_gain(slider_gain(volume_) * master_);
    take_events();
    if (now_ms - refreshed_ms_ >= hud_refresh_ms) refresh();
}

std::vector<std::string> VoiceChat::outgoing(double now_ms) {
    std::vector<std::string> out;
    for (auto &packet : engine_->take_outgoing()) {
        if (!active_ || packet.size() < voice_up_header_bytes) continue;
        // A packet the room would refuse with a strike is dropped here; listeners conceal the gap.
        if (!budget_.spend(packet[4], packet.size(), now_ms)) continue;
        out.push_back(base64(std::string(packet.begin(), packet.end())));
    }
    return out;
}

void VoiceChat::say(Line line) {
    line_ = line;
    line_until_ms_ = now_ms_ + line_ms;
}

void VoiceChat::take_events() {
    for (const auto event : engine_->take_events()) {
        if (event == EngineEvent::asking) say(Line::asking);
        if (event == EngineEvent::denied) say(Line::blocked);
        if (event == EngineEvent::mic_failed) say(Line::failed);
        if (event == EngineEvent::limit) say(Line::limit);
        if (event != EngineEvent::asking) held_ = false;
    }
}

void VoiceChat::apply_gains() {
    for (unsigned slot = 0; slot < slot_count; ++slot) {
        float gain = 1;
        const auto &person = people_[slot];
        if (person.present && !person.id.empty()) {
            const auto found = choices_.find(person.id);
            if (found != choices_.end()) gain = found->second.muted ? 0 : found->second.volume;
        }
        engine_->set_gain(slot, gain);
    }
}

void VoiceChat::set_active(bool active) {
    if (active == active_) return;
    active_ = active;
    engine_->set_listening(active);
    if (active) return;
    held_ = false;
    engine_->stop_talking();
    engine_->clear_talkers();
}

void VoiceChat::refresh() {
    refreshed_ms_ = now_ms_;
    engine_->snapshot(views_);
    for (unsigned slot = 0; slot < slot_count; ++slot) {
        const bool now_talking = active_ && people_[slot].present && views_[slot].audible;
        if (now_talking && !talking_[slot]) talking_since_[slot] = now_ms_;
        talking_[slot] = now_talking;
    }
    row_count_ = 0;
    if (self_ < slot_count) {
        const bool transmitting = active_ && engine_->transmitting();
        talking_[self_] = transmitting;
        if (transmitting) {
            const auto view = engine_->self_view();
            rows_[row_count_++] = {self_, true, people_[self_].name, view.level, view.bands};
        }
    }
    std::array<unsigned, slot_count> order{};
    size_t count = 0;
    for (unsigned slot = 0; slot < slot_count; ++slot)
        if (talking_[slot] && slot != self_) order[count++] = slot;
    std::sort(order.begin(), order.begin() + std::ptrdiff_t(count), [&](unsigned a, unsigned b) {
        return talking_since_[a] < talking_since_[b];
    });
    for (size_t i = 0; i < count && row_count_ < hud_row_count; ++i) {
        const unsigned slot = order[i];
        rows_[row_count_++] = {slot, false, people_[slot].name, views_[slot].level, views_[slot].bands};
    }
}

}  // namespace native::voice
