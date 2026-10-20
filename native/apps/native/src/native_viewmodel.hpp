#pragma once
#ifndef BUNNYHOP_NATIVE_ASSET_ROOT
#define BUNNYHOP_NATIVE_ASSET_ROOT "target/native-assets"
#endif
// Original meshes/pose clips and cosmetic shader recipes are compiled to data at build time.
// This runtime uses native OpenGL GPU skinning; it embeds no JavaScript or web renderer.
class NativeViewmodel {
    struct Clip {std::string name;double duration=0;size_t frames=0,offset=0;};
    struct Entry {size_t bones=0;std::vector<std::string> meshes;std::vector<Clip> clips;};
    struct Mesh {GLuint vao=0,vbo=0,ebo=0;size_t vertices=0,offset=0,indices=0,indexOffset=0;};
    struct Look {std::string outfit="outfit-cream",knife="carrot",glove="knit",gloveId="glove-knit",hat,body="classic";int finish=0,crown=0;};
    Gl &gl;GLuint bonesTexture=0;std::unordered_map<int,GLuint> programs;
    std::unordered_map<std::string,Entry> entries;std::unordered_map<std::string,Mesh> meshes;
    std::vector<std::string> weapons;std::vector<float> data,pose;nlohmann::json metadata;
    std::string vp,vm,fp,fa,fl;Look equipped;
    float fov=54,offsetX=.6f,offsetY=1.5f,offsetZ=-.9f;bool leftHand=false;
    uint32_t previousWeapon=0,previousTick=~0u;int inspectIndex=-1;bool inspectQueued=false,inspectHeld=false;uint32_t inspectPresses=0,inspectLoops=0;std::string previousEntry,action="idle";double started=0;
    const Clip *clip(const Entry &entry,const std::string &name)const{for(const auto &c:entry.clips)if(c.name==name)return &c;return entry.clips.empty()?nullptr:&entry.clips.front();}
    static std::string textFile(const std::filesystem::path &path){std::ifstream file(path);if(!file)throw std::runtime_error("Native cosmetic shader absent: "+path.string());return std::string(std::istreambuf_iterator<char>(file),{});}
    Look look(const std::string &outfit,const std::string &packed)const{
        Look out;if(metadata.at("outfits").contains(outfit))out.outfit=outfit;
        std::vector<std::string> f;std::stringstream stream(packed.size()<=200?packed:"");std::string part;while(std::getline(stream,part,';'))f.push_back(part);
        if(f.size()>=4 && (f[0]=="2" || (f[0]=="1"&&f.size()>=6))){
            const auto knife=f[1].rfind("knife-",0)==0?f[1].substr(6):f[1];if(meshes.count("fpknife:"+knife))out.knife=knife;
            if(metadata.at("finishes").contains(f[2]))out.finish=metadata["finishes"][f[2]];
            const auto id=f[f[0]=="2"?3:5];if(metadata.at("gloves").contains(id)){out.gloveId=id;out.glove=metadata["gloves"][id]["style"];}
            const size_t crown=f[0]=="2"?4:6;if(f.size()>crown && f[crown].size()==1 && f[crown][0]>='1'&&f[crown][0]<='3')out.crown=f[crown][0]-'0';
            if(f[0]=="2"){if(f.size()>5&&meshes.count(f[5]))out.hat=f[5];if(f.size()>6&&f[6]=="body-b")out.body="feminine";}
        }
        // These two character outfits ship with matching paws in the site's default loadout.
        if(out.glove=="knit"&&(out.outfit=="outfit-plush"||out.outfit=="outfit-bune")){out.glove=out.outfit.substr(7);out.gloveId="glove-"+out.glove;}
        return out;
    }
    GLuint program(const Look &look){
        const int key=look.finish+(look.glove!="knit"?32:0);if(programs.count(key))return programs.at(key);
        std::string defs="#version 330 core\n";if(look.finish)defs+="#define FINISH "+std::to_string(look.finish)+"\n";if(look.glove!="knit")defs+="#define GLOVE\n";
        const std::string vs=defs+R"(
layout(location=0)in vec3 position;layout(location=1)in vec3 normal;layout(location=2)in vec3 partColor;layout(location=3)in vec4 boneIds;layout(location=4)in vec4 weights;layout(location=5)in float accent;
uniform sampler2D boneMatrices;uniform mat4 projection,model;uniform vec3 offset,uPalette[8],uAccent;uniform float mirror;
out vec3 vColor,normalV,positionV;
)"+vp+R"(
mat4 bone(int i){vec4 a=texelFetch(boneMatrices,ivec2(0,i),0),b=texelFetch(boneMatrices,ivec2(1,i),0),c=texelFetch(boneMatrices,ivec2(2,i),0);return transpose(mat4(a,b,c,vec4(0,0,0,1)));}
void main(){mat4 m=bone(int(boneIds.x))*weights.x+bone(int(boneIds.y))*weights.y+bone(int(boneIds.z))*weights.z+bone(int(boneIds.w))*weights.w;vec3 p=(m*vec4(position,1)).xyz+offset;p.y*=mirror;vec3 n=mat3(m)*normal;n.y*=mirror;normalV=mat3(model)*n;positionV=(model*vec4(p,1)).xyz;
vColor=accent>15.5?uPalette[6]:accent>10.5?partColor:accent>2.5?uPalette[int(accent-2.5)]:accent>.5?uAccent:partColor;
)"+vm+R"(
gl_Position=projection*vec4(positionV,1);}
)";
        const std::string fs=defs+R"(
in vec3 vColor,normalV,positionV;out vec4 color;uniform vec3 cameraPosition;uniform float opacity;
)"+fp+R"(
void main(){vec3 n=normalize(normalV);float back=gl_FrontFacing?1.:.38;if(!gl_FrontFacing)n=-n;vec3 V=normalize(cameraPosition-positionV),L=normalize(vec3(.42,-.46,.78));float key=smoothstep(-.05,.55,dot(n,L));vec3 ambient=mix(vec3(.30,.27,.26),vec3(.70,.76,.88),n.z*.5+.5)*.62;vec3 albedo=vColor;
)"+fa+R"(
vec3 col=albedo*(ambient+key*vec3(.78,.74,.68));col+=pow(1.-max(dot(n,V),0.),3.)*.22*vec3(1,.86,.65);col*=back;
)"+fl+R"(
#ifdef FINISH
if(abs(vFin.z-1.)<.5)col=finishShade(vec3(n.x,n.z,-n.y),vec3(V.x,V.z,-V.y),vec3(L.x,L.z,-L.y),ambient,key)*back;
#endif
col=max(col,vec3(0));color=vec4(mix(col*12.92,1.055*pow(col,vec3(1./2.4))-.055,step(vec3(.0031308),col)),opacity);}
)";
        GLuint id=link_program(gl,vs.c_str(),fs.c_str());programs.emplace(key,id);return id;
    }
    void mesh(const std::string &name){auto at=meshes.find(name);if(at==meshes.end())return;auto &m=at->second;
        if(!m.vao){gl.GenVertexArrays(1,&m.vao);gl.BindVertexArray(m.vao);gl.GenBuffers(1,&m.vbo);gl.BindBuffer(GL_ARRAY_BUFFER,m.vbo);gl.BufferData(GL_ARRAY_BUFFER,m.vertices*22*sizeof(float),data.data()+m.offset,GL_STATIC_DRAW);
            for(int a=0;a<7;a++){const int size[7]={3,3,3,4,4,1,4},offset[7]={0,3,6,9,13,17,18};gl.EnableVertexAttribArray(a);gl.VertexAttribPointer(a,size[a],GL_FLOAT,GL_FALSE,22*sizeof(float),reinterpret_cast<void*>(size_t(offset[a])*4));}
            // finishUV is declared by generated shader source, so bind its named location separately.
            if(m.indices){gl.GenBuffers(1,&m.ebo);gl.BindBuffer(GL_ELEMENT_ARRAY_BUFFER,m.ebo);gl.BufferData(GL_ELEMENT_ARRAY_BUFFER,m.indices*4,data.data()+m.indexOffset,GL_STATIC_DRAW);}
        }gl.BindVertexArray(m.vao);if(m.indices)gl.DrawElements(GL_TRIANGLES,m.indices,GL_UNSIGNED_INT,nullptr);else gl.DrawArrays(GL_TRIANGLES,0,m.vertices);
    }
    void sample(const Entry &entry,const Clip &c,double t,bool loop){
        if(loop&&c.duration>0)t=std::fmod(std::max(0.,t),c.duration);const double frame=c.duration>0?std::clamp(t/c.duration*double(c.frames-1),0.,double(c.frames-1)):0;
        const size_t a=size_t(frame),b=std::min(a+1,c.frames-1);const float f=float(frame-a);pose.resize(entry.bones*12);for(size_t i=0;i<pose.size();i++){const float x=data[c.offset+a*pose.size()+i],y=data[c.offset+b*pose.size()+i];pose[i]=x+(y-x)*f;}
        gl.ActiveTexture(GL_TEXTURE0);gl.BindTexture(GL_TEXTURE_2D,bonesTexture);gl.TexImage2D(GL_TEXTURE_2D,0,GL_RGBA32F,3,entry.bones,0,GL_RGBA,GL_FLOAT,pose.data());
    }
    static void linearColor(uint32_t hex,float *out){for(int k=0;k<3;k++){float c=float((hex>>(16-k*8))&255)/255;out[k]=c<=.04045f?c/12.92f:std::pow((c+.055f)/1.055f,2.4f);}}
    GLuint bind(const Look &look,const native::Matrix &projection,const native::Matrix &model,const float eye[3],double seconds,float opacity,const float offset[3],float mirror){
        GLuint p=program(look);gl.UseProgram(p);auto loc=[&](const char *n){return gl.GetUniformLocation(p,n);};gl.UniformMatrix4fv(loc("projection"),1,GL_FALSE,projection.data());gl.UniformMatrix4fv(loc("model"),1,GL_FALSE,model.data());gl.Uniform3fv(loc("offset"),1,offset);gl.Uniform3fv(loc("cameraPosition"),1,eye);gl.Uniform1f(loc("mirror"),mirror);gl.Uniform1f(loc("opacity"),opacity);gl.Uniform1f(loc("uFinTime"),seconds);gl.Uniform1i(loc("boneMatrices"),0);
        const auto &pal=metadata.at("outfits").at(look.outfit);const char *slots[]={"hoodie","trim","pants","pantsTrim","shoe","face","glove","detail"};float colors[24],accent[3];for(int i=0;i<8;i++)linearColor(pal.at(slots[i]),colors+i*3);linearColor(pal.at("accent"),accent);gl.Uniform3fv(loc("uPalette"),8,colors);gl.Uniform3fv(loc("uAccent"),1,accent);
        const auto &g=metadata.at("gloves").at(look.gloveId);const char *gs[]={"base","fingers","tips","strap","detail"};float gc[15];for(int i=0;i<5;i++)linearColor(g.at(gs[i]),gc+i*3);gl.Uniform3fv(loc("uGlove"),5,gc);return p;
    }
