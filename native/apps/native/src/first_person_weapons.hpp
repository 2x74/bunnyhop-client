#pragma once
// What the first-person weapons show each frame, without any GL: the knife or gun in hand from its baked clips, the
// website's weapons pass on top (viewmodel/viewmodel.ts, guns/presenter.ts, guns/viewmodel.ts):
//
//   switching     the outgoing weapon lowers out of view over 0.2 s while the new one's draw starts at once (the knife
//                 keeps animating as it goes; a gun plays its holster from wherever it was). Presentation only: the
//                 core switched on its tick. A reset never lowers anything.
//   inspects      the knife's chain (viewmodel_inspect.hpp), the quiet style for your own presses, attacks blending it
//                 out with the knife home in the fist by the middle of the blend, chain switches crossfading.
//   hand idle     the knife wrist and two fingers easing while idle, a settle after an action; on a gun the trigger
//                 finger and support hand after a quiet second or two.
//   feel          the knife's bob, lag, tilt, crouch, landing dip and hard-landing settle (the gun rides it, clamped),
//                 the gun's own motion, and its shot's FOV kick.
//
// NativeViewmodel draws the layers this returns. first_person_weapons_tests.cpp drives it with synthetic clips.
#include "viewmodel_clips.hpp"
#include "viewmodel_feel.hpp"
#include "viewmodel_inspect.hpp"
#include "viewmodel_pose.hpp"
#include <nlohmann/json.hpp>
#include <cstdio>
#include <optional>
#include <string_view>
#include <unordered_map>

namespace native_vm {

inline constexpr uint32_t knife_weapon_id = 1;
// The hand idle scales with Bob over its default (viewmodel/defaults.ts VIEWMODEL_BOB), at most this much.
inline constexpr double hand_idle_bob_reference = .5, hand_idle_most = 1.5;
// core.ts WEAPON_EVENT_*: reload started / finished, dry fire, the silencer going on or off.
inline constexpr uint32_t reload_started_flag = 4, reload_finished_flag = 8, dry_fire_flag = 16, silencer_flag = 256;

// Base clips a weapon plays (the knife's first five, a gun's the rest).
enum class Action {
    idle,
    draw,
    slash1,
    slash2,
    stab,
    fire,
    reload,
    reload_empty,
    inspect,
    shell_start,
    shell_insert,
    shell_end,
    silencer_on,
    silencer_off,
    holster,
    grip_index,
    grip_open,
    preview
};

inline constexpr size_t action_count = size_t(Action::preview) + 1;

inline constexpr std::array<std::string_view, action_count> action_clip_names = {
        "idle",
        "draw",
        "slash1",
        "slash2",
        "stab",
        "fire",
        "reload",
        "reloadEmpty",
        "inspect",
        "shellStart",
        "shellInsert",
        "shellEnd",
        "silencerOn",
        "silencerOff",
        "holster",
        "gripIndex",
        "gripOpen",
        ""
};

// A gun's motion data (export-viewmodels.ts gunMotion): its class and where its right grip sits on the gun bone.
struct GunMotionInfo {
    GunClass cls = GunClass::rifle;
    size_t pivot_bone = 0;
    std::array<float, 3> pivot{};
};

// Everything read once from the asset metadata.
struct FirstPersonConfig {
    std::unordered_map<std::string, std::vector<TrickSpec>> chains, quiet_chains;
    std::optional<KnifeRig> knife_rig;
    std::unordered_map<std::string, GunMotionInfo> guns;
    double gun_lower_seconds = .2;
    double grip_index_off = .28, grip_left_open = .3;

