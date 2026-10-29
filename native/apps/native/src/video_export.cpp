#include "data_location.hpp"
#include "video_export.hpp"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <fstream>
#include <iterator>
#include <stdexcept>
#ifndef _WIN32
#include <poll.h>
#endif

namespace native {
namespace {

using Clock = std::chrono::steady_clock;
constexpr size_t frame_queue_limit = 3;
constexpr size_t spare_buffer_limit = 4;
constexpr uint64_t max_video_frames = uint64_t(max_video_clip_seconds) * 240 + 1;
constexpr size_t max_audio_packet_floats = 22050 * 4;
constexpr auto process_poll_delay_ms = 10;
constexpr uint64_t pipe_retry_delay_ns = 100'000;
constexpr int pipe_wait_ms = 50;
constexpr auto mux_timeout = std::chrono::minutes(5);
constexpr auto probe_timeout = std::chrono::seconds(15);
constexpr size_t probe_output_limit = 1 << 20;
constexpr size_t log_tail_bytes = 4096;
constexpr int probe_side_pixels = 256;
constexpr int probe_frames = 2;
constexpr int audio_file_sample_rate = 48000;
constexpr int min_dnxhr_width_pixels = 256, min_dnxhr_height_pixels = 120;

bool one_of(int value, const auto &choices) {
    return std::find(choices.begin(), choices.end(), value) != choices.end();
}

bool known_codec(const std::string &codec) {
    return std::find(video_codecs.begin(), video_codecs.end(), codec) != video_codecs.end();
}

void validate_picture(const VideoOptions &o) {
    if (o.width < min_video_side_pixels || o.height < min_video_side_pixels || o.width > max_video_side_pixels
        || o.height > max_video_side_pixels || o.width % 2 || o.height % 2
        || int64_t(o.width) * o.height > max_video_pixels)
        throw std::runtime_error("Choose an even video size from 16 px up to 8K (7680×4320).");
    if (!one_of(o.fps, video_frame_rates))
        throw std::runtime_error("Video FPS must be 24, 25, 30, 50, 60, 120, 144 or 240.");
    if (o.camera != "eye" && o.camera != "chase" && o.camera != "flyby" && o.camera != "auto" && o.camera != "orbit")
        throw std::runtime_error("Choose in-eye, chase, flyby, orbit or auto camera.");
    if (o.quality != "standard" && o.quality != "high" && o.quality != "max" && o.quality != "edit")
        throw std::runtime_error("Unknown video quality.");
    if (!known_codec(o.codec)) throw std::runtime_error("Unknown video codec.");
    if (o.codec == "dnxhr" && (o.width < min_dnxhr_width_pixels || o.height < min_dnxhr_height_pixels))
        throw std::runtime_error("DNxHR needs a picture of at least 256×120.");
    if (o.encoder != "auto" && o.encoder != "hardware" && o.encoder != "software")
        throw std::runtime_error("Choose auto, hardware or software encoding.");
    if (o.look != "settings" && o.look != "source" && o.look != "plain")
        throw std::runtime_error("Choose the Source or Plain look.");
    if ((o.supersample != 1 && o.supersample != 2) || !one_of(o.samples, video_sample_counts))
        throw std::runtime_error("Supersampling is 1 or 2; samples per frame 1, 2, 4, 8 or 16.");
    if (!std::isfinite(o.shutter_degrees) || o.shutter_degrees < 0 || o.shutter_degrees > max_shutter_degrees)
        throw std::runtime_error("Shutter must be 0 to 360 degrees.");
}

void validate_music(const VideoOptions &o) {
    if (o.music.empty() || o.music.size() > 256 || !std::isfinite(o.music_offset) || o.music_offset < 0
        || o.music_offset > max_video_clip_seconds || !std::isfinite(o.music_level) || o.music_level < 0
        || o.music_level > 1)
        throw std::runtime_error("Invalid export music settings.");
}

void validate_clip(const VideoOptions &o, uint32_t ticks) {
    if (!std::isfinite(o.tick_interval) || o.tick_interval <= 0 || o.tick_interval > 1 || o.from >= o.to
        || o.to > ticks)
        throw std::runtime_error("Invalid video clip bounds.");
    if ((o.to - o.from) * o.tick_interval > max_video_clip_seconds)
        throw std::runtime_error("Export clips must be at most 30 minutes.");
}

uint64_t clip_frames(const VideoOptions &o) {
    return uint64_t(std::ceil((o.to - o.from) * o.tick_interval * o.fps - 1e-8));
}

std::vector<const char *> c_arguments(const std::vector<std::string> &arguments) {
    std::vector<const char *> result;
    for (const auto &argument : arguments)
        result.push_back(argument.c_str());
    result.push_back(nullptr);
    return result;
}

// stdin from the app when `input`; stdout and stderr discarded, or stderr appended to `errors`.
SDL_Process *create_process(const std::vector<std::string> &arguments, bool input, SDL_IOStream *errors = nullptr) {
    auto args = c_arguments(arguments);
    const auto props = SDL_CreateProperties();
    SDL_SetPointerProperty(props, SDL_PROP_PROCESS_CREATE_ARGS_POINTER, const_cast<char **>(args.data()));
    SDL_SetNumberProperty(
            props, SDL_PROP_PROCESS_CREATE_STDIN_NUMBER, input ? SDL_PROCESS_STDIO_APP : SDL_PROCESS_STDIO_NULL
    );
    SDL_SetNumberProperty(props, SDL_PROP_PROCESS_CREATE_STDOUT_NUMBER, SDL_PROCESS_STDIO_NULL);
    if (errors) {
        SDL_SetNumberProperty(props, SDL_PROP_PROCESS_CREATE_STDERR_NUMBER, SDL_PROCESS_STDIO_REDIRECT);
        SDL_SetPointerProperty(props, SDL_PROP_PROCESS_CREATE_STDERR_POINTER, errors);
    } else {
        SDL_SetNumberProperty(props, SDL_PROP_PROCESS_CREATE_STDERR_NUMBER, SDL_PROCESS_STDIO_NULL);
    }
    auto *process = SDL_CreateProcessWithProperties(props);
    SDL_DestroyProperties(props);
    return process;
}

// A frame is many pipe buffers long: sleeping a whole millisecond each time the pipe fills would cap exports at a
// few frames a second, so wait exactly until FFmpeg has read some.
void wait_writable(SDL_IOStream *output) {
#ifndef _WIN32
    const auto descriptor =
            SDL_GetNumberProperty(SDL_GetIOProperties(output), SDL_PROP_IOSTREAM_FILE_DESCRIPTOR_NUMBER, -1);
    if (descriptor >= 0) {
        pollfd pipe{int(descriptor), POLLOUT, 0};
        poll(&pipe, 1, pipe_wait_ms);
        return;
    }
#endif
    SDL_DelayNS(pipe_retry_delay_ns);
}

// Writes all of `bytes` to a pipe that may not accept them at once; false when the reader went away.
bool write_all(SDL_IOStream *input, const uint8_t *bytes, size_t size, const std::atomic_bool *canceled = nullptr) {
    size_t offset = 0;
    while (offset < size) {
        if (canceled && canceled->load()) return false;
        const auto written = SDL_WriteIO(input, bytes + offset, size - offset);
        offset += written;
        if (written == 0) {
            if (SDL_GetIOStatus(input) != SDL_IO_STATUS_NOT_READY) return false;
            wait_writable(input);
        }
    }
    return true;
}

// Exit code, or -1 when the process outlived the deadline (it is killed).
int wait_for_exit(SDL_Process *process, Clock::duration timeout) {
    const auto deadline = Clock::now() + timeout;
    int code = -1;
    while (!SDL_WaitProcess(process, false, &code)) {
        if (Clock::now() > deadline) {
            SDL_KillProcess(process, true);
            SDL_WaitProcess(process, true, nullptr);
            return -1;
        }
        SDL_Delay(process_poll_delay_ms);
    }
    return code;
}

std::string encoder_list(const std::string &program, bool &found) {
    const std::vector<std::string> arguments = {program, "-hide_banner", "-encoders"};
    auto args = c_arguments(arguments);
    auto *child = SDL_CreateProcess(args.data(), true);
    if (!child) return {};
    found = true;
    if (auto *in = SDL_GetProcessInput(child)) SDL_CloseIO(in);
    size_t size = 0;
    int code = -1;
    auto *bytes = SDL_ReadProcess(child, &size, &code);
    std::string output;
    if (bytes) {
        output.assign(static_cast<char *>(bytes), std::min(size, probe_output_limit));
        SDL_free(bytes);
    }
    SDL_DestroyProcess(child);
    return code ? std::string() : output;
}

// A hardware encoder listed by FFmpeg may still lack a device or driver: encode two small frames to find out.
bool encoder_works(const std::string &program, const VideoEncoderChoice &choice, int width, int height) {
    auto *process = create_process(video_probe_arguments(choice, program, width, height, probe_frames), true);
    if (!process) return false;
    const std::vector<uint8_t> frames(size_t(width) * height * 4 * probe_frames, 0);
    auto *input = SDL_GetProcessInput(process);
    const bool sent = input && write_all(input, frames.data(), frames.size());
    if (input) SDL_CloseIO(input);
    if (!sent) SDL_KillProcess(process, true);
    const int code = wait_for_exit(process, probe_timeout);
    SDL_DestroyProcess(process);
    return sent && code == 0;
}

VideoEncoders usable_encoders(const std::string &program, const std::string &listing) {
    VideoEncoders encoders;
    encoders.program = program;
    for (const auto &name : listed_video_encoders(listing)) {
        if (name == "aac") {
            encoders.aac = true;
            continue;
        }
        const auto *spec = video_encoder_spec(name);
        const VideoEncoderChoice choice{name, std::string(spec->codec), spec->hardware, ""};
        if (!spec->hardware || encoder_works(program, choice, probe_side_pixels, probe_side_pixels))
            encoders.usable.push_back(name);
    }
    return encoders;
}

std::vector<std::string> program_candidates(const std::string &program) {
    std::vector<std::string> candidates = {program};
#ifdef __APPLE__
    // Finder-launched apps may not inherit Homebrew's shell PATH.
    if (program == "ffmpeg")
        for (const char *path : {"/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"})
            if (std::filesystem::is_regular_file(path)) candidates.emplace_back(path);
#endif
    return candidates;
}

std::string missing_ffmpeg_reason() {
#if defined(_WIN32)
    return "FFmpeg is not on PATH. Install it (winget install ffmpeg) and restart the game.";
#elif defined(__APPLE__)
    return "FFmpeg is not installed. Install it with Homebrew (brew install ffmpeg) and restart the game.";
#else
    return "FFmpeg is not on PATH. Install your distribution's ffmpeg package and restart the game.";
#endif
}

uint64_t tree_size(const std::filesystem::path &path) {
    std::error_code ignored;
    if (std::filesystem::is_regular_file(path, ignored)) return std::filesystem::file_size(path, ignored);
    uint64_t total = 0;
    for (const auto &entry : std::filesystem::directory_iterator(path, ignored))
        if (entry.is_regular_file(ignored)) total += entry.file_size(ignored);
    return total;
}

}  // namespace

VideoTimeline VideoTimeline::make(const VideoOptions &o, uint32_t ticks) {
    validate_picture(o);
    validate_music(o);
    validate_clip(o, ticks);
    return {o.from, o.to, o.tick_interval, o.fps, clip_frames(o)};
}

uint64_t VideoTimeline::sample_frame(double seconds, int sample_rate) {
    return uint64_t(std::llround(seconds * sample_rate + 1e-8));
}

uint64_t VideoTimeline::audio_frames(int sample_rate) const {
    return sample_frame(seconds(), sample_rate);
}

double VideoTimeline::tick(uint64_t frame) const {
    return std::min(double(to), double(from) + double(frame) / (fps * tick_interval));
}

VideoAvailability NativeVideoExport::probe(const std::string &program) {
    bool found = false;
    for (const auto &candidate : program_candidates(program)) {
        const auto listing = encoder_list(candidate, found);
        if (listing.empty()) continue;
        auto encoders = usable_encoders(candidate, listing);
        if (encoders.usable.empty()) continue;
        return {true, "", candidate, std::move(encoders)};
    }
    return {false, found ? "This FFmpeg has no usable video encoder." : missing_ffmpeg_reason(), program, {}};
}

VideoEncoderChoice NativeVideoExport::verified_choice(
        const VideoAvailability &available, const VideoOptions &options, VideoEncoderChoice choice
) {
    std::vector<std::string> failed;
    while (choice.hardware && !encoder_works(available.encoder, choice, options.width, options.height)) {
        failed.push_back(choice.name);
        auto software = options;
        software.encoder = "software";
        auto next = choose_video_encoder(available.encoders, software, failed);
        if (!next) throw std::runtime_error("No encoder here can make " + choice.codec + " at this size.");
        next->note = "The hardware encoder refused " + std::to_string(options.width) + "×"
                     + std::to_string(options.height) + ": " + next->name + " instead.";
        choice = std::move(*next);
    }
    return choice;
}

NativeVideoExport::~NativeVideoExport() {
    cancel();
    if (worker.joinable()) worker.join();
}

void NativeVideoExport::start(
        const VideoOptions &o,
        const std::filesystem::path &output,
        uint64_t frames,
        const std::string &encoder_program,
        const VideoEncoderChoice &encoder_choice
) {
    if (running) throw std::runtime_error("A video export is already running.");
    if (worker.joinable()) worker.join();
    validate_picture(o);
    validate_music(o);
    if (frames < 1 || frames > max_video_frames) throw std::runtime_error("Invalid video frame count.");
    const bool sequence = video_codec_is_image_sequence(encoder_choice.codec);
    if ((!sequence && output.extension() != video_extension(encoder_choice.codec)) || !output.is_absolute()
        || !std::filesystem::is_directory(output.parent_path()))
        throw std::runtime_error("Choose an existing output directory and a file name for this format.");
    if (std::filesystem::exists(output)) throw std::runtime_error("Video output already exists; choose another name.");
    if (!std::isfinite(o.tick_interval) || o.tick_interval <= 0 || o.from >= o.to
        || (o.to - o.from) * o.tick_interval > max_video_clip_seconds)
        throw std::runtime_error("Invalid video clip bounds.");
    if (frames != clip_frames(o)) throw std::runtime_error("Video frame count does not match clip duration.");
    static std::atomic_uint64_t serial = 0;
    const auto nonce = std::to_string(Clock::now().time_since_epoch().count()) + "-" + std::to_string(++serial);
    const auto stem = output.parent_path() / (".bunnyhop-" + nonce);
    {
        std::lock_guard lock(mutex);
        options = o;
        choice = encoder_choice;
        program = encoder_program;
        destination = output;
        partial = stem.string() + (sequence ? ".frames" : ".partial" + video_extension(choice.codec));
        video = stem.string() + ".video" + video_extension(choice.codec);
        pcm = stem.string() + ".f32";
        log = stem.string() + ".log";
        queue.clear();
        submitted = written = audio_submitted = bytes = 0;
        total = frames;
        audio_total = o.has_audio() ? VideoTimeline::sample_frame((o.to - o.from) * o.tick_interval) : 0;
        phase = "capturing";
        error.clear();
        finished = false;
        canceled = false;
        running = true;
    }
    try {
        worker = std::thread([this] { run(); });
    } catch (...) {
        running = false;
        std::lock_guard lock(mutex);
        phase = "error";
        error = "Cannot create the video encoder worker.";
        throw;
    }
}

bool NativeVideoExport::can_submit() const {
    std::lock_guard lock(mutex);
    return running && !canceled && !finished && phase == "capturing" && queue.size() < frame_queue_limit
           && submitted < total;
}

std::vector<uint8_t> NativeVideoExport::frame_buffer() {
    std::lock_guard lock(mutex);
    const size_t size = size_t(options.width) * options.height * 4;
    if (!spare.empty()) {
        auto buffer = std::move(spare.back());
        spare.pop_back();
        buffer.resize(size);
        return buffer;
    }
    return std::vector<uint8_t>(size);
}

bool NativeVideoExport::submit(std::vector<uint8_t> rgba, std::vector<float> samples) {
    std::lock_guard lock(mutex);
    if (!running || canceled || finished || phase != "capturing" || queue.size() >= frame_queue_limit
        || submitted >= total)
        return false;
    if (rgba.size() != size_t(options.width) * options.height * 4)
        throw std::runtime_error("Video frame has the wrong byte size.");
    if (samples.size() % 2 || samples.size() > max_audio_packet_floats
        || audio_submitted + samples.size() / 2 > audio_total)
        throw std::runtime_error("Video audio packet has the wrong sample count.");
    for (float v : samples)
        if (!std::isfinite(v)) throw std::runtime_error("Video audio contains non-finite samples.");
    audio_submitted += samples.size() / 2;
    queue.push_back({std::move(rgba), std::move(samples)});
    ++submitted;
    ready.notify_one();
    return true;
}

void NativeVideoExport::finish() {
    std::lock_guard lock(mutex);
    if (!running) return;
    if (submitted != total || audio_submitted != audio_total)
        throw std::runtime_error("Cannot finish before every video frame and audio sample is captured.");
    finished = true;
    phase = "encoding";
    ready.notify_one();
}

void NativeVideoExport::cancel() {
    {
        std::lock_guard lock(mutex);
        if (!running || phase == "completed") return;
        canceled = true;
    }
    ready.notify_all();
    std::lock_guard lock(process_mutex);
    if (process) SDL_KillProcess(process, true);
}

nlohmann::json NativeVideoExport::status() const {
    std::lock_guard lock(mutex);
    const bool done = phase == "completed";
    return {{"state", phase},
            {"frames", submitted},
            {"encodedFrames", written},
            {"totalFrames", total},
            {"progress", total ? double(submitted) / total : 0},
            {"path", done ? native::data_location::utf8(destination) : ""},
            {"bytes", bytes},
            {"error", error},
            {"codec", choice.codec},
            {"encoder", choice.name},
            {"hardware", choice.hardware},
            {"note", choice.note},
            {"videoOnly", !options.has_audio()},
            {"audioSamples", audio_submitted},
            {"musicTrack", options.music},
            {"musicOffset", options.music_offset},
            {"musicLevel", options.music_level},
            {"audioScope",
             options.has_audio() ? (options.music == "none" ? "gameplay"
                                    : options.audio         ? "gameplay+music"
                                                            : "music")
                                 : "none"}};
}

// Owns one process at a time. No shell parses file names.
void NativeVideoExport::spawn(const std::vector<std::string> &arguments) {
    auto *errors = SDL_IOFromFile(native::data_location::utf8(log).c_str(), "ab");
    if (!errors) throw std::runtime_error("Cannot create video encoder log.");
    {
        std::lock_guard lock(process_mutex);
        if (!canceled) process = create_process(arguments, true, errors);
    }
    SDL_CloseIO(errors);
    if (!process)
        throw std::runtime_error(
                canceled ? "Video export canceled." : std::string("Cannot start FFmpeg: ") + SDL_GetError()
        );
}

void NativeVideoExport::wait_process() {
    int code = -1;
    const auto deadline = Clock::now() + mux_timeout;
    for (;;) {
        bool ended;
        {
            std::lock_guard lock(process_mutex);
            if (canceled) SDL_KillProcess(process, true);
            ended = SDL_WaitProcess(process, false, &code);
        }
        if (ended) break;
        if (Clock::now() > deadline) throw std::runtime_error("FFmpeg did not finish within five minutes.");
        SDL_Delay(process_poll_delay_ms);
    }
    {
        std::lock_guard lock(process_mutex);
        SDL_DestroyProcess(process);
        process = nullptr;
    }
    if (!canceled && code) throw std::runtime_error("FFmpeg could not encode the complete video/audio.");
}

// The PCM spool avoids two pipe writers, pipe deadlocks and unbounded RAM for long clips.
void NativeVideoExport::encode_frames() {
    std::ofstream audio;
    if (options.has_audio()) {
        audio.open(pcm, std::ios::binary);
        if (!audio) throw std::runtime_error("Cannot create export audio spool.");
    }
    const bool sequence = video_codec_is_image_sequence(choice.codec);
    if (sequence) std::filesystem::create_directory(partial);
    const auto target = sequence ? partial / "frame-%06d.png" : video;
    spawn(video_encode_arguments(options, choice, program, native::data_location::utf8(target), total));
    auto *input = SDL_GetProcessInput(process);
    if (!input) throw std::runtime_error("FFmpeg input pipe is unavailable.");
    for (;;) {
        Packet packet;
        {
            std::unique_lock lock(mutex);
            ready.wait(lock, [&] { return canceled || !queue.empty() || finished; });
            if (canceled || (queue.empty() && finished)) break;
            packet = std::move(queue.front());
            queue.pop_front();
        }
        if (!packet.pcm.empty()) {
            audio.write(
                    reinterpret_cast<const char *>(packet.pcm.data()),
                    std::streamsize(packet.pcm.size() * sizeof(float))
            );
            if (!audio) throw std::runtime_error("Cannot write export audio (disk full?).");
        }
        if (!write_all(input, packet.rgba.data(), packet.rgba.size(), &canceled)) {
            if (canceled) break;
            throw std::runtime_error("FFmpeg stopped accepting frames.");
        }
        std::lock_guard lock(mutex);
        ++written;
        if (spare.size() < spare_buffer_limit) spare.push_back(std::move(packet.rgba));
    }
    if (audio.is_open()) {
        audio.close();
        if (!audio) throw std::runtime_error("Cannot finish export audio spool.");
    }
    SDL_CloseIO(input);
    wait_process();
    if (!canceled && written != total) throw std::runtime_error("FFmpeg did not receive the complete video.");
}

// CFR images cover [from, to). The container permits a shorter final packet, so a fractional-frame clip ends exactly
// at the clip end instead of gaining an extra video tail. No reordered frames means packet order is display order.
void NativeVideoExport::mux_audio() {
    if (options.has_audio() && std::filesystem::file_size(pcm) != audio_total * 2 * sizeof(float))
        throw std::runtime_error("Export audio spool is incomplete.");
    const uint64_t scale = video_track_timescale;
    const uint64_t duration =
            options.has_audio()
                    ? audio_total * (scale / 22050)
                    : VideoTimeline::sample_frame((options.to - options.from) * options.tick_interval, int(scale));
    const uint64_t last = (total - 1) * (scale / uint64_t(options.fps));
    const auto tail = std::max(int64_t(1), int64_t(duration) - int64_t(last));
    const std::string trim =
            "setts=duration=if(eq(N\\," + std::to_string(total - 1) + ")\\," + std::to_string(tail) + "\\,DURATION)";
    std::vector<std::string> arguments = {
            program, "-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-i", native::data_location::utf8(video)
    };
    if (options.has_audio())
        arguments.insert(
                arguments.end(), {"-f", "f32le", "-ar", "22050", "-ac", "2", "-i", native::data_location::utf8(pcm)}
        );
    arguments.insert(arguments.end(), {"-map", "0:v:0"});
    if (options.has_audio()) {
        arguments.insert(arguments.end(), {"-map", "1:a:0"});
        const auto audio = audio_mux_arguments(choice.codec);
        arguments.insert(arguments.end(), audio.begin(), audio.end());
    }
    arguments.insert(arguments.end(), {"-c:v", "copy", "-bsf:v", trim});
    if (video_extension(choice.codec) != ".mkv")
        arguments.insert(
                arguments.end(),
                {"-video_track_timescale", std::to_string(video_track_timescale), "-movflags", "+faststart"}
        );
    arguments.push_back(native::data_location::utf8(partial));
    spawn(arguments);
    if (auto *in = SDL_GetProcessInput(process)) SDL_CloseIO(in);
    wait_process();
}

void NativeVideoExport::write_audio_file(const std::filesystem::path &file) {
    spawn({program,
           "-hide_banner",
           "-loglevel",
           "error",
           "-nostdin",
           "-n",
           "-f",
           "f32le",
           "-ar",
           "22050",
           "-ac",
           "2",
           "-i",
           native::data_location::utf8(pcm),
           "-c:a",
           "pcm_s16le",
           "-ar",
           std::to_string(audio_file_sample_rate),
           native::data_location::utf8(file)});
    if (auto *in = SDL_GetProcessInput(process)) SDL_CloseIO(in);
    wait_process();
}

void NativeVideoExport::publish_output() {
    std::lock_guard lock(mutex);
    if (canceled) return;
    if (!std::filesystem::exists(partial) || tree_size(partial) < 32)
        throw std::runtime_error("FFmpeg produced no playable video.");
    if (video_codec_is_image_sequence(choice.codec))
        std::filesystem::rename(partial, destination);
    else
        std::filesystem::create_hard_link(partial, destination);
    bytes = tree_size(destination);
    phase = "completed";
}

std::string NativeVideoExport::log_tail() const {
    std::ifstream in(log, std::ios::binary | std::ios::ate);
    if (!in) return {};
    const auto length = in.tellg();
    in.seekg(std::max(std::streamoff(0), std::streamoff(length) - std::streamoff(log_tail_bytes)));
    return {std::istreambuf_iterator<char>(in), {}};
}

void NativeVideoExport::run() {
    std::string failure;
    try {
        encode_frames();
        const bool sequence = video_codec_is_image_sequence(choice.codec);
        if (!canceled && !sequence) mux_audio();
        if (!canceled && options.has_audio() && sequence) write_audio_file(partial / "audio.wav");
        if (!canceled && options.has_audio() && options.audio_file && !sequence) {
            auto sound = destination;
            sound.replace_extension(".wav");
            if (std::filesystem::exists(sound)) throw std::runtime_error("The sound file already exists.");
            write_audio_file(sound);
        }
        publish_output();
    } catch (const std::exception &e) {
        failure = e.what();
    }
    {
        std::lock_guard lock(process_mutex);
        if (process) {
            SDL_KillProcess(process, true);
            SDL_WaitProcess(process, true, nullptr);
            SDL_DestroyProcess(process);
            process = nullptr;
        }
    }
    std::error_code ignored;
    for (const auto &path : {video, pcm})
        std::filesystem::remove(path, ignored);
    std::filesystem::remove_all(partial, ignored);
    if (!failure.empty() && !canceled) {
        const auto detail = log_tail();
        if (!detail.empty()) failure += " " + detail;
    }
    std::filesystem::remove(log, ignored);
    {
        std::lock_guard lock(mutex);
        queue.clear();
        if (phase != "completed") {
            phase = canceled ? "canceled" : "error";
            error = canceled ? "" : failure;
        }
    }
    running = false;
}
}  // namespace native
