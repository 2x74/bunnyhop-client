#pragma once
#include <SDL3/SDL.h>
#include <nlohmann/json.hpp>
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
struct VideoOptions {int width=1280,height=720,fps=60;std::string quality="high",camera="eye";bool hud=true,audio=true;uint32_t from=0,to=0;double tick_interval=.01;
    bool full_recording = false;
    std::string music="none";double music_offset=0;float music_level=1;bool music_loop=true,music_duck=true;
    bool has_audio()const{return audio||music!="none";}
};
struct VideoTimeline {
    uint32_t from=0,to=0;double tick_interval=.01;int fps=60;uint64_t frames=0;
    static VideoTimeline make(const VideoOptions &options,uint32_t recording_ticks);
    double tick(uint64_t frame)const;
    double seconds()const{return double(to-from)*tick_interval;}
    static uint64_t sample_frame(double seconds,int sample_rate=22050);
    uint64_t audio_frames(int sample_rate=22050)const;
};
struct VideoAvailability {bool available=false;std::string reason,encoder="ffmpeg";};
// Real encoder process, never a shell. GL readback stays on the caller thread;
// a bounded queue of RGB frames keeps process I/O off the SDL event thread.
class NativeVideoExport {
    mutable std::mutex mutex,process_mutex;std::condition_variable ready;
    struct Packet {std::vector<uint8_t> rgb;std::vector<float> pcm;};
    std::deque<Packet> queue;std::thread worker;
    std::atomic_bool canceled=false,running=false;bool finished=false;
    SDL_Process *process=nullptr;
    VideoOptions options;std::filesystem::path destination,partial,video,pcm,log;
    std::string phase="idle",error;uint64_t submitted=0,written=0,total=0,audio_submitted=0,audio_total=0;
    void run(std::string encoder);
public:
    ~NativeVideoExport();
    static VideoAvailability probe(const std::string &encoder="ffmpeg");
    void start(const VideoOptions &options,const std::filesystem::path &output,uint64_t frames,const std::string &encoder="ffmpeg");
    bool busy()const{return running;}
    bool can_submit()const;
    // PCM uses the shared offline mixer's 22050 Hz interleaved stereo format.
    // Each packet is bounded; the worker spools it to disk before final muxing.
    bool submit(std::vector<uint8_t> rgb,std::vector<float> pcm={});
    void finish();void cancel();
    nlohmann::json status()const;
};
}