    static FirstPersonConfig from_metadata(const nlohmann::json &metadata);
};

inline GunClass gun_class_named(const std::string &name) {
    return name == "pistol"    ? GunClass::pistol
           : name == "smg"     ? GunClass::smg
           : name == "shotgun" ? GunClass::shotgun
           : name == "sniper"  ? GunClass::sniper
                               : GunClass::rifle;
}

inline FirstPersonConfig FirstPersonConfig::from_metadata(const nlohmann::json &metadata) {
    FirstPersonConfig out;
    std::optional<TrickSpec> quiet;
    if (metadata.contains("quietInspect")) quiet = trick_from_json(metadata.at("quietInspect"));
    for (const auto &[knife, tricks] : metadata.at("inspects").items()) {
        auto &chain = out.chains[knife];
        for (const auto &trick : tricks)
            chain.push_back(trick_from_json(trick));
        if (!quiet) continue;
        auto &quiet_chain = out.quiet_chains[knife];
        quiet_chain.push_back(*quiet);
        quiet_chain.insert(quiet_chain.end(), chain.begin(), chain.end());
    }
    if (metadata.contains("knifeRig")) out.knife_rig = KnifeRig::from_json(metadata.at("knifeRig"));
    for (const auto &[id, gun] : metadata.value("gunMotion", nlohmann::json::object()).items()) {
        GunMotionInfo info;
        info.cls = gun_class_named(gun.at("cls").get<std::string>());
        info.pivot_bone = gun.at("part").get<size_t>();
        info.pivot = gun.at("pivot").get<std::array<float, 3>>();
        out.guns.emplace(id, info);
    }
    out.gun_lower_seconds = metadata.value("gunLowerSeconds", out.gun_lower_seconds);
    if (metadata.contains("gripIdle")) {
        out.grip_index_off = metadata.at("gripIdle").at("indexOff").get<double>();
        out.grip_left_open = metadata.at("gripIdle").at("leftOpen").get<double>();
    }
    return out;
}

// One frame's input.
struct FirstPersonInput {
    double seconds = 0;
    uint32_t weapon = 0;
    // The rig entry of the weapon in hand ("knife:<knife>:<glove>" or "gun:<gun>:<glove>") and the knife or gun id.
    const PoseEntry *entry = nullptr;
    std::string_view entry_name, item;
    uint32_t tick = 0;
    // A pulse to read the events below from without a new tick (a spectated player's shot).
    bool presentation_event = false;
    uint32_t flags = 0, attack_mode = 0;
    bool shot = false;
    // From the weapon report, when there is one.
    bool has_report = false, silenced = false;
    uint32_t rounds = 0, reload_ticks = 0;
    FeelInput movement;
    // Off for menu and export previews: the weapon holds still on its baked poses (no feel, no hand idle).
    bool feel = true;
    double bob = .5, sway = 1;
    bool quiet_inspect = false;
};

// A weapon to draw: its entry, its skinning pose and its 3x4 in view space (before the viewmodel offset).
struct ViewmodelLayer {
    const PoseEntry *entry = nullptr;
    const std::vector<float> *pose = nullptr;
    Matrix34 view = identity34;
    bool gun = false;
    // The gun's FOV narrowed by its shot's kick (1: none).
    double fov_scale = 1;
};

struct FirstPersonOutput {
    // Drawn in order: a weapon lowering out of view, then the one in hand.
    std::array<ViewmodelLayer, 2> layers{};
    size_t count = 0;
};

// The state of the knife or the gun in hand.
struct WeaponState {
    uint32_t weapon = 0;
    const PoseEntry *entry = nullptr;
    std::string entry_name, item;
    Action action = Action::idle;
    const PoseClip *preview_clip = nullptr;
    double started = 0;
    std::array<const PoseClip *, action_count> plain{}, silenced{};
    bool silenced_now = false, shell_gun = false;
    uint32_t rounds = 0;
    std::vector<float> pose;

    const PoseClip *clip() const {
        if (action == Action::preview) return preview_clip;
        const auto index = size_t(action);
        if (silenced_now && silenced[index]) return silenced[index];
        return plain[index] ? plain[index] : plain[size_t(Action::idle)];
    }

    void resolve_clips() {
        plain.fill(nullptr);
        silenced.fill(nullptr);
        shell_gun = false;
        if (!entry) return;
        constexpr std::string_view silenced_suffix = ":silenced";
        for (const auto &clip : entry->clips) {
            const std::string_view name = clip.name;
            const bool quiet = name.ends_with(silenced_suffix);
            const auto base = quiet ? name.substr(0, name.size() - silenced_suffix.size()) : name;
            for (size_t i = 0; i < action_count; i++)
                if (!action_clip_names[i].empty() && action_clip_names[i] == base)
                    (quiet ? silenced : plain)[i] = &clip;
            shell_gun |= name == "shellStart";
        }
    }
};

class FirstPersonWeapons {
public:
    explicit FirstPersonWeapons(FirstPersonConfig config, std::span<const float> data)
        : config_(std::move(config))
        , data_(data) {
        if (config_.knife_rig) work_.size_for(*config_.knife_rig);
    }

