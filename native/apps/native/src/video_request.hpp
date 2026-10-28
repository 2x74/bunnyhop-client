#pragma once
#include "video_export.hpp"

namespace native {

inline VideoOptions parse_video_options(const nlohmann::json &value) {
    VideoOptions options;
    options.width = value.at("width");
    options.height = value.at("height");
    options.fps = value.at("fps");
    options.quality = value.at("quality");
    options.camera = value.at("camera");
    options.hud = value.at("hud");
    options.audio = value.value("audio", true);
    options.music = value.value("music", std::string("none"));
    options.music_offset = value.value("musicOffset", 0.);
    options.music_level = value.value("musicLevel", 1.f);
    options.music_loop = value.value("musicLoop", true);
    options.music_duck = value.value("musicDuck", true);
    options.from = value.value("from", 0u);
    options.to = value.value("to", 0u);
    options.full_recording = value.value("fullRecording", false);
    return options;
}

}  // namespace native
