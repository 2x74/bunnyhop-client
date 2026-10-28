#include "audio.hpp"
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <thread>
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>

static void settled(native::Music &music) {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(15);
    while (music.is_loading() && std::chrono::steady_clock::now() < deadline) {
        music.pump();
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
    assert(!music.is_loading());
}

int main(int argc, char **argv) {
    assert(argc == 2);
    const std::filesystem::path root = argv[1];
    std::ifstream input(root / "manifest.json");
    nlohmann::json manifest;
    input >> manifest;
    std::vector<native::MusicTrack> tracks;
    std::size_t total_frames = 0;
    for (const auto &entry : manifest.at("tracks")) {
        native::MusicTrack track{
                entry.at("id"), entry.at("title"), root / entry.at("file").get<std::string>(), entry.at("role")
        };
        native::DecodedMusic decoded;
        std::string error;
        assert(native::decode_music_file(track.file, &decoded, &error));
        assert(decoded.rate == 48000 && decoded.channels == 2);
        assert(std::abs(
                       double(decoded.samples.size()) / decoded.rate / decoded.channels
                       - entry.at("duration").get<double>()
               )
               < 0.1);
        assert(std::any_of(decoded.samples.begin(), decoded.samples.end(), [](auto value) { return value != 0; }));
        total_frames += decoded.samples.size() / 2;
        tracks.push_back(std::move(track));
    }
    assert(tracks.size() == 11 && total_frames > 60000000);
    SDL_SetHint(SDL_HINT_AUDIO_DRIVER, "dummy");
    {
        native::Music music;
        music.set_playlist(tracks, "missing");
        assert(music.is_loading() && music.is_playing());  // Incoming track shows Pause, not Play.
        // Pausing during asynchronous decode must survive the install.
        music.toggle();
        settled(music);
        assert(music.active() && !music.is_playing() && music.shown()->id == "menu-drift");
        music.set_playlist(tracks, "missing");
        assert(!music.is_playing());
        music.toggle();
        assert(music.is_playing());
        music.skip();
        assert(music.is_loading() && music.is_playing());
        music.set_scene(true);
        assert(!music.is_output_running());  // Pending Airstrafe must not hide installed Drift.
        music.toggle();
        music.toggle();
        assert(!music.is_output_running());
        settled(music);
        assert(music.shown()->id == "game-airstrafe" && music.is_playing());
        music.skip();
        settled(music);
        assert(music.shown()->id == "game-prestrafe" && music.is_crossfading());
        music.duck(.3f, 1.2);
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        music.pump();
        assert(music.duck_level() < .5f);
        music.previous();
        settled(music);
        assert(music.shown()->id == "game-airstrafe");
        music.toggle();
        music.set_scene(false);
        assert(!music.is_playing());
        music.previous();
        settled(music);
        assert(music.shown()->id == "menu-drift" && music.is_playing());
        music.silence();
        assert(!music.active() && !music.is_playing() && !music.is_loading());
        // Scene changes while the menu track is being decoded discard it.
        music.set_playlist(tracks, "missing");
        music.set_scene(true);
        settled(music);
        assert(music.shown()->role == "game");
        music.set_playlist({}, "empty pack");
        assert(!music.active() && music.status() == "empty pack");
    }
    // Multiple skip/crossfade decks must not leak subsystem references.
    assert(SDL_WasInit(SDL_INIT_AUDIO) == 0);
    SDL_Quit();
    {
        native::Audio disabled(root, root, false);
        disabled.set_music_pack(false);
        disabled.set_music_scene(true);
        for (const char *action : {"next", "toggle", "previous"})
            disabled.music_control(action);
        disabled.pump();
        assert(!disabled.music_state().at("available").get<bool>());
        assert(!disabled.music_state().at("playing").get<bool>());
        assert(SDL_WasInit(SDL_INIT_AUDIO) == 0);
    }
    std::cout << "OST: 11 full native decodes; pause, skip, previous, scene transition and disabled audio passed\n";
}