    const FirstPersonConfig &config() const { return config_; }

    // A restart, a seek, an export's start: straight to the weapon's draw with nothing lowering or in flight.
    void reset() {
        current_ = {};
        knife_ = {};
        lowering_ = {};
        lowering_knife_ = false;
        gun_info_ = {};
        view_feel_.reset();
        gun_motion_.reset();
        hand_idle_.reset();
        grip_idle_.reset();
        landing_.reset();
        combo_.reset();
        pending_presses_ = 0;
        last_seconds_.reset();
        previous_tick_.reset();
        last_shot_ = no_shot;
    }

    // One simulation tick of the player: landings for the feel, the side move for the strafe tilt.
    void simulation_tick(bool grounded, double vertical_speed, double side_move) {
        landing_.tick(grounded, vertical_speed);
        side_move_ = side_move;
    }

    // The inspect key. `own`: your press, which may start the quiet check; a replay's never does. Returns whether the
    // press is yours only (it starts the quiet check, so replays and others don't get it).
    bool press_inspect(bool own, bool quiet_style) {
        const bool idle_knife = current_.weapon == knife_weapon_id
                                && (current_.action == Action::idle || current_.action == Action::draw);
        const bool starts_quiet = own && quiet_style && idle_knife && !combo_.active() && pending_presses_ == 0;
        if (pending_presses_ < pending_owner_.size()) pending_owner_[pending_presses_++] = own;
        return starts_quiet;
    }

    void hold_inspect(bool held) { inspect_held_ = held; }

    // Menu and export previews: plays `clip` of the weapon in hand from `started`.
    void preview_clip(std::string_view clip, double started) {
        current_.action = Action::preview;
        current_.preview_clip = current_.entry ? current_.entry->clip_or_idle(clip) : nullptr;
        current_.started = started;
        combo_.cancel_draw();
    }

    const FirstPersonOutput &frame(const FirstPersonInput &in, native_render::InspectCueQueue &cues) {
        const double dt = advance_clock(in.seconds);
        auto movement = in.movement;
        movement.landed = landing_.take();
        movement.sidemove = side_move_;
        const Matrix34 feel = in.feel ? view_feel_.update(dt, movement, in.bob, in.sway, clock_) : identity34;
        switch_weapons(in);
        if (!previous_tick_ || *previous_tick_ != in.tick || in.presentation_event) weapon_events(in);
        previous_tick_ = in.tick;
        output_.count = 0;
        if (current_.weapon == knife_weapon_id) {
            knife_presses(in, cues);
            advance_knife(dt, in, cues);
        } else {
            gun_presses(in);
            advance_lowering_knife(dt, in, cues);
        }
        if (current_.weapon > knife_weapon_id) advance_gun(dt, in);
        add_lowering_layer(in, feel);
        if (current_.weapon == knife_weapon_id) add_knife_layer(in, feel);
        if (current_.weapon > knife_weapon_id) add_gun_layer(dt, in, movement, feel);
        return output_;
    }

    // Seconds since the gun in hand last fired (its muzzle flash).
    double since_shot() const { return clock_ - last_shot_; }

    bool inspecting() const { return combo_.active(); }

private:
    static constexpr double no_shot = -1e9;
    static constexpr double longest_frame_seconds = .1;
    // A gun's switch-away holster fades in from where it was over this long (guns/anim.ts play, "holster").
    static constexpr double holster_fade_seconds = .06;
    static constexpr double knife_lower_seconds = .2;

