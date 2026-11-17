#pragma once
// +paint survives a restart (the website's paint/store.ts): each map's marks are kept in the data folder with the
// map's BSP hash, at most Paint::capacity per map, for the paint_store_maps most recently painted maps. A different BSP
// drops the old marks, and Clear paint (the button, !clearpaint, the bind) clears the saved copy too. Marks are saved
// as the faces they were drawn with, in their surface's own space, so a door's mark comes back on the door.
#include "json_file_writer.hpp"
#include "paint.hpp"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

namespace native {

inline constexpr size_t paint_store_maps = 40;
inline constexpr double paint_save_interval_seconds = 1;

namespace paint_store_detail {
using Mark = native_render::Paint::Mark;
// Saved points to 0.01 units and texture coordinates to 0.0001, as the website rounds its points.
inline constexpr double point_steps = 100, uv_steps = 10000;
inline constexpr size_t values_per_corner = 5;

inline double rounded(double value, double steps) {
    return std::round(value * steps) / steps;
}

inline nlohmann::json mark_json(const Mark &mark) {
    nlohmann::json faces = nlohmann::json::array();
    for (size_t index = 0; index < mark.count; ++index) {
        const auto &face = mark.faces[index];
        nlohmann::json corners = nlohmann::json::array();
        for (size_t corner = 0; corner < face.points.size(); ++corner) {
            for (const float coordinate : face.points[corner])
                corners.push_back(rounded(coordinate, point_steps));
            for (const float coordinate : face.uv[corner])
                corners.push_back(rounded(coordinate, uv_steps));
        }
        faces.push_back(std::move(corners));
    }
    return {{"m", {mark.owner.model, mark.owner.entity}}, {"c", mark.color}, {"f", std::move(faces)}};
}

inline bool finite_number(const nlohmann::json &value) {
    return value.is_number() && std::isfinite(value.get<double>());
}

// A saved mark, checked: anything malformed is dropped rather than drawn.
inline std::optional<Mark> mark_of(const nlohmann::json &value) {
    if (!value.is_object() || !value.contains("m") || !value.contains("c") || !value.contains("f")) return std::nullopt;
    const auto &owner = value.at("m");
    const auto &color = value.at("c");
    const auto &faces = value.at("f");
    if (!owner.is_array() || owner.size() != 2 || !owner[0].is_number_unsigned() || !owner[1].is_number_integer())
        return std::nullopt;
    if (!color.is_array() || color.size() != 4 || !faces.is_array() || faces.empty()
        || faces.size() > native_render::Paint::maximum_faces)
        return std::nullopt;
    Mark mark;
    mark.owner = {owner[0].get<uint32_t>(), owner[1].get<int32_t>()};
    for (size_t channel = 0; channel < 4; ++channel) {
        if (!finite_number(color[channel])) return std::nullopt;
        mark.color[channel] = std::clamp(color[channel].get<float>(), 0.f, 1.f);
    }
    for (const auto &face : faces) {
        const size_t corners = mark.faces[0].points.size();
        if (!face.is_array() || face.size() != corners * values_per_corner) return std::nullopt;
        auto &out = mark.faces[mark.count++];
        for (size_t corner = 0; corner < corners; ++corner) {
            const size_t at = corner * values_per_corner;
            for (size_t value_index = 0; value_index < values_per_corner; ++value_index)
                if (!finite_number(face[at + value_index])) return std::nullopt;
            out.points[corner] = {face[at].get<float>(), face[at + 1].get<float>(), face[at + 2].get<float>()};
            out.uv[corner] = {face[at + 3].get<float>(), face[at + 4].get<float>()};
        }
    }
    return mark;
}
}  // namespace paint_store_detail

// One map's saved marks: {"sha": BSP hash, "marks": [...]}, oldest first.
inline nlohmann::json paint_document(const std::string &sha, const native_render::Paint &paint) {
    nlohmann::json marks = nlohmann::json::array();
    paint.each_mark([&](const auto &mark) { marks.push_back(paint_store_detail::mark_json(mark)); });
    return {{"sha", sha}, {"marks", std::move(marks)}};
}

// Puts a map's saved marks back. Returns how many; none when the BSP changed or the document isn't one.
inline size_t restore_paint(const nlohmann::json &document, const std::string &sha, native_render::Paint &paint) {
    if (sha.empty() || !document.is_object() || document.value("sha", std::string()) != sha) return 0;
    const auto marks = document.find("marks");
    if (marks == document.end() || !marks->is_array()) return 0;
    size_t restored = 0;
    const size_t skip =
            marks->size() > native_render::Paint::capacity ? marks->size() - native_render::Paint::capacity : 0;
    for (size_t index = skip; index < marks->size(); ++index) {
        if (const auto mark = paint_store_detail::mark_of((*marks)[index])) {
            paint.restore(*mark);
            ++restored;
        }
    }
    return restored;
}

// The most recently painted maps, newest first. Touching `map` moves it to the front; the maps pushed past
// paint_store_maps are returned so their copies can go.
inline std::vector<std::string> touch_paint_index(std::vector<std::string> &index, const std::string &map) {
    index.erase(std::remove(index.begin(), index.end(), map), index.end());
    index.insert(index.begin(), map);
    std::vector<std::string> dropped;
    while (index.size() > paint_store_maps) {
        dropped.push_back(index.back());
        index.pop_back();
    }
    return dropped;
}

// Reads and writes the saved copies under <data>/paint. Reads happen once per map load; writes go through the
// JsonFileWriter worker, at most once a second while painting.
class PaintStore {
public:
    explicit PaintStore(std::filesystem::path directory) : directory_(std::move(directory)) {}

