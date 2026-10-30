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
    options.codec = value.value("codec", options.codec);
    options.encoder = value.value("encoder", options.encoder);
    options.look = value.value("look", options.look);
    options.supersample = value.value("supersample", options.supersample);
    options.samples = value.value("samples", options.samples);
    options.shutter_degrees = value.value("shutter", options.shutter_degrees);
    options.speed = value.value("speed", options.hud);
    options.keys = value.value("keys", options.hud);
    options.graph = value.value("graph", options.graph);
    options.crosshair = value.value("crosshair", options.crosshair);
    options.weapon = value.value("weapon", options.weapon);
    options.audio = value.value("audio", true);
    options.audio_file = value.value("audioFile", false);
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

inline nlohmann::json video_options_json(const VideoOptions &options) {
    return {{"width", options.width},
            {"height", options.height},
            {"fps", options.fps},
            {"quality", options.quality},
            {"camera", options.camera},
            {"hud", options.hud},
            {"codec", options.codec},
            {"encoder", options.encoder},
            {"look", options.look},
            {"supersample", options.supersample},
            {"samples", options.samples},
            {"shutter", options.shutter_degrees},
            {"speed", options.speed},
            {"keys", options.keys},
            {"graph", options.graph},
            {"crosshair", options.crosshair},
            {"weapon", options.weapon},
            {"audio", options.audio},
            {"audioFile", options.audio_file},
            {"music", options.music},
            {"musicOffset", options.music_offset},
            {"musicLevel", options.music_level},
            {"musicLoop", options.music_loop},
            {"musicDuck", options.music_duck},
            {"from", options.from},
            {"to", options.to},
            {"fullRecording", options.full_recording}};
}

}  // namespace native
