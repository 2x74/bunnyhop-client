#pragma once
// Avatar pictures, the part with no GL: the request the menu sends (ui/avatar-host.ts) read into typed values,
// and each pose's scripted moment (the website's avatar/stage.ts script()). The numbers below mirror private
// constants in stage.ts; ui/avatar-stage-sync.test.ts fails when the vendored stage.ts changes them.
#include "avatar_picture.hpp"
#include "actor_gestures.hpp"
#include "nlohmann/json.hpp"

#include <cmath>
#include <filesystem>
#include <optional>
#include <string>
#include <unordered_map>

namespace native::avatar {

// stage.ts DT, JUMP, GRAV, HOP, BASE_YAW, SETTLE.
constexpr double pose_step_seconds = 1. / 120;
constexpr double jump_speed = 301.993;
constexpr double gravity = 800;
constexpr double hop_seconds = 2 * jump_speed / gravity;
constexpr double base_yaw_degrees = -62;
constexpr double settle_seconds = 1.2;
constexpr double default_inspect_seconds = 2.4;
constexpr double default_gesture_pitch = 6;

constexpr int min_picture_px = 64;
constexpr int max_picture_px = 2048;
constexpr size_t max_id_bytes = 80;
constexpr size_t max_loadout_bytes = 512;

enum class Hand { knife, gun, none };
enum class Frame { face, close, bust, full };
enum class Focus { none, hand, glove };
// preview: a PNG for the menu to show; webp: the picture to save to the account; file: a PNG written to disk.
enum class Output { preview, webp, file };

struct Spec {
    std::string outfit = "outfit-cream", loadout, pose = "holdup", knife = "knife-carrot", gun = "usp";
    Hand hand = Hand::knife;
    double moment = .5, tilt = 0, ears = 0, turn = 0, zoom = 1;
    Frame frame = Frame::bust;
};

struct Request {
    unsigned id = 0;
    Output output = Output::preview;
    int size = 256;
    Focus focus = Focus::none;
    Spec spec;
    Backdrop backdrop;
    // For Output::file: the folder to write into, chosen by the host.
    std::filesystem::path folder;
};

// What the pose simulation feeds the animation at one moment.
struct PoseInput {
    std::array<float, 3> position{}, velocity{};
    float yaw = 0, pitch = 0;
    bool crouched = false, grounded = true;
};

struct PoseSignal {
    double at = settle_seconds;
    unsigned inspect = 0, attack = 0;
};

// The data exported from the website's stage.ts (export-avatar.ts -> avatar.json).
struct PoseLibrary {
    struct Entry {
        native_gestures::Gesture gesture;
        std::array<double, 3> chest{}, head{};
        double pitch = default_gesture_pitch;
    };

    std::unordered_map<std::string, Entry> gestures;
    std::unordered_map<std::string, double> inspect_seconds;

    static PoseLibrary parse(const nlohmann::json &file) {
        if (file.at("version") != 1) throw std::runtime_error("avatar.json version");
        PoseLibrary out;
        for (const auto &[pose, g] : file.at("gestures").items()) {
            Entry entry;
            entry.gesture = native_gestures::parse_gesture(g);
            if (g.contains("chest")) entry.chest = g["chest"].get<std::array<double, 3>>();
            if (g.contains("head")) entry.head = g["head"].get<std::array<double, 3>>();
            entry.pitch = g.value("pitch", default_gesture_pitch);
            out.gestures.emplace(pose, std::move(entry));
        }
        for (const auto &[knife, seconds] : file.at("inspectSeconds").items())
            if (seconds.is_number()) out.inspect_seconds.emplace(knife, seconds.get<double>());
        return out;
    }

    const Entry *gesture(const std::string &pose) const {
        const auto at = gestures.find(pose);
        return at == gestures.end() ? nullptr : &at->second;
    }

