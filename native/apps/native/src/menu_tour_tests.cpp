// The native menu tour against the web TourDirector (apps/web/src/attract.ts):
// anchor choice and order, shot bounds from the clear-distance probe, the
// camera path, fade cuts and the reduced-motion still. No GL or map needed.
// Windows SDK headers define `near` to nothing before the client includes this
// header. Keep that include-order condition covered on every test platform.
#define near
#include "menu_tour.hpp"
#undef near
#include <cstdlib>
#include <iostream>

namespace {
void check(bool ok, const char *what) {
    if (!ok) {
        std::cerr << "menu tour: " << what << '\n';
        std::exit(1);
    }
}

bool close_to(double a, double b, double e = 1e-6) {
    return std::abs(a - b) <= e;
}

bool close_to(const native::tour::Vec &a, const native::tour::Vec &b) {
    return close_to(a[0], b[0]) && close_to(a[1], b[1]) && close_to(a[2], b[2]);
}

nlohmann::json entity(const char *cls, const char *name, const char *origin, const char *angles = "0 0 0") {
    return {{"classname", cls}, {"targetname", name}, {"origin", origin}, {"angles", angles}};
}
}  // namespace

int main() {
    using namespace native::tour;
    // Intl.Collator numeric, base sensitivity.
    check(natural_compare("t2", "t10") < 0 && natural_compare("t10", "t2") > 0, "numeric runs compare by value");
    check(natural_compare("Stage3", "stage3") == 0, "letters ignore case");
    check(natural_compare("t02", "t2") == 0 && natural_compare("", "a") < 0, "leading zeros and prefixes");

    // Checkpoints in course order; stacked ones within 160 units dropped;
    // malformed origins ignored; spawns ignored when there are checkpoints.
    const nlohmann::json course = nlohmann::json::array({
            entity("info_teleport_destination", "t10", "1000 0 0", "0 90 0"),
            entity("info_teleport_destination", "t2", "500 0 0", "0 180 0"),
            entity("info_teleport_destination", "t1", "0 0 0"),
            entity("info_teleport_destination", "t1b", "100 0 0"),
            entity("info_teleport_destination", "bad", "1 nan"),
            entity("info_player_start", "", "9000 0 0"),
            {{"classname", "info_teleport_destination"}, {"origin", 7}},
    });
    const auto list = anchors(course);
    check(list.size() == 3, "anchor count");
    check(close_to(list[0].pos, {0, 0, 0}) && close_to(list[1].pos, {500, 0, 0}) && close_to(list[2].pos, {1000, 0, 0}),
          "anchor order");
    check(close_to(list[1].yaw, 180) && close_to(list[2].yaw, 90), "anchor yaw from angles[1]");

    // Fewer than two checkpoints: spawns lead, then the checkpoint.
    const auto spawned =
            anchors(nlohmann::json::array({
                    entity("info_teleport_destination", "t1", "2000 0 0"),
                    entity("info_player_terrorist", "", "0 0 0", "0 45 0"),
                    entity("info_player_counterterrorist", "", "50 0 0"),
                    entity("func_button", "", "4000 0 0"),
            }));
    check(spawned.size() == 2 && close_to(spawned[0].pos, {0, 0, 0}) && close_to(spawned[0].yaw, 45)
                  && close_to(spawned[1].pos, {2000, 0, 0}),
          "spawn fallback");

    // Open space: every bound saturates exactly as on the web.
    std::vector<std::pair<Vec, Vec>> probes;
    const auto open = shots({{{10, 20, 30}, 90}, {{0, 0, 0}, 0}}, [&](const Vec &from, const Vec &dir, double max) {
        probes.push_back({from, dir});
        return max;
    });
    check(open.size() == 2 && probes.size() == 6, "probe per direction");
    check(close_to(probes[0].first, {10, 20, 94}), "probe from eye height");
    check(close_to(probes[0].second, {std::cos(pi / 2), 1, 0}) && close_to(probes[1].second, {-std::cos(pi / 2), -1, 0})
                  && close_to(probes[2].second, {0, 0, 1}),
          "probe directions");
    check(close_to(open[0].from, {10, 20 - 56, 94 + 18}) && close_to(open[0].to, {10, 20 + 560, 94 + 110}),
          "open shot bounds");
    check(close_to(open[0].sway, -.12) && close_to(open[1].sway, .12) && close_to(open[0].yaw, pi / 2),
          "sway alternates");

    // Walls close: the camera never leaves the anchor's eye.
    const auto closed = shots({{{0, 0, 0}, 0}}, [](const Vec &, const Vec &, double) { return 10.0; });
    check(close_to(closed[0].from, {0, 0, 64}) && close_to(closed[0].to, {0, 0, 64}), "closed shot stays put");
    // Partial room: ahead 400 -> 250 travel, behind 50 -> 26 back, ceiling 100 -> 72 rise.
    const auto room = shots({{{0, 0, 0}, 0}}, [](const Vec &, const Vec &dir, double max) {
        return dir[2] > 0 ? 100.0 : dir[0] > 0 ? 400.0 : max == 120 ? 50.0 : max;
    });
    check(close_to(room[0].from, {-26, 0, 64 + 18}) && close_to(room[0].to, {250, 0, 64 + 72}), "bounded shot");

    // No entities: the web's slow pass over the origin.
    const auto none = shots(anchors(nlohmann::json::array()), {});
    check(none.size() == 1 && close_to(none[0].from, {-400, 0, 200}) && close_to(none[0].to, {400, 0, 280}),
          "fallback pass");

    // Camera path: lerp, yaw sway around the middle, pitch easing down.
    const auto start = place(open[0], 0), end = place(open[0], 1);
    check(close_to(start.eye, open[0].from) && close_to(end.eye, open[0].to), "camera lerp");
    check(close_to(start.yaw, 90 + .06 * 180 / pi) && close_to(end.yaw, 90 - .06 * 180 / pi), "yaw sway");
    check(close_to(start.pitch, .1 * 180 / pi) && close_to(end.pitch, .16 * 180 / pi), "pitch looks down");

    // Director: fade around cuts, wrap to the next shot, still never moves.
    Director director(open);
    check(director.cut(), "fade in at the first frame");
    const auto still = director.still();
    check(close_to(still.eye, place(open[1], .35).eye), "still is shot 2 at 35%");
    director.advance(.05);
    director.advance(.05);
    check(!director.cut(), "fade in ends");
    for (int i = 0; i < 68; ++i)
        director.advance(.1);  // 6.9 s
    check(!director.cut(), "no fade mid-shot");
    director.advance(.1);  // 7.0 s
    check(director.cut(), "fade out before the cut");
    director.advance(1);  // clamped to .1 s per frame: 7.1 s
    for (int i = 0; i < 5; ++i)
        director.advance(.1);  // 7.6 s: 0.1 s into shot 2
    const auto wrapped = director.pose(), expected = place(open[1], .1 / shot_seconds);
    check(std::abs(wrapped.eye[0] - expected.eye[0]) + std::abs(wrapped.eye[1] - expected.eye[1])
                          + std::abs(wrapped.eye[2] - expected.eye[2])
                  < 1e-6,
          "wraps to the next shot");
    director.advance(std::nan(""));
    check(close_to(director.still().eye, still.eye) && close_to(director.still().yaw, still.yaw),
          "still independent of time");
    Director single(closed);
    check(!single.cut(), "one shot never fades");

    // THREE.PerspectiveCamera(62) vertical lens in Renderer's Source FOV terms.
    check(close_to(renderer_fov(), 77.3, .1), "lens");
    std::cout << "menu tour: anchors, bounds, path, cuts, still and lens match the web director\n";
}
