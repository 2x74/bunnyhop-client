#pragma once
// Background music.
//
// Deliberately separate from Audio's effect mixer. An effect is a few hundred
// milliseconds, mono, and already at the mixer's rate, so it can be held
// decoded and mixed by hand. A track is minutes long, stereo, and at whatever
// rate it was encoded at, and decoding one takes long enough that it cannot
// happen anywhere near the callback that has to answer the device every few
// milliseconds. So music gets its own stream, SDL does the rate and channel
// conversion, and the decode runs on a worker thread.
//
// Tracks are not prefetched, so there is a short gap between them while the
// next one decodes. Prefetching would mean holding two decoded tracks at once,
// which is the difference between 60 MB and 120 MB of resident audio for the
// benefit of a gap most players will read as the gap between two songs.
#include "audio_pack.hpp"
#include <SDL3/SDL.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <future>
#include <iostream>
#include <string>
#include <utility>
#include <vector>

namespace native {

class Music {
    struct Loaded { DecodedMusic audio; MusicTrack track; std::string error; };

    SDL_AudioStream *stream = nullptr;
    std::vector<MusicTrack> playlist;
    std::size_t index = 0, failures = 0;
    // Read by the audio callback; only ever changed under SDL_LockAudioStream.
    DecodedMusic playing;
    std::size_t cursor = 0;
    std::atomic_bool exhausted{false};
    std::future<Loaded> loading;
    std::string playing_title, playing_role, status_text;
    float volume = 0.65f, level = 0.55f;
    bool muted = false, enabled = false, held = false, gameplay = false;

    static void SDLCALL callback(void *data, SDL_AudioStream *stream, int needed, int) {
        auto &self = *static_cast<Music *>(data);
        if (self.playing.samples.empty()) return;
        while (needed > 0) {
            if (self.cursor >= self.playing.samples.size()) {
                // The next track has to be decoded, which cannot happen here.
                // Flag it and let pump() on the main thread take over.
                self.exhausted = true;
                return;
            }
            const std::size_t available = self.playing.samples.size() - self.cursor;
            const std::size_t want = std::min(std::size_t(needed) / sizeof(std::int16_t), available);
            if (want == 0) return;
            SDL_PutAudioStreamData(stream, self.playing.samples.data() + self.cursor,
                                   int(want * sizeof(std::int16_t)));
            self.cursor += want;
            needed -= int(want * sizeof(std::int16_t));
        }
    }

    void apply_gain() {
        if (stream) SDL_SetAudioStreamGain(stream, muted ? 0.0f : std::clamp(volume * level, 0.0f, 1.0f));
    }

    void resume_allowed() {
        if (stream && enabled && !held && !playing.samples.empty() && !(gameplay && playing_role == "menu"))
            SDL_ResumeAudioStreamDevice(stream);
    }

    bool open() {
        if (stream) return true;
        if (!SDL_InitSubSystem(SDL_INIT_AUDIO)) { status_text = SDL_GetError(); return false; }
        // A placeholder spec: every track resets the format to its own before
        // any of its samples are queued.
        SDL_AudioSpec spec{SDL_AUDIO_S16, 2, 44100};
        stream = SDL_OpenAudioDeviceStream(SDL_AUDIO_DEVICE_DEFAULT_PLAYBACK, &spec, callback, this);
        if (!stream) { status_text = SDL_GetError(); return false; }
        apply_gain();
        return true;
    }

    void install(Loaded &&loaded) {
        if (!loaded.audio.ok()) {
            status_text = loaded.track.title + " " + (loaded.error.empty() ? "could not be decoded" : loaded.error);
            std::cerr << "Music: " << status_text << '\n';
            ++failures;
            exhausted = true;  // a bad file must not stall the playlist on itself
            return;
        }
        if (!open()) { stop_playback(status_text); return; }
        SDL_PauseAudioStreamDevice(stream);
        const SDL_AudioSpec spec{SDL_AUDIO_S16, loaded.audio.channels, loaded.audio.rate};
        SDL_LockAudioStream(stream);
        // Swapped rather than assigned so the outgoing track's buffer — tens of
        // megabytes — is freed when |loaded| dies below, outside the lock,
        // instead of making the audio thread wait on the allocator.
        std::swap(playing, loaded.audio);
        cursor = 0;
        exhausted = false;
        SDL_SetAudioStreamFormat(stream, &spec, nullptr);
        SDL_UnlockAudioStream(stream);
        SDL_ClearAudioStream(stream);
        playing_title = loaded.track.title;
        playing_role = loaded.track.role;
        status_text.clear();
        failures = 0;
        resume_allowed();
    }

    // Starts decoding the first playable track at or after |at|. Tracks with no
    // file are skipped here rather than failing: that is what a manifest entry
    // whose audio this build does not bundle looks like.
    void begin(std::size_t at, bool backwards = false) {
        if (playlist.empty()) return;
        for (std::size_t step = 0; step < playlist.size(); ++step) {
            const std::size_t candidate = backwards ? (at + playlist.size() - step) % playlist.size() : (at + step) % playlist.size();
            if (playlist[candidate].file.empty() || (gameplay && playlist[candidate].role == "menu")) continue;
            index = candidate;
            const MusicTrack track = playlist[index];
            loading = std::async(std::launch::async, [track] {
                Loaded loaded;
                loaded.track = track;
                decode_music_file(track.file, &loaded.audio, &loaded.error);
                return loaded;
            });
            return;
        }
    }

