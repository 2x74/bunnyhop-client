#include "map_audio_scene.hpp"
#include <cctype>
#include <numbers>
#include <sstream>

namespace native {
namespace {
using Json = nlohmann::json;
constexpr double scape_check_seconds = .5;
constexpr double scape_position_epsilon = .1;
constexpr double default_scape_level = 70;
constexpr double pitch_percent = 100;
constexpr double random_position_radius = 36;
constexpr size_t scape_entry_limit = 512;
constexpr size_t map_entity_limit = 65536;
constexpr int ambient_everywhere_flag = 1;
constexpr int ambient_start_silent_flag = 16;
constexpr int ambient_not_looping_flag = 32;

std::string lower(std::string value) {
    for (char &ch : value)
        ch = char(std::tolower(static_cast<unsigned char>(ch)));
    return value;
}

std::string trim(std::string value) {
    const auto space = [](unsigned char ch) {
        return std::isspace(ch);
    };
    value.erase(value.begin(), std::find_if_not(value.begin(), value.end(), space));
    value.erase(std::find_if_not(value.rbegin(), value.rend(), space).base(), value.end());
    return value;
}

double number(const Json &entity, const char *key, double fallback = 0) {
    const auto at = entity.find(key);
    if (at == entity.end() || !at->is_string()) return fallback;
    char *end = nullptr;
    const auto &text = at->get_ref<const std::string &>();
    const double value = std::strtod(text.c_str(), &end);
    return end != text.c_str() && std::isfinite(value) ? value : fallback;
}

MapPoint point(const Json &entity, const char *key = "origin") {
    MapPoint result{};
    std::istringstream stream(entity.value(key, std::string()));
    for (auto &value : result) {
        if (!(stream >> value) || !std::isfinite(value)) return {};
    }
    return result;
}

const Json *named_entity(const Json &entities, std::string name) {
    name = lower(name);
    if (name.empty()) return nullptr;
    for (const auto &entity : entities) {
        if (lower(entity.value("targetname", std::string())) == name) return &entity;
    }
    return nullptr;
}

int model_index(const Json &entity) {
    const auto name = entity.value("model", std::string());
    if (name.size() < 2 || name[0] != '*') return -1;
    if (!std::all_of(name.begin() + 1, name.end(), [](char ch) { return ch >= '0' && ch <= '9'; })) return -1;
    return int(number(Json{{"index", name.substr(1)}}, "index", -1));
}

MapPoint model_point(const Json &models, int model, const char *key) {
    if (model < 0 || size_t(model) >= models.size()) return {};
    return models.at(size_t(model)).at(key).get<MapPoint>();
}

MapInterval interval(const Json &entry, const char *key, double fallback) {
    const auto at = entry.find(key);
    if (at == entry.end()) return {fallback, 0};
    auto result = at->get<MapInterval>();
    for (double value : result) {
        if (!std::isfinite(value)) throw std::runtime_error("invalid soundscape interval");
    }
    return result;
}

std::optional<MapPoint> scape_position(const MapAudioScene::ScapePositions &positions, int index) {
    return index >= 0 && size_t(index) < positions.size() ? positions[size_t(index)] : std::nullopt;
}

bool is_sound_file(std::string_view name) {
    return name.ends_with(".wav") || name.ends_with(".mp3");
}

double distance(const MapPoint &first, const MapPoint &second) {
    return std::hypot(
            std::hypot(double(first[0]) - second[0], double(first[1]) - second[1]), double(first[2]) - second[2]
    );
}

bool scape_positions_match(const MapPoint &first, const MapPoint &second) {
    return std::equal(first.begin(), first.end(), second.begin(), [](float first_value, float second_value) {
        return std::abs(first_value - second_value) < scape_position_epsilon;
    });
}

void ramp_up(MapAudioScene::Sound &sound) {
    const auto &levels = sound.levels;
    sound.stopping = false;
    sound.volume = levels.fade_in > 0 ? levels.volume_start : sound.target_volume;
    sound.volume_step = levels.fade_in > 0 ? std::abs(sound.target_volume - levels.volume_start) / levels.fade_in : 0;
    sound.rate = levels.spin_up > 0 ? levels.pitch_start / pitch_percent : sound.target_rate;
    sound.rate_step =
            levels.spin_up > 0 ? std::abs(sound.target_rate - levels.pitch_start / pitch_percent) / levels.spin_up : 0;
}

void advance(double &value, double target, double &step, double elapsed) {
    if (step <= 0) return;
    const double change = step * elapsed;
    value = value < target ? std::min(target, value + change) : std::max(target, value - change);
    if (value == target) step = 0;
}
}  // namespace

std::string map_sound_path(std::string_view name) {
    constexpr std::string_view prefixes = "*#@)(^<>!?&~$+%}";
    while (!name.empty()
           && (std::isspace(static_cast<unsigned char>(name.front()))
               || prefixes.find(name.front()) != std::string_view::npos))
        name.remove_prefix(1);
    while (!name.empty() && std::isspace(static_cast<unsigned char>(name.back())))
        name.remove_suffix(1);
    auto result = lower(std::string(name));
    std::replace(result.begin(), result.end(), '\\', '/');
    result.erase(0, result.find_first_not_of('/'));
    if (!result.starts_with("sound/")) result = "sound/" + result;
    return result;
}

MapAudioScene::MapAudioScene() : sounds(map_sound_slot_limit) {
    for (auto &ready : file_ready)
        ready.store(true, std::memory_order_relaxed);
    file_seen.fill(true);
}

int MapAudioScene::find_file(std::string_view path) const {
    for (size_t i = 0; i < files.size(); ++i) {
        if (files[i].path == path) return int(i);
    }
    return -1;
}

size_t MapAudioScene::add_sound(const Sound &sound) {
    for (size_t i = 0; i < sounds.size(); ++i) {
        if (sounds[i].used) continue;
        sounds[i] = sound;
        sounds[i].used = true;
        return i;
    }
    return SIZE_MAX;
}

double MapAudioScene::random() {
    random_state ^= random_state << 13;
    random_state ^= random_state >> 17;
    random_state ^= random_state << 5;
    return double(random_state) / 4294967296.;
}

double MapAudioScene::roll(const MapInterval &value) {
    return value[0] + value[1] * random();
}

void MapAudioScene::build_ambient(
        const Json &entity, size_t index, const Json &entities, const Json &models, const Json &group
) {
    auto message = lower(trim(entity.value("message", std::string())));
    std::string path;
    std::optional<double> script_level;
    if (is_sound_file(message))
        path = map_sound_path(message);
    else if (group.contains("scripts") && group.at("scripts").contains(message)) {
        const auto &script = group.at("scripts").at(message);
        const auto &waves = script.at("waves");
        if (waves.empty()) return;
        path = waves.at(size_t(random() * waves.size())).get<std::string>();
        if (script.contains("level")) script_level = interval(script, "level", 0)[0];
    }
    const int file = find_file(path);
    if (file < 0 || index >= ambient.size()) return;
    Sound sound;
    sound.file = file;
    sound.entity = int(index);
    sound.position = point(entity);
    sound.levels = map_ambient_levels(entity);
    const int flags = int(number(entity, "spawnflags"));
    sound.level =
            script_level.value_or(map_sound_level(number(entity, "radius"), (flags & ambient_everywhere_flag) != 0));
    sound.target_volume = sound.levels.volume;
    sound.target_rate = sound.levels.pitch / pitch_percent;
    sound.on = !(flags & (ambient_start_silent_flag | ambient_not_looping_flag)) && sound.target_volume > 0;
    ramp_up(sound);
    const auto *source = named_entity(entities, entity.value("sourceentityname", std::string()));
    if (source) {
        sound.position = source->contains("origin") ? point(*source) : sound.position;
        sound.model = model_index(*source);
        if (sound.model >= 0 && size_t(sound.model) < models.size()) {
            const auto minimum = model_point(models, sound.model, "mins");
            const auto maximum = model_point(models, sound.model, "maxs");
            for (size_t axis = 0; axis < 3; ++axis)
                sound.offset[axis] = (minimum[axis] + maximum[axis]) / 2;
        }
    }
    const auto slot = add_sound(sound);
    if (slot != SIZE_MAX) ambient[index] = int(slot);
}

void MapAudioScene::build(const Json &entities, const Json &models, const Json &group) {
    if (!entities.is_array() || entities.size() > map_entity_limit || !models.is_array())
        throw std::runtime_error("map audio entity limit exceeded");
    ambient.assign(entities.size(), -1);
    for (size_t i = 0; i < entities.size(); ++i) {
        const auto &entity = entities[i];
        const auto classname = lower(entity.value("classname", std::string()));
        if (classname == "ambient_generic") build_ambient(entity, i, entities, models, group);
        if (classname != "env_soundscape" && classname != "trigger_soundscape") continue;
        const Json *source = &entity;
        Scape scape;
        if (classname == "trigger_soundscape") {
            source = named_entity(entities, entity.value("soundscape", std::string()));
            const int model = model_index(entity);
            if (!source || model < 0 || size_t(model) >= models.size()) continue;
            scape.trigger = true;
            scape.minimum = model_point(models, model, "mins");
            scape.maximum = model_point(models, model, "maxs");
            const auto origin = point(entity);
            for (size_t axis = 0; axis < 3; ++axis) {
                scape.minimum[axis] += origin[axis];
                scape.maximum[axis] += origin[axis];
            }
        }
        scape.name = lower(trim(source->value("soundscape", std::string())));
        if (!group.contains("scapes") || !group.at("scapes").contains(scape.name)) continue;
        scape.position = point(*source);
        scape.radius = number(*source, "radius", 128);
        std::array<std::optional<MapPoint>, 8> positions{};
        for (size_t position = 0; position < positions.size(); ++position) {
            const auto key = "position" + std::to_string(position);
            const auto *target = named_entity(entities, source->value(key, std::string()));
            if (target && target->contains("origin")) positions[position] = point(*target);
        }
        build_scape(scape, group.at("scapes").at(scape.name), group, positions, {});
        scapes.push_back(std::move(scape));
    }
}

void MapAudioScene::build_scape_loops(
        Scape &scape, const Json &body, const ScapePositions &positions, const ScapeBuild &options
) {
    for (const auto &entry : body.at("loops")) {
        if (scape.loops.size() >= scape_entry_limit) throw std::runtime_error("too many soundscape loops");
        ScapeLoop loop;
        loop.file = find_file(entry.at("wave").get<std::string>());
        if (loop.file < 0) continue;
        int index = entry.contains("position") ? options.start + entry.at("position").get<int>() : -1;
        if (index < 0)
            index = options.ambient_override;
        else if (options.position_override >= 0)
            index = options.position_override;
        const auto position = scape_position(positions, index);
        if (index >= 0 && !position) continue;
        loop.spatial = position.has_value();
        loop.position = position.value_or(MapPoint{});
        loop.volume = interval(entry, "volume", 1);
        loop.pitch = interval(entry, "pitch", pitch_percent);
        loop.level = interval(entry, "level", default_scape_level);
        loop.master_group = options.master;
        scape.actions.push_back({ScapeActionKind::loop, scape.loops.size()});
        scape.loops.push_back(loop);
    }
}

void MapAudioScene::build_scape_randoms(
        Scape &scape, const Json &body, const ScapePositions &positions, const ScapeBuild &options
) {
    for (const auto &entry : body.at("randoms")) {
        if (scape.randoms.size() >= scape_entry_limit) throw std::runtime_error("too many soundscape randoms");
        Random sound;
        for (const auto &wave : entry.at("waves")) {
            const int file = find_file(wave.get<std::string>());
            if (file >= 0) sound.files.push_back(file);
        }
        if (sound.files.empty()) continue;
        int index = -1;
        if (entry.contains("position")) {
            const auto &at = entry.at("position");
            if (at.is_number_integer())
                index = options.start + at.get<int>();
            else
                sound.around_listener = at == "random";
        }
        if (index < 0)
            index = options.ambient_override;
        else if (options.position_override >= 0) {
            index = options.position_override;
            sound.around_listener = false;
        }
        const auto position = scape_position(positions, index);
        if (index >= 0 && !position && !sound.around_listener) continue;
        sound.spatial = position.has_value() || sound.around_listener;
        sound.position = position.value_or(MapPoint{});
        sound.time = interval(entry, "time", 1);
        sound.volume = interval(entry, "volume", 1);
        sound.pitch = interval(entry, "pitch", pitch_percent);
        sound.level = interval(entry, "level", default_scape_level);
        sound.master_group = options.master;
        scape.actions.push_back({ScapeActionKind::random, scape.randoms.size()});
        scape.randoms.push_back(std::move(sound));
    }
}

void MapAudioScene::build_scape(
        Scape &scape, const Json &body, const Json &group, const ScapePositions &positions, const ScapeBuild &options
) {
    build_scape_loops(scape, body, positions, options);
    build_scape_randoms(scape, body, positions, options);
    if (options.depth >= 8) return;
    for (const auto &entry : body.at("subs")) {
        const auto name = entry.at("name").get<std::string>();
        if (!group.at("scapes").contains(name)) continue;
        int next_position = options.position_override;
        int next_ambient = options.ambient_override;
        if (entry.contains("positionOverride") && options.position_override < 0) {
            next_position = options.start + entry.at("positionOverride").get<int>();
            next_ambient = next_position;
        }
        if (entry.contains("ambientOverride") && options.ambient_override < 0)
            next_ambient = options.start + entry.at("ambientOverride").get<int>();
        if (scape.masters.size() >= scape_entry_limit) throw std::runtime_error("too many sub-soundscapes");
        const int next_master = int(scape.masters.size());
        scape.actions.push_back({ScapeActionKind::master, size_t(next_master)});
        scape.masters.push_back({options.master, interval(entry, "volume", 1), 1});
        build_scape(
                scape,
                group.at("scapes").at(name),
                group,
                positions,
                {next_master,
                 options.start + entry.value("position", 0),
                 next_position,
                 next_ambient,
                 options.depth + 1}
        );
    }
}

void MapAudioScene::start_sound(MapAudioMixer &mixer, size_t index, double now, bool audible) {
    auto &sound = sounds[index];
    sound.on = audible;
    sound.started = now;
    mixer.release(index);
    if (sound.entity >= 0) ramp_up(sound);
    last_assign = -1;
}

void MapAudioScene::stop_sound(MapAudioMixer &mixer, size_t index) {
    auto &sound = sounds[index];
    const auto &levels = sound.levels;
    if (sound.on && sound.entity >= 0 && (levels.fade_out > 0 || levels.spin_down > 0)) {
        sound.stopping = true;
        if (levels.fade_out > 0) {
            sound.target_volume = levels.volume_start;
            sound.volume_step = std::abs(sound.volume - levels.volume_start) / levels.fade_out;
        }
        if (levels.spin_down > 0) {
            sound.target_rate = levels.pitch_start / pitch_percent;
            sound.rate_step = std::abs(sound.rate - sound.target_rate) / levels.spin_down;
        }
        return;
    }
    sound.on = false;
    mixer.release(index);
}

void MapAudioScene::apply_state(MapAudioMixer &mixer, std::span<const BhMapSoundState> rows, double now, bool live) {
    constexpr uint32_t active = 1, removed = 2, last_start = 4;
    for (const auto &row : rows) {
        if (row.entity >= ambient.size() || ambient[row.entity] < 0) continue;
        const size_t index = size_t(ambient[row.entity]);
        auto &sound = sounds[index];
        if (row.flags & removed) {
            if (sound.on) stop_sound(mixer, index);
            sound.removed = true;
            continue;
        }
        const double volume = row.volume >= 0 ? row.volume / pitch_percent : sound.levels.volume;
        if (volume != sound.target_volume) sound.volume = sound.target_volume = volume;
        const double rate = (row.pitch > 0 ? row.pitch : sound.levels.pitch) / pitch_percent;
        if (rate != sound.target_rate) {
            sound.rate = sound.target_rate = rate;
            sound.rate_step = 0;
        }
        const bool backward = row.starts < sound.starts || row.stops < sound.stops || sound.removed;
        const bool moved = row.starts != sound.starts || row.stops != sound.stops;
        sound.removed = false;
        sound.starts = row.starts;
        sound.stops = row.stops;
        if (backward) {
            if ((row.flags & active) && !sound.on)
                start_sound(mixer, index, now, sound.levels.volume > 0);
            else if (!(row.flags & active) && sound.on)
                stop_sound(mixer, index);
        } else if (moved) {
            if (row.flags & last_start) {
                if (live || (row.flags & active)) start_sound(mixer, index, now, volume > 0);
            } else
                stop_sound(mixer, index);
        }
    }
}

void MapAudioScene::play_command(MapAudioMixer &mixer, std::string_view command, double now, bool live) {
    if (!live) return;
    const auto whitespace = [](char ch) {
        return std::isspace(static_cast<unsigned char>(ch));
    };
    while (!command.empty() && whitespace(command.front()))
        command.remove_prefix(1);
    const auto separator = command.find_first_of(" \t\r\n");
    if (separator == std::string_view::npos) return;
    command.remove_prefix(separator);
    while (!command.empty() && whitespace(command.front()))
        command.remove_prefix(1);
    command = command.substr(0, command.find_first_of(" \t\r\n"));
    constexpr std::string_view prefixes = "*#@)(^<>!?&~$+%}";
    while (!command.empty() && prefixes.find(command.front()) != std::string_view::npos)
        command.remove_prefix(1);
    std::array<char, 1024> buffer{};
    constexpr std::string_view sound_prefix = "sound/";
    size_t length = sound_prefix.size();
    std::copy(sound_prefix.begin(), sound_prefix.end(), buffer.begin());
    while (!command.empty() && (command.front() == '/' || command.front() == '\\'))
        command.remove_prefix(1);
    if (command.empty() || command.size() + length + 4 > buffer.size()) return;
    for (char ch : command)
        buffer[length++] = ch == '\\' ? '/' : char(std::tolower(static_cast<unsigned char>(ch)));
    if (std::string_view(buffer.data() + sound_prefix.size(), command.size()).starts_with(sound_prefix)) {
        std::move(buffer.begin() + sound_prefix.size(), buffer.begin() + length, buffer.begin());
        length -= sound_prefix.size();
    }
    if (!is_sound_file({buffer.data(), length})) {
        constexpr std::string_view extension = ".wav";
        std::copy(extension.begin(), extension.end(), buffer.begin() + length);
        length += extension.size();
    }
    const int file = find_file({buffer.data(), length});
    if (file < 0 || !file_ready[size_t(file)].load(std::memory_order_acquire)) return;
    Sound sound;
    sound.file = file;
    sound.volume = sound.target_volume = 1;
    sound.transient = true;
    const auto slot = add_sound(sound);
    if (slot != SIZE_MAX) start_sound(mixer, slot, now, true);
}

void MapAudioScene::start_scape(MapAudioMixer &mixer, int index, double now) {
    std::array<bool, map_sound_slot_limit> reused{};
    for (auto &sound : sounds) {
        if (!sound.used || sound.entity >= 0 || sound.transient) continue;
        sound.target_volume = 0;
        sound.volume_step = 1 / map_scape_fade_seconds;
    }
    if (index < 0) return;
    auto &scape = scapes[size_t(index)];
    for (const auto &action : scape.actions) {
        if (action.kind == ScapeActionKind::master) {
            auto &master = scape.masters[action.index];
            master.gain = scape.masters[size_t(master.parent)].gain * roll(master.volume);
        } else if (action.kind == ScapeActionKind::loop) {
            start_scape_loop(scape, scape.loops[action.index], reused, now);
        } else {
            auto &sound = scape.randoms[action.index];
            sound.master = scape.masters[size_t(sound.master_group)].gain;
            sound.next = now + .5 * roll(sound.time);
        }
    }
    (void)mixer;
}

void MapAudioScene::start_scape_loop(
        const Scape &scape, const ScapeLoop &loop, std::array<bool, map_sound_slot_limit> &reused, double now
) {
    const double volume = scape.masters[size_t(loop.master_group)].gain * roll(loop.volume);
    if (volume == 0) return;
    const double rate = roll(loop.pitch) / pitch_percent;
    const double level = loop.spatial ? roll(loop.level) : 0;
    size_t slot = SIZE_MAX;
    for (size_t i = 0; i < sounds.size(); ++i) {
        const auto &sound = sounds[i];
        if (!sound.used || sound.entity >= 0 || sound.transient || reused[i]) continue;
        if (sound.file == loop.file && sound.rate == rate && sound.level == level
            && (!loop.spatial || scape_positions_match(sound.position, loop.position))) {
            slot = i;
            break;
        }
    }
    if (slot == SIZE_MAX) {
        Sound sound;
        sound.file = loop.file;
        sound.position = loop.position;
        sound.rate = sound.target_rate = rate;
        sound.level = std::trunc(level);
        sound.on = true;
        sound.started = now;
        slot = add_sound(sound);
    }
    if (slot == SIZE_MAX) return;
    reused[slot] = true;
    sounds[slot].target_volume = volume;
    sounds[slot].volume_step = 1 / map_scape_fade_seconds;
}

void MapAudioScene::tick_scapes(BhContext *core, MapAudioMixer &mixer, const MapPoint &listener, double now) {
    if (last_scape < 0 || now - last_scape >= scape_check_seconds) {
        last_scape = now;
        int next = -1;
        uint64_t newest = 0;
        for (size_t i = 0; i < scapes.size(); ++i) {
            auto &scape = scapes[i];
            if (!scape.trigger) continue;
            bool inside = true;
            for (size_t axis = 0; axis < 3; ++axis)
                inside = inside && listener[axis] >= scape.minimum[axis] && listener[axis] <= scape.maximum[axis];
            if (inside && !scape.inside) scape.entered = ++trigger_order;
            scape.inside = inside;
            if (inside && scape.entered > newest) {
                next = int(i);
                newest = scape.entered;
            }
        }
        if (next < 0) {
            next = current_scape;
            for (size_t i = 0; i < scapes.size(); ++i) {
                const auto &scape = scapes[i];
                if (scape.trigger) continue;
                const double range = distance(listener, scape.position);
                const bool within = scape.radius > range || scape.radius == -1;
                if (int(i) == next) {
                    current_distance = range;
                    in_range = false;
                } else if (in_range && range >= current_distance)
                    continue;
                if (!within) continue;
                float fraction = 0;
                if (!core || !bh_trace_camera(core, scape.position.data(), listener.data(), 0, &fraction)
                    || fraction < 1)
                    continue;
                next = int(i);
                current_distance = range;
                in_range = true;
            }
        }
        const bool changed =
                next != current_scape
                && (next < 0 || current_scape < 0 || scapes[size_t(next)].name != scapes[size_t(current_scape)].name);
        current_scape = next;
        if (changed) start_scape(mixer, next, now);
    }
    play_scape_randoms(listener, now);
}

void MapAudioScene::play_scape_randoms(const MapPoint &listener, double now) {
    if (current_scape < 0) return;
    for (auto &entry : scapes[size_t(current_scape)].randoms) {
        if (now < entry.next) continue;
        entry.next = now + roll(entry.time);
        Sound sound;
        sound.file = entry.files[size_t(random() * entry.files.size())];
        if (!file_ready[size_t(sound.file)].load(std::memory_order_acquire)) continue;
        sound.volume = sound.target_volume = entry.master * roll(entry.volume);
        sound.rate = sound.target_rate = std::trunc(roll(entry.pitch)) / pitch_percent;
        sound.transient = true;
        sound.on = true;
        sound.started = now;
        if (entry.spatial) {
            sound.level = std::trunc(roll(entry.level));
            sound.position = entry.position;
            if (entry.around_listener) {
                const double angle = random() * 2 * std::numbers::pi;
                sound.position = {
                        listener[0] + float(random_position_radius * std::cos(angle)),
                        listener[1] + float(random_position_radius * std::sin(angle)),
                        listener[2]
                };
            }
        }
        add_sound(sound);
    }
}

bool MapAudioScene::update_sound(
        BhContext *core,
        MapAudioMixer &mixer,
        size_t index,
        const MapPoint &listener,
        double now,
        double elapsed,
        float gain
) {
    auto &sound = sounds[index];
    if (!sound.used) return false;
    advance(sound.volume, sound.target_volume, sound.volume_step, elapsed);
    advance(sound.rate, sound.target_rate, sound.rate_step, elapsed);
    if (sound.entity < 0 && sound.target_volume == 0 && sound.volume_step == 0) sound.on = false;
    if (sound.stopping && sound.volume_step == 0 && sound.rate_step == 0) {
        sound.on = sound.stopping = false;
        sound.target_volume = sound.levels.volume;
        sound.target_rate = sound.levels.pitch / pitch_percent;
    }
    if (!file_ready[size_t(sound.file)].load(std::memory_order_acquire)) {
        mixer.release(index);
        return false;
    }
    const auto &file = files[size_t(sound.file)];
    const double duration = double(file.audio.samples.size()) / file.audio.channels / file.audio.rate;
    if (sound.on && file.loop.start < 0 && (now - sound.started) * sound.rate >= duration) sound.on = false;
    if (!sound.on || gain <= 0) {
        mixer.release(index);
        if (!sound.on && (sound.transient || (sound.entity < 0 && sound.target_volume == 0))) sound.used = false;
        return false;
    }
    if (sound.model >= 0 && core) {
        BhTransform transform{};
        if (bh_model_transform(core, uint32_t(sound.model), &transform)) {
            for (size_t axis = 0; axis < 3; ++axis)
                sound.position[axis] = transform.origin[axis] + sound.offset[axis];
        }
    }
    sound.priority = sound.volume * map_distance_gain(sound.level, distance(sound.position, listener));
    if (sound.priority < map_min_audible) {
        mixer.release(index);
        return false;
    }
    return true;
}

void MapAudioScene::drive_voice(
        MapAudioMixer &mixer, size_t index, const MapPoint &listener, double yaw, double now, float gain, double pitch
) {
    auto &sound = sounds[index];
    const auto &file = files[size_t(sound.file)];
    MapAudioMixer::Voice *voice = nullptr;
    for (auto &candidate : mixer.voices) {
        if (candidate.file && candidate.sound == index) voice = &candidate;
    }
    if (!voice) voice = mixer.acquire(index, file, now - sound.started, sound.rate);
    if (!voice) return;
    position_voice(*voice, sound, listener, yaw, pitch, gain);
}

void MapAudioScene::position_voice(
        MapAudioMixer::Voice &voice, const Sound &sound, const MapPoint &listener, double yaw, double pitch, float gain
) {
    const auto &file = files[size_t(sound.file)];
    const bool spatial = sound.level != 0 && file.audio.channels == 1;
    const auto pan = spatial ? map_pan_gains(sound.position, listener, yaw, pitch) : std::array<float, 2>{1, 1};
    const double level = spatial ? sound.volume * map_distance_gain(sound.level, distance(sound.position, listener))
                                 : sound.priority;
    voice.target_left = pan[0] * float(level) * gain;
    voice.target_right = pan[1] * float(level) * gain;
    voice.target_rate = sound.rate;
}

void MapAudioScene::assign(
        BhContext *core,
        MapAudioMixer &mixer,
        const MapPoint &listener,
        double yaw,
        double now,
        double elapsed,
        float gain,
        double pitch
) {
    for (auto &sound : sounds) {
        if (!sound.used || file_seen[size_t(sound.file)]
            || !file_ready[size_t(sound.file)].load(std::memory_order_acquire))
            continue;
        if (sound.on && files[size_t(sound.file)].loop.start < 0 && !sound.starts) sound.started = now;
    }
    size_t count = 0;
    for (size_t i = sounds.size(); i-- > 0;) {
        if (!update_sound(core, mixer, i, listener, now, elapsed, gain)) continue;
        const auto &sound = sounds[i];
        size_t at = count++;
        while (at > 0 && sounds[ranked[at - 1]].priority < sound.priority) {
            ranked[at] = ranked[at - 1];
            --at;
        }
        ranked[at] = i;
    }
    for (size_t file = 0; file < files.size(); ++file)
        if (file_ready[file].load(std::memory_order_acquire)) file_seen[file] = true;
    const size_t keep = std::min(map_voice_limit, count);
    for (size_t i = keep; i < count; ++i)
        mixer.release(ranked[i]);
    for (size_t i = 0; i < keep; ++i)
        drive_voice(mixer, ranked[i], listener, yaw, now, gain, pitch);
}

void MapAudioScene::frame(
        BhContext *core,
        MapAudioMixer &mixer,
        const MapPoint &listener,
        double yaw,
        double now,
        bool live,
        float gain,
        double pitch
) {
    if (core != observed_core) {
        observed_core = core;
        serial = ~bh_map_sound_serial(core);
    }
    const auto next_serial = bh_map_sound_serial(core);
    if (next_serial != serial) {
        serial = next_serial;
        const size_t count = bh_map_sound_states(core, states.data(), states.size());
        apply_state(mixer, {states.data(), count}, now, live);
        const size_t length = bh_map_sound_commands(core, commands.data(), commands.size());
        std::string_view lines(reinterpret_cast<const char *>(commands.data()), length);
        while (!lines.empty()) {
            const size_t end = lines.find('\n');
            if (end == std::string_view::npos) break;
            play_command(mixer, lines.substr(0, end), now, live);
            lines.remove_prefix(end + 1);
        }
    }
    if (gain <= 0) mixer.clear();
    if (last_assign >= 0 && now - last_assign < map_assign_seconds) {
        for (auto &voice : mixer.voices) {
            if (voice.file && voice.sound != SIZE_MAX)
                position_voice(voice, sounds[voice.sound], listener, yaw, pitch, gain);
        }
        return;
    }
    const double elapsed = last_assign < 0 ? 0 : now - last_assign;
    last_assign = now;
    tick_scapes(core, mixer, listener, now);
    assign(core, mixer, listener, yaw, now, elapsed, gain, pitch);
}
}  // namespace native
