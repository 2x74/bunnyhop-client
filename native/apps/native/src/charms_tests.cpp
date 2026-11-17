#include "base64.hpp"
#include "charm_rig.hpp"
#include "nlohmann/json.hpp"
#include <cassert>
#include <cstring>
#include <fstream>
#include <iostream>

// Hangs the website's charms on the website's fits over the oracle's scripted play (charms-oracle.ts) and checks the
// six bones every frame; then the option text, the ranges and the places.
namespace {

using json = nlohmann::json;
using native_charm::V3;

V3 v3(const json &value) {
    return {value[0].get<double>(), value[1].get<double>(), value[2].get<double>()};
}

std::vector<float> floats(const std::string &text) {
    const auto bytes = native::base64_decode(text);
    assert(bytes && bytes->size() % 4 == 0);
    std::vector<float> out(bytes->size() / 4);
    std::memcpy(out.data(), bytes->data(), bytes->size());
    return out;
}

native_charm::Hang hang_of(const json &h) {
    native_charm::Hang out;
    out.bone = h["bone"];
    out.at = v3(h["at"]);
    for (const auto &c : h["colliders"]) {
        native_charm::HangCollider collider;
        collider.a = v3(c["a"]);
        if (!c["b"].is_null()) collider.b = v3(c["b"]);
        collider.r = c["r"];
        collider.bone = c["bone"];
        collider.bone_b = c["boneB"];
        collider.hand = c["hand"];
        out.colliders.push_back(collider);
    }
    return out;
}

native_charm::Fit fit_of(const json &f, bool bare) {
    native_charm::Fit fit;
    fit.guard = hang_of(f["guard"]);
    if (!f["pommel"].is_null()) fit.pommel = hang_of(f["pommel"]);
    for (const auto &j : f["joints"])
        fit.joints.push_back({j["bone"].get<int>(), v3(j["p"])});
    fit.offers_guard = f["places"]["guard"];
    fit.offers_pommel = f["places"]["pommel"];
    fit.solid = native_charm::PointCloud(floats(f["solid"]));
    fit.hands = native_charm::PointCloud(floats(f["hands"]));
    if (bare) {
        fit.solid = {};
        fit.hands = {};
    }
    return fit;
}

native_charm::CharmDef charm_of(const json &c) {
    native_charm::CharmDef def;
    def.id = c["id"];
    def.link = c["link"];
    def.radius = c["radius"];
    def.lift = c["lift"];
    for (const auto &b : c["balls"])
        def.balls.push_back({b["d"].get<double>(), b["r"].get<double>()});
    if (!c["life"].is_null()) {
        const auto &l = c["life"];
        def.life = {
                native_charm::life_named(l["kind"].get<std::string>()),
                v3(l["at"]),
                v3(l["axis"]),
                l["rate"],
                l["amount"]
        };
    }
    return def;
}

// The rest pose with the knife bone turned about its own z (the oracle's inspect-like turn).
void pose(std::vector<float> &W, const std::vector<float> &rest, int knife_bone, double turn) {
    W = rest;
    if (turn == 0) return;
    const size_t o = size_t(knife_bone) * 12;
    const double c = std::cos(turn), s = std::sin(turn);
    for (size_t r = 0; r < 3; r++) {
        const double x = rest[o + r * 4], y = rest[o + r * 4 + 1];
        W[o + r * 4] = float(x * c + y * s);
        W[o + r * 4 + 1] = float(-x * s + y * c);
    }
}

struct RunResult {
    double early = 0, whole = 0;
};

// Before this, every run is free of the chaos of resting contact (the oracle's knife turn starts at 4 s).
constexpr double early_seconds = 2.5;

RunResult check_run(const json &run) {
    const auto def = charm_of(run["charm"]);
    const auto fit = fit_of(run["fit"], run["case"].value("bare", false));
    const auto &l = run["loadout"];
    native_charm::Options options;
    options.charm = def.id;
    options.length = l.value("length", 100);
    options.size = l.value("size", 100);
    options.swing = l.value("swing", 30);
    options.pommel = l["pommel"];
    native_charm::KnifePlaces places;
    places.guard = run["fit"]["places"]["guard"];
    places.pommel = run["fit"]["places"]["pommel"];
    const auto &c = run["fit"]["clamps"];
    places.at_guard = {c[0][0], c[0][1], c[0][2], c[0][3]};
    places.at_pommel = {c[1][0], c[1][1], c[1][2], c[1][3]};
    native_charm::KnifeCharm charm;
    charm.set(&def, native_charm::clamped(options, places), {}, &fit);
    for (const auto &push : run["pushes"]) {
        const auto q = v3(push["q"]);
        V3 out{};
        const native_charm::PointCloud cloud(floats(run["fit"]["solid"]));
        const bool hit = cloud.push(q[0], q[1], q[2], push["r"], out);
        assert(hit == push["hit"].get<bool>());
        if (hit)
            for (size_t k = 0; k < 3; k++)
                assert(std::abs(out[k] - push["out"][k].get<double>()) < 1e-9);
    }
    const auto rest = run["rest"].get<std::vector<float>>();
    std::vector<float> W;
    const int knife_bone = run["knifeBone"];
    const bool left = run["case"]["left"];
    RunResult worst;
    for (const auto &frame : run["frames"]) {
        pose(W, rest, knife_bone, frame["knifeTurn"]);
        native_charm::Frame f;
        f.dt = frame["dt"];
        f.clock = frame["clock"];
        f.velocity = v3(frame["velocity"]);
        f.yaw = frame["yaw"];
        f.pitch = frame["pitch"];
        f.bones = &W;
        for (size_t k = 0; k < 12; k++)
            f.view[k] = frame["view"][k];
        f.offset = {1.5, left ? .6 : -.6, -.9};
        f.left = left;
        f.knife_bone = knife_bone;
        charm.update(f);
        const auto &want = frame["bones"];
        const bool early = frame["clock"].get<double>() < early_seconds;
        for (size_t k = 0; k < charm.rig.bones.size(); k++) {
            const double d = std::abs(charm.rig.bones[k] - want[k].get<double>());
            worst.whole = std::max(worst.whole, d);
            if (early) worst.early = std::max(worst.early, d);
        }
    }
    return worst;
}

void check_clamps() {
    // The Cleaver's guard: cord 100 to 200, size 80 to 120; nothing at its pommel, which it doesn't offer.
    native_charm::KnifePlaces cleaver{true, false, {100, 200, 80, 120}, {}};
    native_charm::Options o;
    o.length = 50;
    o.size = 140;
    o.pommel = true;
    const auto drawn = native_charm::clamped(o, cleaver);
    assert(drawn.length == 100 && drawn.size == 120 && drawn.pommel);
    // A knife that offers only its pommel uses the pommel's clamps whatever is saved.
    native_charm::KnifePlaces radish{false, true, {}, {60, 70, 90, 100}};
    o.pommel = false;
    const auto butt = native_charm::clamped(o, radish);
    assert(butt.length == 60 && butt.size == 100);
}

void check_options() {
    const native_charm::Range length{50, 200, 100, 10}, size{80, 140, 100, 10}, swing{0, 100, 30, 10};
    const auto unpack = [&](std::string_view text) {
        return native_charm::unpack_options(text, length, size, swing);
    };
    // The website's packLoadoutExt: "charm-bun;IB" is swing 60 on the pommel; "charm-toadstool;7L" cord 200, size 140.
    const auto bun = unpack("charm-bun;IB");
    assert(bun && bun->charm == "charm-bun" && bun->swing == 60 && bun->pommel && bun->length == 100
           && bun->size == 100);
    const auto toadstool = unpack("charm-toadstool;7L");
    assert(toadstool && toadstool->length == 200 && toadstool->size == 140 && toadstool->swing == 30);
    assert(!toadstool->pommel);
    const auto plain = unpack("charm-star");
    assert(plain && plain->length == 100 && plain->size == 100 && plain->swing == 30 && !plain->pommel);
    const auto broken = unpack("charm-star;!!");
    assert(broken && broken->charm == "charm-star" && broken->swing == 30);
    assert(!unpack("") && !unpack(";IB") && !unpack(std::string(201, 'x')));
    // Sizes 150 and swings past 100 are the defaults, as loadoutFor reads them.
    assert(unpack("charm-star;1M")->size == 100);
    assert(std::abs(native_charm::cord_of(100, 1.3) - 1.3) < 1e-12);
    assert(std::abs(native_charm::cord_of(200, 1.3) - 1.3 * std::pow(2., .8)) < 1e-12);
    const auto lively = native_charm::tune_of(100);
    assert(std::abs(lively.cone - 80 * native_charm::degrees) < 1e-12 && std::abs(lively.k_hand - 1) < 1e-12);
}

// A strafing hop seen from the eye (test/charms-physics.test.ts motion), the velocity at the game's 100 ticks.
native_charm::ChainInput strafing(double t) {
    constexpr double period = .66;
    const auto vz_at = [&](double at) {
        const double phase = std::fmod(at, period) / period;
        return phase > .06 && at > .5 ? 300 - 800 * (phase * period) : 0.;
    };
    native_charm::ChainInput in;
    const double yaw = 30 * std::sin(native_charm::pi * (t / period - .5));
    const double speed = std::min(700., 250 + 120 * t), yr = yaw * native_charm::degrees;
    const double tick = std::floor(t * 100) / 100, u = t * 100 - std::floor(t * 100);
    in.anchor = {
            16 + .4 * std::sin(5.1 * t),
            2.2 + .8 * std::sin(2 * native_charm::pi * (t / period)),
            -6 + .3 * std::cos(3.3 * t)
    };
    in.yaw = yaw;
    in.pitch = 8 + 4 * std::sin(.7 * t);
    in.velocity = {std::cos(yr) * speed, std::sin(yr) * speed, vz_at(tick) + (vz_at(tick + .01) - vz_at(tick)) * u};
    return in;
}

// The charm's centre every 1/30 s over `seconds` at `fps`.
std::vector<V3> swing_at(double fps, double seconds, double swing) {
    native_charm::Chain chain;
    chain.tune = native_charm::tune_of(swing);
    auto in = strafing(0);
    chain.update(in);
    std::vector<V3> out;
    V3 previous = {chain.out[9], chain.out[10], chain.out[11]};
    double t = 0;
    int k = 1;
    const double dt = 1 / fps;
    for (int i = 1; i * dt <= seconds + 1e-9; i++) {
        const double t0 = t;
        t = i * dt;
        in = strafing(t);
        in.dt = dt;
        chain.update(in);
        const V3 now = {chain.out[9], chain.out[10], chain.out[11]};
        for (; k / 30. <= t + 1e-9; k++) {
            const double u = (k / 30. - t0) / dt;
            out.push_back(
                    {previous[0] + (now[0] - previous[0]) * u,
                     previous[1] + (now[1] - previous[1]) * u,
                     previous[2] + (now[2] - previous[2]) * u}
            );
        }
        previous = now;
    }
    return out;
}

double apart(const std::vector<V3> &a, const std::vector<V3> &b) {
    double worst = 0;
    for (size_t i = 0; i < std::min(a.size(), b.size()); i++)
        worst = std::max(worst, std::hypot(std::hypot(a[i][0] - b[i][0], a[i][1] - b[i][1]), a[i][2] - b[i][2]));
    return worst;
}

// The website's chain tests: the same motion at any frame rate, hanging along gravity, deterministic, never exploding.
void check_chain_properties() {
    const auto reference = swing_at(1000, 4, 30);
    assert(reference.size() > 110);
    const std::array<std::pair<double, double>, 4> tolerances = {{{30, .35}, {60, .2}, {144, .1}, {240, .08}}};
    for (const auto &[fps, tolerance] : tolerances)
        assert(apart(reference, swing_at(fps, 4, 30)) < tolerance);
    assert(apart(swing_at(1000, 4, 100), swing_at(240, 4, 100)) < .1);
    assert(apart(swing_at(144, 4, 30), swing_at(144, 4, 30)) == 0);
    for (const double pitch : {0., 45., -60.}) {
        native_charm::Chain chain;
        native_charm::ChainInput in;
        in.anchor = {16, 2, -6};
        in.pitch = pitch;
        in.dt = 1. / 60;
        for (int i = 0; i < 300; i++)
            chain.update(in);
        const double th = pitch * native_charm::degrees, L = chain.shape.cord + chain.shape.link;
        const V3 want = {16 + std::sin(th) * L, 2, -6 - std::cos(th) * L};
        assert(apart({{chain.out[9], chain.out[10], chain.out[11]}}, {want}) < .02);
    }
    native_charm::Chain chain;
    auto in = strafing(1);
    in.dt = 1. / 60;
    chain.update(in);
    for (const double dt : {1. / 60, 2., .001, 1. / 144}) {
        in.dt = dt;
        in.anchor[0] += 40;
        chain.update(in);
        in.anchor[0] -= 39.9;
        in.velocity[0] = std::nan("");
        chain.update(in);
        for (const double v : chain.out)
            assert(std::isfinite(v) && std::abs(v) < 200);
    }
}

}  // namespace

