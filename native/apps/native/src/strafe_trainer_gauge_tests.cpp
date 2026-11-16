// The strafe trainer's Gauge look against the website's (hud/strafe-trainer.ts gaugeAngle, gaugeCue, GAUGE_*): the
// needle's angle, the hint, and where the dial's arcs and needle are drawn.
#include "hud_trainer.hpp"
#include "semantic_palette.hpp"
#include <cmath>
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

int main() {
    check_needle_filter();
    check_disc_drawing();
    check_angles();
    check_hints();
    check_drawing();
    return 0;
}