    void stop_playback(const std::string &reason) {
        enabled = false;
        status_text = reason;
        playing_title.clear();
        playing_role.clear();
        if (!stream) return;
        SDL_PauseAudioStreamDevice(stream);
    }

public:
    Music() = default;
    Music(const Music &) = delete;
    Music &operator=(const Music &) = delete;
    ~Music() {
        // The worker captures its track by value and touches nothing here, but
        // it does own the buffer it is decoding into, so it is joined rather
        // than abandoned.
        if (loading.valid()) loading.wait();
        if (stream) SDL_DestroyAudioStream(stream);
    }

    // Replacing the playlist restarts from its first track; setting the same
    // one again is a no-op, so re-applying settings does not restart the music.
    // An empty playlist is a normal state — it is what "no custom music added
    // yet" looks like — and |empty_reason| is what the menu will show for it.
    void set_playlist(std::vector<MusicTrack> tracks, const std::string &empty_reason) {
        const bool same = enabled && tracks.size() == playlist.size() &&
            std::equal(tracks.begin(), tracks.end(), playlist.begin(),
                       [](const MusicTrack &a, const MusicTrack &b) { return a.id == b.id && a.file == b.file && a.role == b.role; });
        if (same) return;
        silence();
        playlist = std::move(tracks);
        enabled = true;
        failures = 0;
        if (playlist.empty()) { stop_playback(empty_reason); return; }
        status_text.clear();
        begin(0);
        if (!loading.valid()) stop_playback(empty_reason);
    }

    void silence() {
        enabled = false;
        held = false;
        playlist.clear();
        playing_title.clear();
        playing_role.clear();
        status_text.clear();
        failures = 0;
        if (loading.valid()) loading.wait();
        loading = {};
        exhausted = false;
        if (!stream) return;
        DecodedMusic released;
        SDL_LockAudioStream(stream);
        std::swap(playing, released);
        cursor = 0;
        SDL_UnlockAudioStream(stream);
        SDL_ClearAudioStream(stream);
        SDL_PauseAudioStreamDevice(stream);
    }

    // Called once a frame from the main thread: everything that cannot happen
    // on the audio thread happens here.
    void pump() {
        if (loading.valid()) {
            if (loading.wait_for(std::chrono::seconds(0)) != std::future_status::ready) return;
            auto loaded = loading.get();
            loading = {};
            // A scene can change while decoding. Never install a stale menu
            // track over gameplay, and never wait for the decoder in an input handler.
            if (gameplay && loaded.track.role == "menu") {
                begin(index + 1);
                if (!loading.valid()) stop_playback("No gameplay music in this pack.");
                return;
            }
            install(std::move(loaded));
            return;
        }
        if (!enabled || held || playlist.empty() || !exhausted) return;
        // A pack where nothing decodes would otherwise retry every track as
        // fast as the worker can fail. One full lap without a success stops.
        if (failures >= playlist.size()) {
            stop_playback("No track in this folder could be played.");
            return;
        }
        begin(index + 1);
        if (!loading.valid()) stop_playback("No track in this folder could be played.");
    }

    void gain(float value) { volume = std::clamp(value, 0.0f, 1.0f); apply_gain(); }
    void mute(bool on) { muted = on; apply_gain(); }
    void skip() {
        if (!enabled || playlist.empty() || loading.valid()) return;
        held = false;
        begin(index + 1);
    }
    void previous() {
        if (!enabled || playlist.empty() || loading.valid()) return;
        held = false;
        bool restart = false;
        if (stream) {
            SDL_LockAudioStream(stream);
            restart = playing.rate > 0 && playing.channels > 0 &&
                double(cursor) / playing.rate / playing.channels > 4.0;
            SDL_UnlockAudioStream(stream);
        }
        if (restart) {
            SDL_PauseAudioStreamDevice(stream);
            SDL_LockAudioStream(stream);
            cursor = 0;
            exhausted = false;
            SDL_UnlockAudioStream(stream);
            SDL_ClearAudioStream(stream);
            resume_allowed();
        } else begin((index + playlist.size() - 1) % playlist.size(), true);
    }
    void toggle() {
        if (!enabled || playlist.empty()) return;
        held = !held;
        if (stream) {
            if (held) SDL_PauseAudioStreamDevice(stream);
            else resume_allowed();
        }
    }
    void set_scene(bool in_game) {
        if (gameplay == in_game) return;
        gameplay = in_game;
        // index names the pending track during a skip; the device can still
        // contain the previous one. Gate the installed track independently.
        if (stream && gameplay && playing_role == "menu") SDL_PauseAudioStreamDevice(stream);
        if (enabled && gameplay && !playlist.empty() && playlist[index].role == "menu" && !loading.valid()) {
            if (stream) SDL_PauseAudioStreamDevice(stream);
            begin(index + 1);
            if (!loading.valid()) stop_playback("No gameplay music in this pack.");
        }
    }
    bool active() const { return enabled && !playlist.empty(); }
    bool is_loading() const { return loading.valid(); }
    // Like a media element's paused flag, controls reflect playback intent
    // while buffering. Otherwise a visible Play button would toggle to pause.
    bool is_playing() const { return active() && !held && (loading.valid() || is_output_running()); }
    bool is_output_running() const { return stream && !SDL_AudioDevicePaused(SDL_GetAudioStreamDevice(stream)); }
    const MusicTrack *shown() const { return active() ? &playlist[index] : nullptr; }
    const std::string &title() const { return playing_title; }
    const std::string &status() const { return status_text; }
};

}  // namespace native