    double advance_clock(double seconds) {
        // A gap longer than this since the last drawn frame (the viewmodel hidden, a seek): nothing lowers.
        constexpr double shown_gap_seconds = .25;
        shown_last_frame_ = last_seconds_ && std::abs(seconds - *last_seconds_) < shown_gap_seconds;
        const double dt = last_seconds_ ? std::clamp(seconds - *last_seconds_, 0., longest_frame_seconds) : 0;
        last_seconds_ = seconds;
        clock_ += dt;
        return dt;
    }

    double time_in(const WeaponState &state, double seconds) const { return std::max(0., seconds - state.started); }

    void start(WeaponState &state, const FirstPersonInput &in, Action action) {
        state.action = action;
        state.started = in.seconds;
    }

    void switch_weapons(const FirstPersonInput &in) {
        if (in.weapon == current_.weapon && in.entry_name == current_.entry_name) {
            current_.silenced_now = in.has_report ? in.silenced : current_.silenced_now;
            return;
        }
        // A new weapon lowers the old one; new gloves or a new knife on the same weapon just swap the model.
        if (current_.weapon && in.weapon != current_.weapon && shown_last_frame_) lower_out(in);
        const bool knife = in.weapon == knife_weapon_id;
        if (knife) lowering_knife_ = false;
        current_.weapon = in.weapon;
        current_.entry = in.entry;
        current_.entry_name = in.entry_name;
        current_.item = in.item;
        current_.silenced_now = in.silenced;
        current_.rounds = in.rounds;
        current_.resolve_clips();
        start(current_, in, Action::draw);
        if (knife) begin_knife(in);
        if (!knife) {
            grip_idle_.reset();
            last_shot_ = no_shot;
            const auto info = config_.guns.find(std::string(in.item));
            gun_info_ = info == config_.guns.end() ? GunMotionInfo{} : info->second;
        }
    }

    void begin_knife(const FirstPersonInput &in) {
        combo_.cancel_draw();
        hand_idle_.reset();
        resolve_chain_clips(in.item);
        pending_presses_ = 0;
    }

    void resolve_chain_clips(std::string_view knife) {
        own_chain_ = chain_of(config_.chains, knife);
        quiet_chain_ = chain_of(config_.quiet_chains, knife);
        own_clips_.clear();
        quiet_clips_.clear();
        if (!current_.entry) return;
        std::array<char, 16> name{};
        for (size_t k = 0; k < own_chain_.size(); k++) {
            const auto length = std::snprintf(name.data(), name.size(), "inspect%zu", k);
            const auto *clip = current_.entry->find(std::string_view(name.data(), size_t(length)));
            own_clips_.push_back(clip);
        }
        if (!quiet_chain_.empty()) {
            quiet_clips_.push_back(current_.entry->find("inspectQuiet"));
            quiet_clips_.insert(quiet_clips_.end(), own_clips_.begin(), own_clips_.end());
        }
    }

    static std::span<const TrickSpec>
    chain_of(const std::unordered_map<std::string, std::vector<TrickSpec>> &chains, std::string_view knife) {
        for (const auto &[id, chain] : chains)
            if (id == knife) return chain;
        return {};
    }

    // The weapon in hand starts lowering out of view (guns/presenter.ts lowerOut, viewmodel.ts holster).
    void lower_out(const FirstPersonInput &in) {
        if (current_.weapon == knife_weapon_id) {
            knife_ = current_;
            lowering_knife_ = true;
            knife_lower_started_ = clock_;
            if (combo_.active()) combo_.cancel_attack(cancel_blend(gap_distance_, gap_angle_));
            return;
        }
        if (!current_.entry || current_.pose.empty()) return;
        lowering_.state = current_;
        lowering_.from = current_.pose;
        lowering_.started = clock_;
        lowering_.motion = gun_motion_matrix_;
        lowering_.active = true;
        lowering_.state.action = Action::holster;
        lowering_.state.started = in.seconds;
    }

    void weapon_events(const FirstPersonInput &in) {
        if (current_.weapon > knife_weapon_id && in.has_report && (in.flags & silencer_flag)) {
            start(current_, in, in.silenced ? Action::silencer_on : Action::silencer_off);
            grip_idle_.quiet_reset();
        } else if (in.shot)
            shot(in);
        else if (in.flags & reload_started_flag)
            reload_started(in);
        else if (current_.weapon > knife_weapon_id && current_.shell_gun && in.has_report)
            shell_events(in);
        if (in.flags & dry_fire_flag) grip_idle_.quiet_reset();
        if (in.has_report) current_.rounds = in.rounds;
    }

