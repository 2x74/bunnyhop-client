#pragma once
// The loaded map's water and ladder volumes, for presentation only (web player/map-volumes.ts): the bunny's swim and
// climb for players whose data doesn't carry them. Ghosts get the water here (their frames carry the ladder bit),
// other players in a room both (the room wire carries neither). Your own bunny and the replay viewer's read the
// simulation's own state instead. Nothing here reaches the simulation.
//
//   water    what the simulation calls water (the core's point_contents): the contents of the world BSP's leaf at a
//            point (CONTENTS_WATER / SLIME), plus func_water_analog brush models at their compiled place. Not the
//            render water (bh_water_json): that also has water brushes the movement never sees.
//   ladders  the BSP's CONTENTS_LADDER brushes, as boxes from their axial sides (compilers add axial bevels to every
//            brush). For other players climbing is what the movement does (LadderGuess).
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <istream>
#include <limits>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace native {

// A ladder brush's box: min x, y, z, then max x, y, z (Source units).
using LadderBox = std::array<double, 6>;

// The lumps of a Source BSP (v19-v21) the volumes read, as raw bytes.
struct BspVolumeLumps {
    static constexpr int entities = 0, planes = 1, nodes = 5, leafs = 10, models = 14, brushes = 18, brush_sides = 19;
    int32_t version = 0;
    std::array<std::string, brush_sides + 1> lumps;

    // Reads the header and those lumps from a BSP file or bytes; nothing for anything that isn't a BSP.
    static std::optional<BspVolumeLumps> read(std::istream &in) {
        constexpr uint32_t vbsp = 0x50534256;
        constexpr int header_bytes = 1036, lump_entry_bytes = 16;
        char header[header_bytes];
        if (!in.read(header, header_bytes)) return std::nullopt;
        if (u32(header, 0) != vbsp) return std::nullopt;
        BspVolumeLumps out;
        out.version = i32(header, 4);
        for (int lump : {entities, planes, nodes, leafs, models, brushes, brush_sides}) {
            const int32_t offset = i32(header, 8 + lump * lump_entry_bytes);
            const int32_t length = i32(header, 8 + lump * lump_entry_bytes + 4);
            if (offset < 0 || length <= 0) continue;
            auto &bytes = out.lumps[size_t(lump)];
            bytes.resize(size_t(length));
            in.clear();
            in.seekg(offset);
            if (!in.read(bytes.data(), length)) bytes.clear();
        }
        return out;
    }

    static uint32_t u32(const char *at, size_t offset) {
        uint32_t value;
        std::memcpy(&value, at + offset, sizeof value);
        return value;
    }

    static int32_t i32(const char *at, size_t offset) {
        int32_t value;
        std::memcpy(&value, at + offset, sizeof value);
        return value;
    }

    static float f32(const char *at, size_t offset) {
        float value;
        std::memcpy(&value, at + offset, sizeof value);
        return value;
    }

    static uint16_t u16(const char *at, size_t offset) {
        uint16_t value;
        std::memcpy(&value, at + offset, sizeof value);
        return value;
    }
};

class MapVolumes {
public:
    static constexpr int32_t contents_slime = 0x10, contents_water = 0x20, contents_ladder = 0x20000000;
    // The hull: 16 units either side, 72 tall standing and 54 ducked. Its centre (36, 18 ducked) under water swims.
    static constexpr double hull_half_width = 16, standing_height = 72, ducked_height = 54;
    static constexpr double standing_centre = 36, ducked_centre = 18, standing_view = 64, ducked_view = 46;

    MapVolumes() = default;

    // A map's volumes from its lumps; unreadable parts are left out (no water, no ladders).
    explicit MapVolumes(const BspVolumeLumps &bsp) {
        read_water(bsp);
        read_ladders(bsp);
    }

    bool has_water() const { return water_; }

    const std::vector<LadderBox> &ladders() const { return ladders_; }

