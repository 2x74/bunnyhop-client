// The strafe trainer's Gauge look against the website's (hud/strafe-trainer.ts gaugeAngle, gaugeCue, GAUGE_*): the
// needle's angle, the hint, and where the dial's arcs and needle are drawn.
#include "hud_trainer.hpp"
#include "semantic_palette.hpp"
#include <cmath>
#include <cstring>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

namespace {
void check(bool value, const std::string &message) {
    if (value) return;
    std::fprintf(stderr, "%s\n", message.c_str());
    std::exit(1);
}

struct Quad {
    std::array<native::HudPoint, 4> points;
    std::array<native::NameColor, 4> colors;
};

struct RecordingHud {
    std::vector<Quad> quads;
    std::vector<std::string> texts;
    std::vector<native::NameColor> text_colors;

    void overlay_quad(const std::array<native::HudPoint, 4> &points, const std::array<native::NameColor, 4> &colors) {
        quads.push_back({points, colors});
    }

    float overlay_pixel() const { return .5f; }

    void overlay_rect(float, float, float, float, native::NameColor) {}

    void overlay_text(float, float, std::string_view value, float, native::NameColor color, bool = false) {
        texts.emplace_back(value);
        text_colors.push_back(color);
    }
};

constexpr float centre_x = 500, top = 0;

// Same colour, whatever the alpha: a dimmed trainer draws its colours at 30%.
bool same_rgb(const native::NameColor &a, const native::NameColor &b) {
    return a[3] > 0 && a[0] == b[0] && a[1] == b[1] && a[2] == b[2];
}

const native::HudPoint pivot = {centre_x, top - native::GaugeLayout::view_top *native::GaugeLayout::units};

// The widest angle, either side of straight up, reached by solid corners of this colour.
float reach_degrees(const RecordingHud &hud, const native::NameColor &color) {
    float widest = 0;
    for (const auto &quad : hud.quads)
        for (size_t i = 0; i < 4; ++i) {
            if (!same_rgb(quad.colors[i], color)) continue;
            const float dx = quad.points[i][0] - pivot[0], dy = pivot[1] - quad.points[i][1];
            widest = std::max(widest, std::abs(float(std::atan2(dx, dy) * 180 / std::numbers::pi)));
        }
    return widest;
}

// How far from the pivot, in dial units, solid corners of this colour reach between `from` and `to` degrees.
float reach_units(const RecordingHud &hud, const native::NameColor &color, float from, float to) {
    float farthest = 0;
    for (const auto &quad : hud.quads)
        for (size_t i = 0; i < 4; ++i) {
            if (!same_rgb(quad.colors[i], color)) continue;
            const float dx = quad.points[i][0] - pivot[0], dy = pivot[1] - quad.points[i][1];
            const float angle = float(std::atan2(dx, dy) * 180 / std::numbers::pi);
            if (angle >= from && angle <= to)
                farthest = std::max(farthest, std::hypot(dx, dy) / native::GaugeLayout::units);
        }
    return farthest;
}

native::StrafeReading reading_at(std::optional<double> value) {
    native::StrafeReading reading;
    reading.has_pace = value.has_value();
    reading.percent = value.value_or(0);
    reading.cue = value ? native::TrainerCue::good : native::TrainerCue::keys;
    if (!value) reading.hint = native::StrafeHint::less_deadtime;
    return reading;
}

void check_angles() {
    const std::vector<std::pair<std::optional<double>, double>> vectors = {
            {std::nullopt, -90},
            {0, -90},
            {25, -67.5},
            {50, -45},
            {90, -9},
            {100, 0},
            {110, 9},
            {150, 45},
            {200, 90},
            {260, 90},
            {-5, -90}
    };
    for (const auto &[value, angle] : vectors)
        check(std::abs(native::gauge_angle(value) - angle) < 1e-9, "needle angle for " + std::to_string(angle));
    check(std::abs(native::gauge_angle(100.04) - 0) < 1e-9, "needle angle is kept to a tenth of a degree");
}

std::optional<native::StrafeHint> arc_hint(const native::StrafeReading &reading) {
    return native::gauge_hint(reading, 10, native::arc_value(reading));
}

void check_hints() {
    using native::StrafeHint;
    check(arc_hint(reading_at(std::nullopt)) == StrafeHint::less_deadtime, "no pace keeps the reading's");
    check(!arc_hint(reading_at(108)), "inside the zone has no hint");
    check(arc_hint(reading_at(85)) == StrafeHint::strafe_more, "slow turns more");
    check(arc_hint(reading_at(125)) == StrafeHint::strafe_less, "fast eases the turn");
    auto bar = reading_at(85);
    bar.bar = 104;
    check(!arc_hint(bar), "the Bar's average decides over the pace");
}

void check_drawing() {
    const auto palette = native::semantic_palette("off");
    native::TrainerAppearance look;
    look.style = "arc";
    look.zone = 10;
    RecordingHud hud;
    native::draw_trainer(hud, centre_x, top, reading_at(150), look, true, palette);
    check(std::abs(reach_degrees(hud, palette.trainer[0]) - 9) < .01f, "zone 10 is green to 9 degrees");
    check(std::abs(reach_degrees(hud, palette.trainer[1]) - 27) < .01f, "zone 10 is amber to 27 degrees");
    // The needle points at 45 degrees and reaches 40 units plus its round end; the centre mark reaches the rim.
    const float needle = native::GaugeLayout::needle + native::GaugeLayout::needle_width / 2;
    check(std::abs(reach_units(hud, look.color, 40, 50) - needle) < .05f, "needle at 45 degrees");
    check(reach_units(hud, look.color, 50, 89) < 3.5f, "only the hub to the needle's right");
    check(std::abs(reach_units(hud, look.color, -2, 2) - 50) < .05f, "centre mark reaches the rim");
    check(hud.texts.front() == "150%", "number under the dial");
    check(hud.texts.size() == 2 && hud.texts.back() == "ease turn", "hint beside the number");

    look.zone = 30;
    look.dim_below = 90;
    RecordingHud dim;
    native::draw_trainer(dim, centre_x, top, reading_at(std::nullopt), look, false, palette);
    check(std::abs(reach_degrees(dim, palette.trainer[0]) - 27) < .01f, "zone 30 is green to 27 degrees");
    check(std::abs(reach_degrees(dim, palette.trainer[1]) - 81) < .01f, "zone 30 is amber to 81 degrees");
    check(dim.texts.front() == "—" && dim.text_colors.front()[3] < .31f, "no pace dims and shows a dash");
    check(native::trainer_width(look) == native::GaugeLayout::box_width, "the dial is 8.5em wide");
}
}  // namespace

