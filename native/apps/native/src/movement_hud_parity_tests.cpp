#include "movement_hud.hpp"
#include <nlohmann/json.hpp>
#include <zlib.h>
#include <cassert>
#include <fstream>
#include <iostream>
#include <stdexcept>

namespace {
using Json = nlohmann::json;
unsigned checks = 0;

void check(bool condition, const std::string &where) {
    ++checks;
    if (!condition) throw std::runtime_error(where);
}

Json vectors(const char *path) {
    gzFile file = gzopen(path, "rb");
    if (!file) throw std::runtime_error("Cannot open movement HUD vectors");
    std::string text;
    std::array<char, 16384> buffer{};
    int count = 0;
    while ((count = gzread(file, buffer.data(), unsigned(buffer.size()))) > 0)
        text.append(buffer.data(), size_t(count));
    const int closed = gzclose(file);
    if (count < 0 || closed != Z_OK) throw std::runtime_error("Cannot decompress movement HUD vectors");
    return Json::parse(text);
}

BhState state_from(const Json &value) {
    BhState state{};
    state.tick = value.at("tick");
    state.grounded = value.at("grounded").get<bool>();
    state.on_ladder = value.at("onLadder").get<bool>();
    state.crouched = value.at("crouched").get<bool>();
    for (unsigned axis = 0; axis < 3; ++axis) {
        state.position[axis] = value.at("position")[axis];
        state.velocity[axis] = value.at("velocity")[axis];
    }
    return state;
}

native::SsjReport report_from(const Json &value) {
    native::SsjReport report;
    report.jump = value.at("jump");
    report.speed = value.at("speed");
    if (!value.at("diff").is_null()) report.diff = value.at("diff");
    if (!value.at("height").is_null()) report.height = value.at("height");
    if (!value.at("strafes").is_null()) report.strafes = value.at("strafes");
    if (!value.at("gain").is_null()) report.gain = value.at("gain");
    if (!value.at("sync").is_null()) report.sync = value.at("sync");
    if (!value.at("eff").is_null()) report.eff = value.at("eff");
    if (!value.at("time").is_null()) report.time = value.at("time");
    return report;
}

native::SsjFields fields_from(const Json &value) {
    return {value.at("speed"),
            value.at("diff"),
            value.at("gain"),
            value.at("sync"),
            value.at("strafes"),
            value.at("eff"),
            value.at("height"),
            value.at("time"),
            false};
}

void check_text(const native::SsjReport &report, const Json &expected, const std::string &where) {
    for (const auto &item : expected) {
        const auto fields = fields_from(item.at("fields"));
        const auto text = native::ssj_labels(report, fields);
        check(text.chat.view() == item.at("chat").get<std::string>(),
              where + " SSJ chat: " + std::string(text.chat.view()));
        check(text.hud.view() == item.at("hud").get<std::string>(),
              where + " SSJ HUD: " + std::string(text.hud.view()));
        const bool accent = fields.gain && report.gain && *report.gain >= native::good_gain;
        check(accent == item.at("accent"), where + " SSJ gain accent");
    }
}

std::string cue_name(native::TrainerCue cue) {
    constexpr std::array names = {"ready", "keys", "direction", "slow", "good", "fast", "unsupported"};
    return names[size_t(cue)];
}

void check_trainer(
        const native::StrafeReading &reading, const Json &tick, native::StrafeTrainer &trainer, const std::string &where
) {
    const auto &expected = tick.at("trainer");
    check(cue_name(reading.cue) == expected.at("cue").get<std::string>(), where + " trainer cue");
    check(reading.has_pace == !expected.at("pace").is_null(), where + " trainer available");
    check(reading.side == expected.at("side"), where + " trainer side");
    if (reading.has_pace)
        check(std::abs(reading.percent - expected.at("pace").get<double>()) < 1e-9, where + " trainer pace");
    check(native::trainer_text(reading).view() == expected.at("text").get<std::string>(), where + " trainer text");
    check((reading.hint ? native::strafe_hint_text(*reading.hint) : "") == expected.at("hint").get<std::string>(),
          where + " trainer hint");
    const double rounded = std::floor(reading.percent + .5);
    constexpr std::array bands = {"bad", "ok", "good"};
    const std::string band = reading.has_pace ? bands[native::trainer_band(rounded, trainer.zone)] : "";
    check(band == expected.at("zone").get<std::string>(), where + " trainer colour zone");
    check(std::abs(
                  native::trainer_position(reading.has_pace ? rounded : 100, reading.side, true)
                  - expected.at("position").get<double>()
          ) < 1e-9,
          where + " trainer marker");
    check((!reading.has_pace || rounded < 40) == expected.at("dim"), where + " trainer dim");
    const auto landing = trainer.take_landing();
    check(bool(landing) == !expected.at("landing").is_null(), where + " landing available");
    if (landing) check(std::abs(*landing - expected.at("landing").get<double>()) < 1e-9, where + " landing pace");
}

void check_settings(const Json &data) {
    auto settings = native::default_settings();
    const auto defaults = native::HudPreferences::from(settings);
    check(defaults.ssj_chat == data.at("defaults").at("chat"), "default SSJ chat");
    check(defaults.ssj_mode == native::SsjMode::sixth, "default SSJ mode");
    constexpr std::array names = {"Speed", "Diff", "Gain", "Sync", "Strafes", "Eff", "Height", "Time"};
    constexpr std::array web_names = {"speed", "diff", "gain", "sync", "strafes", "eff", "height", "time"};
    const auto &formatting = data.at("formatting")[0];
    const auto report = report_from(formatting.at("report"));
    for (const auto &item : formatting.at("expected")) {
        for (size_t i = 0; i < names.size(); ++i)
            settings[std::string("hudSsjFields") + names[i]] = item.at("fields").at(web_names[i]);
        const auto prefs = native::HudPreferences::from(settings);
        check(native::ssj_labels(report, prefs.ssj_fields).chat.view() == item.at("chat").get<std::string>(),
              "SSJ settings fields");
    }
    for (const auto &[name, mode] : std::array{
                 std::pair{"sixth", native::SsjMode::sixth},
                 std::pair{"every", native::SsjMode::every},
                 std::pair{"interval", native::SsjMode::every_nth}
         }) {
        settings["jumpStatsMode"] = name;
        settings["jumpStatsInterval"] = 6;
        const auto prefs = native::HudPreferences::from(settings);
        check(prefs.ssj_mode == mode && prefs.ssj_interval == 6, "SSJ settings mode");
    }
}

void check_palettes(const Json &data) {
    const auto color = [](const Json &value) {
        return native::name_color(value.get<std::string>());
    };
    for (const auto &item : data.at("palettes")) {
        const std::string mode = item.at("mode");
        const auto palette = native::semantic_palette(mode);
        const auto &trainer = item.at("trainer");
        check(palette.trainer[0] == color(trainer.at("good")), "trainer good colour");
        check(palette.trainer[1] == color(trainer.at("ok")), "trainer near colour");
        check(palette.trainer[2] == color(trainer.at("bad")), "trainer off colour");
        native::SsjFields fields;
        check(native::ssj_gain_color(80, fields, palette) == color(item.at("gain")), "SSJ gain colour");
        check(!native::ssj_gain_color(79.99f, fields, palette), "SSJ gain threshold");
        fields.gain = false;
        check(!native::ssj_gain_color(100, fields, palette), "hidden gain has no accent");
        native::LjReport report;
        report.standing = true;
        constexpr std::array distances = {249., 250., 260., 268., 275.};
        for (size_t tier = 0; tier < distances.size(); ++tier) {
            report.distance = distances[tier];
            check(native::lj_color(report, mode) == color(item.at("lj")[tier]), "LJ tier colour");
        }
    }
}

void check_jump_hud(
        native::JumpHud &tracker,
        native::MovementHud &hud,
        const BhCmd &command,
        const BhState &post,
        const Json &expected,
        const std::string &where
) {
    const auto report = tracker.feed(command, post);
    hud.tick_jump(command, post);
    check(bool(report) == !expected.at("report").is_null(), where + " jump report available");
    check(std::abs(tracker.sync() - expected.at("sync").get<double>()) < 1e-9, where + " jump sync");
    check(hud.jump_sync == tracker.sync(), where + " jump sync input");
    if (report) {
        const auto &want = expected.at("report");
        check(report->chain == want.at("chain"), where + " jump chain");
        check(std::abs(report->speed - want.at("speed").get<double>()) < 1e-9, where + " jump speed");
        check(std::abs(report->gain - want.at("gain").get<double>()) < 1e-9, where + " jump gain");
        check(native::jump_gain_text(report->gain).view() == expected.at("gainText").get<std::string>(),
              where + " jump gain text");
    }
    const auto palette = native::semantic_palette("off");
    const auto &band = expected.at("band");
    const auto color = band == "good" ? palette.gain : band == "ok" ? palette.sync : palette.loss;
    check(native::jump_sync_color(tracker.sync(), palette) == color, where + " jump sync colour");
}

void check_start_pre(
        native::StartPreTracker &tracker,
        const native::SsjState &before,
        const native::SsjTick &flags,
        const Json &tick,
        const std::string &where
) {
    const auto speed = tracker.tick(before, flags);
    const auto &expected_pre = tick.at("startPre");
    check(bool(speed) == (expected_pre != "keep"), where + " Start Pre update");
    if (speed) {
        check(bool(*speed) == !expected_pre.is_null(), where + " Start Pre clear");
        if (*speed) check(**speed == expected_pre, where + " Start Pre speed");
    }
}

BhState check_trainer_tick(
        native::MovementFeedback &feedback,
        native::HudPreferences &prefs,
        const native::SsjCmd &cmd,
        const BhState &post,
        const native::SsjTick &flags,
        const Json &tick,
        const std::string &style,
        const std::string &where
) {
    const auto &sample = tick.at("sample");
    prefs.trainer_smoothing = tick.at("smoothing");
    prefs.trainer.zone = tick.at("zone");
    BhSettings physics{};
    physics.max_speed = sample.at("maxSpeed");
    physics.air_accelerate = sample.at("airAccelerate");
    BhState trainer_state = post;
    trainer_state.events = (flags.jumped ? 2u : 0u) | (flags.teleported ? 1u : 0u);
    native::feed_strafe_trainer(
            feedback, prefs, trainer_state, cmd, physics, style, sample.at("dt"), sample.at("interrupted")
    );
    check_trainer(feedback.strafe_trainer.reading, tick, feedback.strafe_trainer, where);
    return trainer_state;
}

void check_offsets_and_first(
        native::OffsetTracker &offsets,
        native::FirstJumpTracker &first,
        const native::SsjCmd &cmd,
        const BhState &post,
        const native::SsjTick &flags,
        const Json &tick,
        const std::string &style,
        const std::string &where
) {
    BhState observed = post;
    observed.events = flags.teleported ? 1 : 0;
    const BhCmd movement{cmd.forward, cmd.side, cmd.yaw, 0, cmd.buttons};
    const auto offset = offsets.feed(movement, observed, style);
    check(bool(offset) == !tick.at("offset").is_null(), where + " offset available");
    if (offset)
        check(native::offset_text(*offset).view() == tick.at("offsetText").get<std::string>(), where + " offset text");
    BhRunState run{};
    run.jumps = tick.at("jumps");
    run.status = flags.in_start ? 0 : 1;
    run.in_start = flags.in_start;
    run.start_tick = tick.at("startTick");
    const auto fjt = first.feed(flags.jumped, run, post.tick, flags.teleported);
    check(bool(fjt) == !tick.at("first").is_null(), where + " FJT available");
    if (fjt) {
        check(native::first_jump_text(*fjt).view() == tick.at("firstHud").get<std::string>(), where + " FJT HUD");
        check(native::first_jump_text(*fjt, .01).view() == tick.at("firstChat").get<std::string>(),
              where + " FJT chat");
    }
}

void scenario(const Json &value) {
    const std::string style = value.at("style"), mode = value.at("mode");
    native::SsjTracker ssj(
            mode == "every"   ? native::SsjMode::every
            : mode == "sixth" ? native::SsjMode::sixth
                              : native::SsjMode::every_nth
    );
    native::StartPreTracker start_pre;
    native::JumpHud jump_tracker;
    native::MovementHud movement_hud;
    native::MovementFeedback feedback;
    auto prefs = native::HudPreferences::from(native::default_settings());
    prefs.trainer_enabled = true;
    auto &trainer = feedback.strafe_trainer;
    native::OffsetTracker offsets;
    native::FirstJumpTracker first;
    for (const auto &tick : value.at("ticks")) {
        if (tick.at("reset")) {
            ssj.reset();
            start_pre.reset();
            trainer.reset();
            offsets.reset();
            first.reset();
            jump_tracker.reset();
            movement_hud.reset();
        }
        const auto pre = state_from(tick.at("pre")), post = state_from(tick.at("post"));
        const auto &command = tick.at("cmd"), &info = tick.at("info");
        const native::SsjCmd cmd{command.at("forward"), command.at("side"), command.at("yaw"), command.at("buttons")};
        const native::SsjState before{pre.position, pre.velocity, bool(pre.grounded), bool(pre.on_ladder)};
        native::SsjTick flags{info.at("jumped"), info.at("teleported"), info.at("inStart"), info.at("noclip"), {}};
        if (!info.at("time").is_null()) flags.time = info.at("time");
        const std::string where = style + "/" + mode + " tick " + std::to_string(post.tick);
        const auto report = ssj.tick(before, cmd, flags);
        check(bool(report) == !tick.at("report").is_null(), where + " report availability");
        if (report) check_text(*report, tick.at("ssj"), where);
        check_start_pre(start_pre, before, flags, tick, where);
        const auto trainer_state = check_trainer_tick(feedback, prefs, cmd, post, flags, tick, style, where);
        const BhCmd movement{cmd.forward, cmd.side, cmd.yaw, 0, cmd.buttons};
        check_jump_hud(jump_tracker, movement_hud, movement, trainer_state, tick.at("jumpHud"), where);
        check_offsets_and_first(offsets, first, cmd, post, flags, tick, style, where);
    }
}
}  // namespace