    void shot(const FirstPersonInput &in) {
        constexpr uint32_t stab_mode = 2;
        if (current_.weapon == knife_weapon_id) {
            const Action swing = in.attack_mode == stab_mode ? Action::stab
                                 : in.tick % 2               ? Action::slash1
                                                             : Action::slash2;
            start(current_, in, swing);
            combo_.cancel_attack(cancel_blend(gap_distance_, gap_angle_));
            return;
        }
        if (current_.weapon <= knife_weapon_id) return;
        start(current_, in, Action::fire);
        last_shot_ = clock_;
        grip_idle_.quiet_reset();
    }

    void reload_started(const FirstPersonInput &in) {
        if (current_.weapon == knife_weapon_id) return;
        const Action action = current_.shell_gun                ? Action::shell_start
                              : in.has_report && in.rounds == 0 ? Action::reload_empty
                                                                : Action::reload;
        start(current_, in, action);
        grip_idle_.quiet_reset();
    }

    void shell_events(const FirstPersonInput &in) {
        if (in.flags & reload_finished_flag) {
            start(current_, in, Action::shell_end);
            grip_idle_.quiet_reset();
        } else if (in.reload_ticks && in.rounds > current_.rounds) {
            start(current_, in, Action::shell_insert);
            grip_idle_.quiet_reset();
        }
    }

    void knife_presses(const FirstPersonInput &in, native_render::InspectCueQueue &cues) {
        ComboEvents events;
        events.cues = &cues;
        for (size_t i = 0; i < pending_presses_; i++) {
            if (current_.action != Action::idle && current_.action != Action::draw) continue;
            if (!combo_.active()) {
                const bool quiet = pending_owner_[i] && in.quiet_inspect && !quiet_chain_.empty();
                combo_.set_chain(quiet ? quiet_chain_ : own_chain_);
            }
            combo_.press(events);
        }
        pending_presses_ = 0;
    }

    // A gun's inspect press plays its inspect clip.
    void gun_presses(const FirstPersonInput &in) {
        if (!pending_presses_) return;
        pending_presses_ = 0;
        if (current_.weapon <= knife_weapon_id) return;
        start(current_, in, Action::inspect);
        grip_idle_.quiet_reset();
    }

    void advance_knife(double dt, const FirstPersonInput &in, native_render::InspectCueQueue &cues) {
        const auto *clip = current_.clip();
        if (clip && current_.action != Action::idle && current_.action != Action::preview
            && time_in(current_, in.seconds) >= clip->duration)
            start(current_, in, Action::idle);
        ComboEvents events;
        events.cues = &cues;
        combo_.update(dt, inspect_held_, events);
        hand_idle_.update(dt, current_.action == Action::idle && !combo_.active());
    }

    void advance_lowering_knife(double dt, const FirstPersonInput &in, native_render::InspectCueQueue &cues) {
        if (!lowering_knife_) return;
        if (clock_ - knife_lower_started_ >= knife_lower_seconds) {
            lowering_knife_ = false;
            combo_.reset();
            return;
        }
        const auto *clip = knife_.clip();
        if (clip && knife_.action != Action::idle && time_in(knife_, in.seconds) >= clip->duration)
            start(knife_, in, Action::idle);
        ComboEvents events;
        events.cues = &cues;
        combo_.update(dt, false, events);
    }

    void advance_gun(double dt, const FirstPersonInput &in) {
        grip_idle_.update(dt);
        const auto *clip = current_.clip();
        if (!clip || current_.action == Action::idle || current_.action == Action::preview) return;
        if (time_in(current_, in.seconds) < clip->duration) return;
        const bool shells_continue =
                current_.shell_gun && in.has_report && in.reload_ticks
                && (current_.action == Action::shell_start || current_.action == Action::shell_insert);
        const Action ended = current_.action;
        start(current_, in, shells_continue ? Action::shell_insert : Action::idle);
        if (shells_continue || ended == Action::fire) return;
        const bool settles = ended == Action::reload || ended == Action::reload_empty || ended == Action::shell_end
                             || ended == Action::silencer_on || ended == Action::silencer_off || ended == Action::draw
                             || ended == Action::inspect;
        grip_idle_.clip_ended(settles);
    }

