#pragma once
#include "bunnyhop_native.h"
#include "client_util.hpp"
#include <curl/curl.h>
#include <nlohmann/json.hpp>
#include <atomic>
#include <chrono>
#include <fstream>
#include <future>
#include <mutex>
#include <regex>
#include <set>

namespace native::updates {
using Json=nlohmann::json;
inline std::string platform(){
#if defined(__APPLE__)
 const char *os="darwin";
#elif defined(_WIN32)
 const char *os="win32";
#else
 const char *os="linux";
#endif
#if defined(__aarch64__) || defined(_M_ARM64)
 return std::string(os)+"/arm64";
#else
 return std::string(os)+"/x64";
#endif
}
inline std::string origin(const std::string &url){
 if(!url.starts_with("https://")||url.size()>4096||url.find_first_of("\\\r\n\t ")!=std::string::npos||url.find('\0')!=std::string::npos||url.find('#')!=std::string::npos)throw std::runtime_error("Update URL must use HTTPS");
 const auto end=url.find_first_of("/?",8);auto host=url.substr(8,end==std::string::npos?end:end-8);
 if(host.empty()||host.find('@')!=std::string::npos||host.find_first_not_of("abcdefghijklmnopqrstuvwxyz0123456789.-:")!=std::string::npos)throw std::runtime_error("Invalid update host");
 if(host.ends_with(":443"))host.resize(host.size()-4);if(host.find(':')!=std::string::npos)throw std::runtime_error("Update URL must use port 443");
 return "https://"+host;
}
inline void allowed(const std::string &url,const Json &trust){const auto host=origin(url);bool ok=false;for(const auto &v:trust.at("downloadOrigins"))if(v.is_string()&&origin(v.get<std::string>())==host)ok=true;if(!ok)throw std::runtime_error("Update URL outside pinned download origins");}
inline int64_t timestamp(const std::string &value){
 static const std::regex pattern(R"(^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$)");std::smatch m;
 if(!std::regex_match(value,m,pattern))throw std::runtime_error("Invalid release date");
 int y=std::stoi(m[1]),mo=std::stoi(m[2]),d=std::stoi(m[3]),h=std::stoi(m[4]),mi=std::stoi(m[5]),s=std::stoi(m[6]);
 const std::chrono::year_month_day day{std::chrono::year(y),std::chrono::month(unsigned(mo)),std::chrono::day(unsigned(d))};
 if(!day.ok()||h>23||mi>59||s>59)throw std::runtime_error("Invalid release date");
 return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::sys_days(day).time_since_epoch()).count()+h*3600+mi*60+s;
}
inline int64_t unix_time(){return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();}
inline std::vector<uint8_t> public_key(const std::string &pem){
 const std::string first="-----BEGIN PUBLIC KEY-----",last="-----END PUBLIC KEY-----";
 if(!pem.starts_with(first))throw std::runtime_error("Release key must be an Ed25519 public key");auto end=pem.find(last,first.size());if(end==std::string::npos)throw std::runtime_error("Malformed release key");
 std::string text;for(char c:pem.substr(first.size(),end-first.size()))if(c!='\n'&&c!='\r'&&c!=' '&&c!='\t')text+=c;
 auto bytes=decode_base64(text);const uint8_t prefix[]={0x30,0x2a,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x03,0x21,0x00};
 if(bytes.size()!=44||!std::equal(std::begin(prefix),std::end(prefix),bytes.begin()))throw std::runtime_error("Release key must be Ed25519 SPKI");return {bytes.begin()+12,bytes.end()};
}
inline Json verify_manifest(const std::string &text,const Json &trust,int64_t now=unix_time()){
 if(text.size()>128*1024||trust.value("schema",0)!=1)throw std::runtime_error("Invalid release envelope/configuration");
 const auto e=Json::parse(text);const auto id=e.at("keyId").get<std::string>();std::vector<uint8_t> key;
 for(const auto &entry:trust.at("keys"))if(entry.at("id")==id){key=public_key(entry.at("publicKey").get<std::string>());break;}
 if(key.empty())throw std::runtime_error("Release key is not pinned");
 auto bytes=decode_base64(e.at("payload").get<std::string>()),signature=decode_base64(e.at("signature").get<std::string>());
 if(bytes.size()>65536||signature.size()!=64||!bh_verify_release_signature(key.data(),signature.data(),bytes.data(),bytes.size()))throw std::runtime_error("Release signature is invalid");
 auto m=Json::parse(bytes);const auto created=timestamp(m.at("createdAt").get<std::string>()),expires=timestamp(m.at("expiresAt").get<std::string>());
 static const std::regex version(R"(^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$)");
 if(m.at("schema")!=1||!std::regex_match(m.at("version").get<std::string>(),version)||created>now+300||expires<=now||expires<=created||expires-created>31*86400)throw std::runtime_error("Release manifest is invalid or expired");
 const auto &artifacts=m.at("artifacts");if(!artifacts.is_array()||artifacts.empty()||artifacts.size()>12)throw std::runtime_error("Invalid release artifacts");std::set<std::string> platforms;
 static const std::regex platforms_re(R"(^(darwin|win32|linux)/(x64|arm64)$)"),file_re(R"(^[A-Za-z0-9][A-Za-z0-9_.-]{0,200}\.(zip|tar\.gz)$)"),hash_re("^[a-f0-9]{64}$"),build_re("^bunnyhop-native/[a-f0-9]{24}$");
 for(const auto &a:artifacts){const auto p=a.at("platform").get<std::string>();
  if(!std::regex_match(p,platforms_re)||!platforms.insert(p).second||!std::regex_match(a.at("filename").get<std::string>(),file_re)||!std::regex_match(a.at("sha256").get<std::string>(),hash_re)||!std::regex_match(a.at("build").get<std::string>(),build_re)||!a.at("bytes").is_number_unsigned()||a.at("bytes").get<uint64_t>()==0||a.at("bytes").get<uint64_t>()>512*1024*1024)throw std::runtime_error("Invalid release artifact metadata");allowed(a.at("url").get<std::string>(),trust);
 }return m;
}
// A semver downgrade is never offered. Prerelease identifiers compare according to SemVer.
inline bool newer(const std::string &candidate,const std::string &current){
 static const std::regex re(R"(^(\d+)\.(\d+)\.(\d+)(?:-([A-Za-z0-9.-]+))?$)");std::smatch a,b;
 if(!std::regex_match(candidate,a,re))return false;if(!std::regex_match(current,b,re))return true;
 auto number=[](std::string x){auto i=x.find_first_not_of('0');return i==std::string::npos?std::string("0"):x.substr(i);};
 auto compare=[&](const std::string &x,const std::string &y){auto n=number(x),m=number(y);return n.size()!=m.size()?(n.size()>m.size()?1:-1):n==m?0:n>m?1:-1;};
 for(int i=1;i<=3;i++){int c=compare(a[i],b[i]);if(c)return c>0;}
 std::string x=a[4],y=b[4];if(x.empty()||y.empty())return x.empty()&&!y.empty();
 auto parts=[](const std::string &s){std::vector<std::string> v;size_t at=0;while(at<=s.size()){auto end=s.find('.',at);v.push_back(s.substr(at,end==std::string::npos?end:end-at));if(end==std::string::npos)break;at=end+1;}return v;};
 auto av=parts(x),bv=parts(y);for(size_t i=0;i<(std::min)(av.size(),bv.size());i++){if(av[i]==bv[i])continue;bool an=av[i].find_first_not_of("0123456789")==std::string::npos,bn=bv[i].find_first_not_of("0123456789")==std::string::npos;if(an!=bn)return !an;if(an)return compare(av[i],bv[i])>0;return av[i]>bv[i];}return av.size()>bv.size();
}
struct Transfer {std::string bytes;std::ofstream *file=nullptr;uint64_t limit=0,total=0;std::atomic_bool *cancel=nullptr;std::atomic_uint64_t *progress=nullptr;};
inline size_t receive(char *data,size_t size,size_t count,void *opaque)noexcept{auto &t=*static_cast<Transfer*>(opaque);if(size&&count>SIZE_MAX/size)return 0;const auto n=size*count;if(t.cancel->load()||n>t.limit-t.total)return 0;try{if(t.file){t.file->write(data,std::streamsize(n));if(!*t.file)return 0;}else t.bytes.append(data,n);t.total+=n;if(t.progress)t.progress->store(t.total);return n;}catch(...){return 0;}}
inline int progress(void *opaque,curl_off_t,curl_off_t,curl_off_t,curl_off_t){return static_cast<Transfer*>(opaque)->cancel->load()?1:0;}
inline void fetch(std::string url,const Json &trust,Transfer &transfer){
 for(int redirects=0;redirects<6;redirects++){
  allowed(url,trust);std::unique_ptr<CURL,decltype(&curl_easy_cleanup)> handle(curl_easy_init(),curl_easy_cleanup);if(!handle)throw std::runtime_error("Cannot initialize update download");
  curl_easy_setopt(handle.get(),CURLOPT_URL,url.c_str());curl_easy_setopt(handle.get(),CURLOPT_PROTOCOLS_STR,"https");curl_easy_setopt(handle.get(),CURLOPT_FOLLOWLOCATION,0L);curl_easy_setopt(handle.get(),CURLOPT_FAILONERROR,1L);curl_easy_setopt(handle.get(),CURLOPT_NOSIGNAL,1L);curl_easy_setopt(handle.get(),CURLOPT_CONNECTTIMEOUT,15L);curl_easy_setopt(handle.get(),CURLOPT_TIMEOUT,300L);curl_easy_setopt(handle.get(),CURLOPT_LOW_SPEED_LIMIT,1024L);curl_easy_setopt(handle.get(),CURLOPT_LOW_SPEED_TIME,30L);curl_easy_setopt(handle.get(),CURLOPT_NOPROGRESS,0L);curl_easy_setopt(handle.get(),CURLOPT_XFERINFOFUNCTION,progress);curl_easy_setopt(handle.get(),CURLOPT_XFERINFODATA,&transfer);
  // Redirect bodies must never be appended to the signed artifact. Headers tell the sink whether to discard them.
  struct Response{Transfer *transfer;bool discard=false;} response{&transfer};
  curl_easy_setopt(handle.get(),CURLOPT_HEADERFUNCTION,+[](char *data,size_t size,size_t count,void *opaque)->size_t{if(size&&count>SIZE_MAX/size)return 0;auto &r=*static_cast<Response*>(opaque);const std::string_view line(data,size*count);if(line.starts_with("HTTP/")){const auto space=line.find(' ');r.discard=space!=std::string_view::npos&&line.substr(space+1,1)=="3";}return size*count;});curl_easy_setopt(handle.get(),CURLOPT_HEADERDATA,&response);
  curl_easy_setopt(handle.get(),CURLOPT_WRITEFUNCTION,+[](char *d,size_t s,size_t n,void *o)->size_t{auto &r=*static_cast<Response*>(o);if(s&&n>SIZE_MAX/s)return 0;return r.discard?s*n:receive(d,s,n,r.transfer);});curl_easy_setopt(handle.get(),CURLOPT_WRITEDATA,&response);
  const auto result=curl_easy_perform(handle.get());long status=0;curl_easy_getinfo(handle.get(),CURLINFO_RESPONSE_CODE,&status);if(transfer.cancel->load())throw std::runtime_error("Update cancelled");
  if(result!=CURLE_OK)throw std::runtime_error(std::string("Update download failed: ")+curl_easy_strerror(result));
  if(status>=300&&status<400){char *next=nullptr;curl_easy_getinfo(handle.get(),CURLINFO_REDIRECT_URL,&next);if(!next)throw std::runtime_error("Update redirect has no destination");url=next;continue;}
  if(status!=200)throw std::runtime_error("Update download returned HTTP "+std::to_string(status));return;
 }throw std::runtime_error("Too many update redirects");
}
class Service {
 Json trust_,state_,manifest_,artifact_;std::filesystem::path directory_,downloaded_;std::string current_version_,build_;
 std::mutex mutex_;std::future<void> worker_;std::atomic_bool cancel_{false};std::atomic_uint64_t received_{0};bool busy_=false;
 void set(Json value){std::lock_guard lock(mutex_);state_=std::move(value);}
 void reap(){if(worker_.valid()&&worker_.wait_for(std::chrono::seconds(0))==std::future_status::ready){worker_.get();busy_=false;}}
 template<class Work> void launch(Work work){try{worker_=std::async(std::launch::async,std::move(work));}catch(const std::exception &e){busy_=false;fail(e);}}
 void fail(const std::exception &e){set({{"status",cancel_.load()?"cancelled":"error"},{"message",cancel_.load()?"Update cancelled.":e.what()}});}
public:
 Service(Json trust,std::filesystem::path directory,std::string version,std::string build):trust_(std::move(trust)),directory_(std::move(directory)),current_version_(std::move(version)),build_(std::move(build)){
  try{if(trust_.value("schema",0)!=1||trust_.at("keys").empty()||!trust_.contains("manifestUrl"))throw std::runtime_error("Updates are not configured for this build.");allowed(trust_.at("manifestUrl"),trust_);for(const auto &k:trust_.at("keys"))public_key(k.at("publicKey"));set({{"status","idle"},{"message","Check for a signed release."}});}catch(const std::exception &e){set({{"status","disabled"},{"message",e.what()}});}
 }
 ~Service(){cancel_=true;if(worker_.valid())worker_.wait();}
 Json state(){reap();std::lock_guard lock(mutex_);auto result=state_;result["currentVersion"]=current_version_;result["platform"]=platform();result["received"]=received_.load();return result;}
 void cancel(){cancel_=true;}
 void check(){reap();if(busy_||state().value("status","")=="disabled")return;cancel_=false;busy_=true;received_=0;downloaded_.clear();manifest_=artifact_=nullptr;set({{"status","checking"},{"message","Checking signed releases…"}});
  launch([this]{try{Transfer t{{},nullptr,128*1024,0,&cancel_,nullptr};fetch(trust_.at("manifestUrl"),trust_,t);auto m=verify_manifest(t.bytes,trust_);Json a;for(const auto &entry:m.at("artifacts"))if(entry.at("platform")==platform())a=entry;if(a.is_null())throw std::runtime_error("No release is available for this platform.");if(cancel_)throw std::runtime_error("Update cancelled");manifest_=m;artifact_=a;const bool available=a.at("build")!=build_&&newer(m.at("version"),current_version_);set({{"status",available?"available":"current"},{"version",m.at("version")},{"bytes",a.at("bytes")},{"message",available?"A signed update is available.":"This build is up to date."}});}catch(const std::exception &e){fail(e);}});
 }
 void download(){reap();if(busy_||state().value("status","")!="available")return;cancel_=false;busy_=true;received_=0;const auto artifact=artifact_;set({{"status","downloading"},{"version",manifest_.at("version")},{"bytes",artifact.at("bytes")},{"message","Downloading and verifying…"}});
  launch([this,artifact]{std::filesystem::path temporary;try{
   if(timestamp(manifest_.at("expiresAt"))<=unix_time())throw std::runtime_error("Release expired. Check for updates again.");std::filesystem::create_directories(directory_);
   for(int attempt=0;attempt<32;attempt++){auto candidate=directory_/("download-"+std::to_string(SDL_GetTicksNS())+"-"+std::to_string(attempt));if(std::filesystem::create_directory(candidate)){temporary=candidate;break;}}if(temporary.empty())throw std::runtime_error("Cannot create update download directory");
   const auto part=temporary/"package.partial",target=directory_/artifact.at("filename").get<std::string>();
   if(std::filesystem::exists(target)){char existing_hash[65]{};const auto utf8=target.u8string();
    if(std::filesystem::is_symlink(target)||!std::filesystem::is_regular_file(target)||std::filesystem::file_size(target)!=artifact.at("bytes").get<uint64_t>()||!bh_sha256_file(reinterpret_cast<const char*>(utf8.c_str()),artifact.at("bytes").get<uint64_t>(),existing_hash)||artifact.at("sha256")!=existing_hash)throw std::runtime_error("An unverified file already uses this package name. Move it out of the updates folder, then retry.");
    if(cancel_)throw std::runtime_error("Update cancelled");if(timestamp(manifest_.at("expiresAt"))<=unix_time())throw std::runtime_error("Release expired. Check for updates again.");
    downloaded_=target;std::filesystem::remove_all(temporary);temporary.clear();set({{"status","ready"},{"version",manifest_.at("version")},{"filename",artifact.at("filename")},{"message","Existing package verified. Open the updates folder, close the game, then install the package."}});return;
   }
   std::ofstream file(part,std::ios::binary);if(!file)throw std::runtime_error("Cannot save update package");Transfer t{{},&file,artifact.at("bytes").get<uint64_t>(),0,&cancel_,&received_};fetch(artifact.at("url"),trust_,t);file.close();if(!file||t.total!=t.limit)throw std::runtime_error("Update size differs from the signed release");
   const auto utf8=part.u8string();char hash[65]{};if(!bh_sha256_file(reinterpret_cast<const char*>(utf8.c_str()),t.limit,hash)||artifact.at("sha256")!=hash)throw std::runtime_error("Update hash differs from the signed release");if(cancel_)throw std::runtime_error("Update cancelled");
   if(timestamp(manifest_.at("expiresAt"))<=unix_time())throw std::runtime_error("Release expired during download. Check for updates again.");
   std::filesystem::create_hard_link(part,target);downloaded_=target;std::filesystem::remove_all(temporary);temporary.clear();set({{"status","ready"},{"version",manifest_.at("version")},{"filename",artifact.at("filename")},{"message","Verified package saved. Open the updates folder, close the game, then install the package."}});
  }catch(const std::exception &e){if(!temporary.empty()){std::error_code ec;std::filesystem::remove_all(temporary,ec);}fail(e);}});
 }
 void reveal(){reap();if(busy_||downloaded_.empty())return;const auto u8=std::filesystem::absolute(directory_).generic_u8string();std::string url="file://";
#ifdef _WIN32
 url+='/';
#endif
 static const char hex[]="0123456789ABCDEF";for(unsigned char c:u8){if(std::isalnum(c)||c=='/'||c==':'||c=='-'||c=='_'||c=='.'||c=='~')url+=char(c);else{url+='%';url+=hex[c>>4];url+=hex[c&15];}}SDL_OpenURL(url.c_str());}
};
}
