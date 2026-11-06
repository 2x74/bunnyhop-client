#include "crash_particles.hpp"
#include <fstream>
#include <iostream>
#include <map>
#include <memory>
#include <stdexcept>

namespace {
size_t comparisons = 0;

void close(double a, double b) {
    ++comparisons;
    if (!std::isfinite(a) || std::abs(a - b) > 1e-9 * std::max(1., std::abs(b)))
        throw std::runtime_error("web particle sample differs: " + std::to_string(a) + " / " + std::to_string(b));
}

void compare(const native_crash::Sample &sample, const nlohmann::json &expected) {
    for (size_t i = 0; i < 3; ++i) {
        close(sample.position[i], expected.at("position")[i]);
        close(sample.velocity[i], expected.at("velocity")[i]);
        close(sample.color[i], expected.at("color")[i]);
    }
    for (size_t i = 0; i < 4; ++i) {
        close(sample.uv[i], expected.at("uv")[i]);
        close(sample.uv_next[i], expected.at("uvNext")[i]);
    }
    close(sample.frame_blend, expected.at("frameBlend"));
    close(sample.radius, expected.at("radius"));
    close(sample.alpha, expected.at("alpha"));
    close(sample.roll, expected.at("roll"));
    close(sample.trail, expected.at("trail"));
}

void card_and_sort_contract(const std::map<std::string, native_crash::Definition> &definitions) {
    using namespace native_crash;
    Sample p;
    p.radius = 200;
    p.velocity = {0, 1000, 0};
    p.trail = .1;
    const auto &spikes = definitions.at("Nitro_CoreSpikes");
    const auto shape = card_shape(spikes, p, .1, 1000);
    close(shape.trail.length, 150);
    close(shape.trail.width, 150);
    const auto head = card_offset(spikes, p, shape, {-1, 1}, {1, 0, 0}, {0, 1, 0});
    const auto tail = card_offset(spikes, p, shape, {-1, -1}, {1, 0, 0}, {0, 1, 0});
    close(head[0], 75);
    close(head[1], 0);
    close(tail[0], 75);
    close(tail[1], -150);
    p.radius = 40;
    const auto &sphere = definitions.at("Nitro_Fire_Sphere");
    const auto near_camera = card_shape(sphere, p, .1, 20), middle = card_shape(sphere, p, .1, 100);
    close(near_camera.fade, 0);
    close(near_camera.radius, 8);
    close(middle.fade, .5);
    close(sphere.add_self, .5);
    close(sphere.overbright, 5);
    if (!sphere.blend_frames || definitions.at("Nitro_Distort").normal_map.empty())
        throw std::runtime_error("SpriteCard or Refract metadata absent");
    std::vector<OrderedSample> sorted;
    for (const auto &[index, y] : std::array<std::pair<uint32_t, double>, 3>{{{7, 100}, {2, 200}, {1, 100}}}) {
        p.position = {0, y, 0};
        sorted.push_back({p, 0, index, view_depth(p, {}, {1, 0, 0}, {0, 0, 1})});
    }
    sort_samples(sorted);
    if (sorted[0].index != 2 || sorted[1].index != 1 || sorted[2].index != 7)
        throw std::runtime_error("particle camera order differs");
}
}  // namespace

int main(int argc, char **argv) {
    try {
        if (argc != 2) throw std::runtime_error("pass the web particle oracle");
        std::ifstream file(argv[1]);
        auto oracle = std::make_unique<nlohmann::json>(nlohmann::json::parse(file));
        if (oracle->at("bspSha256") != native_crash::bsp_sha256) throw std::runtime_error("BSP gate differs");
        std::map<std::string, native_crash::Definition> definitions;
        for (const auto &[name, data] : oracle->at("definitions").items()) {
            auto definition = native_crash::compile(name, data);
            const auto expected = oracle->at("births").at(name).get<std::vector<double>>();
            if (expected.size() != definition.births.size()) throw std::runtime_error("emission count differs");
            for (size_t i = 0; i < expected.size(); ++i)
                close(definition.births[i], expected[i]);
            definitions.emplace(name, std::move(definition));
        }
        card_and_sort_contract(definitions);
        for (const auto &row : oracle->at("rows")) {
            const auto &definition = definitions.at(row.at("system"));
            const auto actual = native_crash::sample(
                    definition,
                    row.at("index"),
                    row.at("age"),
                    row.at("seed"),
                    row.at("angles").get<native_crash::Point>()
            );
            if (bool(actual) == row.at("sample").is_null()) throw std::runtime_error("particle lifetime differs");
            if (actual) {
                compare(*actual, row.at("sample"));
                const auto trail = native_crash::trail_shape(definition, *actual, row.at("age"));
                close(trail.width, row.at("trailShape").at("width"));
                close(trail.length, row.at("trailShape").at("length"));
            }
        }
        if (comparisons < 10000) throw std::runtime_error("particle oracle is empty");
        std::cout << comparisons << " authored particle values match the web sampler\n";
    } catch (const std::exception &error) {
        std::cerr << "Crash particles: " << error.what() << '\n';
        return 1;
    }
}
