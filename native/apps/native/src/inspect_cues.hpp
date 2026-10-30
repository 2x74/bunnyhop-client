#pragma once
#include "nlohmann/json.hpp"
#include <array>
#include <cstdint>
#include <span>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace native_render {

// Sound cues inside a knife's inspect tricks (inspects/combo.ts Cue): the knife leaving the fingers, once per turn of
// a spin, the regrip. The website plays them as quieter knife swings and draws (viewmodel/events.ts).
enum class InspectCue : uint8_t { flip, spin, regrip };

struct InspectCueSound {
    const char *id;
    float gain;
};

inline InspectCueSound inspect_cue_sound(InspectCue cue) {
    switch (cue) {
        case InspectCue::flip:
            return {"carrot_swing", .42f};
        case InspectCue::spin:
            return {"carrot_swing", .2f};
        case InspectCue::regrip:
            return {"carrot_draw", .45f};
    }
    return {"carrot_swing", 0};
}

struct InspectTrickCues {
    std::vector<std::pair<double, InspectCue>> cues;
    double loop_from = 0, loop_to = 0;
};

// Each knife's tricks with their cues, read once from the exported inspect specs ({cues: [[seconds, type]], loop}).
inline std::unordered_map<std::string, std::vector<InspectTrickCues>> parse_inspect_cues(const nlohmann::json &specs) {
    std::unordered_map<std::string, std::vector<InspectTrickCues>> out;
    for (const auto &[knife, tricks] : specs.items()) {
        auto &chain = out[knife];
        for (const auto &trick : tricks) {
            InspectTrickCues cues;
            if (trick.contains("loop") && trick.at("loop").is_array()) {
                cues.loop_from = trick.at("loop").at(0).get<double>();
                cues.loop_to = trick.at("loop").at(1).get<double>();
            }
            for (const auto &cue : trick.value("cues", nlohmann::json::array())) {
                const auto type = cue.at(1).get<std::string>();
                const auto kind = type == "flip"   ? InspectCue::flip
                                  : type == "spin" ? InspectCue::spin
                                                   : InspectCue::regrip;
                cues.cues.emplace_back(cue.at(0).get<double>(), kind);
            }
            chain.push_back(std::move(cues));
        }
    }
    return out;
}

// The cues heard this frame; a frame never passes more than a few.
class InspectCueQueue {
public:
    void push(InspectCue cue) {
        if (count_ < cues_.size()) cues_[count_++] = cue;
    }

    std::span<const InspectCue> cues() const { return {cues_.data(), count_}; }

    void clear() { count_ = 0; }

private:
    std::array<InspectCue, 8> cues_{};
    size_t count_ = 0;
};

// The cues a trick passed from `from` (exclusive) to `to`. When the hold loop wrapped (`to` < `from`), the rest of the
// loop and its start again, so a cue inside the loop plays on every pass (combo.ts update).
inline void collect_inspect_cues(const InspectTrickCues &trick, double from, double to, InspectCueQueue &queue) {
    const auto passed = [&](double after, double until, bool from_inclusive) {
        for (const auto &[seconds, cue] : trick.cues)
            if ((from_inclusive ? seconds >= after : seconds > after) && seconds <= until) queue.push(cue);
    };
    if (to >= from) {
        passed(from, to, false);
        return;
    }
    passed(from, trick.loop_to, false);
    passed(trick.loop_from, to, true);
}

}  // namespace native_render
