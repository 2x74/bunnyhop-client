// Differential test: a made-up studio model posed by the website's bone setup and played by map-props.ts sequenceAt,
// and texture scrolls and flipbooks from texture-scroll.ts (src/map-props-oracle.ts), against the C++ ports. Then what
// the website's tests and Source pin down: activity picks, shared poses, distance steps and one-frame sequences.
#include "map_props.hpp"
#include "runtime_prop_copies.hpp"
#include "texture_motion.hpp"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <nlohmann/json.hpp>
#include <cassert>
#include <cmath>
#include <fstream>
#include <iostream>
#include <memory>
#include <string>
#include <vector>

namespace {

int failures = 0;
long compared = 0;

void fail(const std::string &where, const std::string &what) {
    if (++failures <= 20) std::cerr << "MISMATCH " << where << ": " << what << '\n';
}

// Float storage on both sides; the arithmetic between stores is the same, so only rounding of the last bit differs.
void close_to(const std::string &where, double actual, double expected, double tolerance) {
    ++compared;
    if (std::abs(actual - expected) > tolerance * std::max(1., std::abs(expected)))
        fail(where, std::to_string(actual) + " vs " + std::to_string(expected));
}

native_studio::Rig rig_from(const nlohmann::json &oracle) {
    const auto &animations = oracle.at("animations");
    std::vector<std::vector<float>> samples;
    for (const auto &a : animations)
        samples.push_back(a.get<std::vector<float>>());
    const native_studio::AnimationReader read = [&](uint32_t index) {
        return std::span<const float>(samples[index]);
    };
    return native_studio::Rig(oracle.at("info"), read);
}

std::unique_ptr<native_map_props::MapProps> props_from(const nlohmann::json &oracle) {
    auto props = std::make_unique<native_map_props::MapProps>();
    props->add_model(rig_from(oracle), 10);
    return props;
}

void check_rates_and_poses(const nlohmann::json &oracle) {
    auto props = props_from(oracle);
    auto &model = props->model(0);
    const auto &rates = oracle.at("rates");
    for (size_t seq = 0; seq < rates.size(); ++seq)
        close_to("rate " + std::to_string(seq), model.cycles_per_second(int(seq)), rates[seq].get<double>(), 1e-12);
    std::vector<float> rows(model.rig.bones * native_studio::matrix_floats);
    for (const auto &pose : oracle.at("poses")) {
        const int seq = pose.at("sequence").get<int>();
        const double cycle = pose.at("cycle").get<double>();
        model.setup.init_pose();
        model.setup.accumulate(seq, cycle, 1);
        const auto world = model.setup.build_matrices();
        for (size_t b = 0; b < model.rig.bones; ++b) {
            const size_t at = b * native_studio::matrix_floats;
            native_studio::concat34(world.data() + at, model.rig.pose_to_bone.data() + at, rows.data() + at);
        }
        const auto expected = pose.at("matrices").get<std::vector<double>>();
        const auto where = "pose " + std::to_string(seq) + " at " + std::to_string(cycle);
        for (size_t i = 0; i < rows.size(); ++i)
            close_to(where + " [" + std::to_string(i) + "]", rows[i], expected[i], 2e-6);
    }
}

void check_sequences(const nlohmann::json &oracle) {
    auto props = props_from(oracle);
    auto &model = props->model(0);
    for (const auto &item : oracle.at("shown")) {
        const auto &s = item.at("state");
        const native_map_props::SequenceState state{
                model.lookup(s.at("anim").get<std::string>(), 7),
                model.lookup(s.at("defaultAnim").get<std::string>(), 7),
                s.at("base").get<double>(),
                s.at("since").get<double>(),
                s.at("rate").get<double>()
        };
        for (const auto &at : item.at("at")) {
            const auto shown = native_map_props::sequence_at(state, at.at("time").get<double>(), model);
            const auto where = s.dump() + " at " + at.at("time").dump();
            ++compared;
            if (shown.sequence != at.at("sequence").get<int>())
                fail(where, "sequence " + std::to_string(shown.sequence));
            close_to(where, shown.cycle, at.at("cycle").get<double>(), 1e-12);
        }
    }
}

void check_texture_motion(const nlohmann::json &oracle) {
    for (const auto &scroll : oracle.at("scrolls"))
        for (const auto &at : scroll.at("at")) {
            const auto offset = native_render::scroll_offset(
                    scroll.at("rate").get<double>(), scroll.at("angle").get<double>(), at.at("time").get<double>()
            );
            for (size_t k = 0; k < 2; ++k)
                close_to("scroll " + scroll.at("rate").dump(), offset[k], at.at("offset")[k].get<double>(), 1e-12);
        }
    for (const auto &book : oracle.at("flipbooks"))
        for (const auto &at : book.at("at")) {
            ++compared;
            const auto frame = native_render::animation_frame(
                    book.at("rate").get<double>(),
                    book.at("frames").get<uint32_t>(),
                    book.at("noWrap").get<bool>(),
                    at.at("time").get<double>()
            );
            if (frame != at.at("frame").get<uint32_t>()) fail("flipbook " + book.dump(), std::to_string(frame));
        }
}

// Source picks among an activity's sequences at random; map-props.ts fixes the pick per entity by weight.
void check_activity_picks(const nlohmann::json &oracle) {
    auto props = props_from(oracle);
    auto &model = props->model(0);
    // ACT_IDLE: idle (weight 1) and fly (weight 3). Entity 0 lands at 2.47 of 4, entity 1 at 0.94.
    assert(model.lookup("ACT_IDLE", 0) == 2);
    assert(model.lookup("act_idle", 1) == 0);
    assert(model.lookup("Fly", 0) == 2);
    assert(model.lookup("missing", 0) == -1);
    assert(model.lookup("", 0) == -1);
}

void check_shared_and_still_poses(const nlohmann::json &oracle) {
    auto props = props_from(oracle);
    props->add_instance(10, 0);
    props->add_instance(11, 0);
    props->reserve_rows(512);
    const float viewer_pos[3] = {0, 0, 0};
    props->set_viewer(viewer_pos);
    auto instances = props->instances();
    // Two props of one model on the same sequence and cycle: one bone setup, the same matrices.
    assert(props->pose(instances[0], 1.5, viewer_pos));
    assert(props->pose(instances[1], 1.5, viewer_pos));
    assert(props->take_pose_count() == 1);
    const size_t bones = props->model(0).rig.bones;
    const auto rows = props->rows();
    for (size_t i = 0; i < bones * native_studio::matrix_floats; ++i)
        assert(rows[i] == rows[bones * native_studio::matrix_floats + i]);
    // Once per frame.
    assert(!props->pose(instances[0], 1.5, viewer_pos));
    const auto dirty = props->take_dirty();
    assert(dirty.first == 0 && dirty.second == 2 * bones);
    // A one-frame sequence is posed once, then kept.
    instances[0].state.anim = props->model(0).lookup("still", 10);
    assert(props->pose(instances[0], 2, viewer_pos));
    assert(!props->pose(instances[0], 2.5, viewer_pos));
    assert(props->take_dirty().second == bones);
}

void check_distance_steps(const nlohmann::json &oracle) {
    auto props = props_from(oracle);
    props->add_instance(10, 0);
    props->add_instance(11, 0);
    props->reserve_rows(512);
    auto instances = props->instances();
    instances[1].state.anim = instances[0].state.anim = props->model(0).lookup("idle", 10);
    const float viewer[3] = {0, 0, 0};
    const float far_away[3] = {5000, 0, 0};
    props->set_viewer(viewer);
    // Past 4096 units a prop steps at 6 Hz: at 1.3 s it shows the pose of 7/6 s.
    props->pose(instances[0], 1.3, far_away);
    props->pose(instances[1], 7. / 6, viewer);
    const size_t floats = props->model(0).rig.bones * native_studio::matrix_floats;
    const auto rows = props->rows();
    for (size_t i = 0; i < floats; ++i)
        assert(std::abs(rows[i] - rows[floats + i]) < 1e-5f);
    // Inside 1536 units it doesn't step: at 2.3 s it shows 2.3 s, not 13/6 s.
    props->pose(instances[0], 2.3, viewer);
    props->pose(instances[1], 13. / 6, viewer);
    bool differs = false;
    for (size_t i = 0; i < floats; ++i)
        differs |= std::abs(rows[i] - rows[floats + i]) > 1e-3f;
    assert(differs);
}

// A sequence table standing in for a model (tools/map-props/generate-vectors.ts).
struct VectorTable {
    std::vector<double> rates;
    std::vector<bool> loops;
    std::vector<std::pair<int, double>> idle;

