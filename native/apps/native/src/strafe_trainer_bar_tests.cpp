// The strafe trainer's Bar look against golden vectors from the web
// (native/tools/strafe-trainer-bar/generate-vectors.ts), and how it draws.
#include "hud_trainer.hpp"
#include "semantic_palette.hpp"
#include <cstdio>
#include <fstream>
#include <limits>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

namespace {
using Json = nlohmann::json;
constexpr double tolerance = 1e-9;
constexpr double starting_side = 450;

void check(bool value, const std::string &message) {
    if (value) return;
    std::fprintf(stderr, "%s\n", message.c_str());
    std::exit(1);
}

std::string band_name(const std::optional<native::TrainerBarBand> &band) {
    if (!band) return "";
    constexpr std::array<const char *, 5> names = {"perfect", "good", "ok", "low", "high"};
    return names[size_t(*band)];
}

bool matches(const std::optional<double> &value, const Json &expected) {
    if (expected.is_null()) return !value;
    return value && std::abs(*value - expected.get<double>()) < tolerance;
}

void replay_tick(native::StrafeTrainer &trainer, const Json &tick, const Json &scenario, const Json &vectors) {
    const auto &in = tick.at("in");
    const std::string style = scenario.at("style");
    native::SsjCmd command;
    command.side = in.at("side");
    command.yaw = in.at("yaw").get<float>();
    native::TrainerSample sample;
    sample.speed = in.at("speed");
    sample.grounded = in.at("grounded");
    sample.on_ladder = in.at("onLadder");
    sample.tick = in.at("tick");
    sample.dt = vectors.at("dt");
    sample.max_speed = vectors.at("maxSpeed");
    sample.air_accelerate = vectors.at("airAccelerate");
    sample.style = style;
    sample.interrupted = in.at("interrupted");
    sample.jumped = in.at("jumped");
    trainer.feed(command, sample);
}

void check_tick(const native::StrafeTrainer &trainer, const Json &tick, const std::string &where) {
    const auto &reading = trainer.reading;
    const std::optional<double> pace = reading.has_pace ? std::optional{reading.percent} : std::nullopt;
    check(matches(pace, tick.at("pace")), where + ": pace");
    check(matches(reading.bar, tick.at("bar")), where + ": bar");
    check(reading.bar_side == tick.at("barSide").get<int>(), where + ": bar side");
    check(matches(reading.last_jump, tick.at("lastJump")), where + ": last jump");
    const auto view = native::trainer_bar_view(reading, trainer.zone);
    check(std::abs(view.fill - tick.at("fill").get<double>()) < tolerance, where + ": fill");
    check((view.from_left ? "left" : "right") == tick.at("edge").get<std::string>(), where + ": edge");
    check(band_name(view.band) == tick.at("band").get<std::string>(), where + ": band");
}

size_t replay_vectors(const Json &vectors) {
    size_t ticks = 0;
    for (const auto &scenario : vectors.at("scenarios")) {
        native::StrafeTrainer trainer;
        trainer.set_smoothing(scenario.at("smoothing"));
        trainer.zone = scenario.at("zone");
        native::SsjCmd first;
        first.side = starting_side;
        const std::string style = scenario.at("style");
        native::TrainerSample sample;
        sample.style = style;
        sample.dt = vectors.at("dt");
        trainer.feed(first, sample);
        const std::string name = scenario.at("name");
        size_t index = 0;
        for (const auto &tick : scenario.at("ticks")) {
            replay_tick(trainer, tick, scenario, vectors);
            check_tick(trainer, tick, name + " tick " + std::to_string(index++));
        }
        ticks += index;
    }
    return ticks;
}

struct Rect {
    float x, y, width, height;
    native::NameColor color;
};

struct RecordingHud {
    std::vector<Rect> rects;
    std::string text;

    void overlay_rect(float x, float y, float width, float height, native::NameColor color) {
        rects.push_back({x, y, width, height, color});
    }

    void overlay_text(float, float, std::string_view value, float, native::NameColor, bool = false) {
        if (text.empty()) text = value;
    }
};

// How far left and right rects of this colour reach.
std::pair<float, float> extent(const RecordingHud &hud, const native::NameColor &color) {
    float from = std::numeric_limits<float>::max(), to = std::numeric_limits<float>::lowest();
    for (const auto &rect : hud.rects) {
        if (rect.color != color) continue;
        from = std::min(from, rect.x);
        to = std::max(to, rect.x + rect.width);
    }
    return {from, to};
}

void check_drawing() {
    constexpr float middle = 500;
    const float half = native::TrainerLayout::bar_width / 2;
    const auto palette = native::semantic_palette("off");
    native::TrainerAppearance look;
    look.style = "bar";
    check(native::trainer_width(look) == native::TrainerLayout::bar_width, "track width");
    native::StrafeReading reading;
    reading.percent = 100;
    reading.side = 1;
    reading.last_jump = 96.4;
    RecordingHud right_turn;
    native::draw_trainer(right_turn, middle, 0, reading, look, false, palette);
    const auto [from, to] = extent(right_turn, palette.trainer[3]);
    check(from >= middle - half && from < middle - half + native::TrainerLayout::bar_track / 2,
          "D fills from the left");
    check(std::abs(to - middle) < .01f, "100% reaches the centre tick");
    check(right_turn.text == "96%", "the number is the last jump");
    const auto &tick = right_turn.rects.back();
    check(tick.x == middle - .5f && tick.width == 1, "the centre tick is drawn last");

    reading.side = -1;
    RecordingHud left_turn;
    native::draw_trainer(left_turn, middle, 0, reading, look, false, palette);
    const auto [left_from, left_to] = extent(left_turn, palette.trainer[3]);
    check(std::abs(left_from - middle) < .01f && left_to <= middle + half, "A fills from the right");

    reading.percent = 200;
    reading.side = 1;
    RecordingHud full;
    native::draw_trainer(full, middle, 0, reading, look, false, palette);
    check(extent(full, palette.trainer[2]).second <= middle + half, "a full track stays inside its far end");

    reading = {};
    reading.has_pace = false;
    RecordingHud empty;
    native::draw_trainer(empty, middle, 0, reading, look, false, palette);
    check(empty.text == "—", "no jump yet shows the dash");
    check(extent(empty, palette.trainer[3]).second < extent(empty, palette.trainer[3]).first,
          "an empty track has no fill");

    reading.has_pace = true;
    reading.percent = 25;
    look.color = {1, 0, 1, 1};
    RecordingHud low;
    native::draw_trainer(low, middle, 0, reading, look, false, palette);
    check(extent(low, look.color).second > extent(low, look.color).first, "the low band uses the trainer's colour");
}

void check_palettes(const Json &vectors) {
    for (const auto &[mode, hex] : vectors.at("palettes").items()) {
        const auto text = hex.get<std::string>();
        const uint32_t rgb = uint32_t(std::stoul(text.substr(1), nullptr, 16));
        check(native::semantic_palette(mode).trainer[3] == native::semantic_rgb(rgb), "perfect colour in " + mode);
    }
}
}  // namespace

int main(int argc, char **argv) {
    if (argc != 2) {
        std::fprintf(stderr, "usage: %s strafe_trainer_bar_vectors.json\n", argv[0]);
        return 2;
    }
    std::ifstream file(argv[1]);
    const auto vectors = Json::parse(file);
    const size_t ticks = replay_vectors(vectors);
    check_palettes(vectors);
    check_drawing();
    std::printf("strafe trainer bar: %zu ticks match the web\n", ticks);
    return 0;
}
