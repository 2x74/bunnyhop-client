#include "room_pose.hpp"
#include <nlohmann/json.hpp>
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <iostream>
#include <limits>
#include <string>
#include <vector>

namespace {

using native::RoomPoseBatcher;
using native::RoomPoseSample;

struct Batch {
    uint32_t sent_at_tick = 0;
    std::vector<RoomPoseSample> samples;
};

// Steps the batcher like the game loop does for `ticks` simulated ticks. Wall time and frames play no part: a frame
// that steps several ticks at once (a hitch catching up) must still give evenly spaced samples.
void step(RoomPoseBatcher &batcher, uint32_t &tick, uint32_t ticks, bool sending, std::vector<Batch> &out) {
    for (uint32_t i = 0; i < ticks; ++i) {
        ++tick;
        if (!batcher.advance(sending)) continue;
        RoomPoseSample sample;
        sample.position = {float(tick), 0, 0};
        batcher.add(sample);
        if (!batcher.batch_due()) continue;
        out.push_back({tick, {batcher.samples().begin(), batcher.samples().end()}});
        batcher.clear();
    }
}

void batches_follow_simulated_ticks() {
    RoomPoseBatcher batcher;
    uint32_t tick = 0;
    std::vector<Batch> batches;
    // Ten seconds at 100 ticks a second, stepped in uneven frame-sized chunks.
    for (const uint32_t chunk : {1u, 3u, 7u, 1u, 20u, 2u})
        for (int frame = 0; frame < 30; ++frame)
            step(batcher, tick, chunk, true, batches);
    assert(tick == 30 * (1 + 3 + 7 + 1 + 20 + 2));
    assert(batches.size() == tick / RoomPoseBatcher::send_ticks);
    uint32_t previous = 0;
    for (const auto &batch : batches) {
        // Five samples per batch, four ticks apart, the last one on the tick the batch goes out (web net/mp.ts).
        assert(batch.samples.size() == RoomPoseBatcher::send_ticks / RoomPoseBatcher::sample_ticks);
        assert(batch.samples.back().tick == batch.sent_at_tick);
        for (const auto &sample : batch.samples) {
            assert(sample.tick == previous + RoomPoseBatcher::sample_ticks);
            assert(sample.position[0] == float(sample.tick));
            previous = sample.tick;
        }
    }
}

void ticks_stay_monotonic_while_not_sending() {
    RoomPoseBatcher batcher;
    uint32_t tick = 0;
    std::vector<Batch> batches;
    step(batcher, tick, 30, true, batches);
    assert(batches.size() == 1);
    // Samples taken before spectating are dropped, never sent late with the next batch.
    step(batcher, tick, 47, false, batches);
    assert(batches.size() == 1);
    // Resuming on tick 78: the first sample is tick 80, which is also a send tick, then batches are whole again.
    step(batcher, tick, 23, true, batches);
    assert(batches.size() == 3);
    assert(batches[1].samples.size() == 1);
    assert(batches[1].samples[0].tick == 80);
    assert(batches[2].samples.size() == 5);
    assert(batches[2].samples.front().tick == 84);
    assert(batches[2].samples.back().tick == 100);
}

void a_full_batch_keeps_the_newest_samples() {
    RoomPoseBatcher batcher;
    for (uint32_t i = 0; i < RoomPoseBatcher::max_samples + 3; ++i) {
        batcher.advance(true);
        batcher.add({});
    }
    assert(batcher.samples().size() == RoomPoseBatcher::max_samples);
    assert(batcher.samples().back().tick == RoomPoseBatcher::max_samples + 3);
    assert(batcher.samples().front().tick == 4);
}

void meta_reports_the_run() {
    BhRunState run{};
    assert(native::room_pose_meta(run, 500, "autohop").timer == 0);
    run.in_start = 1;
    assert(native::room_pose_meta(run, 500, "autohop").timer == 1);
    run.in_start = 0;
    run.status = 1;
    run.start_tick = 200;
    run.track = 2;
    auto meta = native::room_pose_meta(run, 500, "sideways");
    assert(meta.timer == 2);
    assert(meta.timer_ticks == 300);
    assert(meta.track == 2);
    run.status = 2;
    run.end_tick = 450;
    meta = native::room_pose_meta(run, 900, "sideways");
    assert(meta.timer == 3);
    assert(meta.timer_ticks == 250);
}

// The JSON inside the script, as room-service.ts gets it.
nlohmann::json script_message(const std::string &script) {
    constexpr std::string_view call = "window.bunnyhopNativeMenu?.onRoomPose?.(";
    assert(script.starts_with(call) && script.ends_with(")"));
    return nlohmann::json::parse(script.substr(call.size(), script.size() - call.size() - 1));
}

void message_has_the_shape_room_service_reads() {
    RoomPoseBatcher batcher;
    for (int i = 0; i < 8; ++i) {
        if (!batcher.advance(true)) continue;
        RoomPoseSample sample;
        sample.position = {1, 2, 3};
        sample.velocity = {4, 5, 6};
        sample.yaw = 90;
        sample.pitch = -10;
        sample.flags = native::room_flag_grounded;
        batcher.add(sample);
    }
    native::RoomPoseMeta meta;
    meta.style = "infinite";
    meta.timer = 2;
    meta.timer_ticks = 123;
    meta.weapon = 2;
    meta.silenced = true;
    native::RoomPoseOutbox outbox;
    outbox.add(7, batcher.samples(), meta);
    native::RoomPoseScript script;
    const auto message = script_message(script.write(7, "eu-1", "bhop_eazy", outbox.batches()[0]));
    assert(message["generation"] == 7);
    assert(message["id"] == "eu-1");
    assert(message["map"] == "bhop_eazy");
    assert(message["samples"].size() == 2);
    assert(message["samples"][0]["tick"] == 4);
    assert(message["samples"][1]["tick"] == 8);
    assert(message["samples"][1]["x"] == 1 && message["samples"][1]["vz"] == 6);
    assert(message["samples"][1]["yaw"] == 90 && message["samples"][1]["pitch"] == -10);
    assert(message["samples"][1]["flags"] == 1);
    assert(message["meta"]["style"] == "infinite");
    assert(message["meta"]["track"] == 0 && message["meta"]["timer"] == 2);
    assert(message["meta"]["timerTicks"] == 123);
    assert(message["weapon"] == 2);
    assert(message["silenced"] == true);
}

// Floats arrive as the exact value the tick had, as nlohmann::json sent them; text that needs escaping survives.
void message_keeps_values_exact() {
    RoomPoseSample sample;
    sample.position = {0.1f, -16303.25f, 1e-7f};
    sample.velocity = {std::numeric_limits<float>::quiet_NaN(), std::numeric_limits<float>::infinity(), 3.4e38f};
    sample.yaw = 359.99997f;
    sample.pitch = -89.f;
    const RoomPoseSample samples[] = {sample};
    native::RoomPoseOutbox outbox;
    outbox.add(1, samples, {.style = "half-sideways"});
    native::RoomPoseScript script;
    const auto message = script_message(script.write(1, "room \"a\"\\b\n", "bhop_\x01", outbox.batches()[0]));
    const auto &sent = message["samples"][0];
    assert(sent["x"].get<double>() == double(0.1f));
    assert(sent["y"].get<double>() == -16303.25);
    assert(sent["z"].get<double>() == double(1e-7f));
    assert(sent["vx"].is_null() && sent["vy"].is_null());
    assert(sent["vz"].get<double>() == double(3.4e38f));
    assert(sent["yaw"].get<double>() == double(359.99997f));
    assert(message["id"] == "room \"a\"\\b\n");
    assert(message["map"] == "bhop_\x01");
    assert(message["meta"]["style"] == "half-sideways");
}

// Writing a full batch again reuses the script's buffer.
void sending_reuses_the_buffer() {
    RoomPoseBatcher batcher;
    for (uint32_t i = 0; i < RoomPoseBatcher::max_samples * RoomPoseBatcher::sample_ticks; ++i) {
        if (!batcher.advance(true)) continue;
        RoomPoseSample sample;
        sample.position = {-16303.123f, -16303.123f, -16303.123f};
        sample.velocity = {-3499.9998f, -3499.9998f, -3499.9998f};
        sample.yaw = -179.99998f;
        sample.pitch = -89.99999f;
        sample.flags = 0xffffffff;
        batcher.add(sample);
    }
    native::RoomPoseMeta meta;
    meta.style = "autostrafe";
    meta.timer_ticks = 0xffffffff;
    native::RoomPoseOutbox outbox;
    outbox.add(~0ull, batcher.samples(), meta);
    native::RoomPoseScript script;
    const std::string room_id(64, 'r');
    const std::string map(96, 'm');
    const auto &first = script.write(~0ull, room_id, map, outbox.batches()[0]);
    const char *buffer = first.data();
    const size_t capacity = first.capacity();
    for (int i = 0; i < 3; ++i) {
        const auto &again = script.write(~0ull, room_id, map, outbox.batches()[0]);
        assert(again.data() == buffer && again.capacity() == capacity);
    }
    assert(script_message(first)["samples"].size() == RoomPoseBatcher::max_samples);
}

// A frame that catches up several sends keeps each batch with the ticks it was taken on; past the outbox's room the
// oldest go.
void a_catch_up_frame_keeps_every_batch() {
    RoomPoseBatcher batcher;
    native::RoomPoseOutbox outbox;
    uint32_t tick = 0;
    const auto step = [&](uint32_t ticks) {
        for (uint32_t i = 0; i < ticks; ++i) {
            ++tick;
            if (!batcher.advance(true)) continue;
            batcher.add({});
            if (!batcher.batch_due()) continue;
            outbox.add(3, batcher.samples(), {});
            batcher.clear();
        }
    };
    step(47);
    assert(outbox.batches().size() == 2);
    assert(outbox.batches()[0].taken().back().tick == 20 && outbox.batches()[1].taken().front().tick == 24);
    assert(outbox.batches()[1].taken().back().tick == 40 && outbox.batches()[1].generation == 3);
    outbox.clear();
    step(RoomPoseBatcher::send_ticks * (native::RoomPoseOutbox::max_batches + 2));
    assert(outbox.batches().size() == native::RoomPoseOutbox::max_batches);
    assert(outbox.batches().back().taken().back().tick
           == tick / RoomPoseBatcher::send_ticks * RoomPoseBatcher::send_ticks);
    for (const auto &batch : outbox.batches())
        assert(batch.count == RoomPoseBatcher::send_ticks / RoomPoseBatcher::sample_ticks);
}

}  // namespace

int main() {
    batches_follow_simulated_ticks();
    ticks_stay_monotonic_while_not_sending();
    a_full_batch_keeps_the_newest_samples();
    meta_reports_the_run();
    message_has_the_shape_room_service_reads();
    message_keeps_values_exact();
    sending_reuses_the_buffer();
    a_catch_up_frame_keeps_every_batch();
    std::cout << "room pose tests passed\n";
}