public:
    explicit NativeViewmodel(Gl &g,const std::filesystem::path &assetRoot=BUNNYHOP_NATIVE_ASSET_ROOT):gl(g){
        std::ifstream file(assetRoot/"viewmodels.json");if(!file)throw std::runtime_error("Native asset bundle absent; run native asset compiler");file>>metadata;if(metadata.at("version")!=2||metadata.at("stride")!=22)throw std::runtime_error("Unsupported native asset format");
        const size_t bytes=metadata.value("bytes",size_t(0));if(bytes){if(bytes>768*1024*1024||bytes%4)throw std::runtime_error("Invalid native asset length");std::ifstream binary(assetRoot/"viewmodels.bin.z",std::ios::binary);std::vector<uint8_t> compressed(std::istreambuf_iterator<char>(binary),{});data.resize(bytes/4);uLongf count=bytes;if(uncompress(reinterpret_cast<Bytef*>(data.data()),&count,compressed.data(),compressed.size())!=Z_OK||count!=bytes)throw std::runtime_error("Invalid compressed native assets");}
        else{std::ifstream binary(assetRoot/"viewmodels.bin",std::ios::binary|std::ios::ate);const auto n=binary.tellg();if(!binary||n<0||n>768*1024*1024||n%4)throw std::runtime_error("Invalid native assets");data.resize(size_t(n)/4);binary.seekg(0);binary.read(reinterpret_cast<char*>(data.data()),n);if(!binary)throw std::runtime_error("Truncated native assets");}
        weapons=metadata.at("weapons").get<std::vector<std::string>>();
        for(const auto &[name,raw]:metadata.at("meshes").items()){Mesh m;m.vertices=raw.at("vertices");m.offset=size_t(raw.at("offset"))/4;m.indices=raw.value("indices",size_t(0));m.indexOffset=raw.value("indexOffset",size_t(0))/4;if(!m.vertices||m.vertices>4000000||m.offset+m.vertices*22>data.size()||m.indexOffset+m.indices>data.size())throw std::runtime_error("Invalid native mesh range");meshes.emplace(name,m);}
        for(const auto &[name,raw]:metadata.at("entries").items()){Entry e;e.bones=raw.at("bones");e.meshes=raw.at("meshes").get<std::vector<std::string>>();if(!e.bones||e.bones>256)throw std::runtime_error("Invalid native rig");for(const auto &c:raw.at("clips")){Clip t{c.at("name"),c.at("duration"),c.at("frames"),size_t(c.at("offset"))/4};if(!t.frames||t.frames>1024||!std::isfinite(t.duration)||t.duration<0||t.offset+t.frames*e.bones*12>data.size())throw std::runtime_error("Invalid native pose range");e.clips.push_back(t);}entries.emplace(name,std::move(e));}
        vp=textFile(assetRoot/"cosmetic-vertex-pars.glsl");vp=std::string(vp).replace(vp.find("in vec4 finishUV;"),17,"layout(location=6)in vec4 finishUV;");vm=textFile(assetRoot/"cosmetic-vertex-main.glsl");fp=textFile(assetRoot/"cosmetic-fragment-pars.glsl");fa=textFile(assetRoot/"cosmetic-fragment-albedo.glsl");fl=textFile(assetRoot/"cosmetic-fragment-light.glsl");
        gl.GenTextures(1,&bonesTexture);gl.BindTexture(GL_TEXTURE_2D,bonesTexture);gl.TexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MIN_FILTER,GL_NEAREST);gl.TexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MAG_FILTER,GL_NEAREST);program(equipped);
        std::cout<<"Native models: "<<meshes.size()<<" original meshes, "<<entries.size()<<" pose sets, GPU skinning/cosmetics\n";
    }
    ~NativeViewmodel(){for(auto &[name,m]:meshes){if(m.ebo)gl.DeleteBuffers(1,&m.ebo);if(m.vbo)gl.DeleteBuffers(1,&m.vbo);if(m.vao)gl.DeleteVertexArrays(1,&m.vao);}for(auto [key,p]:programs)gl.DeleteProgram(p);if(bonesTexture)gl.DeleteTextures(1,&bonesTexture);}
    void cosmetics(const std::string &outfit,const std::string &packed){equipped=look(outfit,packed);}
    void settings(float field,float x,float y,float z,bool left){if(!std::isfinite(field)||!std::isfinite(x)||!std::isfinite(y)||!std::isfinite(z))return;fov=std::clamp(field,30.f,100.f);offsetX=std::clamp(x,-10.f,10.f);offsetY=std::clamp(y,-10.f,10.f);offsetZ=std::clamp(z,-10.f,10.f);leftHand=left;}
    void reset_presentation(){previousWeapon=0;previousTick=~0u;previousEntry.clear();action="idle";started=0;inspectIndex=-1;inspectQueued=inspectHeld=false;inspectPresses=inspectLoops=0;}
    void inspect_press(){inspectPresses=std::min(inspectPresses+1,4u);}
    void inspect_held(bool held){inspectHeld=held;}
    void draw_floor(const BhFloorWeapon &weapon,const native::Matrix &projection,const float eye[3],double seconds){
        if(!weapon.weapon||weapon.weapon>=weapons.size()||weapons[weapon.weapon].empty()||weapons[weapon.weapon]=="knife")return;const float identity[12]={1,0,0,0,0,1,0,0,0,0,1,0};gl.ActiveTexture(GL_TEXTURE0);gl.BindTexture(GL_TEXTURE_2D,bonesTexture);gl.TexImage2D(GL_TEXTURE_2D,0,GL_RGBA32F,3,1,0,GL_RGBA,GL_FLOAT,identity);BhTransform t{};std::copy(weapon.position,weapon.position+3,t.origin);std::copy(weapon.angles,weapon.angles+3,t.angles);const float zero[3]={};Look plain;bind(plain,projection,native::model_matrix(t),eye,seconds,1,zero,1);gl.Enable(GL_DEPTH_TEST);gl.DepthMask(GL_TRUE);gl.Disable(GL_BLEND);gl.Disable(GL_CULL_FACE);mesh("worldgun:"+weapons[weapon.weapon]);
    }
    void draw_actor(const native_render::Actor &actor,const native::Matrix &projection,const float eye[3],double seconds){
        if(!std::isfinite(actor.opacity)||actor.opacity<=0)return;for(float v:actor.frame.position)if(!std::isfinite(v))return;for(float v:actor.frame.velocity)if(!std::isfinite(v))return;if(!std::isfinite(actor.frame.yaw)||!std::isfinite(actor.frame.pitch))return;
        const auto l=look(actor.outfit,actor.loadout);const auto &entry=entries.at("bunny");const auto &frame=actor.frame;const float speed=std::hypot(frame.velocity[0],frame.velocity[1]);const std::string gait=frame.flags&1?"crouch":!(frame.flags&2)?(frame.velocity[2]>0?"air":"fall"):speed>5?"run":"idle";const double phase=seconds*(gait=="run"?std::clamp(speed/250.f,.1f,3.f):1);const auto *c=clip(entry,gait+":0");if(!c)return;sample(entry,*c,phase,true);if(std::isfinite(frame.pitch)&&std::abs(frame.pitch)>.01){auto base=pose;const auto *tilt=clip(entry,gait+(frame.pitch<0?":-60":":60"));sample(entry,*tilt,phase,true);const float amount=std::min(std::abs(frame.pitch)/60.f,1.f);for(size_t i=0;i<pose.size();i++)pose[i]=base[i]+(pose[i]-base[i])*amount;gl.TexImage2D(GL_TEXTURE_2D,0,GL_RGBA32F,3,entry.bones,0,GL_RGBA,GL_FLOAT,pose.data());}
        BhTransform t{};std::copy(frame.position,frame.position+3,t.origin);t.angles[1]=frame.yaw;const auto model=native::model_matrix(t);const float zero[3]={};bind(l,projection,model,eye,seconds,std::clamp(actor.opacity,0.f,1.f),zero,1);
        std::string body=l.outfit=="outfit-tek"?"tek":l.outfit=="outfit-plush"?"plush":l.outfit=="outfit-bune"?"bune":"bunny";std::vector<std::string> parts={"body:"+body+":"+(body=="bunny"?l.body:"classic")+":"+l.glove};if(l.crown)parts.push_back("crown:"+std::to_string(l.crown));if(!l.hat.empty())parts.push_back(l.hat);const auto gun=frame.weapon<weapons.size()?weapons[frame.weapon]:"";parts.push_back(gun.empty()||gun=="knife"?"tpknife:"+l.knife:"tpgun:"+gun);
        gl.Enable(GL_DEPTH_TEST);gl.Disable(GL_CULL_FACE);gl.DepthFunc(GL_LEQUAL);
        if(actor.opacity<1){gl.ColorMask(GL_FALSE,GL_FALSE,GL_FALSE,GL_FALSE);gl.Disable(GL_BLEND);gl.DepthMask(GL_TRUE);for(const auto &part:parts)mesh(part);gl.ColorMask(GL_TRUE,GL_TRUE,GL_TRUE,GL_TRUE);gl.Enable(GL_BLEND);gl.BlendFunc(GL_SRC_ALPHA,GL_ONE_MINUS_SRC_ALPHA);gl.DepthMask(GL_FALSE);}else{gl.Disable(GL_BLEND);gl.DepthMask(GL_TRUE);}for(const auto &part:parts)mesh(part);gl.DepthMask(GL_TRUE);gl.Disable(GL_BLEND);
    }
    void draw(int width,int height,const BhSnapshot &snapshot,uint32_t active,uint32_t flags,bool shot,uint32_t mode,double seconds){
        if(active>=weapons.size()||!active)return;const auto name=active==1?"knife:"+equipped.knife+":"+equipped.glove:"gun:"+weapons[active]+":"+equipped.glove;const auto at=entries.find(name);if(at==entries.end())return;const auto &entry=at->second;
        if(active!=previousWeapon||previousEntry!=name){action="draw";started=seconds;previousWeapon=active;previousEntry=name;inspectIndex=-1;inspectQueued=false;}
        if(snapshot.player.tick!=previousTick){if(shot){inspectIndex=-1;inspectQueued=false;action=active==1?(mode==2?"stab":snapshot.player.tick%2?"slash1":"slash2"):"fire";started=seconds;}else if(flags&4){inspectIndex=-1;inspectQueued=false;action="reload";started=seconds;}previousTick=snapshot.player.tick;}
        if(active==1){const auto &chain=metadata.at("inspects").at(equipped.knife);
            if(inspectPresses){if(inspectIndex<0){inspectIndex=0;action="inspect0";started=seconds;inspectLoops=0;}else if(size_t(inspectIndex+1)<chain.size())inspectQueued=true;inspectPresses=0;}
            if(inspectIndex>=0){const auto &spec=chain.at(inspectIndex);double t=std::max(0.,seconds-started);if(inspectHeld&&!inspectQueued&&spec.contains("loop")&&!spec["loop"].is_null()&&inspectLoops<6){const double from=spec["loop"][0],to=spec["loop"][1];if(t>=to&&to>from){started+=to-from;t-=to-from;inspectLoops++;}}if(inspectQueued&&t>=spec.at("exit").get<double>()&&size_t(inspectIndex+1)<chain.size()){inspectIndex++;action="inspect"+std::to_string(inspectIndex);started=seconds-chain.at(inspectIndex).at("enter").get<double>();inspectLoops=0;inspectQueued=false;}else if(t>=spec.at("duration").get<double>()){inspectIndex=-1;inspectQueued=false;action="idle";started=seconds;}}
        }else{inspectIndex=-1;inspectPresses=0;}
        const Clip *c=clip(entry,action);if(!c)return;double time=std::max(0.,seconds-started);if(c->duration>0&&time>=c->duration){action="idle";c=clip(entry,action);time=0;}sample(entry,*c,time,false);
        gl.Clear(GL_DEPTH_BUFFER_BIT);gl.Enable(GL_DEPTH_TEST);gl.DepthMask(GL_TRUE);gl.Disable(GL_BLEND);gl.Disable(GL_CULL_FACE);
        const float cot=(4.f/3.f)/std::tan(float(fov*native::radians*.5));const native::Matrix perspective={cot/(float(width)/height),0,0,0,0,cot,0,0,0,0,-1.00376f,-1,0,0,-1.50282f,0},sourceView={0,0,-1,0,-1,0,0,0,0,1,0,0,0,0,0,1};
        const float speed=std::hypot(snapshot.player.velocity[0],snapshot.player.velocity[1]),bob=std::min(speed/350.f,1.f);const float offset[3]={offsetY,-offsetX+float(std::sin(seconds*7))*.15f*bob,offsetZ+float(std::abs(std::sin(seconds*7)))*.28f*bob},eye[3]={};bind(equipped,native::multiply(perspective,sourceView),native::identity(),eye,seconds,1,offset,leftHand?-1:1);gl.FrontFace(leftHand?GL_CW:GL_CCW);for(const auto &part:entry.meshes)mesh(part);gl.FrontFace(GL_CCW);
    }
};
