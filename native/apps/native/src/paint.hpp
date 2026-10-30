#pragma once
#include "bunnyhop_native.h"
#include "render_math.hpp"
#include "graphics_settings.hpp"
#include "native_input.hpp"
#include <array>
#include <optional>
#include <span>

namespace native_render {
struct SurfaceOwner {
    uint32_t model = 0;
    int32_t entity = -1;

    bool matrix(BhContext *core, native::Matrix &result) const {
        BhTransform transform{};
        transform.visible = 1;
        if (entity >= 0) {
            if (!bh_prop_transform(core, uint32_t(entity), &transform)) {
                return false;
            }
        } else if (model && !bh_model_transform(core, model, &transform)) {
            return false;
        }
        result = native::model_matrix(transform);
        return transform.visible;
    }

    bool operator==(const SurfaceOwner &) const = default;
};

inline Vec3 surface_local(const native::Matrix &matrix, const Vec3 &point) {
    Vec3 result{};
    for (int axis = 0; axis < 3; ++axis) {
        for (int row = 0; row < 3; ++row) {
            result[axis] += matrix[axis * 4 + row] * (point[row] - matrix[12 + row]);
        }
    }
    return result;
}

struct SurfaceHit {
    Vec3 point{}, normal{};
    SurfaceOwner owner;
};

inline std::optional<float>
ray_triangle(const Vec3 &origin, const Vec3 &direction, const std::array<Vec3, 3> &triangle) {
    Vec3 edge_a{}, edge_b{}, start{};
    for (int axis = 0; axis < 3; ++axis) {
        edge_a[axis] = triangle[1][axis] - triangle[0][axis];
        edge_b[axis] = triangle[2][axis] - triangle[0][axis];
        start[axis] = origin[axis] - triangle[0][axis];
    }
    const auto perpendicular = cross(direction, edge_b);
    const float determinant = dot(edge_a, perpendicular);
    if (determinant <= 1e-6f) {
        return std::nullopt;
    }
    const float u = dot(start, perpendicular) / determinant;
    const auto other = cross(start, edge_a);
    const float v = dot(direction, other) / determinant;
    const float distance = dot(edge_b, other) / determinant;
    if (u < 0 || v < 0 || u + v > 1 || distance < 0 || distance > 2048) {
        return std::nullopt;
    }
    return distance;
}

// World and moving prop triangles share the renderer's transforms and material visibility.
template <class Visitor>
void visit_surfaces(BhContext *core, Visitor &&visit) {
    size_t material_count = 0;
    const auto *materials = bh_materials(core, &material_count);
    for (bool props : {false, true}) {
        size_t vertex_count = 0, index_count = 0, group_count = 0;
        const float *vertices = props ? bh_prop_vertices(core, &vertex_count) : bh_vertices(core, &vertex_count);
        const uint32_t *indices = props ? bh_prop_indices(core, &index_count) : bh_indices(core, &index_count);
        const auto *groups = bh_groups(core, &group_count);
        size_t prop_count = 0;
        const auto *prop_groups = bh_prop_groups(core, &prop_count);
        const size_t count = props ? prop_count : group_count;
        for (size_t group = 0; group < count; ++group) {
            const auto material = props ? prop_groups[group].material : groups[group].material;
            if (!materials || material >= material_count || materials[material].alpha < .5f
                || materials[material].kind == 2 || (props ? prop_groups[group].sky3d : groups[group].sky3d)) {
                continue;
            }
            const uint32_t first = props ? prop_groups[group].first_index : groups[group].first_index;
            const uint32_t length = props ? prop_groups[group].index_count : groups[group].index_count;
            const SurfaceOwner owner{props ? 0 : groups[group].model, props ? prop_groups[group].entity : -1};
            native::Matrix matrix{};
            if (!owner.matrix(core, matrix) || !vertices || !indices || uint64_t(first) + length > index_count) {
                continue;
            }
            const size_t stride = props ? 8 : 10;
            for (size_t index = first; index + 2 < size_t(first) + length; index += 3) {
                std::array<Vec3, 3> triangle{};
                bool valid = true;
                for (size_t corner = 0; corner < 3; ++corner) {
                    const size_t offset = size_t(indices[index + corner]) * stride;
                    if (offset + 2 >= vertex_count) {
                        valid = false;
                        break;
                    }
                    triangle[corner] =
                            transform_point(matrix, {vertices[offset], vertices[offset + 1], vertices[offset + 2]});
                }
                if (valid) {
                    visit(triangle, owner, matrix);
                }
            }
        }
    }
}

inline std::optional<SurfaceHit> pick_surface(BhContext *core, const Vec3 &eye, double yaw, double pitch) {
    const float yaw_radians = float(yaw * native::radians), pitch_radians = float(pitch * native::radians);
    const Vec3 direction{
            std::cos(pitch_radians) * std::cos(yaw_radians),
            std::cos(pitch_radians) * std::sin(yaw_radians),
            -std::sin(pitch_radians)
    };
    float nearest = 2048;
    std::optional<SurfaceHit> hit;
    visit_surfaces(core, [&](const auto &triangle, const auto &owner, const auto &) {
        const auto distance = ray_triangle(eye, direction, triangle);
        if (!distance || *distance >= nearest) {
            return;
        }
        nearest = *distance;
        SurfaceHit next;
        next.owner = owner;
        Vec3 a{}, b{};
        for (int axis = 0; axis < 3; ++axis) {
            next.point[axis] = eye[axis] + direction[axis] * nearest;
            a[axis] = triangle[1][axis] - triangle[0][axis];
            b[axis] = triangle[2][axis] - triangle[0][axis];
        }
        next.normal = cross(a, b);
        const float length = std::sqrt(dot(next.normal, next.normal));
        for (float &channel : next.normal) {
            channel /= length;
        }
        hit = next;
    });
    return hit;
}

struct SurfaceToolBindings {
    static constexpr std::array<std::string_view, 5> actions = {
            "paint", "paintOnce", "clearPaint", "measurePoint", "clearMeasure"
    };
    std::array<std::array<std::string, 4>, 5> codes;

