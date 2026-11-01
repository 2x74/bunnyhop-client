// The strafe trainer's Bar look against the website's trainer and view (native/tools/movement-hud/bar-vectors.ts):
// every tick's reading, then what the player sees of it, drawn. Real ticks in the vectors hold the core's exact gain.
#include "hud_trainer.hpp"
#include "semantic_palette.hpp"
#include <zlib.h>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <nlohmann/json.hpp>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
using Json = nlohmann::json;
constexpr double tolerance = 1e-9;
constexpr std::array color_modes = {"off", "redGreen", "blueYellow"};

void check(bool value, const std::string &message) {
    if (value) return;
    std::fprintf(stderr, "%s\n", message.c_str());
    std::exit(1);
}

Json read_vectors(const char *path) {
    gzFile file = gzopen(path, "rb");
    if (!file) throw std::runtime_error("Cannot open movement HUD vectors");
    constexpr size_t chunk_bytes = 1 << 20;
    std::string text;
    std::vector<char> chunk(chunk_bytes);
    int count = 0;
    while ((count = gzread(file, chunk.data(), unsigned(chunk.size()))) > 0)
        text.append(chunk.data(), size_t(count));
    gzclose(file);
    return Json::parse(text);
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

double observation(const Json &value) {
    return value.is_null() ? NAN : value.get<double>();
}

native::TrainerSample sample_from(const Json &in, const std::string &style, const Json &vectors) {
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
    sample.air_speed_gain = observation(in.at("delta"));
    sample.air_best_gain = observation(in.at("best"));
    return sample;
}

native::SsjCmd command_from(const Json &in) {
    native::SsjCmd command;
    command.forward = in.at("forward");
    command.side = in.at("side");
    command.yaw = in.at("yaw").get<float>();
    return command;
}

struct Rect {
    float x, y, width, height;
    native::NameColor color;
};

struct RecordingHud {
    std::vector<Rect> rects;
    std::vector<std::string> texts;

    void overlay_rect(float x, float y, float width, float height, native::NameColor color) {
        rects.push_back({x, y, width, height, color});
    }

    void overlay_text(float, float, std::string_view value, float, native::NameColor, bool = false) {
        texts.emplace_back(value);
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

native::NameColor expected_band_color(const std::string &band, const native::SemanticPalette &palette) {
    if (band == "perfect") return palette.trainer[3];
    if (band == "good") return palette.trainer[0];
    if (band == "ok") return palette.trainer[1];
    if (band == "high") return palette.trainer[2];
    return {1, 1, 1, 1};
}

// The colour on screen, the edge it grows from and how far, under a trainer colour the fill must ignore.
void check_drawn_fill(
        const native::StrafeReading &reading,
        const Json &tick,
        const native::SemanticPalette &palette,
        float dim_below,
        const std::string &where
) {
    constexpr float middle = 500;
    const float width = native::TrainerLayout::bar_width;
    const float round_end = native::TrainerLayout::bar_track / 2;
    native::TrainerAppearance look;
    look.style = "bar";
    look.color = {1, 0, 1, 1};
    look.dim_below = dim_below;
    RecordingHud hud;
    native::draw_trainer(hud, middle, 0, reading, look, true, palette);
    const double fill = tick.at("fill");
    const std::string band = tick.at("band");
    const bool dimmed = tick.at("dim");
    native::NameColor color = expected_band_color(band, palette);
    if (dimmed) color[3] *= native::TrainerLayout::dimmed_alpha;
    const auto [from, to] = extent(hud, color);
    if (fill <= 0 || band.empty()) return check(to < from, where + ": an empty track has no fill");
    const float reach = float(fill) * width;
    const float left = middle - width / 2;
    if (tick.at("edge") == "left") {
        check(from >= left && from < left + round_end, where + ": grows from the left");
        check(to <= left + reach + .01f && to >= std::min(left + reach, left + width - round_end) - .01f,
              where + ": reaches its fill");
    } else {
        check(to <= left + width && to > left + width - round_end, where + ": grows from the right");
        check(from >= left + width - reach - .01f && from <= std::max(left + width - reach, left + round_end) + .01f,
              where + ": reaches its fill");
    }
    check(hud.rects.back().x == middle - .5f && hud.rects.back().width == 1, where + ": the centre tick is on top");
}

void check_tick(const native::StrafeTrainer &trainer, const Json &tick, float dim_below, const std::string &where) {
    const auto &reading = trainer.reading;
    const std::optional<double> pace = reading.has_pace ? std::optional{reading.percent} : std::nullopt;
    check(matches(pace, tick.at("pace")), where + ": pace");
    check(matches(reading.bar, tick.at("bar")), where + ": bar");
    check(reading.bar_side == tick.at("barSide").get<int>(), where + ": bar side");
    check(matches(reading.gain, tick.at("gain")), where + ": gain");
    check(matches(reading.last_jump, tick.at("lastJump")), where + ": last jump");
    const auto view = native::trainer_bar_view(reading);
    check(std::abs(view.fill - tick.at("fill").get<double>()) < tolerance, where + ": fill");
    check((view.from_left ? "left" : "right") == tick.at("edge").get<std::string>(), where + ": edge");
    check(band_name(view.band) == tick.at("band").get<std::string>(), where + ": band");
    const auto hint = native::trainer_bar_hint(reading);
    check((hint ? native::strafe_hint_text(*hint) : "") == tick.at("hint").get<std::string>(), where + ": hint");
    check(native::trainer_pace_text(reading.last_jump).view() == tick.at("text").get<std::string>(),
          where + ": number");
    const double rounded = std::floor(reading.percent + .5);
    check((dim_below > 0 && (!reading.has_pace || rounded < dim_below)) == tick.at("dim").get<bool>(), where + ": dim");
    for (const char *mode : color_modes)
        check_drawn_fill(reading, tick, native::semantic_palette(mode), dim_below, where + " " + mode);
}

size_t replay_vectors(const Json &vectors) {
    size_t ticks = 0;
    for (const auto &scenario : vectors.at("scenarios")) {
        native::StrafeTrainer trainer;
        trainer.set_smoothing(scenario.at("smoothing"));
        trainer.zone = native::trainer_bar_zone;
        const std::string style = scenario.at("style");
        const std::string name = scenario.at("name");
        const float dim_below = scenario.at("dimBelow");
        size_t index = 0;
        for (const auto &tick : scenario.at("ticks")) {
            const auto &in = tick.at("in");
            trainer.feed(command_from(in), sample_from(in, style, vectors));
            check_tick(trainer, tick, dim_below, name + " tick " + std::to_string(index++));
        }
        ticks += index;
    }
    return ticks;
}

void check_pure_rules(const Json &vectors) {
    for (const auto &item : vectors.at("colours")) {
        const std::optional<double> ratio =
                item.at("ratio").is_null() ? std::nullopt : std::optional{item.at("ratio").get<double>()};
        check(band_name(native::trainer_bar_band(ratio)) == item.at("band").get<std::string>(), "colour boundary");
    }
    check(native::trainer_bar_band(NAN) == native::TrainerBarBand::low, "NaN is neutral");
    for (const auto &item : vectors.at("gains"))
        check(matches(native::trainer_bar_gain(item.at("delta"), item.at("best")), item.at("gain")), "gain rule");
    check(!native::trainer_bar_gain(NAN, 1) && !native::trainer_bar_gain(1, NAN), "NaN has no gain");
}

// A preview that gives no gain stays neutral, and only a synthetic gain colours it.
void check_previews(const Json &vectors) {
    for (const auto &item : vectors.at("previews")) {
        const auto &in = item.at("reading");
        native::StrafeReading reading;
        reading.has_pace = !in.at("pace").is_null();
        reading.percent = reading.has_pace ? in.at("pace").get<double>() : 0;
        reading.side = in.at("side");
        if (!in.at("bar").is_null()) reading.bar = in.at("bar").get<double>();
        reading.bar_side = in.at("barSide");
        if (!in.at("gain").is_null()) reading.gain = in.at("gain").get<double>();
        if (in.at("cue") == "unsupported") reading.cue = native::TrainerCue::unsupported;
        const auto view = native::trainer_bar_view(reading);
        check(band_name(view.band) == item.at("band").get<std::string>(), "preview band");
        check((view.from_left ? "left" : "right") == item.at("edge").get<std::string>(), "preview edge");
        check(std::abs(view.fill - item.at("fill").get<double>()) < tolerance, "preview fill");
        const auto hint = native::trainer_bar_hint(reading);
        check((hint ? native::strafe_hint_text(*hint) : "") == item.at("hint").get<std::string>(), "preview hint");
    }
}

void check_palettes(const Json &palettes) {
    const auto rgb = [](const Json &value) {
        const auto text = value.get<std::string>();
        return native::semantic_rgb(uint32_t(std::stoul(text.substr(1), nullptr, 16)));
    };
    for (const auto &item : palettes) {
        const auto palette = native::semantic_palette(item.at("mode").get<std::string>());
        const auto &trainer = item.at("trainer");
        check(palette.trainer[3] == rgb(trainer.at("perfect")), "best gain colour");
        check(palette.trainer[0] == rgb(trainer.at("good")), "better gain colour");
        check(palette.trainer[1] == rgb(trainer.at("ok")), "positive gain colour");
        check(palette.trainer[2] == rgb(trainer.at("bad")), "loss colour");
    }
}

// The fill's colour never comes from the trainer's colour; the number and hints do.
void check_trainer_color_applies_to_text_only() {
    const auto palette = native::semantic_palette("off");
    native::TrainerAppearance look;
    look.style = "bar";
    look.color = {1, 0, 1, 1};
    native::StrafeReading reading;
    reading.percent = 100;
    reading.side = 1;
    reading.last_jump = 96.4;
    RecordingHud hud;
    native::draw_trainer(hud, 500, 0, reading, look, false, palette);
    check(extent(hud, look.color).second < extent(hud, look.color).first, "no fill in the trainer's colour");
    check(hud.texts.front() == "96%", "the number is the last jump");
    check(native::trainer_width(look) == native::TrainerLayout::bar_width, "track width");
    look.height = 2;
    check(native::trainer_rail_height(look) == 2 * native::TrainerLayout::bar_track, "height scales the track");
}

// What the client and the export hand the trainer reaches the reading, and a tick without it stays neutral.
void check_feed_carries_the_observation() {
    auto settings = native::default_settings();
    settings["strafeTrainer"] = true;
    settings["hudStrafeTrainerStyle"] = "bar";
    auto prefs = native::HudPreferences::from(settings);
    prefs.trainer_enabled = true;
    native::MovementFeedback feedback;
    BhSettings physics{};
    physics.max_speed = 250;
    physics.air_accelerate = 1000;
    BhState state{};
    state.velocity[0] = 400;
    native::SsjCmd command;
    command.side = 450;
    constexpr double tick_seconds = .01;
    const auto feed = [&](uint32_t tick, BhAirSpeedGain gain) {
        state.tick = tick;
        command.yaw = -float(tick);
        native::feed_strafe_trainer(feedback, prefs, state, command, physics, "autohop", tick_seconds, false, gain);
        return native::trainer_bar_view(*feedback.strafe_reading).band;
    };
    feed(0, {NAN, NAN});
    check(feed(1, {1.5f, 1.5f}) == native::TrainerBarBand::perfect, "a full gain is blue");
    check(feed(2, {-1, 1.5f}) == native::TrainerBarBand::high, "a loss is red");
    check(feed(3, {NAN, NAN}) == native::TrainerBarBand::low, "no observation is white, whatever the pace");
    check(feedback.strafe_trainer.zone == native::trainer_bar_zone, "the Bar's zone is fixed");
}

// The stored zone must not change the Bar's hints, and the number's text is only rebuilt for new digits.
void check_number_text() {
    native::TrainerNumberText number;
    check(number.view(std::nullopt) == "—", "no jump yet is a dash");
    check(number.view(96.4) == "96%", "rounds");
    check(number.view(96.2) == "96%", "same digits");
    check(number.view(200) == "200+%", "the far end says so");
    check(number.view(std::nullopt) == "—", "cleared");
}

void check_zone_setting_is_ignored() {
    native::TrainerAppearance look;
    look.zone = 30;
    check(native::trainer_zone(look) == 30, "other looks use the setting");
    look.style = "bar";
    check(native::trainer_zone(look) == native::trainer_bar_zone, "Bar's zone is fixed");
}
}  // namespace

int main(int argc, char **argv) {
    if (argc != 2) {
        std::fprintf(stderr, "usage: %s movement_hud_vectors.json.gz\n", argv[0]);
        return 2;
    }
    const auto data = read_vectors(argv[1]);
    const auto &vectors = data.at("bar");
    const size_t ticks = replay_vectors(vectors);
    check_pure_rules(vectors);
    check_previews(vectors);
    check_palettes(data.at("palettes"));
    check_trainer_color_applies_to_text_only();
    check_number_text();
    check_zone_setting_is_ignored();
    check_feed_carries_the_observation();
    std::printf("strafe trainer bar: %zu ticks match the web\n", ticks);
    return 0;
}