int main(int argc, char **argv) {
    try {
        if (argc != 2) throw std::runtime_error("Pass movement_hud_vectors.json.gz");
        const auto data = vectors(argv[1]);
        check_settings(data);
        check_palettes(data);
        for (const auto &item : data.at("formatting"))
            check_text(report_from(item.at("report")), item.at("expected"), "format boundary");
        for (const auto &item : data.at("offsets")) {
            const auto &value = item.at("report");
            check(native::offset_text({value.at("ticks"), value.at("overlap"), value.at("gap")}).view()
                          == item.at("text").get<std::string>(),
                  "offset boundary");
        }
        for (const auto &item : data.at("longjumps")) {
            const auto &value = item.at("report");
            native::LjReport report;
            report.standing = value.at("kind") == "LJ";
            report.failed = value.at("failed");
            report.distance = value.at("distance");
            report.pre = value.at("pre");
            report.max = value.at("max");
            report.sync = value.at("sync");
            for (unsigned i = 0; i < value.at("strafes").get<unsigned>(); ++i)
                report.strafes.push_back({});
            const auto text = std::string(native::lj_head(report).view()) + " | "
                              + std::string(native::lj_details(report).view());
            check(text == item.at("text").get<std::string>(), "longjump text: " + text);
            check(native::lj_tier(report) == item.at("tier"), "longjump tier");
        }
        for (const auto &item : data.at("perf")) {
            BhRunState run{};
            run.measured_jumps = item.at("measured");
            run.last_perfect_tick = item.at("lastPerfectTick");
            run.perf_percent = item.at("percent").is_null() ? 0 : item.at("percent").get<double>();
            const std::string style = item.at("style");
            const double interval = item.at("interval");
            check(native::perf_text(run).view() == item.at("text").get<std::string>(), "perf label");
            check(native::perfect_hop_visible(style, run, item.at("tick"), interval) == item.at("perfect"),
                  "perfect hop visibility");
            check(!native::perfect_hop_visible(style, run, item.at("tick"), interval, true), "practice perfect hidden");
        }
        for (const auto &value : data.at("scenarios"))
            scenario(value);
        std::cout << checks << " movement HUD parity checks passed\n";
    } catch (const std::exception &error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