    // The knife's pose: its base clip, the inspect over it, the hand idle; into state.pose.
    void pose_knife(WeaponState &state, const FirstPersonInput &in) {
        const auto *clip = state.clip();
        if (!state.entry || !clip) return;
        sample_clip(data_, *state.entry, *clip, time_in(state, in.seconds), false, state.pose);
        if (!config_.knife_rig || config_.knife_rig->bones() != state.entry->bones) {
            blend_inspect_flat(state);
            return;
        }
        const auto &rig = *config_.knife_rig;
        world_.resize(state.pose.size());
        bool posed = blend_inspect(rig, state);
        const double amount = std::min(hand_idle_most, in.bob / hand_idle_bob_reference);
        const auto hand = in.feel ? hand_idle_.pose(clock_, amount) : HandIdlePose{};
        if (hand.flex || hand.deviation || hand.index || hand.pinky) {
            if (!posed) to_world(rig, state.pose, world_);
            apply_hand_idle(rig, world_, hand);
            posed = true;
        }
        if (posed) to_skin(rig, world_, state.pose);
    }

    // The inspect over the base pose in world_ (inspects/runtime.ts apply); false when there's no inspect showing.
    bool blend_inspect(const KnifeRig &rig, WeaponState &state) {
        const auto pose = combo_.pose();
        const auto chain = combo_.chain();
        const auto &clips = chain.data() == quiet_chain_.data() ? quiet_clips_ : own_clips_;
        if (!pose.playing || pose.weight <= 0 || size_t(pose.current.trick) >= clips.size()) return false;
        const auto *current = clips[size_t(pose.current.trick)];
        if (!current) return false;
        to_world(rig, state.pose, world_);
        sample_world(rig, *state.entry, *current, pose.current.t, inspect_world_);
        if (pose.crossfading && pose.mix < 1 && size_t(pose.previous.trick) < clips.size()
            && clips[size_t(pose.previous.trick)]) {
            sample_world(rig, *state.entry, *clips[size_t(pose.previous.trick)], pose.previous.t, previous_world_);
            blend_hierarchy(rig, previous_world_, inspect_world_, pose.mix, work_);
            inspect_world_.swap(previous_world_);
        }
        if (pose.weight >= 1) measure_gap(rig);
        CancelWeights groups;
        if (pose.weight < 1) {
            constexpr double knife_from = .45;
            groups.fingers = std::min(1., pose.weight * 2);
            groups.knife = smooth_step((pose.weight - knife_from) / (1 - knife_from));
        }
        blend_hierarchy(rig, world_, inspect_world_, pose.weight, work_, pose.weight < 1 ? &groups : nullptr);
        return true;
    }

    // Without the knife rig (an older asset bundle): the inspect blended bone by bone over the base pose.
    void blend_inspect_flat(WeaponState &state) {
        const auto pose = combo_.pose();
        const auto &clips = combo_.chain().data() == quiet_chain_.data() ? quiet_clips_ : own_clips_;
        if (!pose.playing || pose.weight <= 0 || size_t(pose.current.trick) >= clips.size()) return;
        const auto *current = clips[size_t(pose.current.trick)];
        if (!current) return;
        sample_clip(data_, *state.entry, *current, pose.current.t, false, inspect_world_);
        const auto *previous = pose.crossfading && size_t(pose.previous.trick) < clips.size()
                                       ? clips[size_t(pose.previous.trick)]
                                       : nullptr;
        if (previous && pose.mix < 1) {
            sample_clip(data_, *state.entry, *previous, pose.previous.t, false, previous_world_);
            blend_flat(previous_world_, inspect_world_, pose.mix);
            inspect_world_.swap(previous_world_);
        }
        blend_flat(state.pose, inspect_world_, pose.weight);
    }