// The website's needle filter vectors (gauge report section 6): 100 tick, 400 u/s, sv_maxspeed 250, sv_airaccelerate
// 1000, so 100% turns atan(30 / 400) a tick.
class NeedleRun {
    native::StrafeTrainer trainer_;
    int64_t tick_ = 0;
    float yaw_ = 0;

public:
    static constexpr double ideal_degrees = 4.289153328819758;  // atan(30 / 400)

    NeedleRun() { feed(0, 450); }

    // One tick turning `pace` times the ideal, holding `side` (450 is D: turning right is a falling yaw).
    double feed(double pace, float side, bool grounded = false) {
        yaw_ -= float(pace * ideal_degrees);
        const native::SsjCmd command{0, side, yaw_, 0};
        native::TrainerSample sample;
        sample.speed = 400;
        sample.grounded = grounded;
        sample.tick = tick_++;
        sample.max_speed = 250;
        sample.air_accelerate = 1000;
        trainer_.feed(command, sample);
        return angle();
    }

    double angle() const { return native::gauge_angle(native::gauge_value(trainer_.reading)); }
};

void check_needle_filter() {
    NeedleRun rest;
    double angle = 0;
    for (int tick = 1; tick <= 4; ++tick)
        angle = rest.feed(1, 450);
    check(std::abs(angle + 45) < 1e-9, "four ticks from rest at 100% reach -45 degrees");
    for (int tick = 5; tick <= 14; ++tick)
        angle = rest.feed(1, 450);
    check(angle > -10, "above -10 degrees by tick 14");
    const std::vector<std::pair<double, double>> settle = {{.5, -45}, {1, 0}, {1.5, 45}, {2, 90}, {3, 90}};
    for (const auto &[pace, expected] : settle) {
        NeedleRun run;
        for (int tick = 0; tick < 200; ++tick)
            angle = run.feed(pace, 450);
        check(std::abs(angle - expected) < .05, "steady pace settles at " + std::to_string(expected));
    }
    const auto at_pace = [] {
        NeedleRun run;
        for (int tick = 0; tick < 40; ++tick)
            run.feed(1, 450);
        return run;
    };
    NeedleRun run = at_pace();
    const double held = run.angle();
    for (int tick = 0; tick < 3; ++tick)
        check(run.feed(1, -450) == held, "a strafe switch holds the needle");
    run = at_pace();
    check(run.feed(0, 450, true) == held, "a hop's ground tick holds the needle");
    check(run.feed(0, 450, true) < held - 5, "a second ground tick lets it fall");
    run = at_pace();
    for (int tick = 0; tick < 8; ++tick)
        check(run.feed(1, -450) == held, "eight ticks against the keys hold");
    check(run.feed(1, -450) < held - 5, "the ninth lets it fall");
    run = at_pace();
    double stopped = 0;
    for (int tick = 1; tick <= 50; ++tick) {
        stopped = run.feed(0, 450);
        if (tick == 20) check(stopped <= -85, "at -85 or below within 20 ticks of stopping");
    }
    check(stopped == -90, "flat left by 50 ticks");
}

