#include "room_pose.hpp"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <iostream>
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
    const auto message = native::room_pose_message(7, "eu-1", "bhop_eazy", batcher.samples(), meta);
    assert(message["generation"] == 7);
    assert(message["id"] == "eu-1");
    assert(message["map"] == "bhop_eazy");
    assert(message["samples"].size() == 2);
    assert(message["samples"][0]["tick"] == 4);
    assert(message["samples"][1]["tick"] == 8);
    assert(message["samples"][1]["vz"] == 6);
    assert(message["samples"][1]["yaw"] == 90);
    assert(message["samples"][1]["flags"] == 1);
    assert(message["meta"]["style"] == "infinite");
    assert(message["meta"]["timerTicks"] == 123);
    assert(message["weapon"] == 2);
    assert(message["silenced"] == true);
}

}  // namespace

int main() {
    batches_follow_simulated_ticks();
    ticks_stay_monotonic_while_not_sending();
    a_full_batch_keeps_the_newest_samples();
    meta_reports_the_run();
    message_has_the_shape_room_service_reads();
    std::cout << "room pose tests passed\n";
}
