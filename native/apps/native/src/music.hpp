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
// Two decoded decks allow a bounded crossfade. The next decode starts shortly
// before the current track ends; retired buffers are released on the main thread.
#include "audio_pack.hpp"
#include "music_envelope.hpp"
#include <SDL3/SDL.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <future>
#include <iostream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace native {

// A single bounded decoded song, sampled directly on the export clock. This
// never creates an SDL stream/device and never keeps a clip-length PCM buffer.
// Source time zero is the selected clip start; simulation pre-roll still advances
// the duck envelope so a trimmed clip preserves a preceding announcement's dip.
class OfflineMusic {
    DecodedMusic audio;
    MusicEnvelope envelope;
    uint64_t cursor=0,start=0,end=0;
    double offset=0;
    float level=.55f;
    bool looping=true,ducking=true;
public:
    void load(const MusicTrack &track,uint64_t clip_start,uint64_t clip_end,double seconds,float gain,bool loop,bool duck){
        if(!std::isfinite(seconds)||seconds<0||seconds>1800||!std::isfinite(gain)||gain<0||gain>1||clip_end<=clip_start)
            throw std::runtime_error("Invalid export music offset, level or clip bounds.");
        audio={};std::string error;
        if(!decode_music_file(track.file,&audio,&error))throw std::runtime_error("Cannot decode export music "+track.title+": "+error);
        if(audio.channels!=1&&audio.channels!=2){audio={};throw std::runtime_error("Export music must be mono or stereo.");}
        start=clip_start;end=clip_end;offset=seconds;level=.55f*gain;looping=loop;ducking=duck;reset();
    }
    void reset(){cursor=0;envelope={};}
    void duck(float depth,double hold){if(ducking)envelope.duck(depth,hold);}
    bool active()const{return audio.ok();}
    size_t decoded_samples()const{return audio.samples.size();}
    void mix(float *output,size_t count,int rate,float gain){
        if(!active())return;
        const auto frames=audio.samples.size()/audio.channels;
        const double duration=double(end-start)/rate,fade_in=std::min(.3,duration/4),fade_out=std::min(.5,duration/4);
        for(size_t i=0;i<count;++i,++cursor){
            const float duck=envelope.duck_gain;envelope.advance(1./rate);
            if(cursor<start||cursor>=end)continue;
            double position=(offset+double(cursor-start)/rate)*audio.rate;
            if(looping)position=std::fmod(position,double(frames));
            else if(position>=frames)continue;
            const size_t at=size_t(position),next=at+1<frames?at+1:looping?0:at;
            const double elapsed=double(cursor-start)/rate,left=double(end-1-cursor)/rate;
            const float fade=float(std::min({1.,elapsed/fade_in,left/fade_out}));
            for(int ch=0;ch<2;++ch){const int channel=audio.channels==1?0:ch;
                const float a=audio.samples[at*audio.channels+channel]/32768.f,b=audio.samples[next*audio.channels+channel]/32768.f;
                output[i*2+ch]+=(a+(b-a)*float(position-at))*level*gain*duck*fade;
            }
        }
    }
};

class Music {
    struct Loaded { DecodedMusic audio; MusicTrack track; std::string error; };

    SDL_AudioStream *stream = nullptr;std::atomic<SDL_AudioStream*> outgoing_stream{nullptr};
    DecodedMusic outgoing_audio;size_t outgoing_cursor=0;
    MusicEnvelope envelope;double pending_fade=1.2;
    std::chrono::steady_clock::time_point envelope_time=std::chrono::steady_clock::now();
    std::vector<MusicTrack> playlist;
    std::size_t index = 0, failures = 0;
    // Read by the audio callback; only ever changed under SDL_LockAudioStream.
    DecodedMusic playing;
    std::size_t cursor = 0;
    std::atomic_bool exhausted{false};
    std::future<Loaded> loading;
    std::string playing_title, playing_role, status_text;
    float volume = 0.65f, level = 0.55f;
    bool muted = false, enabled = false, held = false, gameplay = false,audio_initialized=false;

    static void SDLCALL callback(void *data, SDL_AudioStream *stream, int needed, int) {
        auto &self = *static_cast<Music *>(data);
        const bool outgoing=stream==self.outgoing_stream;
        auto &audio=outgoing?self.outgoing_audio:self.playing;
        auto &cursor=outgoing?self.outgoing_cursor:self.cursor;
        if (audio.samples.empty()) return;
        while (needed > 0) {
            if (cursor >= audio.samples.size()) {
                // The next track has to be decoded, which cannot happen here.
                // Flag it and let pump() on the main thread take over.
                if(!outgoing)self.exhausted = true;
                return;
            }
            const std::size_t available = audio.samples.size() - cursor;
            const std::size_t want = std::min(std::size_t(needed) / sizeof(std::int16_t), available);
            if (want == 0) return;
            SDL_PutAudioStreamData(stream, audio.samples.data() + cursor,
                                   int(want * sizeof(std::int16_t)));
            cursor += want;
            needed -= int(want * sizeof(std::int16_t));
        }
    }