// The Gauge's face, needle and hub: the green line straight up, the needle's tip where the value points.
void check_disc_drawing() {
    native::TrainerAppearance look;
    look.style = "gauge";
    RecordingHud hud;
    auto reading = reading_at(150);
    reading.gauge = 150;
    native::draw_trainer(hud, centre_x, top, reading, look, true, native::semantic_palette("off"));
    const native::HudPoint disc_pivot = {centre_x, top - native::DiscLayout::view_top * native::GaugeLayout::units};
    const auto dark = native::semantic_rgb(native::DiscLayout::needle_rgb);
    float tip = 0, tip_angle = 0;
    for (const auto &quad : hud.quads)
        for (size_t i = 0; i < 4; ++i) {
            if (!same_rgb(quad.colors[i], dark)) continue;
            const float dx = quad.points[i][0] - disc_pivot[0], dy = disc_pivot[1] - quad.points[i][1];
            const float reach = std::hypot(dx, dy) / native::GaugeLayout::units;
            if (reach > tip) {
                tip = reach;
                tip_angle = float(std::atan2(dx, dy) * 180 / std::numbers::pi);
            }
        }
    check(std::abs(tip - native::DiscLayout::needle) < .01f && std::abs(tip_angle - 45) < .5f, "needle tip at 45");
    check(hud.texts.front() == "150%", "the number under the hub");
    // The light edge reaches a unit past the hub's lower half, which hangs below the face.
    float edge_below = 0;
    for (const auto &quad : hud.quads)
        for (size_t i = 0; i < 4; ++i)
            if (same_rgb(quad.colors[i], {1, 1, 1, 1}) && quad.colors[i][3] > .6f)
                edge_below = std::max(edge_below, (quad.points[i][1] - disc_pivot[1]) / native::GaugeLayout::units);
    check(std::abs(edge_below - (native::DiscLayout::hub + native::DiscLayout::edge_width)) < .05f, "light edge");
    const auto close = [](const native::NameColor &a, const native::NameColor &b) {
        for (size_t i = 0; i < 4; ++i)
            if (std::abs(a[i] - b[i]) > 1e-6f) return false;
        return true;
    };
    check(close(native::disc_face_color(0), native::semantic_rgb(0xffffff)), "white straight up");
    check(close(native::disc_face_color(-90), native::semantic_rgb(0x0a04f5)), "blue flat left");
    check(close(native::disc_face_color(90), native::semantic_rgb(0xe00204)), "red flat right");
    const auto between = native::disc_face_color(22.5f), white = native::semantic_rgb(0xffffff),
               pink = native::semantic_rgb(0xec6670);
    check(std::abs(between[1] - (white[1] + pink[1]) / 2) < 1e-6f, "halfway between stops");
    auto preview = reading_at(120);
    check(native::gauge_value(preview) == 120, "a preview shows the pace");
    preview.has_pace = false;
    preview.gauge = 0;
    check(!native::gauge_value(preview), "a resting needle with no pace is nothing");
}

