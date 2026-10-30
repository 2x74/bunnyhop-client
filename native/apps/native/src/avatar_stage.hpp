#pragma once
// Include after renderer.hpp. The native half of the website's avatar/stage.ts: poses the bunny for an avatar spec
// from rest (the same spec always gives the same pose), frames it and draws it supersampled into its own
// framebuffer. Main (GL) thread only; the 2D work and encoding happen in avatar_service.hpp's worker.
#include "avatar_pose.hpp"

#include <array>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

namespace native::avatar {

// What the GL side hands the encoder: the bunny at `supersample` times the picture size, over nothing.
struct BunnyLayer {
    std::vector<uint8_t> gl_rows;
    int px = 0, supersample = 1;
};

class NativeAvatarStage {
    // stage.ts: the 24-degree camera, the thumbnails' close-ups and how far down each head frame reaches.
    static constexpr double camera_fov_degrees = 24;
    static constexpr double full_elevation_degrees = 8, head_elevation_degrees = 5;
    // The website's v0.0.29 framing (the bigger head): ui/avatar-stage-sync.test.ts checks these against
    // the vendored stage.ts once it has that framing.
    static constexpr double face_reach = 13.5, close_reach = 21, bust_reach = 32;
    static constexpr double ear_room = 20, top_margin = 2, top_cap = 40;
    // Fitting to what the camera sees: the head frames keep the top of the bunny under this NDC height, full body
    // fills this share of the picture.
    static constexpr double fit_top_ndc = .92, fit_full_share = .88, fit_top_step = .25, fit_tolerance = .01;
    static constexpr int fit_iterations = 6;
    static constexpr double face_padding = 1.14, head_padding = 1.1, full_padding = 1.14;
    static constexpr double hand_focus_raise = 8, hand_focus_height = 34;
    static constexpr double glove_focus_raise = 3, glove_focus_height = 17;
    static constexpr double tilt_roll_degrees = 18;
    // Fallbacks when there is no posed body to measure.
    static constexpr double default_top = 78, default_head_height = 60, default_center_height = 34;
    static constexpr size_t vertex_sample_step = 5;
    static constexpr int max_supersample = 2, supersample_budget_px = 4096;
    static constexpr int pose_cache_size = 8;
    static constexpr const char *actor_id = "avatar";

    struct CachedPose {
        std::string key;
        std::vector<float> bones;
        float feet_yaw = 0;
        std::array<float, 3> position{};
    };

    struct Bounds {
        std::array<double, 3> min{1e9, 1e9, 1e9}, max{-1e9, -1e9, -1e9};

        bool empty() const { return min[0] > max[0]; }

        void add(const std::array<double, 3> &p) {
            for (size_t k = 0; k < 3; k++) {
                min[k] = std::min(min[k], p[k]);
                max[k] = std::max(max[k], p[k]);
            }
        }
    };

    using Point = std::array<double, 3>;

    struct Shot {
        Point target{};
        double height = 0, elevation = 0;
    };

    struct Camera {
        std::array<float, 3> eye{};
        float elevation = 0;
    };

    native::Gl &gl;
    native::NativeViewmodel models;
    PoseLibrary library;
    GLuint framebuffer = 0, color = 0, depth = 0;
    int target_px = 0;
    std::array<CachedPose, pose_cache_size> poses;
    size_t next_pose = 0;

    static PoseLibrary load_library(const std::filesystem::path &assets) {
        std::ifstream file(assets / "avatar.json");
        if (!file) throw std::runtime_error("Avatar pose data absent; run the native asset compiler");
        nlohmann::json json;
        file >> json;
        return PoseLibrary::parse(json);
    }

    static std::string pose_key(const Spec &spec) {
        char numbers[96];
        std::snprintf(numbers, sizeof numbers, "%.3f|%.3f|%.3f|%.1f", spec.moment, spec.tilt, spec.ears, spec.turn);
        return spec.knife + "|" + std::to_string(int(spec.hand)) + "|" + spec.gun + "|" + spec.pose + "|" + numbers;
    }

    native_render::Actor dressed(const Spec &spec) const {
        native_render::Actor actor;
        actor.id = actor_id;
        actor.opacity = 1;
        actor.outfit = spec.outfit;
        actor.loadout = spec.loadout;
        actor.frame.weapon = spec.hand == Hand::gun && models.gun_slot(spec.gun) ? models.gun_slot(spec.gun) : 1;
        actor.emptyHand = spec.hand == Hand::none;
        return actor;
    }