    // Whether a point (Source units) is in the simulation's water.
    bool water_at(double x, double y, double z) const {
        if (!water_) return false;
        if (contents(world_head_, x, y, z) & water_contents) return true;
        for (const auto &analog : analogs_) {
            const double lx = x - analog.origin[0], ly = y - analog.origin[1], lz = z - analog.origin[2];
            if (lx < analog.mins[0] - 1 || ly < analog.mins[1] - 1 || lz < analog.mins[2] - 1 || lx > analog.maxs[0] + 1
                || ly > analog.maxs[1] + 1 || lz > analog.maxs[2] + 1)
                continue;
            if (contents(analog.head, lx, ly, lz) & water_contents) return true;
        }
        return false;
    }

    // Source's water level at a feet origin: 3 eyes under (origin + view_z), 2 the hull's centre (swimming), 1 the
    // feet, else 0 (the movement's own three points).
    int water_level(const float position[3], double view_z, bool crouched) const {
        if (!water_) return 0;
        const double x = position[0], y = position[1], z = position[2];
        if (!water_at(x, y, z + 1)) return 0;
        if (!water_at(x, y, z + (crouched ? ducked_centre : standing_centre))) return 1;
        return water_at(x, y, z + view_z) ? 3 : 2;
    }

    // A recorded frame's water level, at its standing or ducked view height (ghosts).
    int recorded_water_level(const float position[3], bool crouched) const {
        return water_level(position, crouched ? ducked_view : standing_view, crouched);
    }

    // The horizontal gap (units) from the hull at a feet origin to the nearest ladder box overlapping it in height.
    double ladder_gap(const float position[3], bool crouched) const {
        double best = std::numeric_limits<double>::infinity();
        const double z0 = position[2], z1 = position[2] + (crouched ? ducked_height : standing_height);
        for (const auto &box : ladders_) {
            if (z0 > box[5] || z1 < box[2]) continue;
            const double gx =
                    std::max({0., box[0] - (position[0] + hull_half_width), position[0] - hull_half_width - box[3]});
            const double gy =
                    std::max({0., box[1] - (position[1] + hull_half_width), position[1] - hull_half_width - box[4]});
            best = std::min(best, std::hypot(gx, gy));
        }
        return best;
    }

private:
    static constexpr int32_t water_contents = contents_water | contents_slime;
    static constexpr int max_tree_depth = 4096;

    struct Plane {
        float normal[3], distance;
    };

    struct Node {
        int32_t plane, children[2];
    };

    // A func_water_analog brush model: its own tree, where the map places it, and its bounds.
    struct Analog {
        int32_t head = 0;
        std::array<double, 3> origin{}, mins{}, maxs{};
    };

    std::vector<Plane> planes_;
    std::vector<Node> nodes_;
    std::vector<int32_t> leaf_contents_;
    std::vector<Analog> analogs_;
    std::vector<LadderBox> ladders_;
    int32_t world_head_ = 0;
    bool water_ = false;

    // The contents at a point: down the tree from node `head` to its leaf.
    int32_t contents(int32_t head, double x, double y, double z) const {
        int32_t node = head;
        for (int depth = 0; node >= 0 && depth < max_tree_depth; depth++) {
            if (size_t(node) >= nodes_.size()) return 0;
            const auto &n = nodes_[size_t(node)];
            if (n.plane < 0 || size_t(n.plane) >= planes_.size()) return 0;
            const auto &p = planes_[size_t(n.plane)];
            const double side =
                    double(p.normal[0]) * x + double(p.normal[1]) * y + double(p.normal[2]) * z - double(p.distance);
            node = n.children[side >= 0 ? 0 : 1];
        }
        const int64_t leaf = -1 - int64_t(node);
        return leaf >= 0 && size_t(leaf) < leaf_contents_.size() ? leaf_contents_[size_t(leaf)] : 0;
    }

    void read_planes(const std::string &lump) {
        constexpr size_t plane_bytes = 20;
        planes_.resize(lump.size() / plane_bytes);
        for (size_t i = 0; i < planes_.size(); i++) {
            const char *at = lump.data() + i * plane_bytes;
            for (size_t k = 0; k < 3; k++)
                planes_[i].normal[k] = BspVolumeLumps::f32(at, k * 4);
            planes_[i].distance = BspVolumeLumps::f32(at, 12);
        }
    }