    void read(const nlohmann::json &settings) {
        for (auto &action : codes)
            action.fill({});
        if (!settings.contains("binds") || !settings.at("binds").is_object()) return;
        const auto &binds = settings.at("binds");
        for (size_t action = 0; action < actions.size(); ++action) {
            const auto found = binds.find(std::string(actions[action]));
            if (found == binds.end() || !found->is_array()) continue;
            for (size_t key = 0; key < std::min(size_t(4), found->size()); ++key) {
                if ((*found)[key].is_string()) codes[action][key] = (*found)[key].get<std::string>();
            }
        }
    }

    int match(std::string_view code) const {
        if (code.empty()) return -1;
        for (size_t action = 0; action < codes.size(); ++action) {
            for (const auto &bound : codes[action])
                if (bound == code) return int(action);
        }
        return -1;
    }
};

template <class Renderer, class Toast>
void surface_tool_key(
        Renderer &renderer,
        std::string_view code,
        bool down,
        bool repeat,
        const BhState &state,
        const native::Input &input,
        bool can_paint,
        Toast &toast
) {
    if (const auto *message = renderer.tool_key(code, down, repeat, state, input, can_paint)) toast(message);
}

class Paint {
public:
    static constexpr size_t capacity = 256, maximum_faces = 64;

    struct Mark {
        SurfaceOwner owner;

        struct Face {
            std::array<Vec3, 4> points{};
            std::array<std::array<float, 2>, 4> uv{};
        };

        std::array<Face, maximum_faces> faces{};
        size_t count = 0;
        std::array<float, 4> color{};
    };

private:
    std::array<Mark, capacity> marks_{};
    size_t count_ = 0, next_ = 0;
    float diameter_ = 32;
    std::array<float, 4> color_{1, .251f, .251f, 1};
    double last_seconds_ = -1;
    std::optional<SurfaceHit> last_hit_;

    static size_t clip(std::span<const Vec3> input, std::span<Vec3> output, const Vec3 &normal, float limit) {
        size_t count = 0;
        if (input.empty()) {
            return count;
        }
        Vec3 previous = input.back();
        float previous_distance = dot(previous, normal) - limit;
        for (const auto &point : input) {
            const float distance = dot(point, normal) - limit;
            if ((distance <= 0) != (previous_distance <= 0)) {
                const float fraction = previous_distance / (previous_distance - distance);
                Vec3 intersection{};
                for (int coordinate = 0; coordinate < 3; ++coordinate) {
                    intersection[coordinate] =
                            previous[coordinate] + (point[coordinate] - previous[coordinate]) * fraction;
                }
                output[count++] = intersection;
            }
            if (distance <= 0) {
                output[count++] = point;
            }
            previous = point;
            previous_distance = distance;
        }
        return count;
    }

