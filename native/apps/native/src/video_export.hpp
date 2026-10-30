#pragma once
#include "video_codecs.hpp"
#include <SDL3/SDL.h>
#include <nlohmann/json.hpp>
#include <array>
#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <filesystem>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace native {
struct VideoOptions {
    int width = 1920, height = 1080, fps = 60;
    std::string quality = "high", camera = "eye";
    // h264 hevc av1 prores dnxhr ffv1 png; encoder: auto, hardware or software.
    std::string codec = "h264", encoder = "auto";
    // settings (the player's graphics), source, plain, enhanced or cinematic.
    std::string look = "settings";
    // Motion blur: scene renders per frame spread over the shutter (360 = the whole frame time).
    int supersample = 1, samples = 1;
    double shutter_degrees = 0;
    bool hud = true, speed = true, keys = true, graph = false, crosshair = false, weapon = true;
    bool audio = true, audio_file = false;
    uint32_t from = 0, to = 0;
    double tick_interval = .01;
    bool full_recording = false;
    std::string music = "none";
    double music_offset = 0;
    float music_level = 1;
    bool music_loop = true, music_duck = true;

    bool has_audio() const { return audio || music != "none"; }

    bool overlays() const { return hud || speed || keys || graph || crosshair; }
};

inline constexpr int min_video_side_pixels = 16;
inline constexpr int max_video_side_pixels = 7680;
inline constexpr int64_t max_video_pixels = int64_t(7680) * 4320;
inline constexpr std::array<int, 8> video_frame_rates = {24, 25, 30, 50, 60, 120, 144, 240};
inline constexpr std::array<int, 5> video_sample_counts = {1, 2, 4, 8, 16};
inline constexpr double max_video_clip_seconds = 1800;
inline constexpr double max_shutter_degrees = 360;
// Whole multiples of every frame rate above and of the 22050 Hz mixer, so frame and sample times are exact.
inline constexpr uint64_t video_track_timescale = 2646000;

struct VideoTimeline {
    uint32_t from = 0, to = 0;
    double tick_interval = .01;
    int fps = 60;
    uint64_t frames = 0;
    static VideoTimeline make(const VideoOptions &options, uint32_t recording_ticks);
    double tick(uint64_t frame) const;

    double seconds() const { return double(to - from) * tick_interval; }

    static uint64_t sample_frame(double seconds, int sample_rate = 22050);
    uint64_t audio_frames(int sample_rate = 22050) const;
};

// SDL_CreateProcessWithProperties, retried when another thread closed a descriptor during the spawn (EBADF).
SDL_Process *spawn_process(SDL_PropertiesID props);

struct VideoAvailability {
    bool available = false;
    // `encoder` is the FFmpeg program; `encoders` what it can encode with on this computer.
    std::string reason, encoder = "ffmpeg";
    VideoEncoders encoders;
};

// Real encoder process, never a shell. GL readback stays on the caller thread;
// a bounded queue of RGBA frames keeps process I/O off the rendering thread.
class NativeVideoExport {
    mutable std::mutex mutex, process_mutex;
    std::condition_variable ready;

    struct Packet {
        std::vector<uint8_t> rgba;
        std::vector<float> pcm;
    };

    std::deque<Packet> queue;
    std::vector<std::vector<uint8_t>> spare;
    std::thread worker;
    std::atomic_bool canceled = false, running = false;
    bool finished = false;
    SDL_Process *process = nullptr;
    VideoOptions options;
    VideoEncoderChoice choice;
    std::string program;
    std::filesystem::path destination, partial, video, pcm, log;
    std::string phase = "idle", error;
    uint64_t submitted = 0, written = 0, total = 0, audio_submitted = 0, audio_total = 0, bytes = 0;
    void run();
    void spawn(const std::vector<std::string> &arguments);
    void wait_process();
    void encode_frames();
    void mux_audio();
    void write_audio_file(const std::filesystem::path &file);
    void publish_output();
    std::string log_tail() const;

public:
    ~NativeVideoExport();
    static VideoAvailability probe(const std::string &program = "ffmpeg");
    // An encoder choice whose test encode at this size fails (a hardware size limit) is replaced, with a note.
    static VideoEncoderChoice
    verified_choice(const VideoAvailability &available, const VideoOptions &options, VideoEncoderChoice choice);
    void
    start(const VideoOptions &options,
          const std::filesystem::path &output,
          uint64_t frames,
          const std::string &program = "ffmpeg",
          const VideoEncoderChoice &choice = {"libx264", "h264", false, ""});

    bool busy() const { return running; }

    bool can_submit() const;
    // A buffer for one frame, reused from frames already written.
    std::vector<uint8_t> frame_buffer();
    // PCM uses the shared offline mixer's 22050 Hz interleaved stereo format.
    // Each packet is bounded; the worker spools it to disk before final muxing.
    bool submit(std::vector<uint8_t> rgba, std::vector<float> pcm = {});
    void finish();
    void cancel();
    nlohmann::json status() const;
};
}  // namespace native
