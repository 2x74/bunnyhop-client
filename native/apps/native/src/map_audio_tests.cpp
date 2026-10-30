#include "map_audio_scene.hpp"
#include "data_location.hpp"
#include <atomic>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <new>
#include <stdexcept>

namespace {
std::atomic_size_t allocations = 0;
std::atomic_bool count_allocations = false;
size_t checks = 0;

void require(bool condition, const char *message) {
    ++checks;
    if (!condition) throw std::runtime_error(message);
}

void close(double actual, double expected, double tolerance = 1e-8) {
    require(std::isfinite(actual) && std::abs(actual - expected) <= tolerance * std::max(1., std::abs(expected)),
            "numeric web oracle mismatch");
}

using Json = nlohmann::json;
using namespace native;

std::vector<unsigned char> bytes(const std::filesystem::path &path) {
    std::ifstream stream(path, std::ios::binary);
    return {std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()};
}

void numeric_oracle(const Json &oracle) {
    for (const auto &row : oracle.at("levels"))
        require(map_sound_level(row.at("radius"), row.at("everywhere")) == row.at("level"), "sound level");
    for (const auto &row : oracle.at("falloff")) {
        close(map_reference_distance(row.at("level")), row.at("reference"));
        close(map_distance_gain(row.at("level"), row.at("distance")), row.at("gain"));
    }
    for (const auto &row : oracle.at("ramps")) {
        const auto actual = map_ambient_levels(row.at("entity"));
        const auto &expected = row.at("expected");
        close(actual.volume, expected.at("vol"));
        close(actual.volume_start, expected.at("volStart"));
        close(actual.fade_in, expected.at("fadeIn"));
        close(actual.fade_out, expected.at("fadeOut"));
        close(actual.pitch, expected.at("pitch"));
        close(actual.pitch_start, expected.at("pitchStart"));
        close(actual.spin_up, expected.at("spinUp"));
        close(actual.spin_down, expected.at("spinDown"));
    }
}

void positional_pan() {
    const auto diagonal = map_pan_gains({1, -1, 0}, {}, 0, 0);
    close(diagonal[0], std::cos(std::numbers::pi * 3 / 8), 1e-6);
    close(diagonal[1], std::sin(std::numbers::pi * 3 / 8), 1e-6);
    const auto rear = map_pan_gains({-1, -1, 0}, {}, 0, 0);
    close(rear[0], diagonal[0]);
    close(rear[1], diagonal[1]);
    const auto right = map_pan_gains({0, -1, 0}, {}, 0, 0);
    close(right[0], 0);
    close(right[1], 1);
}

void format_oracle(const Json &oracle, const std::filesystem::path &directory) {
    for (const auto &row : oracle.at("formats")) {
        const auto encoded = bytes(directory / row.at("name").get<std::string>());
        DecodedAudio decoded;
        std::string error;
        require(decode_sfx_bytes(encoded, &decoded, &error), "decoder rejected fixture");
        require(decoded.channels == row.at("channels") && decoded.rate == row.at("rate"), "decoder format");
        double energy = 0;
        for (float value : decoded.samples)
            energy += value * value;
        require(energy > 1, "decoded sound has no signal");
        if (row.at("samples").is_null()) {
            require(map_wave_loop(encoded).start == -1, "MP3 must not loop");
            continue;
        }
        const auto &expected = row.at("samples");
        const size_t frames = expected.at(0).size();
        require(decoded.samples.size() == frames * size_t(decoded.channels), "decoded frame count");
        double maximum_error = 0;
        for (size_t frame = 0; frame < frames; ++frame) {
            for (size_t channel = 0; channel < size_t(decoded.channels); ++channel) {
                const double value = expected.at(channel).at(frame);
                maximum_error =
                        std::max(maximum_error, std::abs(decoded.samples[frame * decoded.channels + channel] - value));
            }
        }
        require(maximum_error <= 1. / 32768, "PCM/ADPCM samples differ from web decoder");
    }
    for (const auto &row : oracle.at("loops")) {
        const auto loop = map_wave_loop(bytes(directory / row.at("name").get<std::string>()));
        require(loop.start == row.at("start") && loop.end == row.at("end"), "WAV loop metadata");
    }
    MapAudioFile file;
    file.audio = {{0, 1, 2, 3, 4, 5, 6, 7}, 1, 8};
    file.loop = {2, 6};
    close(map_loop_cursor(9, file), 5);
    close(map_loop_cursor(14, file), 2);
    DecodedAudio decoded;
    std::string error;
    require(!decode_sfx_bytes({1, 2, 3}, &decoded, &error), "malformed audio must be silent");
    require(!decode_sfx_bytes(bytes(directory / "pcm.wav"), &decoded, &error, 1), "decoded budget");
}

MapAudioFile loop_file(std::string path = "sound/a.wav", int channels = 1) {
    MapAudioFile file;
    file.path = std::move(path);
    file.audio.channels = channels;
    file.audio.rate = map_mixer_rate;
    file.audio.samples.assign(size_t(map_mixer_rate * channels), .25f);
    file.loop = {0, map_mixer_rate};
    return file;
}

size_t voices(const MapAudioMixer &mixer) {
    return size_t(std::count_if(mixer.voices.begin(), mixer.voices.end(), [](const auto &voice) {
        return voice.file && voice.sound != SIZE_MAX;
    }));
}

void render_tail(MapAudioMixer &mixer) {
    std::array<float, 2048> output{};
    for (int i = 0; i < 20; ++i)
        mixer.mix(output.data(), output.size() / 2, 1);
}

void voice_oracle(const Json &oracle) {
    auto scene = std::make_unique<MapAudioScene>();
    MapAudioMixer mixer;
    scene->files.push_back(loop_file());
    scene->build(oracle.at("many"), Json::array(), Json::object());
    double now = 0;
    for (const auto &row : oracle.at("voices")) {
        const MapPoint listener{row.at("listenerX"), 0, 0};
        now += .25;
        scene->assign(nullptr, mixer, listener, 0, now, .25, 1);
        std::vector<int> actual;
        for (const auto &voice : mixer.voices) {
            if (voice.file && voice.sound != SIZE_MAX) actual.push_back(scene->sounds[voice.sound].entity);
        }
        std::sort(actual.begin(), actual.end());
        require(actual == row.at("entities").get<std::vector<int>>(), "loudest 32 voices differ from web");
        require(actual.size() <= map_voice_limit, "map voice cap");
        render_tail(mixer);
    }
    scene->assign(nullptr, mixer, {}, 0, now, .25, 0);
    require(voices(mixer) == 0, "muted map has voices");
    render_tail(mixer);
    count_allocations = true;
    const size_t before = allocations;
    for (int i = 0; i < 1000; ++i) {
        scene->frame(nullptr, mixer, {}, 0, now + i * .25, true, 1);
        render_tail(mixer);
    }
    count_allocations = false;
    require(allocations == before, "map frame/mixer allocated heap memory");
}

Json ambient(std::string message, std::string flags = "0") {
    return {{"classname", "ambient_generic"},
            {"message", message},
            {"health", "10"},
            {"pitch", "100"},
            {"radius", "1250"},
            {"spawnflags", flags},
            {"origin", "0 0 0"}};
}

void state_and_exclusion() {
    auto scene = std::make_unique<MapAudioScene>();
    MapAudioMixer mixer;
    scene->files.push_back(loop_file());
    scene->build(
            Json::array({ambient("a.wav", "16"), ambient("music/song.mp3"), ambient("aoki/xfiles.wav")}),
            Json::array(),
            Json::object()
    );
    require(scene->ambient[1] == -1 && scene->ambient[2] == -1, "excluded emitter admitted");
    const auto update = [&](uint32_t flags, uint32_t starts, uint32_t stops, bool live = true) {
        const BhMapSoundState row{0, flags, starts, stops, -1, -1};
        scene->apply_state(mixer, {&row, 1}, 1, live);
        scene->assign(nullptr, mixer, {}, 0, 1, .25, 1);
    };
    update(5, 1, 0);
    require(voices(mixer) == 1, "map PlaySound");
    update(0, 1, 1);
    require(voices(mixer) == 0, "map StopSound");
    render_tail(mixer);
    update(5, 2, 1);
    require(voices(mixer) == 1, "map restart sound");
    update(2, 2, 1);
    require(voices(mixer) == 0, "map Kill");
    render_tail(mixer);
    update(1, 0, 0);
    require(voices(mixer) == 1, "seek resurrects loop");
    mixer.clear();
    scene->play_command(mixer, "play music/song.mp3", 1, true);
    scene->play_command(mixer, "play aoki/xfiles.wav", 1, true);
    scene->play_command(mixer, "play a.wav", 1, false);
    require(std::count_if(
                    scene->sounds.begin(),
                    scene->sounds.end(),
                    [](const auto &sound) { return sound.used && sound.transient; }
            ) == 0,
            "excluded or scrubbing command admitted");
    scene->play_command(mixer, "play *#SOUND\\A.WAV", 1, true);
    scene->assign(nullptr, mixer, {}, 0, 1, .25, 1);
    require(voices(mixer) == 2, "allowed command plays flat");
    scene->files[0].loop = {};
    mixer.clear();
    scene->assign(nullptr, mixer, {}, 0, 3, .25, 1);
    require(voices(mixer) == 0, "nonloop must finish");
}

void scapes_and_stereo() {
    auto scene = std::make_unique<MapAudioScene>();
    MapAudioMixer mixer;
    scene->files.push_back(loop_file());
    scene->files.push_back(loop_file("sound/stereo.wav", 2));
    scene->files.push_back(loop_file("sound/b.wav"));
    scene->files.back().loop = {};
    Json group = {
            {"scapes",
             {{"outdoor",
               {{"loops", Json::array({{{"wave", "sound/a.wav"}, {"volume", {1, 0}}, {"pitch", {100, 0}}}})},
                {"randoms", Json::array()},
                {"subs", Json::array({{{"name", "sub"}, {"volume", {.5, 0}}}})}}},
              {"sub",
               {{"loops",
                 Json::array(
                         {{{"wave", "sound/stereo.wav"}, {"volume", {1, 0}}, {"pitch", {100, 0}}},
                          {{"wave", "sound/aoki/xfiles.wav"}, {"volume", {1, 0}}, {"pitch", {100, 0}}}}
                 )},
                {"randoms",
                 Json::array(
                         {{{"waves", {"sound/b.wav", "sound/aoki/xfiles.wav"}},
                           {"time", {1, 0}},
                           {"volume", {.25, 0}},
                           {"pitch", {100, 0}},
                           {"position", "random"}}}
                 )},
                {"subs", Json::array()}}}}}
    };
    scene->build(Json::array({{{"classname", "env_soundscape"}, {"soundscape", "outdoor"}}}), Json::array(), group);
    require(scene->scapes.size() == 1 && scene->scapes[0].loops.size() == 2, "nested scapes filter exclusions");
    require(scene->scapes[0].randoms[0].files.size() == 1, "random scape filters exclusions");
    scene->current_scape = 0;
    scene->start_scape(mixer, 0, 0);
    scene->assign(nullptr, mixer, {}, 0, .25, .25, 1);
    close(scene->sounds[0].volume, .25 / map_scape_fade_seconds);
    scene->assign(nullptr, mixer, {}, 0, 3, 3, 1);
    close(scene->sounds[0].volume, 1);
    close(scene->sounds[1].volume, .5);
    scene->tick_scapes(nullptr, mixer, {}, 3);
    require(std::any_of(
                    scene->sounds.begin(),
                    scene->sounds.end(),
                    [](const auto &sound) { return sound.used && sound.transient; }
            ),
            "soundscape random cue");
    scene->start_scape(mixer, -1, 3);
    scene->assign(nullptr, mixer, {}, 0, 7, 4, 1);
    require(voices(mixer) == 0, "soundscape fades out in three seconds");
    scene = std::make_unique<MapAudioScene>();
    mixer.clear();
    scene->files.push_back(loop_file("sound/stereo.wav", 2));
    auto entity = ambient("stereo.wav");
    entity["origin"] = "0 1000 0";
    scene->build(Json::array({entity}), Json::array(), Json::object());
    scene->assign(nullptr, mixer, {}, 0, 0, 0, 1);
    close(mixer.voices[0].target_left, map_distance_gain(70, 1000), 1e-6);
    close(mixer.voices[0].target_left, mixer.voices[0].target_right);
}

void scape_oracle(const std::filesystem::path &directory) {
    std::ifstream stream(directory / "scapes.json");
    const auto oracle = Json::parse(stream);
    auto scene = std::make_unique<MapAudioScene>();
    MapAudioMixer mixer;
    scene->files.push_back(loop_file());
    scene->files.push_back(loop_file("sound/b.wav"));
    scene->files.back().loop = {};
    scene->files.back().audio.samples.resize(size_t(map_mixer_rate / 5));
    scene->build(oracle.at("entities"), Json::array(), oracle.at("group"));
    scene->current_scape = 0;
    scene->start_scape(mixer, 0, .25);
    double previous = .25;
    for (const auto &row : oracle.at("frames")) {
        const double now = row.at("now");
        scene->tick_scapes(nullptr, mixer, {}, now);
        scene->assign(nullptr, mixer, {}, 0, now, now - previous, 1);
        previous = now;
        std::vector<const MapAudioMixer::Voice *> active;
        for (const auto &voice : mixer.voices)
            if (voice.file && voice.sound != SIZE_MAX) active.push_back(&voice);
        std::sort(active.begin(), active.end(), [](const auto *first, const auto *second) {
            return first->target_rate < second->target_rate;
        });
        require(active.size() == row.at("voices").size(), "soundscape voice count differs from web");
        for (size_t i = 0; i < active.size(); ++i) {
            const auto &sound = scene->sounds[active[i]->sound];
            const auto &expected = row.at("voices").at(i);
            require(active[i]->file->path == expected.at("path").get<std::string>(),
                    "soundscape wave differs from web");
            close(sound.volume, expected.at("volume"));
            close(active[i]->target_rate, expected.at("rate"));
            close(sound.level, expected.at("level"));
            for (size_t axis = 0; axis < 3; ++axis)
                close(sound.position[axis], expected.at("position").at(axis), 1e-6);
        }
        render_tail(mixer);
    }
}

void moving_listener() {
    auto scene = std::make_unique<MapAudioScene>();
    MapAudioMixer mixer;
    scene->files.push_back(loop_file());
    auto emitter = ambient("a.wav");
    emitter["origin"] = "1 -1 0";
    scene->build(Json::array({emitter}), Json::array(), Json::object());
    scene->frame(nullptr, mixer, {}, 0, 0, true, 1);
    const float first_left = mixer.voices[0].target_left;
    const float first_right = mixer.voices[0].target_right;
    scene->frame(nullptr, mixer, {}, 180, .01, true, 1);
    close(mixer.voices[0].target_left, first_right);
    close(mixer.voices[0].target_right, first_left);
}

void progressive_files() {
    auto scene = std::make_unique<MapAudioScene>();
    MapAudioMixer mixer;
    scene->files.push_back(MapAudioFile{"sound/a.wav", {}, {}});
    scene->file_ready[0] = false;
    scene->file_seen[0] = false;
    scene->build(Json::array({ambient("a.wav")}), Json::array(), Json::object());
    scene->assign(nullptr, mixer, {}, 0, 20, .25, 1);
    require(voices(mixer) == 0, "pending decode acquired a voice");
    scene->files[0].audio = loop_file().audio;
    scene->file_ready[0].store(true, std::memory_order_release);
    scene->assign(nullptr, mixer, {}, 0, 21, .25, 1);
    require(voices(mixer) == 1, "completed decode did not acquire a voice");
    close(scene->sounds[0].started, 21);
}

}  // namespace

