#pragma once
#include "video_export.hpp"
#include "replay_audio.hpp"
#include "replay_camera.hpp"
#include "renderer.hpp"
#include "hud.hpp"
#include <chrono>
// Native GL capture and replay preparation stay on the context's owner thread.
namespace native {
class ReplayDirectorJob {
 BhContext *core;uint32_t total,saved;bool restored=false,gathered=false,planning=false;
 std::vector<BhGhostFrame> frames_;std::vector<uint8_t> teleports_;BhSnapshot snapshot{};
 void restore(){if(!restored){if(!bh_replay_seek(core,saved,&snapshot))throw std::runtime_error("Cannot restore replay after camera preparation");restored=true;}}
public:
 ReplayDirectorJob(BhContext *ctx,uint32_t ticks,uint32_t original):core(ctx),total(ticks),saved(original){
  if(total>1'000'000)throw std::runtime_error("Cinematic camera preparation supports up to one million replay ticks");
  frames_.reserve(size_t(total)+1);teleports_.reserve(size_t(total)+1);if(!bh_replay_seek(core,0,&snapshot)){bh_replay_seek(core,saved,&snapshot);throw std::runtime_error("Cannot prepare replay cameras");}
 }
 ~ReplayDirectorJob(){try{restore();}catch(...){}}
 bool step(){if(gathered)return true;const auto deadline=std::chrono::steady_clock::now()+std::chrono::milliseconds(5);
  for(unsigned count=0;count<512;count++){
   const auto &s=snapshot.player;BhCmd cmd{};BhWeaponReport weapon{};bh_last_command(core,&cmd);bh_weapon_report(core,&weapon);BhGhostFrame frame{};
   std::copy(s.position,s.position+3,frame.position);std::copy(s.velocity,s.velocity+3,frame.velocity);frame.yaw=cmd.yaw;frame.pitch=cmd.pitch;frame.view_offset_z=s.view_offset_z;frame.tick=s.tick;frame.flags=(s.crouched?1:0)|(s.grounded?2:0);frame.weapon=weapon.active;frames_.push_back(frame);teleports_.push_back(bool(s.events&1));
   if(frames_.size()>total){restore();gathered=true;return true;}
   if(!bh_replay_step(core,&snapshot))throw std::runtime_error("Cinematic camera replay preparation failed");
   if(std::chrono::steady_clock::now()>=deadline)break;
  }return false;
 }
 bool plan(ReplayCamera &camera,double dt,uint32_t from,uint32_t to){if(!planning){camera.begin_direct(std::move(frames_),unsigned(std::lround(1/dt)),from,to,core,total,std::move(teleports_));planning=true;}return camera.step_direct(8,4);}
};
class VideoCapture {
 Gl &gl;BhContext *core;Renderer &renderer;NativeHud &hud;NativeVideoExport &encoder;
 VideoOptions options;VideoTimeline timeline;ReplayCamera camera;Input input;Json settings;std::string map,style,outfit,loadout;
 std::unique_ptr<ReplayAudioTrack> audio;bool audio_prepared=false;
 GLuint framebuffer=0,color=0,depth=0;uint32_t saved_tick;uint64_t frame=0;bool restored=false,done_=false;BhSnapshot previous{},next{};BhCmd prior_cmd{},next_cmd{};
 void checked(int result,const char *message){if(!result)throw std::runtime_error(message);}
 void release(){if(framebuffer)gl.DeleteFramebuffers(1,&framebuffer);if(color)gl.DeleteTextures(1,&color);if(depth)gl.DeleteRenderbuffers(1,&depth);framebuffer=color=depth=0;}
public:
 VideoCapture(Gl &g,BhContext *ctx,Renderer &r,NativeHud &h,NativeVideoExport &e,const VideoOptions &o,uint32_t ticks,uint32_t saved,Json prefs,std::string mapName,std::string styleName,std::string outfitName,std::string packed,const ReplayCamera &prepared,const std::filesystem::path &assets,const std::filesystem::path &cache):gl(g),core(ctx),renderer(r),hud(h),encoder(e),options(o),timeline(VideoTimeline::make(o,ticks)),camera(prepared),settings(std::move(prefs)),map(std::move(mapName)),style(std::move(styleName)),outfit(std::move(outfitName)),loadout(std::move(packed)),saved_tick(saved){
  GLint old=0;gl.GetIntegerv(GL_FRAMEBUFFER_BINDING,&old);
  try{gl.GenFramebuffers(1,&framebuffer);gl.BindFramebuffer(GL_FRAMEBUFFER,framebuffer);gl.GenTextures(1,&color);gl.BindTexture(GL_TEXTURE_2D,color);gl.TexImage2D(GL_TEXTURE_2D,0,GL_RGB8,o.width,o.height,0,GL_RGB,GL_UNSIGNED_BYTE,nullptr);gl.TexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MIN_FILTER,GL_LINEAR);gl.TexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MAG_FILTER,GL_LINEAR);gl.FramebufferTexture2D(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_TEXTURE_2D,color,0);gl.GenRenderbuffers(1,&depth);gl.BindRenderbuffer(GL_RENDERBUFFER,depth);gl.RenderbufferStorage(GL_RENDERBUFFER,GL_DEPTH_COMPONENT24,o.width,o.height);gl.FramebufferRenderbuffer(GL_FRAMEBUFFER,GL_DEPTH_ATTACHMENT,GL_RENDERBUFFER,depth);if(gl.CheckFramebufferStatus(GL_FRAMEBUFFER)!=GL_FRAMEBUFFER_COMPLETE)throw std::runtime_error("Video capture framebuffer is unavailable");gl.BindFramebuffer(GL_FRAMEBUFFER,GLuint(old));
   if(o.has_audio())audio=std::make_unique<ReplayAudioTrack>(assets,cache,settings,style,o);
   checked(bh_replay_seek(core,o.has_audio()?0:o.from,&next),"Cannot seek video clip start");if(audio)audio->tick(core,next,o.tick_interval);audio_prepared=!audio;previous=next;bh_last_command(core,&next_cmd);prior_cmd=next_cmd;renderer.reset_presentation();hud.reset_history();camera.set_mode(o.camera);camera.reset();
  }catch(...){gl.BindFramebuffer(GL_FRAMEBUFFER,GLuint(old));bh_replay_seek(core,saved_tick,&next);release();throw;}
 }
 ~VideoCapture(){try{restore();}catch(...){}release();}
 void restore(){if(restored)return;checked(bh_replay_seek(core,saved_tick,&next),"Cannot restore playback after video export");restored=true;renderer.reset_presentation();hud.reset_history();}
 bool done()const{return done_;}
 void step(){if(done_||!encoder.can_submit())return;
  if(!audio_prepared){const auto deadline=std::chrono::steady_clock::now()+std::chrono::milliseconds(5);for(unsigned count=0;next.player.tick<options.from&&count<512;++count){audio->before_tick(next.player.tick+1,options.tick_interval);checked(bh_replay_step(core,&next),"Replay audio pre-roll failed");audio->tick(core,next,options.tick_interval);if(std::chrono::steady_clock::now()>=deadline)return;}if(next.player.tick<options.from)return;previous=next;bh_last_command(core,&next_cmd);prior_cmd=next_cmd;audio_prepared=true;}
  const auto target=timeline.tick(frame);const auto upper=uint32_t(std::ceil(target));
  while(next.player.tick<upper){previous=next;prior_cmd=next_cmd;if(audio)audio->before_tick(next.player.tick+1,options.tick_interval);checked(bh_replay_step(core,&next),"Replay simulation failed during video capture");if(audio&&next.player.tick<options.to)audio->tick(core,next,options.tick_interval);bh_last_command(core,&next_cmd);BhReplayEvents events{};bh_replay_events(core,previous.player.tick,next.player.tick,&events);if(events.inspect_signal)renderer.inspect_press();renderer.inspect_held(events.inspect_held!=0);renderer.simulation_tick();hud.tick(next.player);}
  BhSnapshot state=next;const double mix=next.player.tick==previous.player.tick?1:std::clamp(target-double(previous.player.tick),0.,1.);auto lerp=[&](double a,double b){return a+(b-a)*mix;};
  const bool teleport=next.player.events&1;for(int k=0;k<3;k++)state.player.position[k]=float(teleport?next.player.position[k]:lerp(previous.player.position[k],next.player.position[k]));state.player.view_offset_z=float(lerp(previous.player.view_offset_z,next.player.view_offset_z));
  const double yaw_delta=std::remainder(double(next_cmd.yaw-prior_cmd.yaw),360.);input.set_angles(lerp(prior_cmd.pitch,next_cmd.pitch),prior_cmd.yaw+yaw_delta*mix,5);float eye[3];camera.sample(core,state.player,input.yaw(),input.pitch,target*options.tick_interval,eye,input,1./options.fps);
  renderer.set_replay_actor(nullptr,0,0);renderer.set_spectated_actor(std::nullopt);renderer.set_viewmodel_weapon(std::nullopt);renderer.set_viewmodel_visible(!camera.third_person()&&settings.value("viewmodel",true));renderer.set_camera_fov(settings.value("fov",90.f));
  std::vector<native_render::Actor> actors;if(camera.third_person()){native_render::Actor actor;actor.id="video-target";actor.outfit=outfit;actor.loadout=loadout;actor.opacity=1;std::copy(state.player.position,state.player.position+3,actor.frame.position);std::copy(state.player.velocity,state.player.velocity+3,actor.frame.velocity);actor.frame.tick=state.player.tick;actor.frame.pitch=next_cmd.pitch;actor.frame.yaw=next_cmd.yaw;actor.frame.view_offset_z=state.player.view_offset_z;actor.frame.flags=(state.player.crouched?1:0)|(state.player.grounded?2:0)|(state.player.events&32?32:0);BhWeaponReport held{};bh_weapon_report(core,&held);actor.frame.weapon=held.active;BhReplayEvents events{};bh_replay_events(core,previous.player.tick,next.player.tick,&events);actor.inspect=events.inspect_signal;actor.attack=events.cosmetic;actor.inspectHeld=events.inspect_held;actors.push_back(actor);}renderer.set_room_actors(actors);
  BhRunState run{};bh_run_state(core,&run);renderer.set_zone_state(run.track,run);GLint old=0,viewport[4]{};gl.GetIntegerv(GL_FRAMEBUFFER_BINDING,&old);gl.GetIntegerv(GL_VIEWPORT,viewport);
  try{gl.BindFramebuffer(GL_FRAMEBUFFER,framebuffer);renderer.draw(options.width,options.height,eye,input,&state,target*options.tick_interval);
   if(options.hud){BhWeaponReport held{};bh_weapon_report(core,&held);hud.draw(options.width,options.height,state,run,next_cmd,map,style,"",options.fps,true,settings.value("crosshair",true),true,held,"",false,std::nullopt,false,nullptr,settings.value("hudScale",100.f));}
   const size_t row=size_t(options.width)*3;std::vector<uint8_t> pixels(row*options.height);gl.PixelStorei(GL_PACK_ALIGNMENT,1);gl.ReadPixels(0,0,options.width,options.height,GL_RGB,GL_UNSIGNED_BYTE,pixels.data());for(int y=0;y<options.height/2;y++)std::swap_ranges(pixels.begin()+y*row,pixels.begin()+(y+1)*row,pixels.begin()+(options.height-1-y)*row);if(gl.GetError()!=GL_NO_ERROR)throw std::runtime_error("OpenGL video capture failed");gl.BindFramebuffer(GL_FRAMEBUFFER,GLuint(old));gl.Viewport(viewport[0],viewport[1],viewport[2],viewport[3]);
   // Capture the last image before draining the remaining simulation ticks.
   // This includes events after the last frame time and before the clip end.
   if(audio&&frame+1==timeline.frames){while(next.player.tick<options.to){audio->before_tick(next.player.tick+1,options.tick_interval);checked(bh_replay_step(core,&next),"Replay audio tail failed");if(next.player.tick<options.to)audio->tick(core,next,options.tick_interval);}audio->finish();}
   if(!encoder.submit(std::move(pixels),audio?audio->take():std::vector<float>{}))throw std::runtime_error("Video encoder stopped during capture");if(++frame==timeline.frames){encoder.finish();done_=true;restore();}
  }catch(...){gl.BindFramebuffer(GL_FRAMEBUFFER,GLuint(old));gl.Viewport(viewport[0],viewport[1],viewport[2],viewport[3]);throw;}
 }
};
}