    native_actor_anim::Acting acting(const Spec &spec) const {
        native_actor_anim::Acting out;
        if (const auto *entry = library.gesture(spec.pose)) {
            out.chestPitch = entry->chest[0];
            out.chestYaw = entry->chest[1];
            out.chestRoll = entry->chest[2];
            out.headPitch = entry->head[0];
            out.headYaw = entry->head[1];
            out.headRoll = entry->head[2];
            out.gesture = entry->gesture;
        }
        out.headRoll += spec.tilt * tilt_roll_degrees;
        out.earL = out.earR = spec.ears;
        return out;
    }

    static void place(native_render::Actor &actor, const PoseInput &input) {
        std::copy(input.position.begin(), input.position.end(), actor.frame.position);
        std::copy(input.velocity.begin(), input.velocity.end(), actor.frame.velocity);
        actor.frame.yaw = input.yaw;
        actor.frame.pitch = input.pitch;
        actor.frame.flags = (input.crouched ? 1u : 0u) | (input.grounded ? 2u : 0u);
    }

    // stage.ts simulate(): the scripted moment run from rest at a fixed step.
    void simulate(const Spec &spec, CachedPose &out) {
        const PoseScript script(spec, library);
        const auto act = acting(spec);
        const double yaw = base_yaw_degrees + spec.turn;
        auto actor = dressed(spec);
        models.forget_actor(actor_id);
        place(actor, script.at(0, yaw));
        actor.snapped = true;
        float feet_yaw = models.pose_actor(actor, 0, &act);
        actor.snapped = false;
        bool fired = false;
        for (double t = 0; t < script.until();) {
            t += pose_step_seconds;
            const auto input = script.at(t, yaw);
            place(actor, input);
            actor.inspect = actor.attack = 0;
            if (script.signal() && !fired && t >= script.signal()->at) {
                fired = true;
                actor.inspect = script.signal()->inspect;
                actor.attack = script.signal()->attack;
            }
            feet_yaw = models.pose_actor(actor, t, &act);
        }
        out.bones = models.actor_pose();
        out.feet_yaw = std::isfinite(feet_yaw) ? feet_yaw : float(yaw);
        std::copy(actor.frame.position, actor.frame.position + 3, out.position.begin());
    }

    const CachedPose &posed(const Spec &spec) {
        const auto key = pose_key(spec);
        for (auto &cached : poses)
            if (cached.key == key) return cached;
        auto &slot = poses[next_pose++ % poses.size()];
        slot.key = key;
        simulate(spec, slot);
        return slot;
    }

    static std::array<double, 3> skin_point(const std::vector<float> &bones, size_t bone, const double p[3]) {
        std::array<double, 3> out{};
        if ((bone + 1) * 12 > bones.size()) return out;
        const float *s = bones.data() + bone * 12;
        for (int r = 0; r < 3; r++)
            out[size_t(r)] = s[r * 4] * p[0] + s[r * 4 + 1] * p[1] + s[r * 4 + 2] * p[2] + s[r * 4 + 3];
        return out;
    }

    // BunnyModel.bodyPoints: a sample of the posed vertices (body, headwear, a knife in hand) in model space,
    // before the feet's yaw. Each vertex is carried by its first bone.
    std::vector<Point> body_points(const native_render::Actor &actor, const std::vector<float> &bones) {
        std::vector<Point> out;
        const auto &fit = models.actor_hat_fit(actor);
        for (const auto &part : models.actor_parts(actor)) {
            if (part.starts_with("tpgun:") || part.starts_with("tpsilencer:")) continue;
            const bool headwear = part.starts_with("hat-") || part.starts_with("crown:");
            const auto vertices = models.mesh_vertices(part);
            const size_t stride = native::NativeViewmodel::mesh_vertex_floats;
            for (size_t v = 0; v * stride < vertices.size(); v += vertex_sample_step) {
                const float *vertex = vertices.data() + v * stride;
                double p[3] = {vertex[0], vertex[1], vertex[2]};
                if (headwear)
                    for (size_t k = 0; k < 3; k++)
                        p[k] = p[k] * fit.scale[k] + fit.offset[k];
                out.push_back(skin_point(bones, size_t(vertex[9]), p));
            }
        }
        return out;
    }

    // A bone's joint in world space (Source axes).
    Point bone_point(const CachedPose &pose, const std::string &name) {
        const int bone = models.actor_bone(name);
        const auto bind = models.actor_bind();
        if (bone < 0 || size_t(bone + 1) * 12 > bind.size()) return {0, 0, default_head_height};
        const size_t at = size_t(bone) * 12;
        const double origin[3] = {bind[at + 3], bind[at + 7], bind[at + 11]};
        return to_world(pose, skin_point(pose.bones, size_t(bone), origin));
    }

    static Point to_world(const CachedPose &pose, const Point &p) {
        const double a = pose.feet_yaw * native::radians, c = std::cos(a), s = std::sin(a);
        return {pose.position[0] + p[0] * c - p[1] * s,
                pose.position[1] + p[0] * s + p[1] * c,
                pose.position[2] + p[2]};
    }