    double inspect_length(const std::string &knife) const {
        const auto at = inspect_seconds.find(knife);
        return at == inspect_seconds.end() ? default_inspect_seconds : at->second;
    }
};

// stage.ts script(): the pose at time t (facing `yaw`), how long to run before the picture, and a one-off
// attack or inspect signal.
class PoseScript {
public:
    PoseScript(const Spec &spec, const PoseLibrary &library) : pose_(spec.pose), moment_(spec.moment) {
        const auto *entry = library.gesture(spec.pose);
        gesture_pitch_ = entry ? entry->pitch : default_gesture_pitch;
        until_ = settle_seconds + moment_ * 3;
        if (pose_ == "crouch")
            until_ = settle_seconds + moment_ * 2;
        else if (pose_ == "run")
            until_ = settle_seconds + moment_ * .9;
        else if (pose_ == "hop")
            until_ = settle_seconds + .04 + moment_ * (hop_seconds - .08);
        else if (pose_ == "strafe")
            until_ = settle_seconds + .08 + moment_ * (hop_seconds - .14);
        else if (pose_ == "swing") {
            until_ = settle_seconds + .02 + moment_ * .6;
            signal_ = PoseSignal{settle_seconds, 0, moment_ > .5 ? 2u : 1u};
        } else if (pose_ == "showoff" && spec.hand == Hand::knife) {
            const double length = library.inspect_length(spec.knife);
            until_ = settle_seconds + .1 + moment_ * std::max(.2, length - .3);
            signal_ = PoseSignal{settle_seconds, 1, 0};
        }
        knife_out_ = spec.hand == Hand::knife;
    }

    double until() const { return until_; }

    const std::optional<PoseSignal> &signal() const { return signal_; }

    PoseInput at(double t, double yaw) const {
        if (pose_ == "lookup") return stand(yaw + 28, -38);
        if (pose_ == "crouch") {
            auto out = stand(yaw, 10);
            out.crouched = true;
            return out;
        }
        if (pose_ == "run") {
            auto out = stand(yaw, 4);
            set_velocity(out, yaw, 250, 0);
            return out;
        }
        if (pose_ == "hop" || pose_ == "strafe") return hopping(t, yaw);
        if (pose_ == "swing") return stand(yaw, 8);
        if (pose_ == "showoff") return stand(yaw, knife_out_ ? 14 : 12);
        if (pose_ == "idle") return stand(yaw, 4);
        return stand(yaw, float(gesture_pitch_));
    }

private:
    std::string pose_;
    double moment_ = 0, until_ = 0, gesture_pitch_ = default_gesture_pitch;
    bool knife_out_ = true;
    std::optional<PoseSignal> signal_;

    static PoseInput stand(double yaw, float pitch) {
        PoseInput out;
        out.yaw = float(yaw);
        out.pitch = pitch;
        return out;
    }

    static void set_velocity(PoseInput &out, double yaw, double speed, double vertical) {
        constexpr double radians_per_degree = 3.141592653589793 / 180;
        out.velocity = {
                float(std::cos(yaw * radians_per_degree) * speed),
                float(std::sin(yaw * radians_per_degree) * speed),
                float(vertical)
        };
    }

