#include "data_location.hpp"
#include "video_export.hpp"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <fstream>
#include <iterator>
#include <stdexcept>
namespace native {
VideoTimeline VideoTimeline::make(const VideoOptions &o,uint32_t ticks){
    if((o.width!=1280||o.height!=720)&&(o.width!=1920||o.height!=1080)&&(o.width!=2560||o.height!=1440)&&(o.width!=720||o.height!=1280)&&(o.width!=1080||o.height!=1920)&&(o.width!=1440||o.height!=2560))throw std::runtime_error("Choose 720p, 1080p or 1440p landscape/portrait.");
    if(o.fps!=30&&o.fps!=60&&o.fps!=120)throw std::runtime_error("Video FPS must be 30, 60 or 120.");
    if(o.camera!="eye"&&o.camera!="chase"&&o.camera!="flyby"&&o.camera!="auto")throw std::runtime_error("Choose eye, chase, flyby or auto camera.");
    if(o.quality!="standard"&&o.quality!="high"&&o.quality!="max")throw std::runtime_error("Unknown video quality.");
    if(o.music.empty()||o.music.size()>256||!std::isfinite(o.music_offset)||o.music_offset<0||o.music_offset>1800||!std::isfinite(o.music_level)||o.music_level<0||o.music_level>1)throw std::runtime_error("Invalid export music settings.");
    if(!std::isfinite(o.tick_interval)||o.tick_interval<=0||o.tick_interval>1||o.from>=o.to||o.to>ticks)throw std::runtime_error("Invalid video clip bounds.");
    const double seconds=(o.to-o.from)*o.tick_interval;if(seconds>1800)throw std::runtime_error("Export clips must be at most 30 minutes.");
    VideoTimeline result{o.from,o.to,o.tick_interval,o.fps,uint64_t(std::ceil(seconds*o.fps-1e-8))};return result;
}
uint64_t VideoTimeline::sample_frame(double seconds,int sample_rate){return uint64_t(std::llround(seconds*sample_rate+1e-8));}
uint64_t VideoTimeline::audio_frames(int sample_rate)const{return sample_frame(seconds(),sample_rate);}
double VideoTimeline::tick(uint64_t frame)const{return std::min(double(to),double(from)+double(frame)/(fps*tick_interval));}
VideoAvailability NativeVideoExport::probe(const std::string &encoder){
    std::vector<std::string> candidates={encoder};
#ifdef __APPLE__
    // Finder-launched apps may not inherit Homebrew's shell PATH.
    if(encoder=="ffmpeg")for(const char *path:{"/opt/homebrew/bin/ffmpeg","/usr/local/bin/ffmpeg"})if(std::filesystem::is_regular_file(path))candidates.emplace_back(path);
#endif
    bool found=false;
    for(const auto &candidate:candidates){const char *args[]={candidate.c_str(),"-hide_banner","-encoders",nullptr};auto *child=SDL_CreateProcess(args,true);if(!child)continue;found=true;
        if(auto *in=SDL_GetProcessInput(child))SDL_CloseIO(in);size_t size=0;int code=-1;auto *bytes=SDL_ReadProcess(child,&size,&code);std::string output;if(bytes){output.assign(static_cast<char*>(bytes),std::min(size,size_t(1<<20)));SDL_free(bytes);}SDL_DestroyProcess(child);
        if(!code&&output.find("libx264")!=std::string::npos&&output.find(" aac ")!=std::string::npos)return {true,"",candidate};
    }
    return {false,found?"FFmpeg must include the libx264 H.264 and AAC encoders.":"FFmpeg is not available on PATH. Install FFmpeg with the libx264 and AAC encoders.",encoder};
}
NativeVideoExport::~NativeVideoExport(){cancel();if(worker.joinable())worker.join();}
void NativeVideoExport::start(const VideoOptions &o,const std::filesystem::path &output,uint64_t frames,const std::string &encoder){
    if(running)throw std::runtime_error("A video export is already running.");if(worker.joinable())worker.join();
    if(o.width<2||o.height<2||o.width>2560||o.height>2560||o.width%2||o.height%2||(o.fps!=30&&o.fps!=60&&o.fps!=120)||frames<1||frames>216001)throw std::runtime_error("Invalid video dimensions or frame count.");
    if(output.extension()!=".mp4"||!output.is_absolute()||!std::filesystem::is_directory(output.parent_path()))throw std::runtime_error("Choose an existing output directory and an MP4 filename.");
    if(std::filesystem::exists(output))throw std::runtime_error("Video output already exists; choose a different filename.");
    if(o.music.empty()||o.music.size()>256||!std::isfinite(o.music_offset)||o.music_offset<0||o.music_offset>1800||!std::isfinite(o.music_level)||o.music_level<0||o.music_level>1)throw std::runtime_error("Invalid export music settings.");
    if(!std::isfinite(o.tick_interval)||o.tick_interval<=0||o.from>=o.to||(o.to-o.from)*o.tick_interval>1800)throw std::runtime_error("Invalid video clip bounds.");
    if(frames!=uint64_t(std::ceil((o.to-o.from)*o.tick_interval*o.fps-1e-8)))throw std::runtime_error("Video frame count does not match clip duration.");
    static std::atomic_uint64_t serial=0;const auto nonce=std::to_string(std::chrono::steady_clock::now().time_since_epoch().count())+"-"+std::to_string(++serial);
    {std::lock_guard lock(mutex);options=o;destination=output;partial=output.parent_path()/(".bunnyhop-"+nonce+".partial.mp4");video=output.parent_path()/(".bunnyhop-"+nonce+".video.mp4");pcm=output.parent_path()/(".bunnyhop-"+nonce+".f32");log=output.parent_path()/(".bunnyhop-"+nonce+".log");queue.clear();submitted=written=audio_submitted=0;total=frames;audio_total=o.has_audio()?VideoTimeline::sample_frame((o.to-o.from)*o.tick_interval):0;phase="capturing";error.clear();finished=false;canceled=false;running=true;}
    try{worker=std::thread([this,encoder]{run(encoder);});}catch(...){running=false;std::lock_guard lock(mutex);phase="error";error="Cannot create the video encoder worker.";throw;}
}
bool NativeVideoExport::can_submit()const{std::lock_guard lock(mutex);return running&&!canceled&&!finished&&phase=="capturing"&&queue.size()<3&&submitted<total;}
bool NativeVideoExport::submit(std::vector<uint8_t> rgb,std::vector<float> samples){
    std::lock_guard lock(mutex);if(!running||canceled||finished||phase!="capturing"||queue.size()>=3||submitted>=total)return false;
    if(rgb.size()!=size_t(options.width)*options.height*3)throw std::runtime_error("Video frame has the wrong byte size.");
    if(samples.size()%2||samples.size()>22050*4||audio_submitted+samples.size()/2>audio_total)throw std::runtime_error("Video audio packet has the wrong sample count.");
    for(float v:samples)if(!std::isfinite(v))throw std::runtime_error("Video audio contains non-finite samples.");
    audio_submitted+=samples.size()/2;queue.push_back({std::move(rgb),std::move(samples)});++submitted;ready.notify_one();return true;
}
void NativeVideoExport::finish(){std::lock_guard lock(mutex);if(!running)return;if(submitted!=total||audio_submitted!=audio_total)throw std::runtime_error("Cannot finish before every video frame and audio sample is captured.");finished=true;phase="encoding";ready.notify_one();}
void NativeVideoExport::cancel(){{std::lock_guard lock(mutex);if(!running||phase=="completed")return;canceled=true;}ready.notify_all();std::lock_guard lock(process_mutex);if(process)SDL_KillProcess(process,true);}
nlohmann::json NativeVideoExport::status() const {
    std::lock_guard lock(mutex);
    return {{"state", phase},
            {"frames", submitted},
            {"encodedFrames", written},
            {"totalFrames", total},
            {"progress", total ? double(submitted) / total : 0},
            {"path", phase == "completed" ? native::data_location::utf8(destination) : ""},
            {"error", error},
            {"videoOnly", !options.has_audio()},
            {"audioSamples", audio_submitted},
            {"musicTrack", options.music},
            {"musicOffset", options.music_offset},
            {"musicLevel", options.music_level},
            {"audioScope", options.has_audio() ? (options.music == "none" ? "gameplay"
                                                  : options.audio         ? "gameplay+music"
                                                                          : "music")
                                               : "none"}};
}
void NativeVideoExport::run(std::string encoder){
    SDL_IOStream *input=nullptr;bool success=false;std::string failure;
    // Own one process at a time. The PCM spool avoids two pipe writers, pipe
    // deadlocks, and unbounded RAM for long clips. No shell parses filenames.
    auto spawn=[&](const std::vector<std::string> &arguments){
        std::vector<const char*> args;for(const auto &arg:arguments)args.push_back(arg.c_str());args.push_back(nullptr);
        auto *errors = SDL_IOFromFile(native::data_location::utf8(log).c_str(), "ab");
        if (!errors)
            throw std::runtime_error("Cannot create video encoder log.");
        const auto props=SDL_CreateProperties();SDL_SetPointerProperty(props,SDL_PROP_PROCESS_CREATE_ARGS_POINTER,const_cast<char**>(args.data()));SDL_SetNumberProperty(props,SDL_PROP_PROCESS_CREATE_STDIN_NUMBER,SDL_PROCESS_STDIO_APP);SDL_SetNumberProperty(props,SDL_PROP_PROCESS_CREATE_STDOUT_NUMBER,SDL_PROCESS_STDIO_NULL);SDL_SetNumberProperty(props,SDL_PROP_PROCESS_CREATE_STDERR_NUMBER,SDL_PROCESS_STDIO_REDIRECT);SDL_SetPointerProperty(props,SDL_PROP_PROCESS_CREATE_STDERR_POINTER,errors);
        {std::lock_guard lock(process_mutex);if(!canceled)process=SDL_CreateProcessWithProperties(props);}
        SDL_DestroyProperties(props);SDL_CloseIO(errors);if(!process)throw std::runtime_error(canceled?"Video export canceled.":std::string("Cannot start FFmpeg: ")+SDL_GetError());
    };
    auto wait=[&](){
        int code=-1;const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(120);
        for(;;){bool ended;{std::lock_guard lock(process_mutex);if(canceled)SDL_KillProcess(process,true);ended=SDL_WaitProcess(process,false,&code);}if(ended)break;if(std::chrono::steady_clock::now()>deadline)throw std::runtime_error("FFmpeg did not finish within two minutes.");SDL_Delay(10);}
        {std::lock_guard lock(process_mutex);SDL_DestroyProcess(process);process=nullptr;}
        if(!canceled&&code)throw std::runtime_error("FFmpeg could not encode the complete video/audio.");
    };
    try{
        std::ofstream audio;
        if(options.has_audio()){audio.open(pcm,std::ios::binary);if(!audio)throw std::runtime_error("Cannot create export audio spool.");}
        const std::string size=std::to_string(options.width)+"x"+std::to_string(options.height),fps=std::to_string(options.fps),count=std::to_string(total),crf=options.quality=="max"?"15":options.quality=="standard"?"23":"18";
        spawn({encoder,
               "-hide_banner",
               "-loglevel",
               "error",
               "-nostdin",
               "-n",
               "-f",
               "rawvideo",
               "-pixel_format",
               "rgb24",
               "-video_size",
               size,
               "-framerate",
               fps,
               "-i",
               "pipe:0",
               "-an",
               "-frames:v",
               count,
               "-c:v",
               "libx264",
               "-bf",
               "0",
               "-video_track_timescale",
               "2646000",
               "-preset",
               "fast",
               "-crf",
               crf,
               "-pix_fmt",
               "yuv420p",
               "-movflags",
               "+faststart",
               native::data_location::utf8(video)});
        input=SDL_GetProcessInput(process);if(!input)throw std::runtime_error("FFmpeg input pipe is unavailable.");
        for(;;){Packet packet;{std::unique_lock lock(mutex);ready.wait(lock,[&]{return canceled||!queue.empty()||finished;});if(canceled)break;if(queue.empty()&&finished)break;packet=std::move(queue.front());queue.pop_front();}
            if(!packet.pcm.empty()){audio.write(reinterpret_cast<const char*>(packet.pcm.data()),std::streamsize(packet.pcm.size()*sizeof(float)));if(!audio)throw std::runtime_error("Cannot write export audio (disk full?).");}
            size_t offset=0;while(offset<packet.rgb.size()&&!canceled){const auto n=SDL_WriteIO(input,packet.rgb.data()+offset,packet.rgb.size()-offset);offset+=n;if(n==0){if(SDL_GetIOStatus(input)!=SDL_IO_STATUS_NOT_READY)throw std::runtime_error("FFmpeg stopped accepting frames.");SDL_Delay(2);}}
            if(canceled)break;{std::lock_guard lock(mutex);++written;}
        }
        if(options.has_audio()){audio.close();if(!audio)throw std::runtime_error("Cannot finish export audio spool.");}
        SDL_CloseIO(input);input=nullptr;wait();
        if(!canceled&&written!=total)throw std::runtime_error("FFmpeg did not receive the complete video.");
        if(!canceled){
            if(options.has_audio()&&std::filesystem::file_size(pcm)!=audio_total*2*sizeof(float))throw std::runtime_error("Export audio spool is incomplete.");
            // CFR images cover [from,to). MP4 permits a shorter final packet,
            // so a fractional-frame clip need not acquire an extra video tail.
            // No B-frames means packet order also equals presentation order.
            constexpr uint64_t scale=2646000; // exact multiples of 30/60/120 and 22050
            const uint64_t duration=options.has_audio()?audio_total*120:VideoTimeline::sample_frame((options.to-options.from)*options.tick_interval,int(scale));
            const uint64_t last=(total-1)*(scale/uint64_t(options.fps));
            const auto tail=std::max(int64_t(1),int64_t(duration)-int64_t(last));
            const std::string trim="setts=duration=if(eq(N\\,"+std::to_string(total-1)+")\\,"+std::to_string(tail)+"\\,DURATION)";
            std::vector<std::string> arguments = {
                encoder,    "-hide_banner", "-loglevel", "error",
                "-nostdin", "-n",           "-i",        native::data_location::utf8(video)};
            if (options.has_audio())
                arguments.insert(arguments.end(),
                                 {"-f", "f32le", "-ar", "22050", "-ac", "2", "-i", native::data_location::utf8(pcm)});
            arguments.insert(arguments.end(),{"-map","0:v:0"});
            if(options.has_audio())arguments.insert(arguments.end(),{"-map","1:a:0","-c:a","aac","-b:a","160k"});
            arguments.insert(arguments.end(), {"-c:v", "copy", "-bsf:v", trim, "-video_track_timescale", "2646000",
                                               "-movflags", "+faststart", native::data_location::utf8(partial)});
            spawn(arguments);if(auto *in=SDL_GetProcessInput(process))SDL_CloseIO(in);wait();
        }
        if(!canceled){std::lock_guard lock(mutex);if(!canceled){if(!std::filesystem::is_regular_file(partial)||std::filesystem::file_size(partial)<32)throw std::runtime_error("FFmpeg produced no playable video.");std::filesystem::create_hard_link(partial,destination);success=true;phase="completed";}}
    }catch(const std::exception &e){failure=e.what();}
    if(input)SDL_CloseIO(input);
    {std::lock_guard lock(process_mutex);if(process){SDL_KillProcess(process,true);SDL_WaitProcess(process,true,nullptr);SDL_DestroyProcess(process);process=nullptr;}}
    std::error_code ignored;for(const auto &path:{partial,video,pcm})std::filesystem::remove(path,ignored);
    if(!failure.empty()&&!canceled){std::ifstream in(log,std::ios::binary|std::ios::ate);if(in){const auto length=in.tellg();in.seekg(std::max(std::streamoff(0),std::streamoff(length)-4096));const std::string detail{std::istreambuf_iterator<char>(in),{}};if(!detail.empty())failure+=" "+detail;}}
    std::filesystem::remove(log,ignored);{std::lock_guard lock(mutex);queue.clear();phase=canceled?"canceled":success?"completed":"error";error=canceled?"":failure;}running=false;
}
}
