#pragma once
// Port of web viewmodel/inspects/{combo,third}.ts. Knife-local authored tracks remain at 60 Hz;
// elbow presentation and knife conjugation are evaluated on the current locomotion pose.
#include "actor_anim.hpp"
#include <optional>
namespace native_tp {
using J=nlohmann::json;using V=std::array<double,3>;using M=std::array<float,12>;using Q=std::array<double,4>;
inline M identity(){return {1,0,0,0,0,1,0,0,0,0,1,0};}
inline double smooth(double x){x=std::clamp(x,0.,1.);return x*x*(3-2*x);}
inline V sub(V a,V b){return {a[0]-b[0],a[1]-b[1],a[2]-b[2]};}
inline double dot(V a,V b){return a[0]*b[0]+a[1]*b[1]+a[2]*b[2];}
inline V cross(V a,V b){return {a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]};}
inline V norm(V v){double l=std::sqrt(dot(v,v));if(l<1e-9)l=1;for(auto &x:v)x/=l;return v;}
inline V pos(const M&m){return {m[3],m[7],m[11]};}
inline V turn(const M&m,V v){V o{};for(int r=0;r<3;r++)for(int c=0;c<3;c++)o[r]+=m[r*4+c]*v[c];return o;}
inline void concat(const float*a,const float*b,float*out){M o;for(int r=0;r<3;r++)for(int c=0;c<4;c++)o[r*4+c]=float(double(a[r*4])*b[c]+double(a[r*4+1])*b[4+c]+double(a[r*4+2])*b[8+c]+(c==3?a[r*4+3]:0));std::copy(o.begin(),o.end(),out);}
inline M mul(const M&a,const M&b){M o;concat(a.data(),b.data(),o.data());return o;}
inline M inverse(const M&m){M o{};for(int r=0;r<3;r++){for(int c=0;c<3;c++)o[r*4+c]=m[c*4+r];o[r*4+3]=float(-(double(o[r*4])*m[3]+double(o[r*4+1])*m[7]+double(o[r*4+2])*m[11]));}return o;}
inline M rotation(V a,double angle,V p){double x=a[0],y=a[1],z=a[2],c=std::cos(angle),s=std::sin(angle),t=1-c;double v[9]={t*x*x+c,t*x*y-s*z,t*x*z+s*y,t*x*y+s*z,t*y*y+c,t*y*z-s*x,t*x*z-s*y,t*y*z+s*x,t*z*z+c};M m{};for(int r=0;r<3;r++){for(int k=0;k<3;k++)m[r*4+k]=float(v[r*3+k]);m[r*4+3]=float(p[r]-(v[r*3]*p[0]+v[r*3+1]*p[1]+v[r*3+2]*p[2]));}return m;}
inline Q quat(const M&m){const double a=m[0],b=m[5],c=m[10],m01=m[1],m02=m[2],m10=m[4],m12=m[6],m20=m[8],m21=m[9],tr=a+b+c;Q q{};if(tr>0){double s=std::sqrt(tr+1)*2;q={(m21-m12)/s,(m02-m20)/s,(m10-m01)/s,.25*s};}else if(a>b&&a>c){double s=std::sqrt(1+a-b-c)*2;q={.25*s,(m01+m10)/s,(m02+m20)/s,(m21-m12)/s};}else if(b>c){double s=std::sqrt(1+b-a-c)*2;q={(m01+m10)/s,.25*s,(m12+m21)/s,(m02-m20)/s};}else{double s=std::sqrt(1+c-a-b)*2;q={(m02+m20)/s,(m12+m21)/s,.25*s,(m10-m01)/s};}return q;}
inline M matrix(Q q,V p){double l=std::sqrt(q[0]*q[0]+q[1]*q[1]+q[2]*q[2]+q[3]*q[3]);if(!l)l=1;for(auto &v:q)v/=l;auto [x,y,z,w]=q;return {float(1-2*(y*y+z*z)),float(2*(x*y-z*w)),float(2*(x*z+y*w)),float(p[0]),float(2*(x*y+z*w)),float(1-2*(x*x+z*z)),float(2*(y*z-x*w)),float(p[1]),float(2*(x*z-y*w)),float(2*(y*z+x*w)),float(1-2*(x*x+y*y)),float(p[2])};}
inline M blend(const M&a,const M&b,double w){auto qa=quat(a),qb=quat(b);for(int i=0;i<4;i++){qa[i]=float(qa[i]);qb[i]=float(qb[i]);}double d=0;for(int i=0;i<4;i++)d+=qa[i]*qb[i];for(int i=0;i<4;i++)qa[i]+=(qb[i]*(d<0?-1:1)-qa[i])*w;V p;for(int i=0;i<3;i++)p[i]=a[i*4+3]+(b[i*4+3]-a[i*4+3])*w;return matrix(qa,p);}
struct Slot{int trick=0;double t=0;};
struct Combo {
 std::optional<Slot> cur,prev;double prevT=0,fade=0,fadeLen=0;bool buffered=false,queued=false;unsigned loops=0;
 bool active()const{return cur&&fadeLen==0;}
 void reset(){cur.reset();prev.reset();fadeLen=0;buffered=queued=false;loops=0;}
 void begin(int trick,double t){prev=cur;prevT=0;cur=Slot{trick,t};fadeLen=0;buffered=queued=false;loops=0;}
 void advance(const J&clips){int n=cur->trick+1;begin(n,clips[n]["enter"]);}
 void remote(int signal,const J&clips){if(clips.empty())return;if(signal==1)begin(0,0);else if(signal==2){if(active()){if(size_t(cur->trick+1)<clips.size())advance(clips);}else if(clips.size()>1)begin(1,clips[1]["enter"]);}}
 void press(const J&clips){if(clips.empty())return;if(!active()){begin(0,0);return;}if(size_t(cur->trick+1)>=clips.size()||queued)return;const auto&s=clips[cur->trick];if(cur->t>=s["exit"].get<double>())advance(clips);else if(cur->t>=s["open"].get<double>())queued=true;else buffered=true;}
 void cancel(){buffered=queued=false;if(active()){fadeLen=.065;fade=0;}}
 void update(double dt,bool held,const J&spec){if(!cur)return;if(fadeLen>0){fade+=dt;if(fade>=fadeLen)reset();return;}const auto&clips=spec["clips"];if(prev){prevT+=dt;prev->t=std::min(prev->t+dt,clips[prev->trick]["len"].get<double>());if(prevT>=.14)prev.reset();}auto&s=clips[cur->trick];double t0=cur->t,t1=t0+dt;if(buffered&&t1>=s["open"].get<double>()){buffered=false;if(size_t(cur->trick+1)<clips.size())queued=true;}if(!s["loop"].is_null()&&held&&!queued&&loops<spec.value("maxLoops",6u)){double from=s["loop"][0],to=s["loop"][1];if(t0<=to&&t1>to){cur->t=from+t1-to;loops++;return;}}if(queued&&t1>=s["exit"].get<double>()){double rest=t1-s["exit"].get<double>();cur->t=s["exit"];advance(clips);cur->t=std::min(clips[cur->trick]["len"].get<double>(),cur->t+rest);return;}if(t1>=s["len"].get<double>()){reset();return;}cur->t=t1;}
 double weight()const{return !cur?0:fadeLen>0?1-smooth(fade/fadeLen):1;}
 double mix()const{return prev&&fadeLen==0?smooth(prevT/.14):1;}
};
inline M sample(const J&clip,double t){const auto&q=clip["q"];const auto&p=clip["p"];int n=clip["n"];double f=std::clamp(t*60,0.,double(n-1));int i=std::min(n-2,int(std::floor(f)));double u=std::max(0.,f-i);Q v;V tr;for(int k=0;k<4;k++)v[k]=q[i*4+k].get<double>()+(q[i*4+4+k].get<double>()-q[i*4+k].get<double>())*u;for(int k=0;k<3;k++)tr[k]=p[i*3+k].get<double>()+(p[i*3+3+k].get<double>()-p[i*3+k].get<double>())*u;return matrix(v,tr);}
inline double presented(double t,const J&c){double enter=c["enter"],exit=c["exit"],len=c["len"];if(t<=0||t>=len)return 0;if(t<enter)return 1-std::pow(1-t/enter,3);if(t>exit)return 1-smooth((t-exit)/(len-exit));return 1;}
inline void apply(const Combo&combo,const J&spec,const std::vector<std::string>&names,const std::vector<int>&parents,const std::vector<float>&bind,std::vector<float>&skin){
 if(!combo.cur||combo.weight()<=0)return;auto index=[&](const char*n){auto at=std::find(names.begin(),names.end(),n);return at==names.end()?-1:int(at-names.begin());};
 int fore=index("ValveBiped.Bip01_R_Forearm"),hand=index("ValveBiped.Bip01_R_Hand"),knife=index("bunny.Knife");if(fore<0||hand<0||knife<0||skin.size()!=bind.size())return;
 auto posed=[&](int i){M o;concat(skin.data()+i*12,bind.data()+i*12,o.data());return o;};auto pre=[&](int i,const M&m){M o;concat(m.data(),skin.data()+i*12,o.data());std::copy(o.begin(),o.end(),skin.begin()+i*12);};
 const auto&clips=spec["clips"];const auto&cc=clips[combo.cur->trick];double p=presented(combo.cur->t,cc),w=combo.weight();M D=sample(cc,combo.cur->t);if(combo.prev&&combo.fadeLen==0){double mix=combo.mix();const auto&pc=clips[combo.prev->trick];p=presented(combo.prev->t,pc)*(1-mix)+p*mix;D=blend(sample(pc,combo.prev->t),D,mix);}p*=w;if(w<1)D=blend(identity(),D,w);
 M A=posed(fore),B=posed(hand);V elbow=pos(A),dir=norm(sub(pos(B),elbow));if(p>1e-3){V target=norm({1,.55,.62}),ax=cross(dir,target);double s=std::sqrt(dot(ax,ax)),angle=std::atan2(s,dot(dir,target))*.75*p;M m=s>1e-6?rotation(norm(ax),angle,elbow):identity();M P=mul(rotation(norm(turn(m,dir)),-70*p*3.141592653589793/180,elbow),m);for(size_t i=0;i<names.size();i++){int ancestor=int(i);while(ancestor>=0&&ancestor!=fore)ancestor=parents[ancestor];if(ancestor==fore&&int(i)!=knife)pre(int(i),P);}pre(knife,P);}
 B=posed(hand);const auto&tp=spec["tp"];V z=norm(tp["z"].get<V>()),y0=tp["y"].get<V>();double yd=dot(y0,z);V y=norm({y0[0]-z[0]*yd,y0[1]-z[1]*yd,y0[2]-z[2]*yd}),x=cross(y,z),o=tp["o"].get<V>();M G={float(x[0]),float(y[0]),float(z[0]),float(o[0]),float(x[1]),float(y[1]),float(z[1]),float(o[1]),float(x[2]),float(y[2]),float(z[2]),float(o[2])};M F=mul(B,G);for(int k:{3,7,11})D[k]=float(D[k]*tp["s"].get<double>());pre(knife,mul(mul(F,D),inverse(F)));
}
} // namespace native_tp