    // The camera at `target`, framing `height` units, slightly above and looking a touch down (stage.ts place()).
    static Camera place(const Point &target, double height, double elevation) {
        const double distance = height / 2 / std::tan(camera_fov_degrees / 2 * native::radians);
        Camera camera;
        camera.elevation = float(elevation);
        camera.eye = {
                float(target[0]),
                float(target[1] - std::cos(elevation * native::radians) * distance),
                float(target[2] + std::sin(elevation * native::radians) * distance)
        };
        return camera;
    }

    static Point to_ndc(const native::Matrix &m, const Point &p) {
        const double w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
        Point out;
        for (size_t r = 0; r < 3; r++)
            out[r] = (m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]) / w;
        return out;
    }

    // Head frames: raise the top until everything between the frame's bottom and the cap is inside it.
    static void
    fit_head(Shot &shot, const std::vector<Point> &points, double lo, double hi, double cap, double padding) {
        std::vector<Point> near_head;
        for (const auto &p : points)
            if (p[2] > lo && p[2] <= cap) near_head.push_back(p);
        for (int i = 0; i < fit_iterations && !near_head.empty(); i++) {
            const auto matrix = projection(place(shot.target, shot.height, shot.elevation));
            double top = -1e9;
            for (const auto &p : near_head)
                top = std::max(top, to_ndc(matrix, p)[1]);
            if (top <= fit_top_ndc) break;
            hi += (top - fit_top_ndc) * shot.height / 2 / padding + fit_top_step;
            shot.target[2] = (lo + hi) / 2;
            shot.height = (hi - lo) * padding;
        }
    }

    // Full body: every point inside, both ways (arms out, a knife held high), centred.
    static void fit_full(Shot &shot, const std::vector<Point> &points) {
        for (int i = 0; i < fit_iterations && !points.empty(); i++) {
            const auto matrix = projection(place(shot.target, shot.height, shot.elevation));
            double x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
            for (const auto &p : points) {
                const auto ndc = to_ndc(matrix, p);
                x0 = std::min(x0, ndc[0]);
                x1 = std::max(x1, ndc[0]);
                y0 = std::min(y0, ndc[1]);
                y1 = std::max(y1, ndc[1]);
            }
            const double need = std::max((y1 - y0) / 2, (x1 - x0) / 2) / fit_full_share;
            const double mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
            if (std::abs(need - 1) < fit_tolerance && std::abs(mx) < fit_tolerance && std::abs(my) < fit_tolerance)
                break;
            // The picture is square: camera right is world +x, up is about world +z at this elevation.
            shot.target[0] += mx * shot.height / 2;
            shot.target[2] += my * shot.height / 2;
            shot.height *= need;
        }
    }

    struct Body {
        std::vector<Point> points;
        Point center{0, 0, default_center_height};
        double top = default_top, feet = 0;
    };