    void sample_world(
            const KnifeRig &rig, const PoseEntry &entry, const PoseClip &clip, double t, std::vector<float> &world
    ) {
        sample_clip(data_, entry, clip, t, false, scratch_);
        world.resize(scratch_.size());
        to_world(rig, scratch_, world);
    }

    // How far the inspect has the knife handle from where the base pose holds it (runtime.ts measureGap).
    void measure_gap(const KnifeRig &rig) {
        const size_t at = size_t(rig.knife_handle) * floats_per_bone;
        const float *base = world_.data() + at, *inspect = inspect_world_.data() + at;
        gap_distance_ = std::hypot(inspect[3] - base[3], inspect[7] - base[7], inspect[11] - base[11]);
        double trace = 0;
        for (int r = 0; r < 3; r++)
            for (int c = 0; c < 3; c++)
                trace += double(base[r * 4 + c]) * inspect[r * 4 + c];
        gap_angle_ = std::acos(std::clamp((trace - 1) / 2, -1., 1.));
    }

    void add_knife_layer(const FirstPersonInput &in, const Matrix34 &feel) {
        pose_knife(current_, in);
        if (current_.pose.empty()) return;
        auto &layer = output_.layers[output_.count++];
        layer = {current_.entry, &current_.pose, feel, false, 1};
    }

    void add_lowering_layer(const FirstPersonInput &in, const Matrix34 &feel) {
        if (lowering_knife_ && current_.weapon != knife_weapon_id) {
            pose_knife(knife_, in);
            const double u = std::clamp((clock_ - knife_lower_started_) / knife_lower_seconds, 0., 1.);
            if (!knife_.pose.empty())
                output_.layers[output_.count++] = {
                        knife_.entry, &knife_.pose, concat(knife_lowered(u), feel), false, 1
                };
        }
        if (!lowering_.active) return;
        const double t = clock_ - lowering_.started;
        if (t >= config_.gun_lower_seconds) {
            lowering_.active = false;
            return;
        }
        const auto *holster = lowering_.state.clip();
        if (!holster || !lowering_.state.entry) return;
        sample_clip(data_, *lowering_.state.entry, *holster, t, false, lowering_.state.pose);
        lowering_.shown.assign(lowering_.from.begin(), lowering_.from.end());
        blend_flat(lowering_.shown, lowering_.state.pose, smooth_step(t / holster_fade_seconds));
        const Matrix34 view = concat(clamp_gun_feel(feel), lowering_.motion);
        output_.layers[output_.count++] = {lowering_.state.entry, &lowering_.shown, view, true, 1};
    }

    // viewmodel.ts lowered: down and out of view, accelerating, the wrist turning the blade down about the hand.
    static Matrix34 knife_lowered(double u) {
        constexpr double hand_x = 16, hand_y = -6, hand_z = -7, pitch_degrees = 24, roll_degrees = 12;
        constexpr double back = 1.5, right = 1, down = 9;
        const double k = u * u;
        Matrix34 lowered{};
        angle_matrix(pitch_degrees * k, 0, roll_degrees * k, 0, 0, 0, lowered);
        lowered[3] = float(hand_x - (lowered[0] * hand_x + lowered[1] * hand_y + lowered[2] * hand_z) - back * k);
        lowered[7] = float(hand_y - (lowered[4] * hand_x + lowered[5] * hand_y + lowered[6] * hand_z) - right * k);
        lowered[11] = float(hand_z - (lowered[8] * hand_x + lowered[9] * hand_y + lowered[10] * hand_z) - down * k);
        return lowered;
    }

    void add_gun_layer(double dt, const FirstPersonInput &in, const FeelInput &movement, const Matrix34 &feel) {
        const auto *clip = current_.clip();
        if (!current_.entry || !clip) return;
        sample_clip(data_, *current_.entry, *clip, time_in(current_, in.seconds), false, current_.pose);
        if (in.feel && current_.action == Action::idle) apply_grip_idle();
        const GunMotionInfo &motion = gun_info_;
        gun_motion_.bob = in.bob;
        gun_motion_.sway = in.sway;
        gun_motion_matrix_ = in.feel ? gun_motion_.update(dt, motion.cls, &movement, pivot_of(motion)) : identity34;
        auto &layer = output_.layers[output_.count++];
        layer = {current_.entry, &current_.pose, concat(clamp_gun_feel(feel), gun_motion_matrix_), true, 1};
        if (in.feel) layer.fov_scale = 1 - fov_kick(motion.cls) * std::min(1., in.bob);
    }