    PoseInput hopping(double t, double yaw) const {
        constexpr double run_up_speed = 300, hop_speed = 400, strafe_speed = 700;
        constexpr double strafe_rate = 5, strafe_swing_degrees = 50, landed_phase_seconds = .01;
        if (t < settle_seconds) {
            auto out = stand(yaw, 4);
            set_velocity(out, yaw, run_up_speed, 0);
            return out;
        }
        const double since = t - settle_seconds;
        const double phase = std::fmod(std::fmod(since, hop_seconds) + hop_seconds, hop_seconds);
        const double height = std::max(0., jump_speed * phase - .5 * gravity * phase * phase);
        const double rise = jump_speed - gravity * phase;
        const bool strafe = pose_ == "strafe";
        const double facing = strafe ? yaw + strafe_swing_degrees * std::sin(since * strafe_rate) : yaw;
        auto out = stand(facing, strafe ? 4 : 6);
        out.position[2] = float(height);
        out.grounded = phase < landed_phase_seconds;
        set_velocity(out, facing, strafe ? strafe_speed : hop_speed, rise);
        return out;
    }
};

namespace detail {

inline bool known_pose(const std::string &pose) {
    static const char *const poses[] = {
            "holdup",
            "idle",
            "showoff",
            "hop",
            "strafe",
            "crouch",
            "lookup",
            "swing",
            "run",
            "wave",
            "point",
            "cheer",
            "crossed",
            "hips",
            "salute",
            "think",
            "shrug"
    };
    for (const char *p : poses)
        if (pose == p) return true;
    return false;
}

inline std::optional<double> number(const nlohmann::json &object, const char *key, double lo, double hi) {
    if (!object.contains(key) || !object[key].is_number()) return std::nullopt;
    const double value = object[key].get<double>();
    if (!std::isfinite(value) || value < lo || value > hi) return std::nullopt;
    return value;
}

inline std::optional<std::string> text(const nlohmann::json &object, const char *key, size_t max_bytes) {
    if (!object.contains(key) || !object[key].is_string()) return std::nullopt;
    auto value = object[key].get<std::string>();
    if (value.size() > max_bytes) return std::nullopt;
    return value;
}

inline std::optional<Spec> parse_spec(const nlohmann::json &s) {
    Spec out;
    const auto outfit = text(s, "outfit", max_id_bytes), loadout = text(s, "loadout", max_loadout_bytes),
               pose = text(s, "pose", max_id_bytes), knife = text(s, "knife", max_id_bytes),
               gun = text(s, "gun", max_id_bytes), hand = text(s, "hand", max_id_bytes),
               frame = text(s, "frame", max_id_bytes);
    const auto moment = number(s, "moment", 0, 1), tilt = number(s, "tilt", -1, 1), ears = number(s, "ears", -1, 1),
               turn = number(s, "turn", -180, 180), zoom = number(s, "zoom", .7, 1.6);
    if (!outfit || !loadout || !pose || !knife || !gun || !hand || !frame || !moment || !tilt || !ears || !turn || !zoom
        || !known_pose(*pose))
        return std::nullopt;
    out.outfit = *outfit;
    out.loadout = *loadout;
    out.pose = *pose;
    out.knife = *knife;
    out.gun = *gun;
    out.hand = *hand == "gun" ? Hand::gun : *hand == "none" ? Hand::none : Hand::knife;
    out.frame = *frame == "face"    ? Frame::face
                : *frame == "close" ? Frame::close
                : *frame == "full"  ? Frame::full
                                    : Frame::bust;
    out.moment = *moment;
    out.tilt = *tilt;
    out.ears = *ears;
    out.turn = *turn;
    out.zoom = *zoom;
    return out;
}

inline std::optional<Backdrop> parse_backdrop(const nlohmann::json &b) {
    Backdrop out;
    const auto kind = text(b, "kind", max_id_bytes);
    if (!kind) return std::nullopt;
    if (*kind == "clear") return out;
    const auto top = parse_hex(text(b, "top", max_id_bytes).value_or(""));
    if (!top) return std::nullopt;
    out.top = *top;
    if (*kind == "solid") {
        out.kind = Backdrop::Kind::solid;
        return out;
    }
    const auto bottom = parse_hex(text(b, "bottom", max_id_bytes).value_or(""));
    if (*kind != "studio" || !bottom) return std::nullopt;
    out.kind = Backdrop::Kind::studio;
    out.bottom = *bottom;
    if (b.contains("glow") && !b["glow"].is_null()) {
        out.glow = parse_hex(text(b, "glow", max_id_bytes).value_or(""));
        if (!out.glow) return std::nullopt;
    }
    return out;
}

}  // namespace detail

// The menu's avatarRender message, or nullopt when anything is missing or out of range.
inline std::optional<Request> parse_request(const nlohmann::json &message) {
    if (!message.is_object() || !message.contains("spec") || !message.contains("backdrop")) return std::nullopt;
    const auto &spec_json = message["spec"];
    const auto &backdrop_json = message["backdrop"];
    if (!spec_json.is_object() || !backdrop_json.is_object()) return std::nullopt;
    Request out;
    const auto id = detail::number(message, "id", 1, 4294967295.);
    const auto size = detail::number(message, "size", min_picture_px, max_picture_px);
    const auto output = detail::text(message, "output", max_id_bytes);
    const auto focus = detail::text(message, "focus", max_id_bytes).value_or("");
    const auto spec = detail::parse_spec(spec_json);
    const auto backdrop = detail::parse_backdrop(backdrop_json);
    if (!id || !size || !output || !spec || !backdrop) return std::nullopt;
    out.id = unsigned(*id);
    out.size = int(*size);
    out.output = *output == "webp" ? Output::webp : *output == "file" ? Output::file : Output::preview;
    out.focus = focus == "hand" ? Focus::hand : focus == "glove" ? Focus::glove : Focus::none;
    out.spec = *spec;
    out.backdrop = *backdrop;
    return out;
}

}  // namespace native::avatar
