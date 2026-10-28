#include "tutorial_runner.hpp"
#include "startup.hpp"
#include "json_file_writer.hpp"
#include <iostream>
#include <stdexcept>

namespace native {
namespace {

void require(bool ok, BhContext *core, const char *operation) {
    if (!ok) {
        const char *error = bh_last_error(core);
        throw std::runtime_error(std::string(operation) + ": " + (error && *error ? error : "native core failed"));
    }
}

}  // namespace

void TutorialRunner::load_progress(const std::filesystem::path &cache) {
    try {
        if (std::filesystem::exists(cache / "tutorial-progress.json")
            && std::filesystem::file_size(cache / "tutorial-progress.json") <= 4096) {
            const auto saved = nlohmann::json::parse(read_text(cache / "tutorial-progress.json"));
            if (saved.is_array()) completed = saved;
        }
    } catch (const std::exception &error) {
        std::cerr << "Tutorial progress: " << error.what() << '\n';
    }
}

void TutorialRunner::save(const std::filesystem::path &cache, JsonFileWriter &writer) {
    if (!lesson) return;
    completed = lesson->stateJSON().at("completed");
    writer.write(cache / "tutorial-progress.json", completed);
}

std::unique_ptr<Tutorial> TutorialRunner::prepare(
        const std::filesystem::path &path, const std::filesystem::path &assets, const std::string &selected_style
) const {
    const auto metadata = nlohmann::json::parse(read_text(assets / "tutorial.json"));
    if (file_hash(path) != metadata.at("bspSha256").get<std::string>())
        throw std::runtime_error(
                "Tutorial BSP does not match bundled lessons; update the tutorial assets and map together"
        );
    auto next = std::make_unique<Tutorial>(metadata, selected_style == "legit" || selected_style == "scroll");
    next->set_completed(completed);
    return next;
}

bool TutorialRunner::practice(const std::string &current_map) const {
    // Lessons are practice; the final course has its own ranked board.
    return current_map == map_id && !(lesson && lesson->is_active() && lesson->lesson_id() == "final");
}

void TutorialRunner::start(const std::string &id, BhContext *core, GhostSlots &ghosts) {
    ghosts.clear_for_tutorial(core);
    demo = false;
    stopped = false;
    final_saved = false;
    lesson->start(id);
}

void TutorialRunner::set_keys(const BindTable &binds) {
    std::array<std::string, 4> labels{"Space", "W", "A", "D"};
    const char *actions[] = {"jump", "forward", "left", "right"};
    for (int k = 0; k < 4; k++) {
        const auto &bound = binds.codes(actions[k]);
        if (!bound.empty()) {
            labels[k] = bound[0];
            if (labels[k].rfind("Key", 0) == 0) labels[k].erase(0, 3);
        }
    }
    lesson->set_keys(labels);
}

void TutorialRunner::load_demo(
        BhContext *core, const std::filesystem::path &assets, const std::string &active_style, GhostSlots &ghosts
) {
    const auto &metadata = lesson->lesson_data();
    const auto key = (active_style == "legit" || active_style == "scroll") && metadata.contains("nativeDemoLegit")
                             ? "nativeDemoLegit"
                             : "nativeDemo";
    if (!metadata.contains(key)) throw std::runtime_error("Tutorial demonstration is absent");
    const auto file = metadata.at(key).get<std::string>();
    if (file.find_first_of("/\\") != std::string::npos)
        throw std::runtime_error("Invalid bundled tutorial replay path");
    ghosts.handle = bh_ghost_load(core, data_location::utf8(assets / "tutorial" / file).c_str());
    require(ghosts.handle != 0, core, "Loading native tutorial demonstration");
    size_t bytes = 0;
    const auto *raw = bh_ghost_info(core, ghosts.handle, &bytes);
    require(raw != nullptr, core, "Reading tutorial demonstration");
    ghosts.info = nlohmann::json::parse(raw, raw + bytes);
}

void TutorialRunner::begin_demo(const std::string &id, uint32_t tick, GhostSlots &ghosts) {
    ghosts.enabled = true;
    demo = true;
    demo_start = tick;
    ghosts.id = "tutorial-" + id;
}

void TutorialRunner::restart(BhContext *core, const std::string &active_style, BhState &current) {
    lesson->set_legit(active_style == "legit" || active_style == "scroll");
    lesson->start(lesson->lesson_index());
    const auto spawn = lesson->spawn();
    require(bh_set_position(core, spawn.position[0], spawn.position[1], spawn.position[2], spawn.yaw),
            core,
            "Placing tutorial player");
    require(bh_set_velocity(core, 0, 0, 0), core, "Stopping tutorial player");
    require(bh_state(core, &current), core, "Reading tutorial restart");
    if (demo) demo_start = current.tick;
}

Tutorial::TickResult TutorialRunner::tick(
        const BhState &pre,
        const BhState &post,
        const BhCmd &command,
        uint32_t events,
        double dt,
        const BhRunState &run,
        const std::filesystem::path &cache,
        JsonFileWriter &writer
) {
    const auto result = lesson->tick(pre, post, command, events, dt);
    if (result.completed) save(cache, writer);
    if (run.status == 2 && lesson->lesson_id() == "final" && !final_saved) {
        lesson->finish(run.seconds);
        save(cache, writer);
        final_saved = true;
    }
    return result;
}

}  // namespace native
