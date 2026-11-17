#pragma once
// The Back slot (web player/back-fx.ts, player/robe-fx.ts, loadout.ts packCape / packRobe): what a worn back item is,
// its options from the packed loadout, and its motion. The geometry and the shader come from the website at build
// time (export-viewmodels.ts); this is the CPU side the website runs per player per frame.
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

namespace native_back {

constexpr double pi = 3.141592653589793;

enum class Kind { none, still, key, pinwheel, cape, balloon, jet, wings, pack, blade, robe };

inline Kind kind_named(std::string_view name) {
    constexpr std::pair<std::string_view, Kind> names[] = {
            {"still", Kind::still},
            {"key", Kind::key},
            {"pinwheel", Kind::pinwheel},
            {"cape", Kind::cape},
            {"balloon", Kind::balloon},
            {"jet", Kind::jet},
            {"wings", Kind::wings},
            {"pack", Kind::pack},
            {"blade", Kind::blade},
            {"robe", Kind::robe},
    };
    for (const auto &[text, kind] : names)
        if (text == name) return kind;
    return Kind::none;
}

inline constexpr std::string_view cape_item = "back-cape", robe_item = "back-robe";
inline constexpr int cape_length_min = 100, cape_length_max = 260, cape_length_step = 5;

using Rgb = std::array<float, 3>;

// The 15th packed field (loadout.ts packCape / packRobe). Absent or malformed: the default cape or robe.
struct Options {
    int cape_length = cape_length_min;
    std::optional<uint32_t> outer, lining;
    int robe_pattern = 0;
    bool robe_tied = false;
};

// loadout.ts B64: six bits a character. -1 for a character outside the alphabet.
inline int64_t unb64(std::string_view text) {
    constexpr std::string_view alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_";
    int64_t value = 0;
    for (char c : text) {
        const auto at = alphabet.find(c);
        if (at == std::string_view::npos) return -1;
        value = value * 64 + int64_t(at);
    }
    return value;
}

// loadout.ts ungrid18: six bits a channel back to 0xRRGGBB.
inline uint32_t ungrid18(int64_t n) {
    const auto channel = [&](int shift) {
        return uint32_t(std::lround(double((n >> shift) & 63) * 255 / 63));
    };
    return (channel(12) << 16) | (channel(6) << 8) | channel(0);
}

// The head (two characters) and up to two colours (three characters each), flags 256 and 512 saying which follow.
struct PackedColors {
    int64_t head = -1;
    std::optional<uint32_t> first, second;
};

inline std::optional<PackedColors> unpack_colors(std::string_view field) {
    constexpr int64_t first_flag = 256, second_flag = 512, head_limit = 1024;
    if (field.size() < 2) return std::nullopt;
    PackedColors out;
    out.head = unb64(field.substr(0, 2));
    if (out.head < 0 || out.head >= head_limit) return std::nullopt;
    const bool first = out.head & first_flag, second = out.head & second_flag;
    if (field.size() != 2 + (first ? 3u : 0u) + (second ? 3u : 0u)) return std::nullopt;
    const int64_t a = first ? unb64(field.substr(2, 3)) : 0, b = second ? unb64(field.substr(first ? 5 : 2)) : 0;
    if (a < 0 || b < 0) return std::nullopt;
    if (first) out.first = ungrid18(a);
    if (second) out.second = ungrid18(b);
    return out;
}

inline Options unpack_cape(std::string_view field) {
    Options out;
    const auto packed = unpack_colors(field);
    if (!packed) return out;
    const int length = int(packed->head & 255) + cape_length_min;
    if (length > cape_length_max || length % cape_length_step) return out;
    out.cape_length = length;
    out.outer = packed->first;
    out.lining = packed->second;
    return out;
}

inline Options unpack_robe(std::string_view field) {
    constexpr int64_t tied_flag = 8, reserved_bits = 0xf0, pattern_bits = 7, pattern_count = 5;
    Options out;
    const auto packed = unpack_colors(field);
    if (!packed || packed->head & reserved_bits) return out;
    const int pattern = int(packed->head & pattern_bits);
    if (pattern >= pattern_count) return out;
    out.robe_pattern = pattern;
    out.robe_tied = packed->head & tied_flag;
    out.outer = packed->first;
    out.lining = packed->second;
    return out;
}

// The Cape length native draws (export-viewmodels.ts NATIVE_CAPE_STEP): the nearest exported one, ties going longer.
inline int drawn_cape_length(int length, int exported_step) {
    const int steps = (std::clamp(length, cape_length_min, cape_length_max) - cape_length_min + exported_step / 2)
                      / exported_step;
    return std::min(cape_length_max, cape_length_min + steps * exported_step);
}

// backs.ts backFit + backKey: the exported mesh for an item on a body.
struct Fit {
    std::string profile = "a";
    bool hood_down = false, tail = false;
};

inline Fit fit_for(std::string_view body_look, bool feminine, bool hood_down, bool ponytail) {
    Fit fit;
    fit.profile = body_look == "plush"                                        ? "plush"
                  : body_look == "bune" || (body_look == "bunny" && feminine) ? "b"
                                                                              : "a";
    fit.hood_down = body_look == "bunny" && hood_down;
    fit.tail = !fit.hood_down && ponytail;
    return fit;
}

inline std::string mesh_key(std::string_view id, const Fit &fit, int cape_length, bool tied) {
    std::string key = "back:" + std::string(id) + "|" + fit.profile + (fit.hood_down ? "|down" : "|up");
    if (fit.tail) key += "|tail";
    if (id == cape_item && cape_length != cape_length_min) key += "|l" + std::to_string(cape_length);
    if (id == robe_item && tied) key += "|tied";
    return key;
}

inline float linear_channel(float c) {
    return c <= .04045f ? c / 12.92f : std::pow((c + .055f) / 1.055f, 2.4f);
}

inline Rgb linear_hex(uint32_t hex) {
    return {linear_channel(float((hex >> 16) & 255) / 255),
            linear_channel(float((hex >> 8) & 255) / 255),
            linear_channel(float(hex & 255) / 255)};
}

inline float luminance(const Rgb &c) {
    return .2126f * c[0] + .7152f * c[1] + .0722f * c[2];
}

constexpr float tone_min = .012f, tone_max = .88f;

inline Rgb kept_tone(Rgb c) {
    for (auto &channel : c)
        channel = std::clamp(channel, tone_min, tone_max);
    return c;
}

// robe-fx.ts apart: `c` moved lighter or darker (the way it leans from `from`, if there is room) until the contrast
// ratio between them is at least `least`.
inline Rgb apart(const Rgb &c, const Rgb &from, float least) {
    const float yc = luminance(c), yf = luminance(from);
    const float ratio = (std::max(yc, yf) + .05f) / (std::min(yc, yf) + .05f);
    if (ratio >= least) return c;
    const float lighter = (yf + .05f) * least - .05f, darker = (yf + .05f) / least - .05f;
    const bool up = yc >= yf ? lighter <= tone_max : darker < tone_min;
    Rgb out = c;
    if (up) {
        const float t = std::clamp((lighter - yc) / std::max(1e-4f, 1 - yc), 0.f, 1.f);
        for (auto &channel : out)
            channel += (1 - channel) * t;
    } else {
        const float k = std::clamp(darker / std::max(1e-4f, yc), 0.f, 1.f);
        for (auto &channel : out)
            channel *= k;
    }
    return out;
}

// back-fx.ts capeTones: outside, trim, lining, clasp (linear) from the colourway's accent and the picked colours.
inline std::array<Rgb, 4> cape_tones(const Rgb &accent, std::optional<uint32_t> outer, std::optional<uint32_t> lining) {
    constexpr float trim_contrast = 1.8f, lining_shade = .8f, clasp_floor = .12f;
    const Rgb ivory = linear_hex(0xf3ecdc), ivory_shade = linear_hex(0xcdbfa6), gold = linear_hex(0xe6b54a);
    if (!outer && !lining) return {accent, ivory, ivory_shade, gold};
    const Rgb out = outer ? kept_tone(linear_hex(*outer)) : accent;
    const Rgb base = kept_tone(lining ? linear_hex(*lining) : ivory);
    const Rgb trim = apart(base, out, trim_contrast);
    const Rgb inner =
            lining ? Rgb{base[0] * lining_shade, base[1] * lining_shade, base[2] * lining_shade} : ivory_shade;
    const float yt = luminance(trim);
    Rgb clasp = gold;
    if (lining) {
        clasp = trim;
        if (yt < clasp_floor)
            for (auto &channel : clasp)
                channel += clasp_floor - yt;
    }
    return {out, trim, inner, clasp};
}

// robe-fx.ts robeTones: cloth, print, lining, collar band (linear) from the joggers' colour, the accent and the picks.
inline std::array<Rgb, 4>
robe_tones(const Rgb &pants, const Rgb &accent, std::optional<uint32_t> cloth, std::optional<uint32_t> print) {
    constexpr float print_contrast = 1.7f, band_contrast = 1.45f, lining_mix = .34f, lining_shade = .62f;
    const Rgb base = cloth ? kept_tone(linear_hex(*cloth)) : pants;
    const Rgb ink = apart(print ? kept_tone(linear_hex(*print)) : accent, base, print_contrast);
    const Rgb band = apart(ink, base, band_contrast);
    Rgb inner{};
    for (size_t k = 0; k < 3; ++k)
        inner[k] = (base[k] + (ink[k] - base[k]) * lining_mix) * lining_shade;
    return {base, ink, inner, band};
}

// A worn back item as drawn: its mesh, its kind, its options and the uniforms that stay the same while it is worn.
struct Worn {
    std::string id, mesh;
    Kind kind = Kind::none;
    Options options;
    std::array<float, 3> pivot{}, pivot2{}, axis{0, 1, 0};
    // uCape: a long cape's [on, the height it hangs from, the ground under the feet, 0] (BackRig.hang).
    std::array<float, 4> cape{};
    // uRobe: [pattern, the sleeves' drop, their radius, where they start]. With nothing worn, the website's defaults.
    std::array<float, 4> robe{0, 1, 0, 0};
    std::array<float, 12> tones{1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1};
    // uPonytail.w: how far a long ponytail stands further off the back over a pack (backs.ts ponytailRest).
    float ponytail_rest = 0;

