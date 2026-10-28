#include "video_export.hpp"
#include "replay_audio.hpp"
#include "settings.hpp"
#include "video_request.hpp"
#include "replay_range.hpp"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
static void done(native::NativeVideoExport &encoder){const auto end=std::chrono::steady_clock::now()+std::chrono::seconds(30);while(encoder.busy()&&std::chrono::steady_clock::now()<end)SDL_Delay(2);if(encoder.status()["state"]=="error")std::cerr<<encoder.status()<<'\n';assert(!encoder.busy());}
static std::vector<uint8_t> command(const std::vector<std::string> &arguments){std::vector<const char*> args;for(const auto &s:arguments)args.push_back(s.c_str());args.push_back(nullptr);auto *p=SDL_CreateProcess(args.data(),true);assert(p);if(auto *in=SDL_GetProcessInput(p))SDL_CloseIO(in);size_t size=0;int code=-1;auto *bytes=static_cast<uint8_t*>(SDL_ReadProcess(p,&size,&code));assert(!code);std::vector<uint8_t> out;if(bytes){out.assign(bytes,bytes+size);SDL_free(bytes);}SDL_DestroyProcess(p);return out;}
static nlohmann::json probe(const std::filesystem::path &p){const auto bytes=command({"ffprobe","-v","error","-show_streams","-show_format","-of","json",p.string()});return nlohmann::json::parse(bytes);}
static std::vector<float> decode(const std::filesystem::path &p){const auto bytes=command({"ffmpeg","-v","error","-i",p.string(),"-map","0:a:0","-f","f32le","-ac","2","-ar","22050","pipe:1"});assert(bytes.size()%sizeof(float)==0);std::vector<float> samples(bytes.size()/sizeof(float));std::memcpy(samples.data(),bytes.data(),bytes.size());return samples;}
static double energy(const std::vector<float> &pcm){double sum=0;for(float v:pcm){assert(std::isfinite(v));sum+=double(v)*v;}return sum;}
// Feed the actual gameplay cue path with jumps and weapon attacks on ticks
// that a 30 FPS capture does not render. No generated tone stands in for SFX.
static void tick(native::ReplayAudioTrack &track,uint32_t n,double dt,bool finish=false){BhSnapshot s{};s.player.tick=n;s.player.grounded=n<2||n>=40&&n<50||n>=90;s.player.view_offset_z=64;s.player.velocity[2]=s.player.grounded?0:-20;if(n==2||n==50){s.player.events=2;s.player.velocity[2]=280;}if(n==40||n==90)s.player.events=4;BhWeaponReport gun{};gun.active=2;BhAttackReport attack{};attack.weapon=2;attack.mode=1;BhRunState run{};if(finish&&n==3)run.update_flags=2;track.tick(s,run,gun,(n==3||n==60||n==119)?&attack:nullptr,dt,"concrete",NAN);}
static std::vector<float> mix(const std::filesystem::path &assets,const std::filesystem::path &cache,native::VideoOptions o,nlohmann::json prefs,int take_fps,bool finish=false){native::ReplayAudioTrack track(assets,cache,prefs,"autohop",o);tick(track,0,o.tick_interval,finish);std::vector<float> out;auto take=[&]{auto block=track.take();out.insert(out.end(),block.begin(),block.end());};uint32_t n=0;for(uint64_t frame=0;frame<native::VideoTimeline::make(o,o.to).frames;++frame){const auto upper=uint32_t(std::ceil(o.from+double(frame)/(take_fps*o.tick_interval)));while(n<std::min(upper,o.to)){track.before_tick(++n,o.tick_interval);if(n<o.to)tick(track,n,o.tick_interval,finish);}take();}while(n<o.to){track.before_tick(++n,o.tick_interval);if(n<o.to)tick(track,n,o.tick_interval,finish);}track.finish();take();return out;}
// A tiny decoded-file fixture with different L/R signals and a non-mixer
// sample rate verifies offset, channel preservation, interpolation and looping.
static std::vector<int16_t> song(const std::filesystem::path &file,int channels=2){
    constexpr uint32_t rate=32000,frames=6400;std::vector<int16_t> pcm(frames*channels);
    for(size_t n=0;n<frames;++n)for(int ch=0;ch<channels;++ch)pcm[n*channels+ch]=int16_t(8000*std::sin(double(n)*(ch?.041:.023)));
    std::ofstream f(file,std::ios::binary);auto u16=[&](uint16_t v){f.put(char(v));f.put(char(v>>8));};auto u32=[&](uint32_t v){u16(uint16_t(v));u16(uint16_t(v>>16));};
    f.write("RIFF",4);u32(36+uint32_t(pcm.size()*2));f.write("WAVEfmt ",8);u32(16);u16(1);u16(uint16_t(channels));u32(rate);u32(rate*channels*2);u16(uint16_t(channels*2));u16(16);f.write("data",4);u32(uint32_t(pcm.size()*2));for(auto v:pcm)u16(uint16_t(v));return pcm;
}
static void music_clock(const std::filesystem::path &file,const std::vector<int16_t> &song){
    constexpr uint64_t start=1103,end=start+24917;native::MusicTrack track{"test","Stereo fixture",file};
    native::OfflineMusic a,b;a.load(track,start,end,.013,1,true,true);b.load(track,start,end,.013,1,true,true);
    assert(a.decoded_samples()==song.size()&&a.decoded_samples()<=native::max_music_samples);
    std::vector<float> full(end*2),pieces(end*2);a.mix(full.data(),end,22050,.65f);
    for(size_t n=0;n<end;){const auto count=std::min(size_t(137),size_t(end)-n);b.mix(pieces.data()+n*2,count,22050,.65f);n+=count;}assert(full==pieces);
    assert(energy(std::vector<float>(full.begin(),full.begin()+start*2))==0&&full[start*2]==0&&full[(end-1)*2]==0);
    const size_t sample=start+9000;const double position=std::fmod((.013+double(sample-start)/22050)*32000,double(song.size()/2));const size_t at=size_t(position),next=(at+1)%(song.size()/2);
    for(int ch=0;ch<2;++ch){const float x=song[at*2+ch]/32768.f,y=song[next*2+ch]/32768.f;assert(std::abs(full[sample*2+ch]-(x+(y-x)*float(position-at))*.55f*.65f)<1e-7);}
    assert(full[sample*2]!=full[sample*2+1]);assert(SDL_WasInit(SDL_INIT_AUDIO)==0);
}
static void default_export_range() {
    const nlohmann::json info = {{"startTick", 1900}, {"endTick", 4300}, {"totalTicks", 5000},
                                 {"settings", {{"tickInterval", .01}}}};
    nlohmann::json request = {{"width", 1280}, {"height", 720}, {"fps", 60}, {"quality", "high"},
                              {"camera", "eye"}, {"hud", true}};
    const auto range = native::ReplayRange::make(info);
    auto options = native::parse_video_options(request);
    range.export_bounds(options);
    assert(options.from == 1800 && options.to == 4450);
    assert(native::VideoTimeline::make(options, 5000).frames == 1590);
    request["fullRecording"] = true;
    options = native::parse_video_options(request);
    range.export_bounds(options);
    assert(options.from == 0 && options.to == 5000);
    assert(native::VideoTimeline::make(options, 5000).frames == 3000);
}