    void
    project(Mark &mark,
            const SurfaceHit &hit,
            const Vec3 &right,
            const Vec3 &up,
            const std::array<Vec3, 3> &triangle,
            const native::Matrix &matrix) {
        if (mark.count == maximum_faces) {
            return;
        }
        Vec3 edge_a{}, edge_b{};
        for (int axis = 0; axis < 3; ++axis) {
            edge_a[axis] = triangle[1][axis] - triangle[0][axis];
            edge_b[axis] = triangle[2][axis] - triangle[0][axis];
        }
        const auto normal = cross(edge_a, edge_b);
        if (dot(normal, hit.normal) < .5f * std::sqrt(dot(normal, normal))) {
            return;
        }
        std::array<Vec3, 32> a{}, b{};
        for (size_t corner = 0; corner < 3; ++corner) {
            Vec3 delta{};
            for (int axis = 0; axis < 3; ++axis) {
                delta[axis] = triangle[corner][axis] - hit.point[axis];
            }
            a[corner] = {dot(delta, right), dot(delta, up), dot(delta, hit.normal)};
        }
        size_t count = 3;
        // A square projector keeps UVs linear across clipped triangles; the fragment shader rounds the decal.
        constexpr std::array<Vec3, 4> sides = {{{1, 0, 0}, {0, 1, 0}, {-1, 0, 0}, {0, -1, 0}}};
        for (const auto &side : sides) {
            count = clip({a.data(), count}, b, side, diameter_ * .5f);
            a = b;
        }
        count = clip({a.data(), count}, b, {0, 0, 1}, 1);
        count = clip({b.data(), count}, a, {0, 0, -1}, 1);
        for (size_t corner = 1; corner + 1 < count && mark.count < maximum_faces; ++corner) {
            Mark::Face face;
            const size_t indices[4] = {0, corner, corner + 1, corner + 1};
            for (size_t vertex = 0; vertex < 4; ++vertex) {
                const auto &point = a[indices[vertex]];
                Vec3 world{};
                for (int axis = 0; axis < 3; ++axis) {
                    world[axis] = hit.point[axis] + right[axis] * point[0] + up[axis] * point[1]
                                  + hit.normal[axis] * (point[2] + .08f);
                }
                face.points[vertex] = surface_local(matrix, world);
                face.uv[vertex] = {
                        std::clamp(point[0] / diameter_ + .5f, 0.f, 1.f),
                        std::clamp(point[1] / diameter_ + .5f, 0.f, 1.f)
                };
            }
            mark.faces[mark.count++] = face;
        }
    }

public:
    void settings(const nlohmann::json &settings) {
        auto document = native::default_graphics_settings();
        if (settings.contains("paint")) {
            native::patch_graphics_setting(document, "paint", settings.at("paint"));
        }
        const auto &value = document.at("paint");
        diameter_ = value.at("size") == "small" ? 16 : value.at("size") == "large" ? 64 : 32;
        const auto text = value.at("color").get<std::string>();
        const auto hex = uint32_t(std::stoul(text.substr(1), nullptr, 16));
        for (int axis = 0; axis < 3; ++axis) {
            color_[axis] = float((hex >> (16 - axis * 8)) & 255) / 255;
        }
    }

    bool ready(double seconds, bool held) const {
        constexpr double interval_seconds = .1;
        return !held || seconds - last_seconds_ >= interval_seconds;
    }

    bool request(double seconds, bool held) {
        if (!ready(seconds, held)) return false;
        last_seconds_ = seconds;
        return true;
    }

    bool stamp(BhContext *core, const SurfaceHit &hit, bool held = false) {
        if (held && last_hit_ && last_hit_->owner == hit.owner) {
            Vec3 delta{};
            for (int axis = 0; axis < 3; ++axis) {
                delta[axis] = hit.point[axis] - last_hit_->point[axis];
            }
            if (dot(delta, delta) < std::pow(diameter_ * .15f, 2)) {
                return false;
            }
        }
        auto &mark = marks_[next_];
        mark.count = 0;
        mark.owner = hit.owner;
        mark.color = color_;
        Vec3 right = cross(hit.normal, std::abs(hit.normal[2]) > .9f ? Vec3{0, 1, 0} : Vec3{0, 0, 1});
        const float length = std::sqrt(dot(right, right));
        for (float &coordinate : right) {
            coordinate /= length;
        }
        const auto up = cross(hit.normal, right);
        visit_surfaces(core, [&](const auto &triangle, const auto &owner, const auto &matrix) {
            if (owner == hit.owner) {
                project(mark, hit, right, up, triangle, matrix);
            }
        });
        if (!mark.count) {
            return false;
        }
        next_ = (next_ + 1) % capacity;
        count_ = std::min(count_ + 1, capacity);
        last_hit_ = hit;
        return true;
    }

    template <class Presentation>
    void draw(BhContext *core, Presentation &presentation) const {
        for (size_t index = 0; index < count_; ++index) {
            const auto &mark = marks_[index];
            native::Matrix matrix{};
            if (!mark.owner.matrix(core, matrix)) {
                continue;
            }
            for (size_t triangle = 0; triangle < mark.count; ++triangle) {
                auto face = mark.faces[triangle];
                for (auto &point : face.points) {
                    point = transform_point(matrix, point);
                }
                presentation.decal(face.points, mark.color, face.uv);
            }
        }
    }

    size_t count() const { return count_; }

    void clear() {
        count_ = next_ = 0;
        last_seconds_ = -1;
        last_hit_.reset();
    }
};
}  // namespace native_render