    double cape_length_scale() const { return double(options.cape_length) / cape_length_min; }
};

// backs.ts PONY_REST: on the standard bunny, then on Plush and Bun-E.
inline float ponytail_rest(std::string_view id, bool standard_bunny) {
    if (id == "back-carrot-pack") return standard_bunny ? 2.4f : 4.3f;
    if (id == "back-jetpack") return standard_bunny ? 2.0f : 3.9f;
    return 0;
}

// back-fx.ts Swing: a root spring and a softer one for the free end, the wind's pull, the couplings and the limits.
struct Swing {
    double hz, zeta, tip_hz, tip_zeta, lift, lift_speed, side_lift, k_forward, k_up, k_side, turn;
    std::array<double, 2> pitch;
    double side, idle;
};

inline const Swing *swing_of(Kind kind) {
    static const Swing cape{1.1, .46, 1.0, .42, .8, 800, .75, .00032, .00026, .0002, .035, {.02, 1.12}, .9, .022};
    static const Swing balloon{.85, .3, .75, .2, .55, 600, .5, .0004, .00005, .0007, .05, {-.22, .6}, .55, .07};
    static const Swing pinwheel{3.1, .22, 2.6, .2, .12, 900, .1, .00007, 0, .00012, .012, {-.1, .22}, .16, .008};
    static const Swing pack{2.3, .22, 1.9, .2, .55, 700, .4, .0003, .00012, .0004, .03, {-.3, .8}, .55, .03};
    static const Swing blade{1.8, .16, 1.7, .16, .95, 650, .7, .0004, .0004, .0007, .07, {0, 1.2}, .8, .05};
    static const Swing key{4.5, .22, 4.5, .3, 0, 700, 0, 0, .00009, .00006, 0, {-.16, .16}, .12, 0};
    static const Swing robe{1.3, .5, 1.2, .4, .4, 900, .36, .00022, .00016, .00018, .028, {0, .58}, .46, .016};
    static const Swing wings{2.1, .3, 1.9, .22, 0, 700, 0, 0, .00034, 0, 0, {-.5, .5}, .01, .035};
    switch (kind) {
        case Kind::cape:
            return &cape;
        case Kind::balloon:
            return &balloon;
        case Kind::pinwheel:
            return &pinwheel;
        case Kind::pack:
            return &pack;
        case Kind::blade:
            return &blade;
        case Kind::key:
            return &key;
        case Kind::robe:
            return &robe;
        case Kind::wings:
            return &wings;
        default:
            return nullptr;
    }
}

// back-fx.ts capeSwing: a longer cape is heavier (`length` over the short cape's, 1 .. 2.6).
inline Swing cape_swing(double length) {
    Swing swing = *swing_of(Kind::cape);
    const double l = std::clamp(std::isfinite(length) ? length : 1., 1., 2.6);
    const double g = (l - 1) / 1.6, f = 1 / std::sqrt(l);
    const Swing &base = *swing_of(Kind::cape);
    swing.hz = base.hz * f;
    swing.tip_hz = base.tip_hz * f;
    swing.lift = base.lift - .2 * g;
    swing.side_lift = base.side_lift - .3 * g;
    swing.pitch = {base.pitch[0], base.pitch[1] - .32 * g};
    swing.side = base.side - .35 * g;
    swing.turn = base.turn * (1 - .3 * g);
    return swing;
}

inline Swing robe_tied_swing() {
    Swing swing = *swing_of(Kind::robe);
    swing.hz = 1.7;
    swing.tip_hz = 1.55;
    swing.lift = .46;
    swing.side_lift = .36;
    swing.pitch = {0, .62};
    swing.side = .46;
    return swing;
}

struct Motion {
    double spin = 0, spin_rate = 0, pitch = 0, pitch_rate = 0, side = 0, side_rate = 0;
    double tip_pitch = 0, tip_pitch_rate = 0, tip_side = 0, tip_side_rate = 0;
    double mid_pitch = 0, mid_pitch_rate = 0, mid_side = 0, mid_side_rate = 0;
    double land = 10, previous_vz = 0, bounce = 0, bounce_rate = 0, flare = 0, fold = 0;
    std::array<double, 3> velocity_filtered{};
    double yaw = 0, yaw_rate = 0, time = 0;
    bool initialized = false;
};

// The key's clicks (rad a click, clicks a second at rest, added at full speed, speed scale) and their snap and ring.
constexpr double key_step = pi;
constexpr std::array<double, 3> key_rate = {.45, 1.9, 650};
constexpr double key_snap_seconds = .07, key_ring = 15;
constexpr std::array<double, 3> pinwheel_rate = {.7, 9.5, 520};
constexpr double pinwheel_up_seconds = .3, pinwheel_down_seconds = 1.7;
constexpr double robe_flare = .8, robe_flare_speed = 520, robe_flare_hop = .16;
constexpr double mid_hz_scale = 1.55, bounce_limit = 1.6;
constexpr double wing_fold = .62, wing_fold_speed = 700, wing_turn = .06;
constexpr double jet_idle = .2, jet_speed = .2, jet_speed_scale = 800, flare_seconds = .2;
constexpr double acceleration_seconds = .06, acceleration_saturation = 1400;

inline double finite(double x) {
    return std::isfinite(x) ? x : 0;
}

// A strapped pack's spring: Hz, damping, units per u/s2 of upward acceleration.
inline std::optional<std::array<double, 3>> bounce_of(Kind kind) {
    if (kind == Kind::jet) return std::array<double, 3>{3.4, .3, .0006};
    if (kind == Kind::pack) return std::array<double, 3>{3.0, .34, .00075};
    return std::nullopt;
}

inline std::array<double, 2> wind_rest(const Swing &swing, double left, double forward) {
    const double speed = std::hypot(left, forward);
    if (speed < 1) return {0, 0};
    const double wind = 1 - std::exp(-speed / swing.lift_speed);
    return {swing.lift * wind * std::max(0., forward / speed), swing.side_lift * wind * (left / speed)};
}

inline double rate_at(const std::array<double, 3> &rate, double speed) {
    return rate[0] + rate[1] * (1 - std::exp(-speed / rate[2]));
}

struct Step {
    Kind kind = Kind::none;
    std::array<double, 3> velocity{};
    double yaw_degrees = 0, dt = 0, cape_length = 1;
    bool jumped = false, snap = false, still = false, tied = false;
};

namespace detail {
inline void reset(Motion &m, Kind kind, const Swing *swing, double left, double forward, double speed) {
    m = Motion{.velocity_filtered = m.velocity_filtered, .yaw = m.yaw};
    if (swing) {
        const auto [p, q] = wind_rest(*swing, left, forward);
        m.pitch = std::clamp(p, swing->pitch[0], swing->pitch[1]);
        m.side = std::clamp(q, -swing->side, swing->side);
    }
    m.tip_pitch = m.mid_pitch = m.pitch;
    m.tip_side = m.mid_side = m.side;
    if (kind == Kind::pinwheel) m.spin_rate = rate_at(pinwheel_rate, speed);
    m.fold = std::max(0., forward);
}

inline void spring_bounce(Motion &m, const std::array<double, 3> &bounce, double up, int steps, double dh) {
    const double w0 = 2 * pi * bounce[0], k = w0 * w0, c = 2 * bounce[1] * w0;
    for (int i = 0; i < steps; i++) {
        m.bounce_rate += (k * (bounce[2] * up - m.bounce) - c * m.bounce_rate) * dh;
        m.bounce += m.bounce_rate * dh;
        if (std::abs(m.bounce) > bounce_limit) {
            m.bounce = std::copysign(bounce_limit, m.bounce);
            m.bounce_rate *= -.2;
        }
    }
}

struct Targets {
    double pitch, side, force_pitch, force_side;
};

inline void spring_swing(Motion &m, const Swing &sw, Kind kind, const Targets &t, int steps, double dh) {
    const double w0 = 2 * pi * sw.hz, k = w0 * w0, c = 2 * sw.zeta * w0;
    const double w1 = 2 * pi * sw.tip_hz, kt = w1 * w1, ct = 2 * sw.tip_zeta * w1;
    const double slack_pitch = .25 * (sw.pitch[1] - sw.pitch[0]), slack_side = .25 * sw.side;
    const double w2 = w1 * mid_hz_scale, km = w2 * w2, cm = (sw.zeta + sw.tip_zeta) * w2;
    const bool middle = kind == Kind::cape || kind == Kind::robe;
    for (int i = 0; i < steps; i++) {
        m.pitch_rate += (k * (t.force_pitch + t.pitch - m.pitch) - c * m.pitch_rate) * dh;
        m.side_rate += (k * (t.force_side + t.side - m.side) - c * m.side_rate) * dh;
        m.pitch += m.pitch_rate * dh;
        m.side += m.side_rate * dh;
        if (m.pitch < sw.pitch[0]) {
            m.pitch = sw.pitch[0];
            m.pitch_rate = std::max(0., m.pitch_rate) * .3;
        }
        if (m.pitch > sw.pitch[1]) {
            m.pitch = sw.pitch[1];
            m.pitch_rate = std::min(0., m.pitch_rate) * .3;
        }
        if (std::abs(m.side) > sw.side) {
            m.side = std::copysign(sw.side, m.side);
            m.side_rate *= -.2;
        }
        m.tip_pitch_rate += (kt * (m.pitch - m.tip_pitch) - ct * m.tip_pitch_rate) * dh;
        m.tip_side_rate += (kt * (m.side - m.tip_side) - ct * m.tip_side_rate) * dh;
        m.tip_pitch =
                std::clamp(m.tip_pitch + m.tip_pitch_rate * dh, sw.pitch[0] - slack_pitch, sw.pitch[1] + slack_pitch);
        m.tip_side = std::clamp(m.tip_side + m.tip_side_rate * dh, -sw.side - slack_side, sw.side + slack_side);
        if (!middle) continue;
        m.mid_pitch_rate += (km * (m.pitch - m.mid_pitch) - cm * m.mid_pitch_rate) * dh;
        m.mid_side_rate += (km * (m.side - m.mid_side) - cm * m.mid_side_rate) * dh;
        m.mid_pitch =
                std::clamp(m.mid_pitch + m.mid_pitch_rate * dh, sw.pitch[0] - slack_pitch, sw.pitch[1] + slack_pitch);
        m.mid_side = std::clamp(m.mid_side + m.mid_side_rate * dh, -sw.side - slack_side, sw.side + slack_side);
    }
}
}  // namespace detail

// back-fx.ts advanceBack: one player's back item stepped by `step.dt` seconds.
inline void advance(Motion &m, const Step &step) {
    const double h = std::clamp(finite(step.dt), 0., .1);
    const std::array<double, 3> v = {finite(step.velocity[0]), finite(step.velocity[1]), finite(step.velocity[2])};
    const double yaw = finite(step.yaw_degrees) * (pi / 180);
    const double speed = std::hypot(v[0], v[1]);
    const double cy = std::cos(yaw), sy = std::sin(yaw);
    const double left = -sy * v[0] + cy * v[1], forward = cy * v[0] + sy * v[1];
    Swing chosen{};
    const Swing *sw = nullptr;
    if (step.kind == Kind::cape) {
        chosen = cape_swing(step.cape_length);
        sw = &chosen;
    } else if (step.kind == Kind::robe && step.tied) {
        chosen = robe_tied_swing();
        sw = &chosen;
    } else
        sw = swing_of(step.kind);
    if (step.still || step.snap || !m.initialized) {
        if (!step.still) detail::reset(m, step.kind, sw, left, forward, speed);
        m.previous_vz = v[2];
        m.velocity_filtered = v;
        m.yaw = yaw;
        m.yaw_rate = 0;
        m.initialized = true;
        return;
    }
    if (h <= 0) return;
    m.time = std::fmod(m.time + h, pi * 200);
    m.flare = std::max(step.jumped ? 1. : 0., m.flare * std::exp(-h / flare_seconds));
    const bool landed = step.jumped || (m.previous_vz < -120 && v[2] > m.previous_vz + 150);
    m.land = landed ? 0 : std::min(10., m.land + h);
    m.previous_vz = v[2];
    if (step.kind == Kind::key)
        m.spin = std::fmod(m.spin + rate_at(key_rate, speed) * h, 4096.);
    else if (step.kind == Kind::pinwheel) {
        const double want = rate_at(pinwheel_rate, speed);
        const double seconds = want > m.spin_rate ? pinwheel_up_seconds : pinwheel_down_seconds;
        m.spin_rate += (want - m.spin_rate) * (1 - std::exp(-h / seconds));
        m.spin = std::fmod(m.spin + m.spin_rate * h, pi * 2);
    }
    m.fold += (std::max(0., forward) - m.fold) * (1 - std::exp(-h / .18));
    const auto bounce = bounce_of(step.kind);
    if (!sw && !bounce) return;
    const double k = 1 - std::exp(-h / acceleration_seconds);
    std::array<double, 3> a{};
    for (size_t i = 0; i < 3; i++) {
        a[i] = (v[i] - m.velocity_filtered[i]) * k / h;
        m.velocity_filtered[i] += (v[i] - m.velocity_filtered[i]) * k;
    }
    const auto saturate = [](double x) {
        return acceleration_saturation * std::tanh(x / acceleration_saturation);
    };
    double dyaw = yaw - m.yaw;
    dyaw = std::atan2(std::sin(dyaw), std::cos(dyaw));
    m.yaw = yaw;
    m.yaw_rate += (dyaw / h - m.yaw_rate) * (1 - std::exp(-h / .05));
    const double a_left = saturate(-sy * a[0] + cy * a[1]), a_forward = saturate(cy * a[0] + sy * a[1]);
    const double a_up = saturate(a[2]);
    const int steps = std::max(1, int(std::ceil(h / (1. / 120))));
    const double dh = h / steps;
    if (bounce) detail::spring_bounce(m, *bounce, a_up, steps, dh);
    if (!sw) return;
    const auto [wind_pitch, wind_side] = wind_rest(*sw, left, forward);
    const double idle = sw->idle * std::exp(-speed / 120);
    const detail::Targets targets{
            wind_pitch + idle * .6 * std::sin(m.time * 1.7),
            wind_side + idle * std::sin(m.time * 1.1) + sw->turn * std::clamp(m.yaw_rate, -4., 4.),
            sw->k_forward * a_forward - sw->k_up * a_up,
            sw->k_side * a_left,
    };
    detail::spring_swing(m, *sw, step.kind, targets, steps, dh);
}

inline double key_angle(double clicks, double rate) {
    const double whole = std::floor(clicks);
    const double since = (clicks - whole) / std::max(rate, 1e-3);
    return key_step * (whole + 1 - std::exp(-since / key_snap_seconds) * std::cos(key_ring * since));
}

using Vec4 = std::array<float, 4>;

// The uBack, uBackTip and uBackMid uniforms (back-fx.ts backUniform, backUniformTip, backUniformMid).
struct Uniforms {
    Vec4 back{}, tip{}, mid{};
};

inline Uniforms uniforms(const Motion &m, Kind kind, double speed, double cape_length = 1) {
    const double sp = std::max(0., finite(speed));
    const auto f = [](double x) {
        return float(x);
    };
    Uniforms u;
    switch (kind) {
        case Kind::key:
            u.back = {f(key_angle(m.spin, rate_at(key_rate, sp))), f(m.pitch), f(m.side), 0};
            u.tip = {f(m.pitch), f(m.side), 0, 0};
            break;
        case Kind::jet:
            u.back = {0, 0, 0, f(jet_idle + jet_speed * (1 - std::exp(-sp / jet_speed_scale)) + m.flare)};
            u.tip = {0, 0, f(m.bounce), 0};
            break;
        case Kind::wings:
            u.back = {
                    0,
                    f(wing_fold * (1 - std::exp(-m.fold / wing_fold_speed))),
                    f(wing_turn * std::clamp(m.yaw_rate, -4., 4.)),
                    f(m.pitch)
            };
            u.tip = {f(m.tip_pitch), 0, 0, 0};
            break;
        case Kind::cape:
        case Kind::blade:
            u.back = {0, f(m.pitch), f(m.side), f(1 - std::exp(-sp / 700))};
            u.tip = {f(m.tip_pitch), f(m.tip_side), 0, 0};
            break;
        case Kind::robe:
            u.back = {
                    f(robe_flare * (1 - std::exp(-m.fold / robe_flare_speed)) + robe_flare_hop * m.flare),
                    f(m.pitch),
                    f(m.side),
                    f(1 - std::exp(-sp / 700))
            };
            u.tip = {f(m.tip_pitch), f(m.tip_side), 0, 0};
            break;
        case Kind::balloon:
            u.back = {
                    f(.55 * m.tip_pitch + .6 * (m.pitch - m.tip_pitch)),
                    f(-m.pitch),
                    f(-m.side),
                    f(.55 * m.tip_side + .6 * (m.side - m.tip_side))
            };
            u.tip = {f(-m.tip_pitch), f(-m.tip_side), 0, 0};
            break;
        case Kind::pinwheel:
        case Kind::pack:
            u.back = {f(m.spin), f(-m.pitch), f(-m.side), 0};
            u.tip = {f(-m.tip_pitch), f(-m.tip_side), kind == Kind::pack ? f(m.bounce) : 0, 0};
            break;
        default:
            break;
    }
    if (kind == Kind::robe)
        u.mid = {f(m.mid_pitch), f(m.mid_side), 0, f(m.land)};
    else if (kind == Kind::cape) {
        const double g = std::clamp((finite(cape_length) - 1) / 1.6, 0., 1.);
        const double twist =
                std::clamp(g * (1.4 * (m.tip_side - m.mid_side) + .9 * (m.mid_side - m.side) + .4 * m.side), -.45, .45);
        u.mid = {f(m.mid_pitch), f(m.mid_side), f(twist), f(m.land)};
    } else
        u.mid = {u.back[1], u.back[2], 0, 0};
    return u;
}

// robe-fx.ts advanceSleeves: one pendulum per sleeve in the model's own frame.
struct SleeveMotion {
    std::array<double, 16> q{};
    std::array<double, 6> at{}, velocity{};
    double yaw = 0;
    bool initialized = false;
};

struct SleeveSpec {
    double hz = 1.9, zeta = .34, tip_hz = 1.55, tip_zeta = .3, wind = .62, wind_speed = 620, acceleration = .00042,
           acceleration_limit = 1500, limit = .85;
};

namespace detail {
inline std::array<double, 2> sleeve_rest(double vx, double vy) {
    const SleeveSpec spec;
    const double sp = std::hypot(vx, vy);
    if (sp < 1) return {0, 0};
    const double k = -spec.wind * (1 - std::exp(-sp / spec.wind_speed)) / sp;
    return {vx * k, vy * k};
}

inline void sleeve_springs(double *q, std::array<double, 2> rest, std::array<double, 2> force, int steps, double dh) {
    const SleeveSpec spec;
    const double w0 = 2 * pi * spec.hz, k = w0 * w0, c = 2 * spec.zeta * w0;
    const double w1 = 2 * pi * spec.tip_hz, kt = w1 * w1, ct = 2 * spec.tip_zeta * w1;
    const double tip_limit = spec.limit * 1.15;
    for (int j = 0; j < steps; j++) {
        q[2] += (k * (rest[0] + force[0] - q[0]) - c * q[2]) * dh;
        q[3] += (k * (rest[1] + force[1] - q[1]) - c * q[3]) * dh;
        q[0] += q[2] * dh;
        q[1] += q[3] * dh;
        const double root = std::hypot(q[0], q[1]);
        if (root > spec.limit) {
            q[0] *= spec.limit / root;
            q[1] *= spec.limit / root;
            q[2] *= .5;
            q[3] *= .5;
        }
        q[6] += (kt * (q[0] - q[4]) - ct * q[6]) * dh;
        q[7] += (kt * (q[1] - q[5]) - ct * q[7]) * dh;
        q[4] += q[6] * dh;
        q[5] += q[7] * dh;
        const double tip = std::hypot(q[4], q[5]);
        if (tip > tip_limit) {
            q[4] *= tip_limit / tip;
            q[5] *= tip_limit / tip;
        }
    }
}
}  // namespace detail

// `anchors`: where each sleeve hangs from (left then right, model space); `velocity` the body's (Source, world);
// `yaw_degrees` the feet's yaw.
inline void advance_sleeves(
        SleeveMotion &s,
        const std::array<double, 6> &anchors,
        const std::array<double, 3> &velocity,
        double yaw_degrees,
        double dt,
        bool snap,
        bool still
) {
    const SleeveSpec spec;
    const double h = std::clamp(finite(dt), 0., .1);
    const double yaw = finite(yaw_degrees) * (pi / 180), cy = std::cos(yaw), sy = std::sin(yaw);
    const double bx = cy * finite(velocity[0]) + sy * finite(velocity[1]);
    const double by = -sy * finite(velocity[0]) + cy * finite(velocity[1]);
    if (still || snap || !s.initialized) {
        if (!still) {
            const auto rest = detail::sleeve_rest(bx, by);
            for (size_t i = 0; i < 2; i++) {
                std::fill(s.q.begin() + long(i * 8), s.q.begin() + long(i * 8 + 8), 0.);
                s.q[i * 8] = s.q[i * 8 + 4] = rest[0];
                s.q[i * 8 + 1] = s.q[i * 8 + 5] = rest[1];
            }
        }
        for (size_t i = 0; i < 6; i++) {
            s.at[i] = finite(anchors[i]);
            s.velocity[i] = 0;
        }
        s.yaw = yaw;
        s.initialized = true;
        return;
    }
    if (h <= 0) return;
    double dyaw = yaw - s.yaw;
    dyaw = std::atan2(std::sin(dyaw), std::cos(dyaw));
    s.yaw = yaw;
    const double turn = std::clamp(dyaw / h, -12., 12.);
    const double k = 1 - std::exp(-h / .05);
    const int steps = std::max(1, int(std::ceil(h / (1. / 120))));
    const double dh = h / steps;
    const auto saturate = [&](double x) {
        return spec.acceleration_limit * std::tanh(x / spec.acceleration_limit);
    };
    for (size_t i = 0; i < 2; i++) {
        const size_t a = i * 3;
        const double ax = finite(anchors[a]), ay = finite(anchors[a + 1]), az = finite(anchors[a + 2]);
        const double vx = (ax - s.at[a]) / h, vy = (ay - s.at[a + 1]) / h, vz = (az - s.at[a + 2]) / h;
        const double acx = (vx - s.velocity[a]) * k / h, acy = (vy - s.velocity[a + 1]) * k / h;
        s.velocity[a] += (vx - s.velocity[a]) * k;
        s.velocity[a + 1] += (vy - s.velocity[a + 1]) * k;
        s.velocity[a + 2] += (vz - s.velocity[a + 2]) * k;
        s.at[a] = ax;
        s.at[a + 1] = ay;
        s.at[a + 2] = az;
        const auto rest = detail::sleeve_rest(bx + s.velocity[a] - turn * ay, by + s.velocity[a + 1] + turn * ax);
        const std::array<double, 2> force = {-spec.acceleration * saturate(acx), -spec.acceleration * saturate(acy)};
        detail::sleeve_springs(s.q.data() + i * 8, rest, force, steps, dh);
    }
}

inline Vec4 sleeve_uniform(const SleeveMotion &s, size_t side) {
    return {float(s.q[side * 8]), float(s.q[side * 8 + 1]), float(s.q[side * 8 + 4]), float(s.q[side * 8 + 5])};
}

// viewmodel/robe-sleeves.ts RobeSleeves.update: the first-person drops' lag, in viewmodel space (x forward, y left).
struct FirstPersonSleeves {
    std::array<double, 8> q{};
    double yaw = 0;
    bool started = false;

