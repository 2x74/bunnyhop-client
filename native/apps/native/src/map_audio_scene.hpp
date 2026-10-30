#pragma once
#include "map_audio_mix.hpp"
#include "bunnyhop_native.h"
#include <atomic>
#include <nlohmann/json.hpp>
#include <optional>
#include <string_view>

namespace native {
inline constexpr size_t map_sound_slot_limit = 4096;
using MapPoint = std::array<float, 3>;
using MapInterval = std::array<double, 2>;

struct MapAmbientLevels {
    double volume = 0, volume_start = 0, fade_in = 0, fade_out = 0;
    double pitch = 100, pitch_start = 100, spin_up = 0, spin_down = 0;
};

MapAmbientLevels map_ambient_levels(const nlohmann::json &entity);
std::string map_sound_path(std::string_view name);

class MapAudioScene {
public:
    using ScapePositions = std::array<std::optional<MapPoint>, 8>;

    struct ScapeBuild {
        int master = 0;
        int start = 0;
        int position_override = -1;
        int ambient_override = -1;
        int depth = 0;
    };

    struct Sound {
        int file = -1;
        int entity = -1;
        int model = -1;
        MapPoint position{}, offset{};
        double level = 0, volume = 0, target_volume = 0, volume_step = 0;
        double rate = 1, target_rate = 1, rate_step = 0, started = 0, priority = 0;
        uint32_t starts = 0, stops = 0;
        bool on = false, removed = false, stopping = false, transient = false, used = false;
        MapAmbientLevels levels;
    };

    struct Random {
        std::vector<int> files;
        MapInterval time{}, volume{}, pitch{}, level{};
        MapPoint position{};
        double master = 1, next = 0;
        int master_group = 0;
        bool spatial = false, around_listener = false;
    };

    struct ScapeLoop {
        int file = -1;
        MapPoint position{};
        MapInterval volume{}, pitch{}, level{};
        int master_group = 0;
        bool spatial = false;
    };

    struct ScapeMaster {
        int parent = -1;
        MapInterval volume{1, 0};
        double gain = 1;
    };

    enum class ScapeActionKind { master, loop, random };

    struct ScapeAction {
        ScapeActionKind kind;
        size_t index;
    };

    struct Scape {
        std::string name;
        MapPoint position{}, minimum{}, maximum{};
        double radius = 128;
        bool trigger = false, inside = false;
        uint64_t entered = 0;
        std::vector<ScapeMaster> masters{{}};
        std::vector<ScapeAction> actions;
        std::vector<ScapeLoop> loops;
        std::vector<Random> randoms;
    };

    // The worker publishes each immutable decoded file with a release store after filling its samples.
    std::array<std::atomic_bool, map_sound_slot_limit> file_ready{};
    std::array<bool, map_sound_slot_limit> file_seen{};
    std::vector<MapAudioFile> files;
    std::vector<Sound> sounds;
    std::vector<Scape> scapes;
    std::array<BhMapSoundState, map_sound_slot_limit> states{};
    std::array<uint8_t, 16384> commands{};
    std::array<size_t, map_sound_slot_limit> ranked{};
    std::vector<int> ambient;
    BhContext *observed_core = nullptr;
    uint32_t serial = ~0u, random_state = 977;
    double last_assign = -1, last_scape = -1;
    int current_scape = -1;
    uint64_t trigger_order = 0;
    bool in_range = false;
    double current_distance = 0;

    MapAudioScene();
    int find_file(std::string_view path) const;
    size_t add_sound(const Sound &sound);
    double random();
    double roll(const MapInterval &interval);
    void build(const nlohmann::json &entities, const nlohmann::json &models, const nlohmann::json &group);
    void
    frame(BhContext *core,
          MapAudioMixer &mixer,
          const MapPoint &listener,
          double yaw,
          double now,
          bool live,
          float gain,
          double pitch = 0);
    void apply_state(MapAudioMixer &mixer, std::span<const BhMapSoundState> rows, double now, bool live);
    void play_command(MapAudioMixer &mixer, std::string_view command, double now, bool live);
    void
    assign(BhContext *core,
           MapAudioMixer &mixer,
           const MapPoint &listener,
           double yaw,
           double now,
           double elapsed,
           float gain,
           double pitch = 0);
    void tick_scapes(BhContext *core, MapAudioMixer &mixer, const MapPoint &listener, double now);
    void start_scape(MapAudioMixer &mixer, int index, double now);

private:
    void start_sound(MapAudioMixer &mixer, size_t index, double now, bool audible);
    void stop_sound(MapAudioMixer &mixer, size_t index);
    void build_ambient(
            const nlohmann::json &entity,
            size_t index,
            const nlohmann::json &entities,
            const nlohmann::json &models,
            const nlohmann::json &group
    );
    void start_scape_loop(
            const Scape &scape, const ScapeLoop &loop, std::array<bool, map_sound_slot_limit> &reused, double now
    );
    void build_scape(
            Scape &scape,
            const nlohmann::json &body,
            const nlohmann::json &group,
            const ScapePositions &positions,
            const ScapeBuild &options
    );
    void build_scape_loops(
            Scape &scape, const nlohmann::json &body, const ScapePositions &positions, const ScapeBuild &options
    );
    void build_scape_randoms(
            Scape &scape, const nlohmann::json &body, const ScapePositions &positions, const ScapeBuild &options
    );
    void play_scape_randoms(const MapPoint &listener, double now);
    bool update_sound(
            BhContext *core,
            MapAudioMixer &mixer,
            size_t index,
            const MapPoint &listener,
            double now,
            double elapsed,
            float gain
    );
    void position_voice(
            MapAudioMixer::Voice &voice,
            const Sound &sound,
            const MapPoint &listener,
            double yaw,
            double pitch,
            float gain
    );
    void drive_voice(
            MapAudioMixer &mixer,
            size_t index,
            const MapPoint &listener,
            double yaw,
            double now,
            float gain,
            double pitch
    );
};

struct MapAudioLoad {
    std::shared_ptr<MapAudioScene> scene;
    std::atomic_bool published = false;
};

std::shared_ptr<MapAudioScene> load_map_audio(
        const std::filesystem::path &bsp,
        const std::filesystem::path &content_root,
        const std::string &entities,
        const std::string &models,
        const std::atomic_bool &cancel,
        MapAudioLoad *publication = nullptr
);
}  // namespace native