int main(int argc,char **argv){
    default_export_range();
    native::VideoOptions options;options.from=10;options.to=110;options.fps=30;const auto timeline=native::VideoTimeline::make(options,200);assert(timeline.frames==30&&std::abs(timeline.tick(1)-13.3333333333)<1e-6&&timeline.audio_frames()==22050);
    for(int fps:{30,60,120}){options.fps=fps;assert(native::VideoTimeline::make(options,200).frames==uint64_t(fps));}options.to=111;assert(native::VideoTimeline::make(options,200).frames==122);options.to=110;
    bool rejected=false;try{auto bad=options;bad.to=300;native::VideoTimeline::make(bad,200);}catch(...){rejected=true;}assert(rejected);
    for(int kind=0;kind<4;++kind){auto bad=options;if(kind==0)bad.music_offset=NAN;if(kind==1)bad.music_offset=-1;if(kind==2)bad.music_level=1.1f;if(kind==3)bad.music_level=NAN;rejected=false;try{native::VideoTimeline::make(bad,200);}catch(...){rejected=true;}assert(rejected);}
    const auto available=native::NativeVideoExport::probe();if(!available.available){std::cout<<"Video real-encoder integration unavailable: "<<available.reason<<'\n';return 77;}
    // Keep a deterministic, low-memory video-only path when audio is disabled.
    const auto directory=std::filesystem::temp_directory_path()/("bunnyhop video test "+std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));std::filesystem::create_directory(directory);
    const auto output=directory/"clip ; ' $(literal).mp4";native::NativeVideoExport encoder;options.width=options.height=64;options.fps=30;options.audio=false;options.from=0;options.to=20;encoder.start(options,output,6,available.encoder);
    std::vector<uint8_t> frame(64*64*3);for(int y=0;y<64;++y)for(int x=0;x<64;++x){const size_t i=size_t(y*64+x)*3;frame[i]=y<32?240:10;frame[i+1]=20;frame[i+2]=y<32?10:240;}
    for(int i=0;i<6;++i){while(!encoder.can_submit()&&encoder.busy())SDL_Delay(2);assert(encoder.submit(frame));}encoder.finish();done(encoder);assert(encoder.status()["state"]=="completed"&&std::filesystem::file_size(output)>32&&encoder.status()["videoOnly"]==true);
    const auto pixels=command({available.encoder,"-v","error","-i",output.string(),"-f","rawvideo","-pix_fmt","rgb24","pipe:1"});assert(pixels.size()==6*64*64*3);assert(pixels[0]>200&&pixels[2]<40&&pixels[64*48*3+2]>200);assert(probe(output)["streams"].size()==1);
    const std::filesystem::path assets=argc>1?argv[1]:std::filesystem::path(__FILE__).parent_path()/"../../../target/native-assets";
    assert(std::filesystem::is_regular_file(assets / "audio.json"));
    auto prefs = native::default_settings();
    prefs["volume"] = .65;
    prefs["musicVolume"] = 1.;
    prefs["sfxVolume"] = 1.;
    prefs["wind"] = false;
    prefs["footsteps"] = false;
    prefs["announcer"]["enabled"] = false;
    native::VideoOptions audio_options;audio_options.to=120;auto full=mix(assets,directory,audio_options,prefs,60);assert(full.size()==2*26460&&energy(full)>.001);assert(SDL_WasInit(SDL_INIT_AUDIO)==0);
    for(int fps:{30,120}){auto same=audio_options;same.fps=fps;assert(mix(assets,directory,same,prefs,fps)==full);} // tick 119 fire lies after the last 30 FPS frame
    // First jump is at .02 s; there must be silence before it and sound after.
    assert(energy(std::vector<float>(full.begin(),full.begin()+2*441))==0);assert(energy(std::vector<float>(full.begin()+2*441,full.begin()+2*662))>0);
    audio_options.from=5;audio_options.to=118;const auto source_offset=size_t(native::VideoTimeline::sample_frame(.05))*2;const auto expected_count=size_t(native::VideoTimeline::sample_frame(1.13))*2;const std::vector<float> expected(full.begin()+source_offset,full.begin()+source_offset+expected_count);
    for(int fps:{30,60,120}){audio_options.fps=fps;const auto pcm=mix(assets,directory,audio_options,prefs,fps);if(pcm!=expected){size_t diff=0;while(diff<std::min(pcm.size(),expected.size())&&pcm[diff]==expected[diff])++diff;std::cerr<<"FPS "<<fps<<" sizes "<<pcm.size()<<" "<<expected.size()<<" first diff "<<diff<<" values "<<(diff<pcm.size()?pcm[diff]:0)<<" "<<(diff<expected.size()?expected[diff]:0)<<"\n";}assert(pcm==expected);}
    auto silent=prefs;silent["muted"]=true;assert(energy(mix(assets,directory,audio_options,silent,30))==0);silent=prefs;silent["sfxVolume"]=0;assert(energy(mix(assets,directory,audio_options,silent,30))==0);
    // Exclusive clip end: a jump at the end is excluded; the same jump at
    // the start is included and retains its deterministic variant.
    auto edge=audio_options;edge.from=0;edge.to=2;assert(energy(mix(assets,directory,edge,prefs,30))==0);edge.from=2;edge.to=3;assert(energy(mix(assets,directory,edge,prefs,30))>0);
    std::filesystem::create_directory(directory/"bgm");const auto song_pcm=song(directory/"bgm"/"fixture.wav");music_clock(directory/"bgm"/"fixture.wav",song_pcm);
    auto music_prefs=prefs;music_prefs["musicPack"]="custom";music_prefs["sfxVolume"]=0;
    auto musical=audio_options;musical.music="fixture.wav";musical.audio=false;musical.music_offset=.013;
    const auto music_pcm=mix(assets,directory,musical,music_prefs,120);assert(music_pcm.size()==expected_count&&energy(music_pcm)>.001);
    for(int fps:{30,60,120}){musical.fps=fps;assert(mix(assets,directory,musical,music_prefs,fps)==music_pcm);}
    auto scaled=musical;scaled.music_level=.5f;const auto half=mix(assets,directory,scaled,music_prefs,120);for(size_t k=0;k<half.size();++k)assert(half[k]==music_pcm[k]*.5f);
    auto low=music_prefs;low["musicVolume"]=.5f;assert(mix(assets,directory,musical,low,120)==half);low=music_prefs;low["volume"]=.325f;assert(mix(assets,directory,musical,low,120)==half);
    for(const char *mute:{"muted","muteMusic"}){auto p=music_prefs;p[mute]=true;assert(energy(mix(assets,directory,musical,p,120))==0);}
    low=music_prefs;low["musicVolume"]=0;assert(energy(mix(assets,directory,musical,low,120))==0);scaled=musical;scaled.music_level=0;assert(energy(mix(assets,directory,scaled,music_prefs,120))==0);
    low=music_prefs;low["muteSfx"]=true;low["muteAmbience"]=true;assert(mix(assets,directory,musical,low,120)==music_pcm);
    auto mixed_options=musical;mixed_options.audio=true;auto mixed_prefs=music_prefs;mixed_prefs["sfxVolume"]=1.;const auto combined=mix(assets,directory,mixed_options,mixed_prefs,120);
    for(size_t k=0;k<combined.size();++k)assert(std::abs(combined[k]-std::clamp(expected[k]+music_pcm[k],-.98f,.98f))<1e-7);
    mixed_prefs["muteMusic"]=true;assert(mix(assets,directory,mixed_options,mixed_prefs,120)==expected);
    auto no_loop=musical;no_loop.music_loop=false;auto tail=mix(assets,directory,no_loop,music_prefs,120);assert(energy(tail)>0&&energy(std::vector<float>(tail.begin()+22050,tail.end()))==0);
    no_loop.music_offset=1;assert(energy(mix(assets,directory,no_loop,music_prefs,120))==0);scaled=musical;scaled.music_offset=.017;assert(mix(assets,directory,scaled,music_prefs,120)!=music_pcm);
    // A finish before the trimmed start must still duck the music. Disabling
    // ducking or gameplay audio prevents an inaudible cue from dipping the bed.
    auto ducked=musical;ducked.audio=true;const auto dip=mix(assets,directory,ducked,music_prefs,120,true);assert(energy(dip)<energy(music_pcm)*.3);ducked.music_duck=false;assert(mix(assets,directory,ducked,music_prefs,120,true)==music_pcm);assert(mix(assets,directory,musical,music_prefs,120,true)==music_pcm);
    for(const char *invalid:{"missing.wav","menu-drift"}){scaled=musical;scaled.music=invalid;rejected=false;try{mix(assets,directory,scaled,music_prefs,120);}catch(...){rejected=true;}assert(rejected);}
    low=music_prefs;low["musicPack"]="default";rejected=false;try{mix(assets,directory,musical,low,120);}catch(...){rejected=true;}assert(rejected);
    std::ofstream(directory/"bgm"/"bad.wav")<<"bad";scaled=musical;scaled.music="bad.wav";rejected=false;try{mix(assets,directory,scaled,music_prefs,120);}catch(...){rejected=true;}assert(rejected);
    // Decode the real shipped OST through the same offline path, and ensure
    // menu-only music cannot be selected as a gameplay soundtrack.
    scaled=musical;scaled.music="game-airstrafe";assert(energy(mix(assets,directory,scaled,prefs,120))>.001);scaled.music="menu-drift";rejected=false;try{mix(assets,directory,scaled,prefs,120);}catch(...){rejected=true;}assert(rejected);
    const auto mono_file=directory/"bgm"/"mono.wav";song(mono_file,1);scaled=musical;scaled.music="mono.wav";const auto mono=mix(assets,directory,scaled,music_prefs,120);for(size_t i=0;i<mono.size();i+=2)assert(mono[i]==mono[i+1]);
    assert(SDL_WasInit(SDL_INIT_AUDIO)==0);
    nlohmann::json evidence=nlohmann::json::array();
    for(int fps:{30,60,120}){audio_options.fps=fps;const auto plan=native::VideoTimeline::make(audio_options,120);const auto path=directory/("audio-"+std::to_string(fps)+".mp4");auto small=audio_options;small.width=small.height=64;encoder.start(small,path,plan.frames,available.encoder);size_t at=0;
        for(uint64_t i=0;i<plan.frames;++i){const size_t end=expected.size()*(i+1)/plan.frames/2*2;std::vector<float> block(expected.begin()+at,expected.begin()+end);at=end;while(!encoder.can_submit()&&encoder.busy())SDL_Delay(2);assert(encoder.submit(frame,std::move(block)));}encoder.finish();done(encoder);assert(encoder.status()["state"]=="completed"&&encoder.status()["videoOnly"]==false);
        const auto metadata=probe(path);assert(metadata["streams"].size()==2);const auto &v=metadata["streams"][0],&a=metadata["streams"][1];assert(v["codec_name"]=="h264"&&a["codec_name"]=="aac"&&a["channels"]==2&&a["sample_rate"]=="22050");assert(std::stoull(v["nb_frames"].get<std::string>())==plan.frames);const double vd=std::stod(v["duration"].get<std::string>()),ad=std::stod(a["duration"].get<std::string>());assert(std::abs(vd-1.13)<.00005&&std::abs(ad-1.13)<.002&&std::abs(vd-ad)<.000002);
        const auto decoded=decode(path);assert(decoded.size()>=expected.size()&&decoded.size()<expected.size()+2048*2&&energy(decoded)>.001);double dot=0,original=0,encoded=0;for(size_t k=0;k<expected.size();++k){dot+=double(decoded[k])*expected[k];original+=double(expected[k])*expected[k];encoded+=double(decoded[k])*decoded[k];}const double correlation=dot/std::sqrt(original*encoded);assert(correlation>.85);evidence.push_back({{"fps",fps},{"frames",plan.frames},{"sourceDuration",1.13},{"videoDuration",vd},{"audioDuration",ad},{"pcmFrames",expected.size()/2},{"decodedEnergy",energy(decoded)},{"waveformCorrelation",correlation}});
        small.audio=false;const auto video_only=directory/("audio-off-"+std::to_string(fps)+".mp4");encoder.start(small,video_only,plan.frames,available.encoder);for(uint64_t i=0;i<plan.frames;++i){while(!encoder.can_submit()&&encoder.busy())SDL_Delay(2);assert(encoder.submit(frame));}encoder.finish();done(encoder);assert(encoder.status()["state"]=="completed");const auto only=probe(video_only);assert(only["streams"].size()==1&&std::abs(std::stod(only["streams"][0]["duration"].get<std::string>())-1.13)<.000002);
        if(const char *artifact=std::getenv("BUNNYHOP_VIDEO_EVIDENCE")){std::filesystem::create_directories(artifact);std::filesystem::copy_file(path,std::filesystem::path(artifact)/path.filename(),std::filesystem::copy_options::overwrite_existing);}
    }
    // Music-only exports still receive an AAC track and the exact duration.
    for(int fps:{30,60,120})for(bool gameplay:{false,true}){auto o=musical;o.audio=gameplay;o.fps=fps;const auto plan=native::VideoTimeline::make(o,120);const auto path=directory/((gameplay?"audio-music-gameplay-":"audio-music-only-")+std::to_string(fps)+".mp4");auto p=music_prefs;if(gameplay)p["sfxVolume"]=1.;const auto pcm=mix(assets,directory,o,p,o.fps);o.width=o.height=64;encoder.start(o,path,plan.frames,available.encoder);size_t at=0;
        for(uint64_t i=0;i<plan.frames;++i){const size_t end=pcm.size()*(i+1)/plan.frames/2*2;while(!encoder.can_submit()&&encoder.busy())SDL_Delay(2);assert(encoder.submit(frame,{pcm.begin()+at,pcm.begin()+end}));at=end;}encoder.finish();done(encoder);assert(encoder.status()["state"]=="completed"&&!encoder.status()["videoOnly"].get<bool>()&&encoder.status()["audioScope"]==(gameplay?"gameplay+music":"music"));const auto metadata=probe(path);assert(metadata["streams"].size()==2);for(const auto &stream:metadata["streams"])assert(std::abs(std::stod(stream["duration"].get<std::string>())-1.13)<.00005);const auto output_pcm=decode(path);assert(output_pcm.size()>=pcm.size()&&energy(output_pcm)>.001);double dot=0,source=0,encoded=0;for(size_t i=0;i<pcm.size();++i){dot+=double(pcm[i])*output_pcm[i];source+=double(pcm[i])*pcm[i];encoded+=double(output_pcm[i])*output_pcm[i];}assert(dot/std::sqrt(source*encoded)>.9);
        evidence.push_back({{"fps",fps},{"music",musical.music},{"gameplay",gameplay},{"pcmFrames",pcm.size()/2},{"waveformCorrelation",dot/std::sqrt(source*encoded)}});
    }
    std::filesystem::remove_all(directory/"bgm");
    for(bool with_audio:{false,true}){auto tiny=audio_options;tiny.width=tiny.height=64;tiny.from=0;tiny.to=1;tiny.fps=30;tiny.audio=with_audio;const auto path=directory/(with_audio?"audio-tiny.mp4":"audio-tiny-off.mp4");encoder.start(tiny,path,1,available.encoder);while(!encoder.can_submit()&&encoder.busy())SDL_Delay(2);assert(encoder.submit(frame,with_audio?std::vector<float>(442):std::vector<float>{}));encoder.finish();done(encoder);assert(encoder.status()["state"]=="completed");const auto metadata=probe(path);for(const auto &stream:metadata["streams"])assert(std::abs(std::stod(stream["duration"].get<std::string>())-.01)<.00005);}
    options.audio=true;options.from=0;options.to=100;encoder.start(options,directory/"cancel.mp4",30,available.encoder);assert(encoder.submit(frame,std::vector<float>(1000)));encoder.cancel();done(encoder);assert(encoder.status()["state"]=="canceled"&&!std::filesystem::exists(directory/"cancel.mp4"));
    options.to=1;encoder.start(options,directory/"missing.mp4",1,"bunnyhop-encoder-does-not-exist");done(encoder);assert(encoder.status()["state"]=="error"&&!std::filesystem::exists(directory/"missing.mp4"));
    rejected=false;try{encoder.start(options,output,1);}catch(...){rejected=true;}assert(rejected);
    encoder.start(options,directory/"incomplete.mp4",1,available.encoder);assert(encoder.submit(frame));rejected=false;try{encoder.finish();}catch(...){rejected=true;}assert(rejected);encoder.cancel();done(encoder);
    for(const auto &entry:std::filesystem::directory_iterator(directory))assert(entry.path()==output||entry.path().filename().string().starts_with("audio-"));std::filesystem::remove_all(directory);
    if(const char *artifact=std::getenv("BUNNYHOP_VIDEO_EVIDENCE"))std::ofstream(std::filesystem::path(artifact)/"result.json")<<evidence.dump(2)<<'\n';std::cout<<evidence.dump(2)<<"\nGameplay/music audio MP4 encode/decode, stereo resampling/offset/loop/gain/duck/pack gates, trim tails, exclusive boundaries, FPS invariance, mute, cancellation, errors and cleanup passed\n";
}