    // `scale`: the viewmodel's sway setting and reduced motion (0 = still); `mirror`: the left-handed view.
    void update(double dt, const std::array<double, 3> &velocity, double yaw_degrees, double scale, bool mirror) {
        constexpr double hz = 2.3, zeta = .5, tip_hz = 1.8, tip_zeta = .38, strafe = .11, strafe_speed = 500;
        constexpr double wind = .1, wind_speed = 900, turn = .00045, limit = .2, turn_limit_degrees = 400;
        const double h = std::clamp(dt, 0., .1);
        const double now = yaw_degrees * pi / 180;
        double dyaw = now - yaw;
        dyaw = std::atan2(std::sin(dyaw), std::cos(dyaw));
        yaw = now;
        if (!started || h <= 0) {
            started = true;
            return;
        }
        const double cy = std::cos(now), sy = std::sin(now);
        const double forward = cy * velocity[0] + sy * velocity[1], left = -sy * velocity[0] + cy * velocity[1];
        double tx = -wind * (1 - std::exp(-std::max(0., forward) / wind_speed));
        double ty = -strafe * std::tanh(left / strafe_speed)
                    - turn * std::clamp(dyaw / h * (180 / pi), -turn_limit_degrees, turn_limit_degrees);
        if (mirror) ty = -ty;
        tx *= scale;
        ty *= scale;
        const int steps = std::max(1, int(std::ceil(h / (1. / 120))));
        const double dh = h / steps;
        const double w0 = 2 * pi * hz, k = w0 * w0, c = 2 * zeta * w0;
        const double w1 = 2 * pi * tip_hz, kt = w1 * w1, ct = 2 * tip_zeta * w1;
        for (int i = 0; i < steps; i++) {
            q[2] += (k * (tx - q[0]) - c * q[2]) * dh;
            q[3] += (k * (ty - q[1]) - c * q[3]) * dh;
            q[0] += q[2] * dh;
            q[1] += q[3] * dh;
            q[6] += (kt * (q[0] - q[4]) - ct * q[6]) * dh;
            q[7] += (kt * (q[1] - q[5]) - ct * q[7]) * dh;
            q[4] += q[6] * dh;
            q[5] += q[7] * dh;
            for (const size_t o : {size_t(0), size_t(4)}) {
                const double m = std::hypot(q[o], q[o + 1]);
                if (m <= limit) continue;
                q[o] *= limit / m;
                q[o + 1] *= limit / m;
                q[o + 2] *= .5;
                q[o + 3] *= .5;
            }
        }
    }

    Vec4 uniform() const { return {float(q[0]), float(q[1]), float(q[4]), float(q[5])}; }
};

}  // namespace native_back
