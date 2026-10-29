// Avatar pictures without GL: the menu's request read into typed values, the pose scripts' timings
// (avatar/stage.ts script()), the exported gesture data, backdrops, and the files a picture becomes.
#include "avatar_pose.hpp"

#include <cassert>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iostream>

namespace {

using namespace native::avatar;

nlohmann::json message() {
    return {{"type", "avatarRender"},
            {"id", 7},
            {"output", "webp"},
            {"size", 256},
            {"spec",
             {{"outfit", "outfit-mint"},
              {"loadout", "2;knife-carrot;fin-garden;glove-knit;;hat-halo;body-a"},
              {"pose", "swing"},
              {"knife", "knife-carrot"},
              {"gun", "usp"},
              {"hand", "knife"},
              {"moment", .75},
              {"tilt", .2},
              {"ears", -.4},
              {"turn", -18},
              {"frame", "close"},
              {"zoom", 1.1}}},
            {"backdrop", {{"kind", "studio"}, {"top", "#22222a"}, {"bottom", "#0e0e12"}, {"glow", "#7ee0b0"}}}};
}

bool near(double a, double b) {
    return std::abs(a - b) < 1e-9;
}

void reads_requests() {
    const auto request = parse_request(message());
    assert(request && request->id == 7 && request->output == Output::webp && request->size == 256);
    assert(request->spec.pose == "swing" && request->spec.frame == Frame::close && request->spec.hand == Hand::knife);
    assert(near(request->spec.moment, .75) && near(request->spec.zoom, 1.1));
    assert(request->backdrop.kind == Backdrop::Kind::studio && request->backdrop.glow
           && request->backdrop.glow->g == 0xe0);
    // Anything out of the spec's ranges (avatar/spec.ts cleanAvatar) is refused rather than clamped.
    for (const auto &[key, value] : std::vector<std::pair<std::string, nlohmann::json>>{
                 {"moment", 1.5}, {"zoom", 3}, {"turn", 400}, {"pose", "dab"}, {"tilt", "x"}
         }) {
        auto bad = message();
        bad["spec"][key] = value;
        assert(!parse_request(bad));
    }
    auto bad = message();
    bad["size"] = 4096;
    assert(!parse_request(bad));
    bad = message();
    bad["backdrop"] = {{"kind", "solid"}, {"top", "red"}};
    assert(!parse_request(bad));
    bad = message();
    bad["backdrop"] = {{"kind", "clear"}};
    assert(parse_request(bad)->backdrop.kind == Backdrop::Kind::clear);
}

void times_poses() {
    PoseLibrary library;
    library.inspect_seconds["knife-thornback"] = 3.15;
    Spec spec;
    spec.moment = .5;
    spec.pose = "idle";
    assert(near(PoseScript(spec, library).until(), settle_seconds + 1.5));
    spec.pose = "swing";
    PoseScript swing(spec, library);
    assert(near(swing.until(), settle_seconds + .02 + .3) && swing.signal() && swing.signal()->attack == 1);
    spec.pose = "showoff";
    spec.knife = "knife-thornback";
    PoseScript showoff(spec, library);
    assert(near(showoff.until(), settle_seconds + .1 + .5 * (3.15 - .3)) && showoff.signal()->inspect == 1);
    spec.hand = Hand::none;
    assert(!PoseScript(spec, library).signal());
    spec.pose = "hop";
    spec.hand = Hand::knife;
    PoseScript hop(spec, library);
    // A hop leaves the ground at SETTLE and peaks half a hop later at JUMP^2 / (2 GRAV).
    const auto peak = hop.at(settle_seconds + hop_seconds / 2, base_yaw_degrees);
    assert(std::abs(peak.position[2] - jump_speed * jump_speed / (2 * gravity)) < .01 && !peak.grounded);
    assert(hop.at(settle_seconds, 0).grounded && std::abs(hop.at(0, 0).velocity[0] - 300) < 1e-3);
    spec.pose = "lookup";
    const auto up = PoseScript(spec, library).at(0, -62);
    assert(near(up.yaw, -34) && near(up.pitch, -38));
}

void reads_exported_gestures(const std::filesystem::path &assets) {
    std::ifstream file(assets / "avatar.json");
    if (!file) {
        std::cout << "avatar.json absent: gesture data not checked\n";
        return;
    }
    const auto library = PoseLibrary::parse(nlohmann::json::parse(file));
    const auto *wave = library.gesture("wave");
    assert(wave && wave->gesture.arms[0].reach && wave->gesture.arms[1].reach);
    assert(wave->gesture.arms[0].hand == native_gestures::HandShape::open && wave->gesture.square == 1);
    const auto *holdup = library.gesture("holdup");
    assert(holdup && holdup->gesture.arms[0].turn && !holdup->gesture.arms[0].reach && holdup->gesture.square == 0);
    assert(library.gesture("point")->gesture.arms[0].hand == native_gestures::HandShape::point);
    assert(!library.gesture("idle") && library.inspect_length("knife-carrot") > 1);
}

void paints_backdrops() {
    Backdrop studio;
    studio.kind = Backdrop::Kind::studio;
    studio.top = *parse_hex("#26262d");
    studio.bottom = *parse_hex("#0c0c0f");
    const auto picture = paint_backdrop(studio, 100);
    const auto at = [&](int x, int y, int k) {
        return int(picture.rgba[(size_t(y) * 100 + x) * 4 + k]);
    };
    // Opaque, brightest under the light, darker at the bottom.
    assert(at(0, 0, 3) == 255 && at(50, 28, 0) > at(50, 90, 0) && at(50, 28, 0) > 0x26);
    assert(paint_backdrop(Backdrop{}, 8).rgba == std::vector<uint8_t>(8 * 8 * 4, 0));
    assert(!parse_hex("#12345") && !parse_hex("123456") && !parse_hex("#ABCDEF"));
}

void encodes_pictures() {
    Backdrop solid;
    solid.kind = Backdrop::Kind::solid;
    solid.top = {200, 100, 50};
    auto picture = paint_backdrop(solid, 256);
    Picture dot = paint_backdrop(Backdrop{}, 256);
    dot.rgba[(128 * 256 + 128) * 4 + 3] = 255;
    draw_over(picture, dot);
    assert(picture.rgba[(128 * 256 + 128) * 4] == 0 && picture.rgba[0] == 200);
    const auto png = encode_png(picture);
    assert(png.compare(0, 8, "\x89PNG\r\n\x1a\n", 8) == 0);
    const auto webp = encode_avatar_webp(picture, 96 * 1024);
    assert(!webp.empty() && webp.compare(0, 4, "RIFF") == 0 && webp.compare(12, 4, "VP8L") == 0);
    // Too big even posterized: no picture rather than one the server refuses.
    assert(encode_avatar_webp(picture, 10).empty());
    // Half-covered supersampled pixels average to half alpha.
    Picture coarse = paint_backdrop(Backdrop{}, 2);
    coarse.rgba[3] = 255;
    coarse.rgba[7] = 255;
    assert(downsample(coarse, 2).rgba[3] == 128);
}

}  // namespace

int main(int argc, char **argv) {
    reads_requests();
    times_poses();
    reads_exported_gestures(argc > 1 ? argv[1] : "target/native-assets");
    paints_backdrops();
    encodes_pictures();
    std::cout << "avatar tests passed\n";
    return 0;
}