    Body measure(const native_render::Actor &actor, const CachedPose &pose) {
        Body body;
        Bounds box;
        for (const auto &p : body_points(actor, pose.bones)) {
            box.add(p);
            body.points.push_back(to_world(pose, p));
        }
        if (box.empty()) return body;
        body.center = to_world(pose, {(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, 0});
        body.top = pose.position[2] + box.max[2];
        body.feet = pose.position[2] + box.min[2];
        return body;
    }

    Shot head_shot(Frame frame, const Body &body, const Point &head) {
        const double reach = frame == Frame::face ? face_reach : frame == Frame::close ? close_reach : bust_reach;
        const double padding = frame == Frame::face ? face_padding : head_padding;
        const double lo = head[2] - reach, cap = head[2] + top_cap;
        const double hi = std::max(head[2] + ear_room, std::min(body.top + top_margin, cap));
        const bool bust = frame == Frame::bust;
        Shot shot;
        shot.elevation = head_elevation_degrees;
        shot.target = {
                bust ? (head[0] + body.center[0]) / 2 : head[0],
                bust ? (head[1] + body.center[1]) / 2 : head[1],
                (lo + hi) / 2
        };
        shot.height = (hi - lo) * padding;
        fit_head(shot, body.points, lo, hi, cap, padding);
        return shot;
    }

    // stage.ts frame(): the camera for the spec's framing, or on the right hand for a thumbnail.
    Camera frame(const Request &request, const native_render::Actor &actor, const CachedPose &pose) {
        const auto &spec = request.spec;
        const auto body = measure(actor, pose);
        Shot shot;
        if (request.focus != Focus::none) {
            const bool hand = request.focus == Focus::hand;
            shot.target = bone_point(pose, "ValveBiped.Bip01_R_Hand");
            shot.target[2] += hand ? hand_focus_raise : glove_focus_raise;
            shot.height = hand ? hand_focus_height : glove_focus_height;
            shot.elevation = spec.frame == Frame::full ? full_elevation_degrees : head_elevation_degrees;
        } else if (spec.frame != Frame::full) {
            shot = head_shot(spec.frame, body, bone_point(pose, "ValveBiped.Bip01_Head1"));
        } else {
            shot.elevation = full_elevation_degrees;
            shot.target = {body.center[0], body.center[1], (body.feet + body.top) / 2};
            shot.height = (body.top - body.feet) * full_padding;
            fit_full(shot, body.points);
        }
        return place(shot.target, shot.height * spec.zoom, shot.elevation);
    }

    static native::Matrix projection(const Camera &camera) {
        constexpr double looking_along_y_degrees = 90;
        // camera_matrix has Source's 4:3 field; scale it to the stage's.
        constexpr float source_cot = 4.f / 3.f;
        auto matrix = native::camera_matrix(camera.eye.data(), looking_along_y_degrees, camera.elevation, 1);
        const float scale = float(1 / std::tan(camera_fov_degrees / 2 * native::radians)) / source_cot;
        for (int c = 0; c < 4; c++) {
            matrix[c * 4] *= scale;
            matrix[c * 4 + 1] *= scale;
        }
        return matrix;
    }

    bool bind_target(int px) {
        gl.BindFramebuffer(GL_FRAMEBUFFER, framebuffer);
        if (target_px != px) {
            target_px = px;
            gl.BindTexture(GL_TEXTURE_2D, color);
            gl.TexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, px, px, 0, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
            gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
            gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
            gl.FramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, color, 0);
            gl.BindRenderbuffer(GL_RENDERBUFFER, depth);
            gl.RenderbufferStorage(GL_RENDERBUFFER, GL_DEPTH_COMPONENT24, px, px);
            gl.FramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_RENDERBUFFER, depth);
        }
        return gl.CheckFramebufferStatus(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE;
    }

public:
    NativeAvatarStage(native::Gl &api, const std::filesystem::path &assets)
        : gl(api)
        , models(api, assets)
        , library(load_library(assets)) {
        gl.GenFramebuffers(1, &framebuffer);
        gl.GenTextures(1, &color);
        gl.GenRenderbuffers(1, &depth);
    }

    NativeAvatarStage(const NativeAvatarStage &) = delete;
    NativeAvatarStage &operator=(const NativeAvatarStage &) = delete;

    ~NativeAvatarStage() {
        gl.DeleteRenderbuffers(1, &depth);
        gl.DeleteTextures(1, &color);
        gl.DeleteFramebuffers(1, &framebuffer);
    }

    // The bunny for `request`, transparent around it, at twice the picture size (stage.ts render()).
    // Restores the framebuffer and viewport it found. Empty when the target can't be made.
    BunnyLayer draw(const Request &request) {
        const int supersample = std::clamp(supersample_budget_px / request.size, 1, max_supersample);
        const int px = request.size * supersample;
        const auto &pose = posed(request.spec);
        auto actor = dressed(request.spec);
        std::copy(pose.position.begin(), pose.position.end(), actor.frame.position);
        GLint previous = 0, viewport[4];
        gl.GetIntegerv(GL_FRAMEBUFFER_BINDING, &previous);
        gl.GetIntegerv(GL_VIEWPORT, viewport);
        BunnyLayer layer;
        if (bind_target(px)) {
            const auto camera = frame(request, actor, pose);
            gl.Viewport(0, 0, px, px);
            gl.ColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
            gl.DepthMask(GL_TRUE);
            gl.ClearColor(0, 0, 0, 0);
            gl.Clear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
            models.upload_actor_pose(pose.bones);
            models.draw_posed_actor(actor, projection(camera), camera.eye.data(), 0, pose.feet_yaw);
            layer.px = px;
            layer.supersample = supersample;
            layer.gl_rows.resize(size_t(px) * px * 4);
            gl.PixelStorei(GL_PACK_ALIGNMENT, 1);
            gl.ReadPixels(0, 0, px, px, GL_RGBA, GL_UNSIGNED_BYTE, layer.gl_rows.data());
        }
        gl.BindFramebuffer(GL_FRAMEBUFFER, GLuint(previous));
        gl.Viewport(viewport[0], viewport[1], viewport[2], viewport[3]);
        return layer;
    }
};

// The finished picture: the backdrop with the bunny scaled down over it. Any thread.
inline Picture compose(const Request &request, const BunnyLayer &layer) {
    auto picture = paint_backdrop(request.backdrop, request.size);
    if (layer.px) draw_over(picture, downsample(from_gl_rows(layer.gl_rows, layer.px, layer.px), layer.supersample));
    return picture;
}

}  // namespace native::avatar