// The Gauge's strafe sync against the website's G1-G15 (test/strafe-trainer-gauge-sync.test.ts; findings in the
// reference analysis): 400 u/s, push 30, Smoothing 8, after 40 ticks of A turning left at the ideal rate. Source air
// movement at 100 tick feeds the trainer as the HUD does: the command and the velocity it ended with.
class Air {
    static constexpr double push = 30;
    std::array<double, 2> velocity_ = {400, 0};
    double yaw_ = 0;
    int64_t tick_ = 0;
    bool sideways_, heading_;

public:
    native::StrafeTrainer trainer;

    explicit Air(bool sideways = false, bool heading = true) : sideways_(sideways), heading_(heading) {
        for (int i = 0; i < 40; ++i)
            step(1, 1);
    }

    // `key`: 1 A (strafe left), -1 D, 0 none; `rate`: the turn in ideal steps.
    double step(int key, double rate, bool grounded = false, bool interrupted = false) {
        constexpr double degrees = 180 / std::numbers::pi;
        const double speed = std::hypot(velocity_[0], velocity_[1]);
        yaw_ += rate * std::atan2(push, speed) * degrees;
        const double view = sideways_ ? yaw_ + 90 : yaw_;
        const double forward = sideways_ ? key * 450. : 0, side = sideways_ ? 0 : -key * 450.;
        const double y = view / degrees;
        const double wx = forward * std::cos(y) + side * std::sin(y), wy = forward * std::sin(y) - side * std::cos(y);
        const double length = std::hypot(wx, wy);
        if (length && !grounded) {
            const double along = (velocity_[0] * wx + velocity_[1] * wy) / length;
            if (along < push) {
                velocity_[0] += wx / length * (push - along);
                velocity_[1] += wy / length * (push - along);
            }
        }
        native::TrainerSample sample;
        sample.speed = std::hypot(velocity_[0], velocity_[1]);
        if (heading_) sample.vel_yaw = std::atan2(velocity_[1], velocity_[0]) * degrees;
        sample.grounded = grounded;
        sample.interrupted = interrupted;
        sample.tick = tick_++;
        sample.max_speed = 250;
        sample.air_accelerate = 1000;
        trainer.feed({float(forward), float(side), float(view), 0}, sample);
        return native::gauge_angle(native::gauge_value(trainer.reading));
    }

    std::vector<double> run(const std::vector<std::pair<int, double>> &script) {
        std::vector<double> angles;
        for (const auto &[key, rate] : script)
            angles.push_back(step(key, rate));
        return angles;
    }
};

std::vector<std::pair<int, double>> repeat(int count, int key, double rate) {
    return std::vector<std::pair<int, double>>(size_t(count), {key, rate});
}

std::vector<std::pair<int, double>>
join(std::vector<std::pair<int, double>> a, const std::vector<std::pair<int, double>> &b) {
    a.insert(a.end(), b.begin(), b.end());
    return a;
}

bool near(double got, double want, double tolerance) {
    return std::abs(got - want) < tolerance;
}