    // A map just loaded: its saved marks, if they belong to this BSP.
    void load(const std::string &map, const std::string &sha, native_render::Paint &paint) {
        map_ = map;
        sha_ = sha;
        if (sha.empty()) return;
        std::error_code error;
        std::filesystem::create_directories(directory_, error);
        read_index();
        const auto document = read(path(map));
        restore_paint(document, sha, paint);
        saved_revision_ = paint.revision();
    }

    // Each frame: writes the map's copy once marks changed and a second has passed since the last write.
    void frame(const native_render::Paint &paint, double seconds, JsonFileWriter &writer) {
        if (map_.empty() || sha_.empty() || paint.revision() == saved_revision_) return;
        if (seconds - saved_at_ < paint_save_interval_seconds) return;
        save(paint, seconds, writer);
    }

    // Leaving the map or quitting: the last marks are written now.
    void flush(const native_render::Paint &paint, JsonFileWriter &writer) {
        if (!map_.empty() && !sha_.empty() && paint.revision() != saved_revision_) save(paint, saved_at_, writer);
    }

private:
    std::filesystem::path path(const std::string &map) const { return directory_ / (map + ".json"); }

    static nlohmann::json read(const std::filesystem::path &file) {
        std::ifstream stream(file, std::ios::binary);
        if (!stream) return nullptr;
        return nlohmann::json::parse(stream, nullptr, false);
    }

    void read_index() {
        if (index_loaded_) return;
        index_loaded_ = true;
        const auto document = read(directory_ / "index.json");
        if (!document.is_array()) return;
        for (const auto &map : document)
            if (map.is_string() && index_.size() < paint_store_maps) index_.push_back(map.get<std::string>());
    }

    void save(const native_render::Paint &paint, double seconds, JsonFileWriter &writer) {
        saved_revision_ = paint.revision();
        saved_at_ = seconds;
        writer.write(path(map_), paint_document(sha_, paint));
        if (!paint.count()) return;
        const auto dropped = touch_paint_index(index_, map_);
        for (const auto &map : dropped)
            writer.write(path(map), nlohmann::json::object());
        writer.write(directory_ / "index.json", index_);
    }

    std::filesystem::path directory_;
    std::string map_, sha_;
    std::vector<std::string> index_;
    bool index_loaded_ = false;
    uint64_t saved_revision_ = 0;
    double saved_at_ = -paint_save_interval_seconds;
};

}  // namespace native