void *operator new(std::size_t size) {
    if (count_allocations) ++allocations;
    if (void *memory = std::malloc(size ? size : 1)) return memory;
    throw std::bad_alloc();
}

void operator delete(void *memory) noexcept {
    std::free(memory);
}

void operator delete(void *memory, std::size_t) noexcept {
    std::free(memory);
}

void operator delete[](void *memory, std::size_t) noexcept {
    std::free(memory);
}

void *operator new[](std::size_t size) {
    return ::operator new(size);
}

void operator delete[](void *memory) noexcept {
    std::free(memory);
}

int main(int argc, char **argv) {
    try {
        require(argc == 2, "pass oracle directory");
        const auto directory = data_location::from_utf8(argv[1]);
        std::ifstream stream(directory / "oracle.json");
        const auto oracle = Json::parse(stream);
        numeric_oracle(oracle);
        positional_pan();
        format_oracle(oracle, directory);
        voice_oracle(oracle);
        state_and_exclusion();
        scapes_and_stereo();
        scape_oracle(directory);
        progressive_files();
        moving_listener();
        std::cout << "Map audio: " << checks << " checks passed; 1000 frames/mixes allocated 0 times\n";
    } catch (const std::exception &error) {
        std::cerr << "Map audio after " << checks << " checks: " << error.what() << '\n';
        return 1;
    }
}
