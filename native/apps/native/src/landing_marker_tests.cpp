#include "landing_marker.hpp"
#include <cassert>
#include <fstream>
#include <iostream>

int main(int argc, char **argv) {
    using namespace native_render;
    assert(argc == 2);
    nlohmann::json oracle;
    std::ifstream(argv[1]) >> oracle;
    size_t vertex = 0;
    for (size_t ring = 0; ring < landing_rings; ring++) {
        for (size_t segment = 0; segment < landing_segments; segment++) {
            const std::array<LandingVertex, 4> quad{
                    landing_vertex(ring, segment),
                    landing_vertex(ring, segment + 1),
                    landing_vertex(ring + 1, segment + 1),
                    landing_vertex(ring + 1, segment)
            };
            for (size_t i : {0, 1, 2, 0, 2, 3}) {
                for (size_t k = 0; k < 3; k++)
                    assert(std::abs(quad[i].position[k] - oracle["positions"][vertex * 3 + k].get<float>()) < 1e-5);
                assert(std::abs(quad[i].alpha - oracle["alpha"][vertex].get<float>()) < 1e-6);
                vertex++;
            }
        }
    }
    for (const auto &sample : oracle["scales"])
        assert(std::abs(landing_scale(sample[0], sample[1]) - sample[2].get<float>()) < 1e-5);
    for (const auto &sample : oracle["drops"]) {
        BhLandingPrediction result{};
        result.kind = 1;
        const auto normal = sample["normal"].get<Vec3>();
        std::copy(normal.begin(), normal.end(), result.normal);
        const auto center = landing_point({}, result, 1);
        assert(std::abs(center[2] + sample["drop"].get<float>()) < 1e-5);
        const auto rim = landing_point({14, 0, 0}, result, 1);
        assert(std::abs(rim[0] * normal[0] + rim[1] * normal[1] + (rim[2] - center[2]) * normal[2]) < 1e-5);
    }
    std::array<BhLandingPiece, 2> pieces{};
    const auto raw = oracle["pieces"].get<std::vector<float>>();
    for (size_t i = 0; i < pieces.size(); i++) {
        for (size_t k = 0; k < 3; k++) {
            pieces[i].start[k] = raw[i * 10 + k];
            pieces[i].velocity[k] = raw[i * 10 + 3 + k];
            pieces[i].acceleration[k] = raw[i * 10 + 6 + k];
        }
        pieces[i].seconds = raw[i * 10 + 9];
    }
    std::array<Vec3, landing_dots> dots;
    const size_t count = landing_arc(pieces, dots);
    assert(count * 3 == oracle["arc"].size());
    for (size_t i = 0; i < count; i++)
        for (size_t k = 0; k < 3; k++)
            assert(std::abs(dots[i][k] - oracle["arc"][i * 3 + k].get<float>()) < 1e-5);
    LandingMarker marker;
    assert(marker.mode == LandingMarker::Mode::off && !marker.path && !marker.enabled(true, true));
    for (const auto &mode : {"off", "practice", "always"}) {
        marker.settings({{"landing", {{"mode", mode}, {"arc", true}, {"color", "#123456"}}}});
        for (bool practice : {false, true})
            for (bool replay : {false, true})
                assert(marker.enabled(practice, replay)
                       == (std::string(mode) == "always" || (std::string(mode) == "practice" && (practice || replay))));
    }
    BhState grounded{};
    grounded.grounded = 1;
    marker.visible = true;
    marker.air_at = 1;
    assert(marker.frame(nullptr, grounded, false, false, false, 1.079));
    assert(!marker.frame(nullptr, grounded, false, false, false, 1.081));
    marker.visible = true;
    assert(!marker.frame(nullptr, grounded, true, false, false, 1));
    marker.visible = true;
    grounded.on_ladder = 1;
    assert(!marker.frame(nullptr, grounded, false, false, false, 1));
    std::cout << vertex << " web dome vertices, arc/ramp/minimum-size vectors and scope/hold cases passed\n";
}
