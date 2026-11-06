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
    for (size_t i = 0; i < 4; ++i)
        close(sample.uv[i], expected.at("uv")[i]);
    close(sample.radius, expected.at("radius"));
    close(sample.alpha, expected.at("alpha"));
    close(sample.roll, expected.at("roll"));
    close(sample.trail, expected.at("trail"));
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
            if (actual) compare(*actual, row.at("sample"));
        }
        if (comparisons < 10000) throw std::runtime_error("particle oracle is empty");
        std::cout << comparisons << " authored particle values match the web sampler\n";
    } catch (const std::exception &error) {
        std::cerr << "Crash particles: " << error.what() << '\n';
        return 1;
    }
}