    // The trigger finger and support hand of the grip idle, toward the baked poses at full strength.
    void apply_grip_idle() {
        const auto grip = grip_idle_.pose();
        const double index = grip.index_off / config_.grip_index_off, open = grip.left_open / config_.grip_left_open;
        if (index <= 0 && open <= 0) return;
        const auto *eased = current_.silenced_now && current_.silenced[size_t(Action::grip_index)]
                                    ? current_.silenced[size_t(Action::grip_index)]
                                    : current_.plain[size_t(Action::grip_index)];
        const auto *relaxed = current_.silenced_now && current_.silenced[size_t(Action::grip_open)]
                                      ? current_.silenced[size_t(Action::grip_open)]
                                      : current_.plain[size_t(Action::grip_open)];
        idle_.assign(current_.pose.begin(), current_.pose.end());
        add_toward(eased, index);
        add_toward(relaxed, open);
    }

    void add_toward(const PoseClip *basis, double amount) {
        if (!basis || amount <= 0) return;
        sample_clip(data_, *current_.entry, *basis, 0, false, scratch_);
        if (scratch_.size() != current_.pose.size()) return;
        for (size_t i = 0; i < scratch_.size(); i++)
            current_.pose[i] += float(amount) * (scratch_[i] - idle_[i]);
    }

    // The right grip on the gun bone this frame (guns/viewmodel.ts update): the gun's motion turns about it.
    std::array<float, 3> pivot_of(const GunMotionInfo &info) const {
        const size_t at = info.pivot_bone * floats_per_bone;
        if (at + floats_per_bone > current_.pose.size()) return info.pivot;
        const float *m = current_.pose.data() + at;
        const auto &p = info.pivot;
        return {m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
                m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
                m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11]};
    }

    // The shot's kick on the viewmodel FOV, a fraction of it (guns/viewmodel.ts fovKick): a 30 ms punch, an ease back.
    double fov_kick(GunClass cls) const {
        constexpr double kick_seconds = .4, punch_seconds = .03, ease_rate = 12;
        const double t = since_shot();
        if (t > kick_seconds || t < 0) return 0;
        const double size = cls == GunClass::shotgun || cls == GunClass::sniper ? .035
                            : cls == GunClass::smg || cls == GunClass::rifle    ? .012
                                                                                : .022;
        return size * (t < punch_seconds ? t / punch_seconds : std::exp(-(t - punch_seconds) * ease_rate));
    }

    struct GunLowering {
        bool active = false;
        WeaponState state;
        std::vector<float> from, shown;
        double started = 0;
        Matrix34 motion = identity34;
    };

    FirstPersonConfig config_;
    std::span<const float> data_;
    WeaponState current_, knife_;
    GunLowering lowering_;
    bool lowering_knife_ = false;
    double knife_lower_started_ = 0;
    ViewFeel view_feel_;
    GunMotion gun_motion_;
    GunMotionInfo gun_info_;
    Matrix34 gun_motion_matrix_ = identity34;
    bool shown_last_frame_ = false;
    HandIdle hand_idle_;
    GripIdle grip_idle_;
    LandingWatch landing_;
    double side_move_ = 0;
    InspectCombo combo_;
    std::span<const TrickSpec> own_chain_, quiet_chain_;
    std::vector<const PoseClip *> own_clips_, quiet_clips_;
    std::array<bool, 4> pending_owner_{};
    size_t pending_presses_ = 0;
    bool inspect_held_ = false;
    double gap_distance_ = 0, gap_angle_ = 0;
    std::optional<double> last_seconds_;
    std::optional<uint32_t> previous_tick_;
    double clock_ = 0, last_shot_ = no_shot;
    PoseWork work_;
    std::vector<float> world_, inspect_world_, previous_world_, scratch_, idle_;
    FirstPersonOutput output_;
};

}  // namespace native_vm
