#include "video_capture.hpp"
#include <algorithm>
#include <cmath>

namespace native {
namespace {

constexpr float default_fov_degrees = 90;
constexpr float default_hud_percent = 100;
constexpr uint32_t teleported_event = 1;
constexpr uint32_t attacked_event = 32;
constexpr unsigned crouched_flag = 1, grounded_flag = 2;

void checked(bool result, const char *message) {
    if (!result) throw std::runtime_error(message);
}

}  // namespace

VideoCapture::VideoCapture(
        Gl &gl,
        BhContext *core,
        Renderer &renderer,
        NativeHud &hud,
        NativeVideoExport &encoder,
        const VideoOptions &options,
        uint32_t ticks,
        Scene scene,
        const ReplayCamera &prepared
)
    : core_(core)
    , renderer_(renderer)
    , hud_(hud)
    , encoder_(encoder)
    , options_(options)
    , timeline_(VideoTimeline::make(options, ticks))
    , camera_(prepared)
    , scene_(std::move(scene))
    , targets_(gl, options.width, options.height, options.supersample, options.samples) {
    if (options.has_audio())
        audio_ =
                std::make_unique<ReplayAudioTrack>(scene_.assets, scene_.cache, scene_.settings, scene_.style, options);
    checked(bh_replay_seek(core_, audio_ ? 0 : options.from, &next_), "Cannot seek video clip start");
    if (audio_) audio_->tick(core_, next_, options.tick_interval);
    previous_ = next_;
    bh_last_command(core_, &next_command_);
    prior_command_ = next_command_;
    bh_run_state(core_, &run_);
    renderer_.reset_presentation();
    hud_.reset_history();
    camera_.set_mode(options.camera);
    camera_.reset();
}

void VideoCapture::prepare_audio() {
    if (!audio_) return;
    while (next_.player.tick < options_.from) {
        audio_->before_tick(next_.player.tick + 1, options_.tick_interval);
        checked(bh_replay_step(core_, &next_), "Replay audio pre-roll failed");
        audio_->tick(core_, next_, options_.tick_interval);
    }
    previous_ = next_;
    bh_last_command(core_, &next_command_);
    prior_command_ = next_command_;
    bh_run_state(core_, &run_);
}

// Centred on the frame time and spread over the shutter, never before the clip start or a sample already drawn: the
// replay only plays forward.
double VideoCapture::sample_tick(double frame_tick, int sample) const {
    const double shutter_ticks = options_.shutter_degrees / max_shutter_degrees / options_.fps / options_.tick_interval;
    const double offset = ((sample + .5) / options_.samples - .5) * shutter_ticks;
    const double earliest = std::max(double(options_.from), last_sample_tick_);
    return std::clamp(frame_tick + offset, earliest, double(options_.to));
}

void VideoCapture::step_simulation() {
    previous_ = next_;
    prior_command_ = next_command_;
    if (audio_) audio_->before_tick(next_.player.tick + 1, options_.tick_interval);
    checked(bh_replay_step(core_, &next_), "Replay simulation failed during video capture");
    if (audio_ && next_.player.tick < options_.to) audio_->tick(core_, next_, options_.tick_interval);
    bh_last_command(core_, &next_command_);
    BhReplayEvents events{};
    bh_replay_events(core_, previous_.player.tick, next_.player.tick, &events);
    if (events.inspect_signal) renderer_.inspect_press();
    renderer_.inspect_held(events.inspect_held != 0);
    renderer_.simulation_tick();
    hud_.tick(next_.player);
    hud_.command_tick(next_command_, next_.player.tick);
    bh_run_state(core_, &run_);
}

void VideoCapture::advance_to(double tick) {
    const auto upper = uint32_t(std::ceil(tick));
    while (next_.player.tick < upper)
        step_simulation();
}

BhSnapshot VideoCapture::interpolated(double tick, double &mix) {
    BhSnapshot state = next_;
    mix = next_.player.tick == previous_.player.tick ? 1 : std::clamp(tick - double(previous_.player.tick), 0., 1.);
    const auto lerp = [mix](double a, double b) {
        return a + (b - a) * mix;
    };
    const bool teleport = next_.player.events & teleported_event;
    for (int k = 0; k < 3; k++)
        state.player.position[k] =
                float(teleport ? next_.player.position[k]
                               : lerp(previous_.player.position[k], next_.player.position[k]));
    state.player.view_offset_z = float(lerp(previous_.player.view_offset_z, next_.player.view_offset_z));
    const double yaw_delta = std::remainder(double(next_command_.yaw - prior_command_.yaw), 360.);
    input_.set_angles(lerp(prior_command_.pitch, next_command_.pitch), prior_command_.yaw + yaw_delta * mix, 5);
    return state;
}

void VideoCapture::place_actor(const BhSnapshot &state) {
    std::vector<native_render::Actor> actors;
    if (camera_.third_person()) {
        native_render::Actor actor;
        actor.id = "video-target";
        actor.outfit = scene_.outfit;
        actor.loadout = scene_.loadout;
        actor.opacity = 1;
        actor.emptyHand = !options_.weapon;
        std::copy(state.player.position, state.player.position + 3, actor.frame.position);
        std::copy(state.player.velocity, state.player.velocity + 3, actor.frame.velocity);
        actor.frame.tick = state.player.tick;
        actor.frame.pitch = next_command_.pitch;
        actor.frame.yaw = next_command_.yaw;
        actor.frame.view_offset_z = state.player.view_offset_z;
        actor.frame.flags = (state.player.crouched ? crouched_flag : 0) | (state.player.grounded ? grounded_flag : 0)
                            | (state.player.events & attacked_event);
        BhWeaponReport held{};
        bh_weapon_report(core_, &held);
        actor.frame.weapon = held.active;
        BhReplayEvents events{};
        bh_replay_events(core_, previous_.player.tick, next_.player.tick, &events);
        actor.inspect = events.inspect_signal;
        actor.attack = events.cosmetic;
        actor.inspectHeld = events.inspect_held;
        actors.push_back(std::move(actor));
    }
    renderer_.set_room_actors(actors);
}

void VideoCapture::draw_sample(double tick, double dt) {
    advance_to(tick);
    double mix = 1;
    const BhSnapshot state = interpolated(tick, mix);
    const double seconds = tick * options_.tick_interval;
    float eye[3];
    camera_.sample(core_, state.player, input_.yaw(), input_.pitch, seconds, eye, input_, dt);
    renderer_.set_replay_actor(nullptr, 0, 0);
    renderer_.set_spectated_actor(std::nullopt);
    renderer_.set_viewmodel_weapon(std::nullopt);
    renderer_.set_viewmodel_visible(options_.weapon && !camera_.third_person());
    renderer_.set_camera_fov(scene_.settings.value("fov", default_fov_degrees));
    place_actor(state);
    renderer_.set_zone_state(run_.track, run_);
    targets_.bind_scene();
    renderer_.draw(targets_.render_width(), targets_.render_height(), eye, input_, &state, seconds);
}

void VideoCapture::draw_overlays(const BhSnapshot &state) {
    if (!options_.overlays()) return;
    targets_.bind_output();
    BhWeaponReport held{};
    bh_weapon_report(core_, &held);
    hud_.draw(
            options_.width,
            options_.height,
            state,
            run_,
            next_command_,
            scene_.map,
            scene_.style,
            "",
            options_.fps,
            options_.hud || options_.speed || options_.keys || options_.graph,
            options_.crosshair && !camera_.third_person(),
            false,
            held,
            "",
            std::nullopt,
            std::nullopt,
            false,
            nullptr,
            scene_.settings.value("hudScale", default_hud_percent)
    );
}

// After the last image, play out the remaining ticks before the clip end so their sounds are in the track.
void VideoCapture::finish_audio() {
    if (!audio_) return;
    while (next_.player.tick < options_.to) {
        audio_->before_tick(next_.player.tick + 1, options_.tick_interval);
        checked(bh_replay_step(core_, &next_), "Replay audio tail failed");
        if (next_.player.tick < options_.to) audio_->tick(core_, next_, options_.tick_interval);
    }
    audio_->finish();
}

void VideoCapture::render_frame() {
    const double frame_tick = timeline_.tick(frame_);
    targets_.begin_frame();
    for (int sample = 0; sample < options_.samples; ++sample) {
        const double tick = sample_tick(frame_tick, sample);
        const double dt = last_sample_tick_ < 0 ? 0 : (tick - last_sample_tick_) * options_.tick_interval;
        draw_sample(tick, dt);
        targets_.add_sample(options_.samples);
        last_sample_tick_ = tick;
    }
    targets_.resolve();
    double mix = 1;
    draw_overlays(interpolated(last_sample_tick_, mix));
    targets_.read_back(size_t(frame_ % VideoFrameTargets::readback_slots));
    if (frame_ + 1 == timeline_.frames) finish_audio();
    frame_audio_.push_back(audio_ ? audio_->take() : std::vector<float>{});
    ++frame_;
}

bool VideoCapture::hand_over() {
    if (!waiting_) return true;
    if (!encoder_.can_submit()) return false;
    if (!encoder_.submit(std::move(*waiting_), std::move(frame_audio_.front())))
        throw std::runtime_error("Video encoder stopped during capture");
    waiting_.reset();
    frame_audio_.pop_front();
    if (++submitted_ == timeline_.frames) {
        encoder_.finish();
        done_ = true;
    }
    return true;
}

bool VideoCapture::step() {
    if (done_) return false;
    if (!hand_over()) return false;
    if (done_) return true;
    const uint64_t in_flight = frame_ - collected_;
    if (in_flight > 0 && (in_flight + 1 >= VideoFrameTargets::readback_slots || frame_ == timeline_.frames)) {
        waiting_ = encoder_.frame_buffer();
        targets_.collect(size_t(collected_ % VideoFrameTargets::readback_slots), *waiting_);
        ++collected_;
        hand_over();
        return true;
    }
    if (frame_ < timeline_.frames) render_frame();
    return true;
}

}  // namespace native
