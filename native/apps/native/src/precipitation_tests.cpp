// Snow and rain against the website's map-effects/precipitation.ts: the numbers below come from
// precipitation-oracle.ts (bun apps/native/src/precipitation-oracle.ts), which runs the website's module on the same
// entities, models and traced world.
#undef NDEBUG
#include "precipitation.hpp"
#include <cassert>
#include <cstdio>
#include <cstring>
#include <optional>

namespace {
using native_precip::Kind;

/** FNV-1a over the float bit patterns, as precipitation-oracle.ts hashes them. */
uint32_t fnv(const std::vector<float> &data) {
    uint32_t h = 0x811c9dc5u;
    for (const float value : data) {
        uint32_t word = 0;
        std::memcpy(&word, &value, sizeof(word));
        for (int b = 0; b < 4; ++b) {
            h ^= (word >> (b * 8)) & 0xffu;
            h *= 0x01000193u;
        }
    }
    return h;
}

// The oracle's world: ground at z <= 0, a roof slab 200..216 over x, y in [100, 300], solid sky from z 1000 up.
constexpr double ground_top = 0, roof_bottom = 200, roof_top = 216, sky_bottom = 1000;

bool in_roof(double x, double y) { return x >= 100 && x <= 300 && y >= 100 && y <= 300; }

bool solid(double x, double y, double z) {
    return z <= ground_top || z >= sky_bottom || (in_roof(x, y) && z >= roof_bottom && z <= roof_top);
}

/** A vertical trace through that world; the fraction comes back as a float, as from the core. */
double trace(double sx, double sy, double sz, double, double, double ez) {
    if (solid(sx, sy, sz)) return 0;
    std::optional<double> hit;
    const auto consider = [&](double surface, bool candidate) {
        if (!candidate) return;
        const bool between = ez < sz ? surface <= sz && surface >= ez : surface >= sz && surface <= ez;
        const bool nearer = !hit || (ez < sz ? surface > *hit : surface < *hit);
        if (between && nearer) hit = surface;
    };
    if (ez < sz) {
        consider(ground_top, true);
        consider(roof_top, in_roof(sx, sy) && sz > roof_top);
    } else {
        consider(sky_bottom, true);
        consider(roof_bottom, in_roof(sx, sy) && sz < roof_bottom);
    }
    return double(float(hit ? (sz - *hit) / (sz - ez) : 1.));
}

nlohmann::json models() {
    const auto box = [](std::array<float, 3> lo, std::array<float, 3> hi) {
        return nlohmann::json{{"mins", lo}, {"maxs", hi}};
    };
    return nlohmann::json::array({
            box({0, 0, 0}, {0, 0, 0}),
            box({-201, -201, 49}, {601, 601, 1201}),
            box({-1, -1, 299}, {401, 401, 901}),
            box({0, 0, 0}, {10, 10, 10}),
    });
}

nlohmann::json entities() {
    return nlohmann::json::array({
            {{"classname", "worldspawn"}},
            {{"classname", "func_precipitation"}, {"model", "*1"}, {"preciptype", "3"}},
            {{"classname", "Func_Precipitation"}, {"model", "*2"}, {"preciptype", "0"}, {"renderamt", "100"}},
            {{"classname", "func_precipitation"}, {"model", "*3"}, {"preciptype", "2"}},
            {{"classname", "func_precipitation"}, {"model", "*2"}, {"PRECIPTYPE", " 7 "}, {"renderamt", "x"}},
            {{"classname", "func_precipitation"}, {"model", "*2"}, {"preciptype", "1"}, {"renderamt", "60"}},
    });
}

void test_kinds() {
    using native_precip::kind_of;
    assert(kind_of(-1) == Kind::rain && kind_of(0) == Kind::rain && kind_of(1) == Kind::snow);
    assert(!kind_of(2) && kind_of(3) == Kind::snowfall && !kind_of(4));
    assert(kind_of(5) == Kind::rain && kind_of(7) == Kind::rain && !kind_of(2.9));
    assert(kind_of(std::numeric_limits<double>::quiet_NaN()) == Kind::rain);
}

void test_volumes() {
    const auto v = native_precip::volumes(entities(), models());
    assert(v.size() == 4);
    const Kind kinds[] = {Kind::snowfall, Kind::rain, Kind::rain, Kind::snow};
    const size_t entity[] = {1, 2, 4, 5};
    const double amount[] = {255, 100, 255, 60};
    for (size_t i = 0; i < v.size(); ++i)
        assert(v[i].kind == kinds[i] && v[i].entity == entity[i] && v[i].amount == amount[i]);
    assert(v[0].min == (std::array<double, 3>{-200, -200, 50}) && v[0].max == (std::array<double, 3>{600, 600, 1200}));
    assert(v[1].min == (std::array<double, 3>{0, 0, 300}) && v[1].max == (std::array<double, 3>{400, 400, 900}));
}

void test_fields() {
    using native_precip::field_count;
    assert(field_count(Kind::snowfall) == 5285 && field_count(Kind::snowfall, 100) == 5285);
    assert(field_count(Kind::rain) == 4027 && field_count(Kind::rain, 100) == 1579);
    assert(field_count(Kind::rain, 5000) == 8192 && field_count(Kind::snow) == 4027);
    struct Expected {
        Kind kind;
        uint32_t hash;
        std::array<float, 12> eighth;
    };
    const Expected expected[] = {
            {Kind::snowfall,
             884623630u,
             {398.4371643066406f, 286.3125f, 673.658203125f, 5.24160099029541f, 2.133333444595337f,
              2.133333444595337f, -42.2400016784668f, 1.329940915107727f, 1.0117168426513672f, 4.440579414367676f,
              .24433180689811707f, .8246381282806396f}},
            {Kind::rain,
             217311878u,
             {1156.3756103515625f, 1224.6529541015625f, 559.3612670898438f, 1.6144884824752808f,
              -10.239999771118164f, -7.679999828338623f, -600.7466430664062f, 0, .5f, 0, .6793618202209473f,
              .7697437405586243f}},
            {Kind::snow,
             3821841195u,
             {492.7425231933594f, 734.1190795898438f, 825.7672119140625f, .12352307885885239f, 0, 0,
              -600.7466430664062f, 3.549999713897705f, .5f, 28, .6244080662727356f, .8205255270004272f}},
    };
    for (const auto &e : expected) {
        const auto data = native_precip::instances(e.kind, field_count(e.kind));
        for (size_t k = 0; k < 12; ++k)
            assert(data[7 * 12 + k] == e.eighth[k]);
        assert(fnv(data) == e.hash);
    }
}

void test_columns_and_spans() {
    const auto v = native_precip::volumes(entities(), models());
    const auto columns = native_precip::build_columns(v, trace, 4096);
    assert(columns.width == 120 && columns.height == 48 && columns.traces == 20160 && !columns.truncated);
    const int x[] = {0, 48, 72, 96}, size[] = {48, 24, 24, 24};
    for (size_t i = 0; i < 4; ++i) {
        const auto &l = columns.layout[i];
        assert(l.x == x[i] && l.y == 0 && l.cell == 17 && l.cols == size[i] && l.rows == size[i]);
    }
    assert(fnv(columns.data) == 703304423u);
    struct Probe {
        Kind kind;
        double x, y, z, eye;
        std::optional<std::array<float, 2>> span;
    };
    const Probe probes[] = {
            {Kind::snowfall, 50, 50, 500, 100, std::array<float, 2>{50, 1000}},
            {Kind::snowfall, 200, 200, 150, 100, std::nullopt},
            {Kind::snowfall, 200, 200, 300, 100, std::array<float, 2>{216.00001525878906f, 1000}},
            {Kind::snowfall, 550, 550, 980, 100, std::array<float, 2>{50, 1000}},
            {Kind::rain, 50, 50, 600, 100, std::array<float, 2>{.000028818845748901367f, 612}},
            {Kind::rain, 50, 50, 20, 100, std::array<float, 2>{.000028818845748901367f, 612}},
            {Kind::rain, 200, 200, 250, 900, std::array<float, 2>{215.99998474121094f, 900}},
            {Kind::snow, 350, 350, 400, 100, std::array<float, 2>{.000028818845748901367f, 612}},
    };
    for (const auto &p : probes) {
        const auto s = native_precip::span(p.kind, v, columns, p.x, p.y, p.z, p.eye);
        assert(bool(s) == bool(p.span));
        if (s) assert(float(s->floor) == (*p.span)[0] && float(s->top) == (*p.span)[1]);
    }
}

void test_setting() {
    using native_precip::preset_level;
    assert(native_precip::density_of("full") == 1 && native_precip::density_of("light") == .5);
    assert(native_precip::density_of("off") == 0);
    assert(preset_level(nlohmann::json::object()) == "full");
    const auto preset = [](bool potato, bool antialias, int anisotropy, double scale, bool reflections) {
        return nlohmann::json{
                {"graphicsPotato", potato},
                {"graphicsAntialias", antialias},
                {"graphicsAnisotropy", anisotropy},
                {"graphicsResolutionScale", scale},
                {"graphicsWaterReflections", reflections},
        };
    };
    assert(preset_level(preset(true, false, 1, .5, false)) == "off");
    assert(preset_level(preset(true, false, 1, 1, false)) == "off");
    assert(preset_level(preset(false, false, 4, 1, false)) == "light");
    assert(preset_level(preset(false, true, 8, 1, true)) == "full");
    // No preset matches: the default graphics' Full.
    assert(preset_level(preset(false, true, 16, 1, true)) == "full");
}

}  // namespace

int main() {
    test_kinds();
    test_volumes();
    test_fields();
    test_columns_and_spans();
    test_setting();
    std::puts("precipitation passed");
}
