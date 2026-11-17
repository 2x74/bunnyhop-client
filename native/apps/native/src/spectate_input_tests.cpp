// The watched player's HUD feed (spectate_input.hpp) against the website's (net/spectate-input.ts): the block's JSON
// is the one the website's encoder turns into its test vectors' bytes (ui/room-input.test.ts checks that half), and
// the recorder and feed keep the same ticks and reports.
#include "spectate_input.hpp"
#include <cstdio>
#include <cstdlib>
#include <string>

namespace {
using native::spectate_input::Block;
using native::spectate_input::Feed;
using native::spectate_input::Recorder;
using native::spectate_input::Report;
using native::spectate_input::Settings;
using native::spectate_input::Tick;
namespace input = native::spectate_input;

void check(bool value, const std::string &message) {
    if (value) return;
    std::fprintf(stderr, "%s\n", message.c_str());
    std::exit(1);
}

// $V42/spectate/vectors.txt V1, as the website decodes it.
constexpr const char *vector_v1 =
        R"({"tickInterval":0.01,"maxSpeed":250,"airAccelerate":1000,"ticks":[{"tick":123456,"keys":24,"forward":0,)"
        R"("side":450,"gain":4,"state":4,"yaw":87.25,"vx":612.5,"vy":-40.75},{"tick":123457,"keys":37,"forward":450,)"
        R"("side":-450,"gain":2,"state":17,"yaw":86.5,"vx":600,"vy":-41}],"reports":[{"tick":123456,"kind":1,"ssj":)"
        R"({"jump":6,"speed":615,"diff":51,"height":0,"gain":79.31999969482422,"sync":98.66000366210938,)"
        R"("eff":70.33000183105469,"strafes":2,"time":3.77,"jss":0.9871}},{"tick":123457,"kind":3,"speed":null}]})";

void check_vector_round_trip() {
    const auto v1 = nlohmann::json::parse(vector_v1);
    const auto block = input::from_json(v1);
    check(block.has_value(), "V1 reads");
    check(block->ticks.size() == 2 && block->reports.size() == 2, "V1 ticks and reports");
    check(input::to_json(*block) == v1, "V1 writes back the same block: " + input::to_json(*block).dump());
    const auto &every = block->reports[0];
    const auto jhud = input::jhud_of(every);
    check(jhud && jhud->jump == 6 && jhud->speed == 615 && jhud->jss && std::abs(*jhud->jss - .9871) < 1e-12,
          "V1 JHUD");
    check(input::shown_jump(every, native::SsjMode::every).has_value(), "every jump shows the every-jump stream");
    check(!input::shown_jump(every, native::SsjMode::sixth), "6th jump reads the every-6th stream");
    check(block->reports[1].kind == input::report_start_pre && !block->reports[1].start_pre, "V1 cleared prespeed");
}

void check_refused_blocks() {
    auto v1 = nlohmann::json::parse(vector_v1);
    auto broken = v1;
    broken["ticks"][1]["yaw"] = "north";
    check(!input::from_json(broken), "a record that doesn't read refuses the block");
    broken = v1;
    broken["ticks"] = nlohmann::json::array();
    check(!input::from_json(broken), "a block needs a record");
    broken = v1;
    broken["reports"][0]["kind"] = 9;
    const auto skipped = input::from_json(broken);
    check(skipped && skipped->reports.size() == 1, "an unknown report kind is skipped");
}

void check_keys_and_bands() {
    for (unsigned keys = 0; keys < 64; ++keys)
        check(input::keys_of(input::buttons_of(keys)) == keys, "keys survive buttons");
    check(input::gain_band(NAN, 10) == input::gain_none, "no observation");
    check(input::gain_band(0, 10) == input::gain_zero, "no gain");
    check(input::gain_band(-3, 10) == input::gain_loss, "a loss");
    check(input::gain_band(10, 10) == input::gain_perfect, "all of it");
    check(std::isnan(input::band_gain(input::gain_none)) && input::band_gain(input::gain_loss) == -1, "band gains");
}

Tick held(unsigned keys) {
    Tick tick;
    tick.keys = keys;
    tick.forward = 450;
    return tick;
}

void check_recorder() {
    Recorder recorder;
    const Settings normal{.01, 250, 1000};
    recorder.record(held(1), 10, normal);
    check(!recorder.take(), "unwatched keeps nothing");
    recorder.on = true;
    recorder.reset();
    recorder.report({0, input::report_start_pre, {}, 277});
    recorder.record(held(1), 11, normal);
    recorder.record(held(5), 12, normal);
    auto block = recorder.take();
    check(block && block->ticks.size() == 2 && block->ticks[0].state & input::state_reset,
          "a restart marks one record");
    check(!(block->ticks[1].state & input::state_reset), "only the first record after it");
    check(block->reports.size() == 1 && block->reports[0].tick == 11 && block->reports[0].start_pre == 277,
          "report tick");
    recorder.record(held(1), 13, normal);
    recorder.record(held(1), 15, normal);
    block = recorder.take();
    check(block && block->ticks.size() == 1 && block->ticks[0].tick == 15, "a gap starts a new block");
    recorder.record(held(1), 16, normal);
    recorder.record(held(1), 17, {.01, 260, 1000});
    block = recorder.take();
    check(block && block->ticks.size() == 1 && block->settings.max_speed == 260, "another style starts a new block");
    for (uint32_t tick = 100; tick < 150; ++tick)
        recorder.record(held(1), tick, normal);
    block = recorder.take();
    check(block && block->ticks.size() == input::max_ticks && block->ticks.front().tick == 110, "newest 40 records");
}

void check_feed() {
    Feed feed;
    const auto v1 = *input::from_json(nlohmann::json::parse(vector_v1));
    check(!feed.live(5), "no block yet");
    feed.push(v1, 5);
    check(feed.live(5.9) && !feed.live(6), "live for a second");
    std::vector<uint32_t> order;
    feed.take(
            123456,
            [&](const Tick &tick, const Settings &) { order.push_back(tick.tick); },
            [&](const Report &report) { order.push_back(1000000 + report.kind); }
    );
    check(order == std::vector<uint32_t>{123456, 1000001}, "the camera's tick and its report");
    feed.take(
            200000,
            [&](const Tick &tick, const Settings &) { order.push_back(tick.tick); },
            [&](const Report &report) { order.push_back(1000000 + report.kind); }
    );
    check(order == std::vector<uint32_t>{123456, 1000001, 123457, 1000003}, "the next tick and its report, in order");
}
}  // namespace

int main() {
    check_vector_round_trip();
    check_refused_blocks();
    check_keys_and_bands();
    check_recorder();
    check_feed();
    return 0;
}