int main(int argc, char **argv) {
    assert(argc == 2);
    std::ifstream file(argv[1]);
    const auto oracle = json::parse(file);
    // Resting on the dense point clouds is chaotic (the nearest point jumps, so a millionth apart grows over seconds of
    // contact): there, exact until the charm first rests and never further apart than a charm's size. On the capsules
    // alone, and hanging free, exact over every frame.
    constexpr double exact = 5e-4, capsules_exact = 1e-4, bounded = 2;
    for (const auto &run : oracle["runs"]) {
        const auto result = check_run(run);
        const auto contact = run["case"]["contact"].get<std::string>();
        const bool bare = run["case"].value("bare", false);
        std::cout << run["charm"]["id"].get<std::string>() << " on " << run["case"]["knife"].get<std::string>()
                  << (bare ? " (capsules only)" : "") << ": first " << early_seconds << " s " << result.early
                  << ", whole run " << result.whole << "\n";
        if (bare) {
            assert(result.whole < capsules_exact);
            continue;
        }
        if (contact != "start") assert(result.early < exact);
        assert(result.whole < (contact == "none" ? exact : bounded));
    }
    check_options();
    check_clamps();
    check_chain_properties();
    std::cout << "Charms match the website: " << oracle["runs"].size() << " runs\n";
}