    void read_water(const BspVolumeLumps &bsp) {
        constexpr size_t node_bytes = 32, model_bytes = 48;
        const size_t leaf_bytes = bsp.version <= 19 ? 56 : 32;
        const auto &leafs = bsp.lumps[BspVolumeLumps::leafs];
        leaf_contents_.resize(leafs.size() / leaf_bytes);
        for (size_t i = 0; i < leaf_contents_.size(); i++) {
            leaf_contents_[i] = BspVolumeLumps::i32(leafs.data(), i * leaf_bytes);
            if (leaf_contents_[i] & water_contents) water_ = true;
        }
        if (!water_) return;
        read_planes(bsp.lumps[BspVolumeLumps::planes]);
        const auto &nodes = bsp.lumps[BspVolumeLumps::nodes];
        nodes_.resize(nodes.size() / node_bytes);
        for (size_t i = 0; i < nodes_.size(); i++) {
            const char *at = nodes.data() + i * node_bytes;
            nodes_[i] = {BspVolumeLumps::i32(at, 0), {BspVolumeLumps::i32(at, 4), BspVolumeLumps::i32(at, 8)}};
        }
        const auto &models = bsp.lumps[BspVolumeLumps::models];
        const size_t model_count = models.size() / model_bytes;
        if (!model_count) {
            water_ = false;
            return;
        }
        world_head_ = BspVolumeLumps::i32(models.data(), 36);
        read_analogs(bsp.lumps[BspVolumeLumps::entities], models, model_count);
    }

    // The func_water_analog brush models (where the map places them; their movement isn't followed).
    void read_analogs(const std::string &entities, const std::string &models, size_t model_count) {
        constexpr size_t model_bytes = 48;
        for (size_t open = entities.find('{'); open != std::string::npos; open = entities.find('{', open + 1)) {
            const size_t close = entities.find_first_of("{}", open + 1);
            if (close == std::string::npos) break;
            if (entities[close] == '{') continue;
            const std::string_view entity(entities.data() + open + 1, close - open - 1);
            if (value_of(entity, "classname") != "func_water_analog") continue;
            const auto index = model_index(value_of(entity, "model"));
            if (!index || *index == 0 || *index >= model_count) continue;
            const char *at = models.data() + *index * model_bytes;
            Analog analog;
            analog.head = BspVolumeLumps::i32(at, 36);
            for (size_t k = 0; k < 3; k++) {
                analog.mins[k] = BspVolumeLumps::f32(at, k * 4);
                analog.maxs[k] = BspVolumeLumps::f32(at, 12 + k * 4);
            }
            analog.origin = origin_of(value_of(entity, "origin"));
            analogs_.push_back(analog);
        }
    }

    // An entity's first "key" "value" pair with this key (empty: none).
    static std::string_view value_of(std::string_view entity, std::string_view key) {
        size_t at = 0;
        while (true) {
            const auto key_open = entity.find('"', at);
            if (key_open == std::string_view::npos) return {};
            const auto key_close = entity.find('"', key_open + 1);
            const auto value_open = key_close == std::string_view::npos ? key_close : entity.find('"', key_close + 1);
            const auto value_close =
                    value_open == std::string_view::npos ? value_open : entity.find('"', value_open + 1);
            if (value_close == std::string_view::npos) return {};
            if (entity.substr(key_open + 1, key_close - key_open - 1) == key)
                return entity.substr(value_open + 1, value_close - value_open - 1);
            at = value_close + 1;
        }
    }

    // "*12" -> 12.
    static std::optional<size_t> model_index(std::string_view model) {
        if (model.size() < 2 || model[0] != '*') return std::nullopt;
        size_t index = 0;
        for (char c : model.substr(1)) {
            if (c < '0' || c > '9') return std::nullopt;
            index = index * 10 + size_t(c - '0');
        }
        return index;
    }

    // "x y z", three numbers made of digits, '-', '.' and 'e' only (as the website reads it); else the world origin.
    static std::array<double, 3> origin_of(std::string_view text) {
        std::array<double, 3> out{};
        const std::string numbers(text);
        if (numbers.find_first_not_of("-0123456789.e \t") != std::string::npos) return {};
        const char *at = numbers.c_str();
        for (auto &value : out) {
            char *end = nullptr;
            value = std::strtod(at, &end);
            if (end == at) return {};
            at = end;
        }
        return *at == 0 ? out : std::array<double, 3>{};
    }

