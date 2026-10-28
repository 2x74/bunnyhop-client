#pragma once
// Include after menu_backdrop.hpp. Owns an independent cosmetic renderer and offscreen target.
class NativeLoadoutPreview {
    Gl &gl;NativeViewmodel models;GLuint framebuffer=0,color=0,depth=0;int width=0,height=0;unsigned inspect=0;double started=-1;std::string signature;
public:
    NativeLoadoutPreview(Gl &api,const std::filesystem::path &assets):gl(api),models(api,assets){gl.GenFramebuffers(1,&framebuffer);gl.GenTextures(1,&color);gl.GenRenderbuffers(1,&depth);}
    ~NativeLoadoutPreview(){gl.DeleteRenderbuffers(1,&depth);gl.DeleteTextures(1,&color);gl.DeleteFramebuffers(1,&framebuffer);}
    // Call on the owning GL thread before the normal scene draw. Restores target and viewport;
    // standard renderer draw rebinds shader/textures/depth/blending afterwards.
    std::string render(const nlohmann::json &job,double now){
        if(!job.is_object()||job.dump().size()>8192)return {};
        const auto id=job.value("id",0u);const auto view=job.value("view",std::string("fp"));
        if(!id||(view!="fp"&&view!="close"&&view!="bunny"&&view!="ghost"&&view!="onboarding"))return {};
        const int w=std::clamp(job.value("width",768),384,960),h=std::clamp(job.value("height",480),240,600);
        const float yaw=job.value("yaw",0.f),pitch=job.value("pitch",0.f);if(!std::isfinite(yaw)||!std::isfinite(pitch))return {};
        const auto packed=job.value("loadout",std::string("")),outfit=job.value("outfit",std::string("outfit-cream")),ghost=job.value("ghost",std::string("ghost-gold"));if(packed.size()>512||outfit.size()>80||ghost.size()>80)return {};
        const auto trail = job.value("trail", std::string("trail-gold"));
        if (trail.size() > 80)
            return {};
        models.trail_cosmetics(trail);
        const bool onboarding=view=="onboarding";
        if(onboarding){if(!job.contains("stage")||!job["stage"].is_object())return {};const auto&s=job["stage"];for(const char*key:{"position","velocity"}){if(!s.contains(key)||!s[key].is_array()||s[key].size()!=3)return {};for(const auto&v:s[key])if(!v.is_number()||!std::isfinite(v.get<double>())||std::abs(v.get<double>())>10000)return {};}if(!s.contains("acting")||!s["acting"].is_object())return {};for(const auto&v:s["acting"])if(!v.is_number()||!std::isfinite(v.get<double>())||std::abs(v.get<double>())>180)return {};for(const char*key:{"yaw","pitch","squash","spin","clock"})if(!s.contains(key)||!s[key].is_number()||!std::isfinite(s[key].get<double>()))return {};if(std::abs(s["squash"].get<double>())>.2||s["clock"].get<double>()<0)return {};}
        const auto next=onboarding?view:outfit+";"+packed+";"+view+";"+ghost;
        const bool changed=signature!=next;
        if(changed){signature=next;models.reset_presentation();models.cosmetics(outfit,packed);inspect=0;started=now;}
        if(onboarding)models.cosmetics(outfit,packed);
        models.ghost_cosmetics(ghost);models.player_glow(job.contains("playerGlow")?native_render::parse_glow(job["playerGlow"]):std::nullopt);
        const unsigned count=job.value("inspect",0u),presses=count>=inspect?std::min(count-inspect,4u):0;inspect=count;
        GLint previous=0,viewport[4];gl.GetIntegerv(GL_FRAMEBUFFER_BINDING,&previous);gl.GetIntegerv(GL_VIEWPORT,viewport);
        struct Restore{Gl &gl;GLint target;GLint *vp;~Restore(){gl.BindFramebuffer(GL_FRAMEBUFFER,GLuint(target));gl.Viewport(vp[0],vp[1],vp[2],vp[3]);}}restore{gl,previous,viewport};
        gl.BindFramebuffer(GL_FRAMEBUFFER,framebuffer);
        if(width!=w||height!=h){width=w;height=h;gl.BindTexture(GL_TEXTURE_2D,color);gl.TexImage2D(GL_TEXTURE_2D,0,GL_RGBA8,w,h,0,GL_RGBA,GL_UNSIGNED_BYTE,nullptr);gl.TexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MIN_FILTER,GL_LINEAR);gl.TexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MAG_FILTER,GL_LINEAR);gl.FramebufferTexture2D(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_TEXTURE_2D,color,0);gl.BindRenderbuffer(GL_RENDERBUFFER,depth);gl.RenderbufferStorage(GL_RENDERBUFFER,GL_DEPTH_COMPONENT24,w,h);gl.FramebufferRenderbuffer(GL_FRAMEBUFFER,GL_DEPTH_ATTACHMENT,GL_RENDERBUFFER,depth);}
        if(gl.CheckFramebufferStatus(GL_FRAMEBUFFER)!=GL_FRAMEBUFFER_COMPLETE)return {};
        gl.Viewport(0,0,w,h);gl.ColorMask(GL_TRUE,GL_TRUE,GL_TRUE,GL_TRUE);gl.DepthMask(GL_TRUE);if(onboarding)gl.ClearColor(0,0,0,0);else gl.ClearColor(.045f,.06f,.085f,1);gl.Clear(GL_COLOR_BUFFER_BIT|GL_DEPTH_BUFFER_BIT);
        // Settle the weapon draw clip before delivering the first frame; otherwise the first
        // request can capture hands still below the camera and no animation is requested yet.
        if(changed&&!onboarding){models.draw_menu_preview(w,h,view,0,yaw,pitch,0,false);gl.Clear(GL_COLOR_BUFFER_BIT|GL_DEPTH_BUFFER_BIT);}
        if(onboarding)models.draw_onboarding_preview(w,h,job["stage"],job["stage"]["clock"],presses?1:0);
        else models.draw_menu_preview(w,h,view,2+std::max(0.,now-started),yaw,pitch,presses,job.value("held",false));
        return backbuffer_png(gl,w,h,2000000);
    }
};