    double cycles_per_second(int sequence) const { return rates[size_t(sequence)]; }

    bool looping(int sequence) const { return loops[size_t(sequence)]; }

    const std::vector<std::pair<int, double>> &idle_sequences() const { return idle; }
};

VectorTable table_from(const nlohmann::json &t) {
    VectorTable table;
    table.rates = t.at("cps").get<std::vector<double>>();
    table.loops = t.at("looping").get<std::vector<bool>>();
    for (const auto &c : t.at("idle"))
        table.idle.push_back({c.at("seq").get<int>(), c.at("weight").get<double>()});
    return table;
}

// RandomAnimation props: the website's seeded generator and its think-by-think switches, exactly.
void check_random_animators(const nlohmann::json &vectors) {
    for (const auto &r : vectors.at("randoms")) {
        native_map_props::SeededRandom random(r.at("seed").get<uint32_t>());
        for (const auto &value : r.at("values")) {
            ++compared;
            const double next = random.next();
            if (next != value.get<double>()) fail("random " + r.at("seed").dump(), std::to_string(next));
        }
    }
    std::vector<VectorTable> tables;
    for (const auto &t : vectors.at("tables"))
        tables.push_back(table_from(t));
    for (const auto &a : vectors.at("animators")) {
        auto &table = tables[a.at("table").get<size_t>()];
        native_map_props::RandomAnimator animator(
                a.at("seed").get<uint32_t>(), a.at("min").get<double>(), a.at("max").get<double>()
        );
        for (const auto &at : a.at("at")) {
            const auto shown = animator.at(at.at("time").get<double>(), table);
            const auto where = "animator " + a.at("seed").dump() + " at " + at.at("time").dump();
            ++compared;
            if (shown.sequence != at.at("sequence").get<int>())
                fail(where, "sequence " + std::to_string(shown.sequence));
            close_to(where, shown.cycle, at.at("cycle").get<double>(), 0);
        }
    }
}

void check_runtime_copies() {
    native::RuntimePropCopies copies;
    const BhPropGroup groups[] = {{4, 10, 30, 0, 2}, {5, 40, 60, 0, 3}};
    copies.load(groups);
    const BhEntityInstance fruit = {100, 2, {12, 13, 14}, {0, 90, 0}, 1};
    copies.observe({&fruit, 1});
    assert(copies.find(100)->source == 2);
    assert(copies.groups(2)[0].first_index == 10);
    assert(copies.find(100)->origin[1] == 13);
    const BhEntityInstance crate = {100, 3, {20, 21, 22}, {}, 0};
    copies.observe({&crate, 1});
    assert(copies.find(100)->source == 3 && copies.find(100)->visible == 0);
    assert(copies.groups(3)[0].material == 5);
    copies.observe({});
    assert(copies.instances().empty() && !copies.find(100));
    copies.observe({&fruit, 1});
    assert(copies.find(100)->source == 2 && copies.find(100)->visible == 1);
}

void check_visual_time() {
    // Play: the newest tick and the frame's blend. A replay: the tick shown between the two.
    assert(std::abs(native::world_visual_seconds(9, 10, .25f, .01, false) - .1025) < 1e-12);
    assert(std::abs(native::world_visual_seconds(9, 10, .25f, .01, true) - .0925) < 1e-12);
    assert(native::world_visual_seconds(500, 500, 1, .01, true) == 5);
}

}  // namespace