    void advance_envelope(){const auto now=std::chrono::steady_clock::now();const double dt=std::chrono::duration<double>(now-envelope_time).count();envelope_time=now;envelope.advance(dt,held);}
    void apply_gain() {
        const float gain=muted?0.f:std::clamp(volume*level*envelope.duck_gain,0.f,1.f);
        if(stream)SDL_SetAudioStreamGain(stream,gain*envelope.incoming());
        if(outgoing_stream)SDL_SetAudioStreamGain(outgoing_stream,gain*envelope.outgoing());
    }

    void resume_allowed() {
        if (stream && enabled && !held && !playing.samples.empty() && !(gameplay && playing_role == "menu"))
            SDL_ResumeAudioStreamDevice(stream);
        if(outgoing_stream&&enabled&&!held&&envelope.fading())SDL_ResumeAudioStreamDevice(outgoing_stream);
    }
    void retire_outgoing(){if(outgoing_stream){SDL_DestroyAudioStream(outgoing_stream);outgoing_stream=nullptr;}outgoing_audio={};outgoing_cursor=0;}


    bool open() {
        if (stream) return true;
        // Own exactly one subsystem reference, not one per crossfade deck.
        if(!audio_initialized){if(!SDL_InitSubSystem(SDL_INIT_AUDIO)){status_text=SDL_GetError();return false;}audio_initialized=true;}
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
        retire_outgoing();
        if(stream){
            SDL_PauseAudioStreamDevice(stream);SDL_LockAudioStream(stream);
            outgoing_stream=stream;stream=nullptr;std::swap(outgoing_audio,playing);outgoing_cursor=cursor;cursor=0;
            SDL_UnlockAudioStream(outgoing_stream);
        }
        if (!open()) { retire_outgoing();stop_playback(status_text); return; }
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
        failures = 0;envelope.crossfade(outgoing_stream?pending_fade:.3);apply_gain();
        resume_allowed();
    }

    // Starts decoding the first playable track at or after |at|. Tracks with no
    // file are skipped here rather than failing: that is what a manifest entry
    // whose audio this build does not bundle looks like.
    void begin(std::size_t at, bool backwards = false) {
        if (playlist.empty()) return;
        // A new skip never leaves a third full decoded track resident.
        retire_outgoing();envelope.crossfade(0);apply_gain();
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
        retire_outgoing();if (!stream) return;
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
        retire_outgoing();if (stream) SDL_DestroyAudioStream(stream);
        if(audio_initialized)SDL_QuitSubSystem(SDL_INIT_AUDIO);
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
        exhausted = false;retire_outgoing();envelope.crossfade(0);
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
        advance_envelope();apply_gain();if(outgoing_stream&&!envelope.fading())retire_outgoing();
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
        if (!enabled || held || playlist.empty()) return;
        if(!exhausted){
            double left=1e9;if(stream){SDL_LockAudioStream(stream);if(playing.rate>0&&playing.channels>0)left=double(playing.samples.size()-std::min(cursor,playing.samples.size()))/playing.rate/playing.channels;SDL_UnlockAudioStream(stream);}
            if(left>3.5)return;
        }
        pending_fade=3;
        // A pack where nothing decodes would otherwise retry every track as
        // fast as the worker can fail. One full lap without a success stops.
        if (failures >= playlist.size()) {
            stop_playback("No track in this folder could be played.");
            return;
        }
        begin(index + 1);
        if (!loading.valid()) stop_playback("No track in this folder could be played.");
    }

    void duck(float depth=.35f,double hold=2.5){envelope.duck(depth,hold);}
    bool is_crossfading()const{return outgoing_stream&&envelope.fading();}
    float duck_level()const{return envelope.duck_gain;}
    void gain(float value) { volume = std::clamp(value, 0.0f, 1.0f); apply_gain(); }
    void mute(bool on) { muted = on; apply_gain(); }
    void skip() {
        if (!enabled || playlist.empty() || loading.valid()) return;
        held = false;pending_fade=1.2;
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
        } else {pending_fade=1.2;begin((index + playlist.size() - 1) % playlist.size(), true);}
    }
    void toggle() {
        if (!enabled || playlist.empty()) return;
        advance_envelope();held = !held;
        if (stream) {
            if (held) {SDL_PauseAudioStreamDevice(stream);if(outgoing_stream)SDL_PauseAudioStreamDevice(outgoing_stream);}
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
