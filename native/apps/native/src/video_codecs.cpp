#include "video_codecs.hpp"
#include "video_export.hpp"
#include <algorithm>
#include <cmath>

namespace native {
namespace {

// The website's bitrates (viewer/export-options.ts QUALITIES) as bits per pixel per frame.
constexpr double standard_bits_per_pixel = .12;
constexpr double high_bits_per_pixel = .2;
constexpr double max_bits_per_pixel = .35;
constexpr double edit_bits_per_pixel = 1.2;
// Above every preset at 1440p60 for a file that plays everywhere; Edit-ready may go far higher.
constexpr uint64_t max_bitrate = 80'000'000;
constexpr uint64_t edit_max_bitrate = 240'000'000;
constexpr int keyframe_seconds = 2;
constexpr const char *vaapi_device = "/dev/dri/renderD128";
constexpr int probe_frame_rate = 30;

struct Crf {
    int standard, high, max, edit;
};

constexpr Crf x264_crf{23, 18, 14, 8};
constexpr Crf x265_crf{26, 22, 18, 12};
constexpr Crf svt_av1_crf{38, 32, 26, 18};
constexpr Crf aom_av1_crf{36, 30, 24, 16};

int crf_for(const Crf &table, const std::string &quality) {
    if (quality == "standard") return table.standard;
    if (quality == "max") return table.max;
    if (quality == "edit") return table.edit;
    return table.high;
}

bool starts_with(std::string_view text, std::string_view prefix) {
    return text.substr(0, prefix.size()) == prefix;
}

bool ends_with(std::string_view text, std::string_view suffix) {
    return text.size() >= suffix.size() && text.substr(text.size() - suffix.size()) == suffix;
}

void append(std::vector<std::string> &arguments, std::initializer_list<std::string> values) {
    arguments.insert(arguments.end(), values);
}

bool rgb_output(std::string_view codec) {
    return codec == "ffv1" || codec == "png";
}

std::string pixel_format(const VideoEncoderChoice &choice, const std::string &quality) {
    const std::string_view name = choice.name;
    if (choice.codec == "png") return "rgb24";
    if (choice.codec == "ffv1") return "bgr0";
    if (name == "prores_ks") return "yuv422p10le";
    if (name == "prores_videotoolbox") return "p210le";
    if (name == "dnxhd") return quality == "max" || quality == "edit" ? "yuv422p10le" : "yuv422p";
    if (choice.hardware) return "nv12";
    return "yuv420p";
}

// Rows arrive bottom-up from OpenGL; YUV codecs convert with the HD (BT.709) matrix players assume.
std::string video_filter(const VideoEncoderChoice &choice, const std::string &quality) {
    std::string filter = "vflip";
    if (!rgb_output(choice.codec)) filter += ",scale=out_color_matrix=bt709:out_range=tv";
    filter += ",format=" + pixel_format(choice, quality);
    if (ends_with(choice.name, "_vaapi")) filter += ",hwupload";
    return filter;
}

std::string prores_profile(const VideoEncoderChoice &choice, const std::string &quality) {
    if (choice.hardware) return quality == "standard" ? "standard" : "hq";
    return quality == "standard" ? "2" : "3";
}

std::string dnxhr_profile(const std::string &quality) {
    if (quality == "standard") return "dnxhr_sq";
    if (quality == "high") return "dnxhr_hq";
    return "dnxhr_hqx";
}

void append_bitrate(std::vector<std::string> &arguments, const VideoOptions &options, bool peak) {
    const uint64_t rate = video_bitrate(options);
    append(arguments, {"-b:v", std::to_string(rate)});
    if (peak) append(arguments, {"-maxrate", std::to_string(rate * 3 / 2), "-bufsize", std::to_string(rate * 2)});
}

void append_software(std::vector<std::string> &arguments, const VideoOptions &options, std::string_view name) {
    if (name == "libx264") {
        append(arguments, {"-preset", "fast", "-crf", std::to_string(crf_for(x264_crf, options.quality))});
    } else if (name == "libx265") {
        append(arguments, {"-preset", "fast", "-crf", std::to_string(crf_for(x265_crf, options.quality))});
        append(arguments, {"-x265-params", "log-level=error", "-tag:v", "hvc1"});
    } else if (name == "libsvtav1") {
        // Low-delay prediction keeps decode order equal to presentation order, which the exact clip end needs.
        append(arguments, {"-preset", "8", "-crf", std::to_string(crf_for(svt_av1_crf, options.quality))});
        append(arguments, {"-svtav1-params", "pred-struct=1"});
    } else if (name == "libaom-av1") {
        append(arguments, {"-cpu-used", "6", "-row-mt", "1", "-lag-in-frames", "0", "-b:v", "0"});
        append(arguments, {"-crf", std::to_string(crf_for(aom_av1_crf, options.quality))});
    }
}

void append_hardware(std::vector<std::string> &arguments, const VideoOptions &options, std::string_view name) {
    if (ends_with(name, "_videotoolbox")) {
        append_bitrate(arguments, options, false);
        append(arguments, {"-allow_sw", "0"});
        if (starts_with(name, "hevc")) append(arguments, {"-tag:v", "hvc1"});
    } else if (ends_with(name, "_nvenc")) {
        append(arguments, {"-preset", "p5", "-rc", "vbr"});
        append_bitrate(arguments, options, true);
    } else if (ends_with(name, "_qsv")) {
        append(arguments, {"-preset", "medium"});
        append_bitrate(arguments, options, true);
    } else if (ends_with(name, "_amf")) {
        append(arguments, {"-quality", "quality", "-rc", "vbr_peak"});
        append_bitrate(arguments, options, true);
    } else {
        append_bitrate(arguments, options, true);
    }
    if (starts_with(name, "hevc") && !ends_with(name, "_videotoolbox")) append(arguments, {"-tag:v", "hvc1"});
}

void append_codec(std::vector<std::string> &arguments, const VideoOptions &options, const VideoEncoderChoice &choice) {
    append(arguments, {"-c:v", choice.name});
    if (choice.codec == "prores") {
        append(arguments, {"-profile:v", prores_profile(choice, options.quality)});
        if (!choice.hardware) append(arguments, {"-vendor", "apl0"});
        return;
    }
    if (choice.codec == "dnxhr") {
        append(arguments, {"-profile:v", dnxhr_profile(options.quality)});
        return;
    }
    if (choice.codec == "ffv1") {
        append(arguments, {"-level", "3", "-g", "1", "-slices", "16", "-slicecrc", "1"});
        return;
    }
    if (choice.codec == "png") return;
    // Editors seek to keyframes: every half second for Edit-ready, every two seconds otherwise.
    const int keyframes = options.quality == "edit" ? std::max(1, options.fps / 2) : options.fps * keyframe_seconds;
    append(arguments, {"-g", std::to_string(keyframes), "-bf", "0"});
    if (choice.hardware)
        append_hardware(arguments, options, choice.name);
    else
        append_software(arguments, options, choice.name);
}

bool usable_spec(const VideoEncoders &encoders, const VideoEncoderSpec &spec, const std::vector<std::string> &failed) {
    return encoders.has(spec.name) && std::find(failed.begin(), failed.end(), spec.name) == failed.end();
}

std::optional<VideoEncoderChoice>
pick(const VideoEncoders &encoders, std::string_view codec, bool hardware, const std::vector<std::string> &failed) {
    for (const auto &spec : video_encoder_specs) {
        if (spec.codec != codec || spec.hardware != hardware || !usable_spec(encoders, spec, failed)) continue;
        return VideoEncoderChoice{std::string(spec.name), std::string(spec.codec), spec.hardware, ""};
    }
    return std::nullopt;
}

std::vector<std::string> encode_arguments(
        const VideoOptions &options, const VideoEncoderChoice &choice, std::string_view program, uint64_t frames
) {
    std::vector<std::string> arguments = {std::string(program), "-hide_banner", "-loglevel", "error", "-nostdin", "-n"};
    if (ends_with(choice.name, "_vaapi")) append(arguments, {"-vaapi_device", vaapi_device});
    const std::string size = std::to_string(options.width) + "x" + std::to_string(options.height);
    append(arguments, {"-f", "rawvideo", "-pixel_format", "rgba", "-video_size", size});
    append(arguments, {"-framerate", std::to_string(options.fps), "-i", "pipe:0", "-an"});
    append(arguments, {"-frames:v", std::to_string(frames), "-vf", video_filter(choice, options.quality)});
    append_codec(arguments, options, choice);
    if (!rgb_output(choice.codec))
        append(arguments,
               {"-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"});
    return arguments;
}

}  // namespace

bool VideoEncoders::has(std::string_view name) const {
    return std::find(usable.begin(), usable.end(), name) != usable.end();
}

const VideoEncoderSpec *video_encoder_spec(std::string_view name) {
    for (const auto &spec : video_encoder_specs)
        if (spec.name == name) return &spec;
    return nullptr;
}

std::string_view video_codec_label(std::string_view codec) {
    if (codec == "h264") return "H.264";
    if (codec == "hevc") return "HEVC";
    if (codec == "av1") return "AV1";
    if (codec == "prores") return "ProRes";
    if (codec == "dnxhr") return "DNxHR";
    if (codec == "ffv1") return "FFV1 lossless";
    if (codec == "png") return "PNG sequence";
    return codec;
}

std::vector<std::string> listed_video_encoders(std::string_view output) {
    // Lines look like " V....D libx264              libx264 H.264 / AVC ...": flags, then the name.
    std::vector<std::string> names;
    size_t start = 0;
    while (start < output.size()) {
        const size_t end = std::min(output.find('\n', start), output.size());
        const auto line = output.substr(start, end - start);
        start = end + 1;
        const size_t flags = line.find_first_not_of(' ');
        if (flags == std::string_view::npos || line.size() < flags + 8 || line[flags + 6] != ' ') continue;
        const auto rest = line.substr(flags + 7);
        const size_t name_start = rest.find_first_not_of(' ');
        if (name_start == std::string_view::npos) continue;
        const auto name = rest.substr(name_start, rest.find(' ', name_start) - name_start);
        if (video_encoder_spec(name) || name == "aac") names.emplace_back(name);
    }
    return names;
}

std::optional<VideoEncoderChoice> choose_video_encoder(
        const VideoEncoders &encoders, const VideoOptions &options, const std::vector<std::string> &failed
) {
    // Auto prefers hardware: it is several times faster and frees the CPU for the game.
    const bool software_first = options.encoder == "software";
    if (auto preferred = pick(encoders, options.codec, !software_first, failed)) return preferred;
    const auto label = std::string(video_codec_label(options.codec));
    if (auto other = pick(encoders, options.codec, software_first, failed)) {
        if (options.encoder == "hardware") other->note = "No hardware " + label + " encoder here: software instead.";
        if (software_first) other->note = "No software " + label + " encoder here: hardware instead.";
        return other;
    }
    if (options.codec == "h264") return std::nullopt;
    auto fallback = pick(encoders, "h264", !software_first, failed);
    if (!fallback) fallback = pick(encoders, "h264", software_first, failed);
    if (fallback) fallback->note = "This FFmpeg has no " + label + " encoder: H.264 instead.";
    return fallback;
}

std::string video_extension(std::string_view codec) {
    if (codec == "prores" || codec == "dnxhr") return ".mov";
    if (codec == "ffv1") return ".mkv";
    if (codec == "png") return "";
    return ".mp4";
}

bool video_codec_is_image_sequence(std::string_view codec) {
    return codec == "png";
}

uint64_t video_bitrate(const VideoOptions &options) {
    double bits_per_pixel = high_bits_per_pixel;
    if (options.quality == "standard") bits_per_pixel = standard_bits_per_pixel;
    if (options.quality == "max") bits_per_pixel = max_bits_per_pixel;
    if (options.quality == "edit") bits_per_pixel = edit_bits_per_pixel;
    const double rate = double(options.width) * options.height * options.fps * bits_per_pixel;
    const uint64_t cap = options.quality == "edit" ? edit_max_bitrate : max_bitrate;
    return std::min(cap, uint64_t(std::llround(rate)));
}

std::vector<std::string> video_encode_arguments(
        const VideoOptions &options,
        const VideoEncoderChoice &choice,
        std::string_view program,
        const std::string &output,
        uint64_t frames
) {
    auto arguments = encode_arguments(options, choice, program, frames);
    if (video_codec_is_image_sequence(choice.codec)) {
        append(arguments, {"-f", "image2", "-start_number", "0"});
    } else if (video_extension(choice.codec) != ".mkv") {
        append(arguments, {"-video_track_timescale", std::to_string(video_track_timescale)});
        append(arguments, {"-movflags", "+faststart"});
    }
    arguments.push_back(output);
    return arguments;
}

std::vector<std::string> video_probe_arguments(
        const VideoEncoderChoice &choice, std::string_view program, int width, int height, uint64_t frames
) {
    VideoOptions options;
    options.width = width;
    options.height = height;
    options.fps = probe_frame_rate;
    options.codec = choice.codec;
    auto arguments = encode_arguments(options, choice, program, frames);
    append(arguments, {"-f", "null", "-"});
    return arguments;
}

std::vector<std::string> audio_mux_arguments(std::string_view codec) {
    if (codec == "prores" || codec == "dnxhr") return {"-c:a", "pcm_s16le"};
    if (codec == "ffv1") return {"-c:a", "flac"};
    return {"-c:a", "aac", "-b:a", "160k"};
}

nlohmann::json describe_video_encoders(const VideoEncoders &encoders) {
    auto codecs = nlohmann::json::array();
    for (const auto codec : video_codecs) {
        nlohmann::json entry = {{"id", codec}, {"label", video_codec_label(codec)}, {"software", ""}, {"hardware", ""}};
        for (const auto &spec : video_encoder_specs) {
            if (spec.codec != codec || !encoders.has(spec.name)) continue;
            auto &slot = entry[spec.hardware ? "hardware" : "software"];
            if (slot.get<std::string>().empty()) slot = spec.name;
        }
        codecs.push_back(std::move(entry));
    }
    return codecs;
}

}  // namespace native