int main(int argc, char **argv) {
    const std::string path = argc > 1 ? argv[1] : "map-props-oracle.json";
    const std::string vectors_path = argc > 2 ? argv[2] : "map_props_vectors.json";
    std::ifstream vectors_file(vectors_path);
    if (!vectors_file) {
        std::cerr << "Cannot open the map props vectors at " << vectors_path << '\n';
        return 2;
    }
    check_random_animators(*std::make_unique<nlohmann::json>(nlohmann::json::parse(vectors_file)));
    std::ifstream file(path);
    if (!file) {
        std::cerr << "Cannot open the map props oracle at " << path
                  << "\nGenerate it with: bun apps/native/src/map-props-oracle.ts " << path << '\n';
        return 2;
    }
    const auto oracle = std::make_unique<nlohmann::json>(nlohmann::json::parse(file));
    check_rates_and_poses(*oracle);
    check_sequences(*oracle);
    check_texture_motion(*oracle);
    // An oracle that produced nothing would otherwise pass silently.
    constexpr long least_answers = 2000;
    if (compared < least_answers) {
        std::cerr << "Only " << compared << " answers were compared; the oracle looks wrong\n";
        return 1;
    }
    if (failures) {
        std::cerr << failures << " mismatches across " << compared << " answers\n";
        return 1;
    }
    check_activity_picks(*oracle);
    check_shared_and_still_poses(*oracle);
    check_distance_steps(*oracle);
    check_visual_time();
    check_runtime_copies();
    std::cout << "Map props and moving textures match the web reference across " << compared << " answers\n";
    return 0;
}