void check_gauge_sync() {
    constexpr int A = 1, D = -1;
    check(native::gauge_sync(400, 0, 0, 450, 0, 30) && near(*native::gauge_sync(400, 0, 0, 450, 0, 30), 100, 1e-9),
          "sync square");
    check(native::gauge_sync(400, 0, 0, 450, 90, 30) == 0., "sync gains nothing");
    check(native::gauge_sync(400, 0, 0, 450, -90, 30) == 200., "sync points back");
    check(!native::gauge_sync(400, 0, 0, 0, 0, 30), "no wish");
    for (const double angle : Air().run(repeat(6, A, 1)))
        check(std::abs(angle) < 1, "G1 steady");
    Air g2;
    for (const double angle : g2.run(join({{D, 1}}, repeat(8, D, -1))))
        check(std::abs(angle) < 20, "G2 ideal switch");
    check(g2.trainer.flattens.red == 0 && g2.trainer.flattens.blue == 0, "G2 no snap");
    Air g3;
    const auto red = g3.run(repeat(17, D, -1));
    check(red[0] == 90 && red[1] == 90 && near(red[2], 75.6, 2) && near(red[3], 63.6, 2) && std::abs(red[16]) < 10,
          "G3");
    check(g3.trainer.flattens.red == 1 && g3.trainer.flattens.blue == 0, "G3 one red");
    Air g4;
    const auto blue = g4.run(join(repeat(2, D, 1), repeat(8, D, -1)));
    check(std::abs(blue[0]) < 1 && blue[1] == -90 && blue[2] == -90 && near(blue[3], -75.7, 2), "G4");
    check(g4.trainer.flattens.red == 0 && g4.trainer.flattens.blue == 1, "G4 one blue");
    const auto g5 = Air().run(join(repeat(3, D, 1), repeat(8, D, -1)));
    check(g5[1] == -90 && g5[2] == -90 && g5[3] == -90 && g5[4] == -90 && g5[5] > -80, "G5");
    const auto g6 = Air().run(join({{A, -1}}, repeat(8, D, -1)));
    check(g6[0] == -90 && g6[1] == 90 && g6[2] == 90, "G6");
    const auto g7 = Air().run(join(repeat(3, 0, -1), repeat(8, D, -1)));
    check(near(g7[0], -14.6, 1) && near(g7[1], -26.6, 1) && near(g7[2], -36.7, 1) && g7[3] == 90 && g7[4] == 90, "G7");
    Air g8;
    std::vector<std::pair<int, double>> sixty;
    for (int i = 0; i < 6; ++i)
        sixty = join(sixty, {{A, 0}, {A, 2}});
    for (const double angle : g8.run(sixty))
        check(std::abs(angle) < 20, "G8 60 fps mouse");
    check(g8.trainer.flattens.red == 0 && g8.trainer.flattens.blue == 0, "G8 no snap");
    Air g9;
    const auto flick = g9.run(join({{A, 2.6}}, repeat(6, A, 1)));
    check(near(flick[0], 14.1, 1) && g9.trainer.flattens.red + g9.trainer.flattens.blue == 0, "G9");
    const auto g10 = Air().run(repeat(30, A, 0));
    const auto g10_old = Air(false, false).run(repeat(30, A, 0));
    for (size_t i = 0; i < g10.size(); ++i)
        check(near(g10[i], g10_old[i], 1), "G10 the same curve as without sync");
    check(near(g10[0], -14.6, 1) && near(g10[1], -26.6, 1) && near(g10[2], -36.7, 1), "G10");
    const auto sideways_red = Air(true).run(repeat(4, D, -1));
    check(sideways_red[0] == 90 && sideways_red[1] == 90 && near(sideways_red[2], 75.6, 2), "G12 red");
    const auto sideways_blue = Air(true).run(join(repeat(2, D, 1), repeat(2, D, -1)));
    check(sideways_blue[1] == -90 && sideways_blue[2] == -90 && near(sideways_blue[3], -75.7, 2), "G12 blue");
    const auto no_keys = Air().run(repeat(20, 0, 1)), no_keys_old = Air(false, false).run(repeat(20, 0, 1));
    for (size_t i = 0; i < no_keys.size(); ++i)
        check(near(no_keys[i], no_keys_old[i], 1), "G13 no keys");
    Air g13;
    const double up = g13.step(A, 1);
    check(g13.step(A, 1, true) == up && g13.step(A, 1, true) < up - 5, "G13 ground");
    g13.run(repeat(20, A, 1));
    check(g13.step(A, 1, false, true) == -90 && g13.trainer.flattens.red + g13.trainer.flattens.blue == 0,
          "G13 teleport");
    for (const auto &script : {repeat(8, D, -1), join(repeat(2, D, 1), repeat(6, D, -1))}) {
        Air old(false, false);
        for (const double angle : old.run(script))
            check(std::abs(angle) < 25, "G14 without the heading");
        check(old.trainer.flattens.red + old.trainer.flattens.blue == 0, "G14 no flattens");
    }
}

