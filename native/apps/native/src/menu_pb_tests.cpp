// Offline integration test: link the native bridge; no SDL, GL, cache writes or
// network. Usage: menu-pb-tests MAP.bsp COMPLETED.bhr [CONTENT_ROOT [FIXTURE_DIR]]
#include "menu_pb.hpp"
#include <cstring>
#include <filesystem>
#include <iostream>
#include <memory>
#include <vector>

int main(int argc, char **argv) {
    try {
        if (argc < 3 || argc > 5) throw std::runtime_error("usage: menu-pb-tests MAP.bsp COMPLETED.bhr [CONTENT_ROOT [FIXTURE_DIR]]");
        using Core = std::unique_ptr<BhContext, decltype(&bh_destroy)>;
        Core scene(bh_create(), bh_destroy), oracle(bh_create(), bh_destroy);
        auto check = [](bool ok, const char *why) { if (!ok) throw std::runtime_error(why); };
        const char *content = argc >= 4 ? argv[3] : nullptr;
        check(scene && oracle, "context creation failed");
        check(bh_load_map(scene.get(), argv[1], content), bh_last_error(scene.get()));
        check(bh_load_map(oracle.get(), argv[1], content), bh_last_error(oracle.get()));
        native::backdrop::PbPlayback pb;
        pb.load(scene.get(), argv[2]);
        check(pb.generation() == 1 && pb.snapshot().player.tick == 0, "initial seek did not reset history");
        check(bh_replay_load(oracle.get(), argv[2]), bh_last_error(oracle.get()));
        auto compare = [&] {
            BhSnapshot expected{};
            const auto tick = pb.snapshot().player.tick;
            check(bh_replay_seek(oracle.get(), tick, &expected), bh_last_error(oracle.get()));
            size_t n = 0;
            const auto *bytes = bh_snapshot_bytes(scene.get(), &n);
            check(bytes && n, "missing backdrop state bytes");
            const std::vector<uint8_t> actual(bytes, bytes + n);
            bytes = bh_snapshot_bytes(oracle.get(), &n);
            check(bytes && actual == std::vector<uint8_t>(bytes, bytes + n), "backdrop differs from native deterministic seek");
            BhCmd cmd{};
            check(bh_last_command(oracle.get(), &cmd), "missing replay camera angles");
            check(std::memcmp(&cmd, &pb.command(), sizeof cmd) == 0, "replay camera differs from canonical command");
            // Native entity transforms must come from stepped replay world state.
            size_t groups = 0;
            const auto *g = bh_groups(scene.get(), &groups);
            for (size_t i = 0; i < groups; ++i) if (g[i].model) {
                BhTransform a{}, b{};
                check(bh_model_transform(scene.get(), g[i].model, &a) && bh_model_transform(oracle.get(), g[i].model, &b), "missing model transform");
                check(std::memcmp(&a, &b, sizeof a) == 0, "backdrop brush transform differs from replay world");
            }
            const auto *p = bh_prop_groups(scene.get(), &groups);
            for (size_t i = 0; i < groups; ++i) if (p[i].entity >= 0) {
                BhTransform a{}, b{};
                check(bh_prop_transform(scene.get(), p[i].entity, &a) && bh_prop_transform(oracle.get(), p[i].entity, &b), "missing prop transform");
                check(std::memcmp(&a, &b, sizeof a) == 0, "backdrop prop transform differs from replay world");
            }
        };
        compare();
        pb.advance(.1); compare();
        check(pb.snapshot().player.tick > 0 && pb.snapshot().player.tick <= 128, "unbounded or stalled playback");
        const auto tick = pb.snapshot().player.tick;
        const auto generation = pb.generation();
        pb.advance(-1); pb.advance(NAN); pb.advance(INFINITY);
        check(pb.snapshot().player.tick == tick, "non-finite/negative frame advanced replay");
        pb.seek(0); compare();
        check(pb.generation() == generation + 1 && pb.seconds() == 0, "backwards seek kept presentation history/time");
        pb.seek(pb.total_ticks()); compare();
        const auto end_generation = pb.generation();
        pb.advance(.1); compare();
        check(pb.generation() > end_generation && pb.snapshot().player.tick < pb.total_ticks(), "replay did not loop/reset history");
        bool rejected = false;
        try { pb.seek(pb.total_ticks() + 1); } catch (const std::exception &) { rejected = true; }
        check(rejected, "accepted seek beyond replay");
        compare();
        if (argc == 5) {
            const auto fixture = [&](const char *name) { return (std::filesystem::path(argv[4]) / name).string(); };
            for (const char *name : {"incomplete.bhr", "wrong-map.bhr"}) {
                bool rejected = false;
                try { pb.load(scene.get(), fixture(name)); } catch (const std::exception &) { rejected = true; }
                check(rejected, "accepted incomplete or wrong-map PB");
            }
            pb.load(scene.get(), fixture("checkpoint.bhr"));
            bool rejected = false;
            try { pb.advance(.1); } catch (const std::exception &) { rejected = true; }
            check(rejected, "ignored authoritative replay checkpoint failure");
            pb.load(scene.get(), fixture("tiny-interval.bhr"));
            pb.advance(1e6);
            check(pb.snapshot().player.tick == 128, "untrusted tick interval escaped 128-step frame bound");
        }
        std::cout << "PB backdrop: deterministic native step/seek/loop, camera and entity transforms match; bounded frame work; history generations reset\n";
    } catch (const std::exception &e) { std::cerr << "PB backdrop test: " << e.what() << '\n'; return 1; }
}
