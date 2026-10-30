#pragma once
#include <nlohmann/json.hpp>
#include <array>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace native {

struct VideoOptions;

// One FFmpeg encoder the exporter can drive. Within a codec the list is in order of preference.
struct VideoEncoderSpec {
    std::string_view name;
    std::string_view codec;
    bool hardware;
};

// clang-format off
inline constexpr std::array<VideoEncoderSpec, 23> video_encoder_specs = {{
        {"h264_videotoolbox", "h264", true},  {"h264_nvenc", "h264", true},  {"h264_qsv", "h264", true},
        {"h264_amf", "h264", true},           {"h264_vaapi", "h264", true},  {"libx264", "h264", false},
        {"hevc_videotoolbox", "hevc", true},  {"hevc_nvenc", "hevc", true},  {"hevc_qsv", "hevc", true},
        {"hevc_amf", "hevc", true},           {"hevc_vaapi", "hevc", true},  {"libx265", "hevc", false},
        {"av1_nvenc", "av1", true},           {"av1_qsv", "av1", true},      {"av1_amf", "av1", true},
        {"av1_vaapi", "av1", true},           {"libsvtav1", "av1", false},   {"libaom-av1", "av1", false},
        {"prores_videotoolbox", "prores", true}, {"prores_ks", "prores", false},
        {"dnxhd", "dnxhr", false},            {"ffv1", "ffv1", false},       {"png", "png", false},
}};
// clang-format on

inline constexpr std::array<std::string_view, 7> video_codecs = {
        "h264", "hevc", "av1", "prores", "dnxhr", "ffv1", "png"
};

// What the installed FFmpeg can actually encode with: hardware encoders are listed only after a test encode.
struct VideoEncoders {
    std::string program;
    std::vector<std::string> usable;
    bool aac = false;

    bool has(std::string_view name) const;
};

struct VideoEncoderChoice {
    std::string name;
    std::string codec;
    bool hardware = false;
    // Why this isn't what the player asked for, shown with the result.
    std::string note;
};

const VideoEncoderSpec *video_encoder_spec(std::string_view name);
std::string_view video_codec_label(std::string_view codec);
// Encoder names from `ffmpeg -encoders`.
std::vector<std::string> listed_video_encoders(std::string_view ffmpeg_output);
// The encoder for the options' codec and encoder preference, or another codec's when FFmpeg has none for it.
std::optional<VideoEncoderChoice> choose_video_encoder(
        const VideoEncoders &encoders, const VideoOptions &options, const std::vector<std::string> &failed = {}
);
// ".mp4", ".mov" or ".mkv"; empty for an image sequence, which is a folder.
std::string video_extension(std::string_view codec);
bool video_codec_is_image_sequence(std::string_view codec);
// Target bits per second for encoders that take a bitrate (the website's bits per pixel per frame).
uint64_t video_bitrate(const VideoOptions &options);
std::vector<std::string> video_encode_arguments(
        const VideoOptions &options,
        const VideoEncoderChoice &choice,
        std::string_view program,
        const std::string &output,
        uint64_t frames
);
// A test encode to FFmpeg's null output: does this encoder work here at this size?
std::vector<std::string> video_probe_arguments(
        const VideoEncoderChoice &choice, std::string_view program, int width, int height, uint64_t frames
);
std::vector<std::string> audio_mux_arguments(std::string_view codec);
// Codecs as the export dialog lists them: whether software and hardware encoders exist for each.
nlohmann::json describe_video_encoders(const VideoEncoders &encoders);

}  // namespace native