// G15: the bhop_bfur Autohop WR's trainer feed (the website's test/fixtures/gauge/bfur-wr.bin): about 21 flattens, 8
// red and 13 blue, and about 5% of strafing air ticks flat.
void check_wr(const char *path) {
    std::FILE *file = std::fopen(path, "rb");
    check(file != nullptr, "G15 fixture");
    std::vector<unsigned char> bytes;
    for (int c; (c = std::fgetc(file)) != EOF;)
        bytes.push_back((unsigned char)c);
    std::fclose(file);
    const auto u32 = [&](size_t o) {
        uint32_t v;
        std::memcpy(&v, &bytes[o], 4);
        return v;
    };
    const auto f32 = [&](size_t o) {
        float v;
        std::memcpy(&v, &bytes[o], 4);
        return v;
    };
    const auto i16 = [&](size_t o) {
        int16_t v;
        std::memcpy(&v, &bytes[o], 2);
        return v;
    };
    const uint32_t count = u32(0);
    const float dt = f32(4), max_speed = f32(8), accelerate = f32(12);
    native::StrafeTrainer trainer;
    int events = 0, red_events = 0, last_kind = 0;
    int64_t last_tick = -100;
    unsigned air = 0, flat = 0;
    for (uint32_t i = 0; i < count; ++i) {
        const size_t o = 16 + size_t(i) * 17;
        const float yaw = f32(o), vx = f32(o + 4), vy = f32(o + 8);
        const int16_t forward = i16(o + 12), side = i16(o + 14);
        const unsigned flags = bytes[o + 16];
        const double speed = std::hypot(double(vx), double(vy));
        native::TrainerSample sample;
        sample.speed = double(float(speed));
        sample.vel_yaw = std::atan2(double(vy), double(vx)) * 180 / std::numbers::pi;
        sample.grounded = flags & 1;
        sample.on_ladder = flags & 2;
        sample.jumped = flags & 4;
        sample.interrupted = flags & 8;
        sample.tick = int64_t(i) + 1;
        sample.dt = dt;
        sample.max_speed = max_speed;
        sample.air_accelerate = accelerate;
        const auto before = trainer.flattens;
        trainer.feed({float(forward), float(side), yaw, 0}, sample);
        const int kind = trainer.flattens.red > before.red ? 1 : trainer.flattens.blue > before.blue ? 2 : 0;
        if (kind) {
            // Snaps closer together than gauge_flat_ticks are one flatten (the analysis counts them so).
            if (!(int64_t(i) - last_tick <= native::gauge_flat_ticks && kind == last_kind)) {
                ++events;
                red_events += kind == 1;
            }
            last_tick = i;
            last_kind = kind;
        }
        if (!(flags & 3) && speed >= 100 && (side || forward)) {
            ++air;
            flat += std::abs(native::gauge_angle(native::gauge_value(trainer.reading))) >= 80;
        }
    }
    check(std::abs(events - 21) <= 2 && std::abs(red_events - 8) <= 2 && std::abs(events - red_events - 13) <= 2,
          "G15 flattens: " + std::to_string(events) + " (" + std::to_string(red_events) + " red)");
    const double share = double(flat) / air;
    check(share > .02 && share < .08, "G15 flat share " + std::to_string(share));
}

int main(int argc, char **argv) {
    check_needle_filter();
    check_gauge_sync();
    if (argc > 1) check_wr(argv[1]);
    check_disc_drawing();
    check_angles();
    check_hints();
    check_drawing();
    return 0;
}