    void read_ladders(const BspVolumeLumps &bsp) {
        constexpr size_t brush_bytes = 12;
        const auto &brushes = bsp.lumps[BspVolumeLumps::brushes];
        if (planes_.empty()) read_planes(bsp.lumps[BspVolumeLumps::planes]);
        for (size_t b = 0; b < brushes.size() / brush_bytes; b++) {
            const char *at = brushes.data() + b * brush_bytes;
            const int32_t first = BspVolumeLumps::i32(at, 0), count = BspVolumeLumps::i32(at, 4);
            if (!(BspVolumeLumps::i32(at, 8) & contents_ladder) || count <= 0) continue;
            if (const auto box = ladder_box(bsp.lumps[BspVolumeLumps::brush_sides], first, count))
                ladders_.push_back(*box);
        }
    }

    // A brush's box from its axial sides: +axis planes bound the max, -axis ones the min.
    std::optional<LadderBox> ladder_box(const std::string &sides, int32_t first, int32_t count) const {
        constexpr size_t side_bytes = 8;
        constexpr double axial = .999, infinity = std::numeric_limits<double>::infinity();
        LadderBox box = {-infinity, -infinity, -infinity, infinity, infinity, infinity};
        for (int32_t s = 0; s < count; s++) {
            const int64_t offset = (int64_t(first) + s) * int64_t(side_bytes);
            if (offset < 0 || size_t(offset) + side_bytes > sides.size()) break;
            const uint16_t plane = BspVolumeLumps::u16(sides.data(), size_t(offset));
            if (plane >= planes_.size()) continue;
            const auto &p = planes_[plane];
            const double nx = p.normal[0], ny = p.normal[1], nz = p.normal[2], d = p.distance;
            if (nx > axial)
                box[3] = std::min(box[3], d);
            else if (nx < -axial)
                box[0] = std::max(box[0], -d);
            else if (ny > axial)
                box[4] = std::min(box[4], d);
            else if (ny < -axial)
                box[1] = std::max(box[1], -d);
            else if (nz > axial)
                box[5] = std::min(box[5], d);
            else if (nz < -axial)
                box[2] = std::max(box[2], -d);
        }
        for (double v : box)
            if (!std::isfinite(v)) return std::nullopt;
        if (!(box[0] < box[3] && box[1] < box[4] && box[2] < box[5])) return std::nullopt;
        return box;
    }
};

// Climbing, for another player in a room (their wire carries no movement mode), as the movement decides it: off the
// ground and out of deep water, the hull within ladder_near_units of a ladder brush (ladder_hold_units once on it), and
// a vertical acceleration that isn't gravity, measured from their interpolated velocity over at least
// measure_seconds (strafing past a ladder falls at sv_gravity; a push lift has no ladder brush near it). Nothing is
// assumed before the first measurement. One per player; `time` in seconds.
class LadderGuess {
public:
    static constexpr double ladder_near_units = 2, ladder_hold_units = 10;

    void reset() {
        has_measure_ = false;
        falling_ = true;
        on_ = false;
    }

    bool
    update(const float position[3],
           const float velocity[3],
           bool crouched,
           bool grounded,
           double time,
           const MapVolumes &volumes) {
        constexpr double gravity = 800, gravity_tolerance = 40, measure_seconds = .009, stale_seconds = .5;
        if (!has_measure_ || time < measured_at_ || time - measured_at_ > stale_seconds) {
            vertical_speed_ = velocity[2];
            measured_at_ = time;
            falling_ = true;
            has_measure_ = true;
        } else if (time - measured_at_ >= measure_seconds) {
            const double acceleration = (velocity[2] - vertical_speed_) / (time - measured_at_);
            falling_ = std::abs(acceleration + gravity) <= gravity_tolerance;
            vertical_speed_ = velocity[2];
            measured_at_ = time;
        }
        if (grounded || volumes.ladders().empty() || volumes.recorded_water_level(position, crouched) >= 2)
            return on_ = false;
        return on_ = !falling_
                     && volumes.ladder_gap(position, crouched) <= (on_ ? ladder_hold_units : ladder_near_units);
    }

private:
    double vertical_speed_ = 0, measured_at_ = 0;
    bool has_measure_ = false, falling_ = true, on_ = false;
};

}  // namespace native
