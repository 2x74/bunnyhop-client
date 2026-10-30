#include "inspect_cues.hpp"
#include <cassert>

namespace {

// The Whirligig's Flick (two spin cues) and a looped trick with a spin cue inside its hold loop.
const nlohmann::json specs = {
        {"whirligig",
         {{{"duration", 3.2}, {"cues", {{.62, "spin"}, {1.5, "spin"}}}},
          {{"duration", 3.05}, {"loop", {.77, 1.03}}, {"cues", {{.4, "flip"}, {.8, "spin"}, {2.2, "catch"}}}}}}
};

void test_cues_play_once_as_the_trick_passes_them() {
    const auto cues = native_render::parse_inspect_cues(specs);
    const auto &flick = cues.at("whirligig").at(0);
    native_render::InspectCueQueue queue;
    native_render::collect_inspect_cues(flick, 0, .6, queue);
    assert(queue.cues().empty());
    native_render::collect_inspect_cues(flick, .6, .62, queue);
    native_render::collect_inspect_cues(flick, .62, 1.6, queue);
    assert(queue.cues().size() == 2 && queue.cues()[0] == native_render::InspectCue::spin);
}

void test_a_hold_loop_plays_its_cue_on_every_pass() {
    const auto cues = native_render::parse_inspect_cues(specs);
    const auto &pinwheel = cues.at("whirligig").at(1);
    assert(pinwheel.loop_from == .77 && pinwheel.loop_to == 1.03);
    native_render::InspectCueQueue queue;
    native_render::collect_inspect_cues(pinwheel, .3, .9, queue);
    assert(queue.cues().size() == 2);
    queue.clear();
    // Wrapped from 1.0 back to .82: the rest of the loop, then its start again past the spin.
    native_render::collect_inspect_cues(pinwheel, 1., .82, queue);
    assert(queue.cues().size() == 1 && queue.cues()[0] == native_render::InspectCue::spin);
    queue.clear();
    native_render::collect_inspect_cues(pinwheel, 2., 2.3, queue);
    assert(queue.cues().size() == 1 && queue.cues()[0] == native_render::InspectCue::regrip);
}

void test_sounds_match_the_website() {
    assert(std::string(native_render::inspect_cue_sound(native_render::InspectCue::flip).id) == "carrot_swing");
    assert(native_render::inspect_cue_sound(native_render::InspectCue::spin).gain == .2f);
    assert(std::string(native_render::inspect_cue_sound(native_render::InspectCue::regrip).id) == "carrot_draw");
}

void test_the_queue_holds_a_frame() {
    native_render::InspectCueQueue queue;
    for (int i = 0; i < 20; ++i)
        queue.push(native_render::InspectCue::spin);
    assert(queue.cues().size() == 8);
}

}  // namespace

int main() {
    test_cues_play_once_as_the_trick_passes_them();
    test_a_hold_loop_plays_its_cue_on_every_pass();
    test_sounds_match_the_website();
    test_the_queue_holds_a_frame();
}
