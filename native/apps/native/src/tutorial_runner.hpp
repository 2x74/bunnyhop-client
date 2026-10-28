#pragma once
#include "tutorial.hpp"
#include "ghost_slots.hpp"
#include "input_binds.hpp"
#include <filesystem>
#include <memory>

namespace native {

class JsonFileWriter;

struct TutorialRunner {
    static constexpr const char *map_id = "bhop_lol_tutorial";
    std::unique_ptr<Tutorial> lesson;
    nlohmann::json completed = nlohmann::json::array();
    bool demo = false, stopped = false, final_saved = false;
    uint32_t demo_start = 0;

    void load_progress(const std::filesystem::path &cache);
    void save(const std::filesystem::path &cache, JsonFileWriter &writer);
    std::unique_ptr<Tutorial>
    prepare(const std::filesystem::path &path,
            const std::filesystem::path &assets,
            const std::string &selected_style) const;
    bool practice(const std::string &current_map) const;
    void start(const std::string &id, BhContext *core, GhostSlots &ghosts);
    void set_keys(const BindTable &binds);
    void load_demo(
            BhContext *core, const std::filesystem::path &assets, const std::string &active_style, GhostSlots &ghosts
    );
    void begin_demo(const std::string &id, uint32_t tick, GhostSlots &ghosts);
    void restart(BhContext *core, const std::string &active_style, BhState &current);
    Tutorial::TickResult
    tick(const BhState &pre,
         const BhState &post,
         const BhCmd &command,
         uint32_t events,
         double dt,
         const BhRunState &run,
         const std::filesystem::path &cache,
         JsonFileWriter &writer);
};

}  // namespace native
