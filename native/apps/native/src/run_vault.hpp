#pragma once
// Device-local finish metadata and optional PB captures. Never deletes a BHR and
// never upgrades a local result to an account/server verified personal best.
#include "nlohmann/json.hpp"
#include "atomic_replace.hpp"
#include <filesystem>
#include <fstream>
#include <vector>
#include <string>
#include <optional>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cctype>
#include <limits>
namespace native {
class RunVault {
 using J=nlohmann::json;std::filesystem::path root_;size_t maxRuns_,maxShots_,maxShotBytes_,maxTotalBytes_;
 struct Entry{std::filesystem::path path;std::filesystem::file_time_type age;uintmax_t bytes;};
 static bool regular(const std::filesystem::path&p){return !std::filesystem::is_symlink(p)&&std::filesystem::is_regular_file(p);}
 void ensure()const{for(const auto&p:{root_,root_/"runs",root_/"captures"}){if(std::filesystem::is_symlink(p))throw std::runtime_error("Vault directory is a symbolic link");std::filesystem::create_directories(p);}}
 std::filesystem::path summary_path(const std::string&id)const{if(!valid_id(id))throw std::runtime_error("Invalid vault replay identifier");return root_/"runs"/(id+".json");}
 std::filesystem::path capture_path(const std::string&id)const{if(!valid_id(id))throw std::runtime_error("Invalid vault replay identifier");return root_/"captures"/(id+".png");}
 static void atomic_write(const std::filesystem::path& path, const std::string& value) {
     if (std::filesystem::is_symlink(path))
         throw std::runtime_error("Vault file is a symbolic link");
     atomic_write_file(path, value);
 }

 std::vector<Entry> files(const char*dir,const char*extension)const{std::vector<Entry> result;if(std::filesystem::is_symlink(root_)||std::filesystem::is_symlink(root_/dir)||!std::filesystem::exists(root_/dir))return result;for(const auto&e:std::filesystem::directory_iterator(root_/dir)){if(e.is_symlink()||!e.is_regular_file()||e.path().extension()!=extension)continue;const auto name=e.path().filename().string(),suffix=std::string(extension);if(!valid_id(name.substr(0,name.size()-suffix.size())))continue;result.push_back({e.path(),e.last_write_time(),e.file_size()});}std::sort(result.begin(),result.end(),[](const auto&a,const auto&b){return a.age!=b.age?a.age>b.age:a.path.filename()>b.path.filename();});return result;}
 static std::optional<double> number(const J&j,const char*key,double max,bool integer=false){if(!j.contains(key)||!j[key].is_number())return std::nullopt;const double n=j[key];return std::isfinite(n)&&n>=0&&n<=max&&(!integer||std::floor(n)==n)?std::optional<double>(n):std::nullopt;}
 static std::string text(const J&j,const char*key,size_t limit){if(!j.contains(key)||!j[key].is_string())return {};std::string s;for(unsigned char c:j[key].get<std::string>())if(c>=32&&c!=127)s+=char(c);if(s.size()>limit)s.resize(limit);return s;}
public:
 static constexpr size_t max_summary_bytes=64*1024;
 explicit RunVault(std::filesystem::path root,size_t maxRuns=5000,size_t maxShots=500,size_t maxShotBytes=16*1024*1024,size_t maxTotalBytes=1024ull*1024*1024):root_(std::move(root)),maxRuns_(maxRuns),maxShots_(maxShots),maxShotBytes_(maxShotBytes),maxTotalBytes_(maxTotalBytes){}
 static bool valid_id(const std::string&id){if(id.size()<5||id.size()>180||!id.ends_with(".bhr")||id==".bhr"||id.find("..")!=std::string::npos)return false;for(unsigned char c:id)if(!((c>='a'&&c<='z')||(c>='A'&&c<='Z')||(c>='0'&&c<='9')||c=='-'||c=='_'||c=='.'))return false;return true;}
 static J sanitize(const J&raw){if(!raw.is_object())return nullptr;const auto time=number(raw,"time",86400),track=number(raw,"track",64,true),jumps=number(raw,"jumps",1000000000,true),strafes=number(raw,"strafes",1000000000,true),sync=number(raw,"sync",100),date=number(raw,"finishedAt",100000000000000.);const auto map=text(raw,"map",80),style=text(raw,"style",32);if(!time||*time<=0||!track||!jumps||!strafes||!sync||!date||map.empty()||style.empty())return nullptr;return {{"schema",1},{"map",map},{"style",style},{"track",unsigned(*track)},{"time",*time},{"jumps",jumps?J(uint64_t(*jumps)):J(nullptr)},{"strafes",strafes?J(uint64_t(*strafes)):J(nullptr)},{"sync",sync?J(*sync):J(nullptr)},{"finishedAt",date?J(*date):J(0)},{"client",text(raw,"client",32)},{"localPb",raw.value("localPb",J(false))==true},{"eligible",raw.value("eligible",J(false))==true},{"verified",false}};}
 J read(const std::string&id)const{try{const auto p=summary_path(id);if(std::filesystem::is_symlink(root_)||std::filesystem::is_symlink(root_/"runs")||!regular(p)||std::filesystem::file_size(p)>max_summary_bytes)return nullptr;std::ifstream in(p);J raw;in>>raw;return sanitize(raw);}catch(...){return nullptr;}}
 bool is_local_pb(const J&summary)const{const auto clean=sanitize(summary);if(clean.is_null()||!clean["eligible"].get<bool>())return false;for(const auto&e:files("runs",".json")){const auto name=e.path.filename().string();const auto old=read(name.substr(0,name.size()-5));if(old.is_object()&&old["eligible"]==true&&old["map"]==clean["map"]&&old["style"]==clean["style"]&&old["track"]==clean["track"]&&old["time"].get<double>()<=clean["time"].get<double>())return false;}return true;}
 J archive(const std::string&id,const J&raw){ensure();J clean=sanitize(raw);if(clean.is_null())throw std::runtime_error("Invalid finish summary");clean["localPb"]=false;
 // PB indices outlive bounded summary pruning. A damaged/full index cannot invent a PB.
 const auto pbFile=root_/"pbs.json";J pbs=J::object();bool indexValid=true;if(std::filesystem::exists(pbFile)){try{if(!regular(pbFile)||std::filesystem::file_size(pbFile)>1024*1024)throw std::runtime_error("Invalid PB index");std::ifstream input(pbFile);input>>pbs;if(!pbs.is_object()||pbs.size()>4096)throw std::runtime_error("Invalid PB index");}catch(...){indexValid=false;}}
 const std::string key=J::array({clean["map"],clean["style"],clean["track"]}).dump();
 if(indexValid&&clean["eligible"]==true){const auto found=pbs.find(key);const bool known=found!=pbs.end();bool validBest=!known||(found->is_number()&&std::isfinite(found->get<double>())&&found->get<double>()>0&&found->get<double>()<=86400);if(validBest&&(known||pbs.size()<4096)){const double best=known?found->get<double>():std::numeric_limits<double>::infinity();clean["localPb"]=clean["time"].get<double>()<best&&is_local_pb(clean);if(clean["time"].get<double>()<best){pbs[key]=clean["time"];atomic_write(pbFile,pbs.dump());}}}
 atomic_write(summary_path(id),clean.dump());auto summaries=files("runs",".json");for(size_t i=maxRuns_;i<summaries.size();i++){const auto name=summaries[i].path.filename().string(),oldId=name.substr(0,name.size()-5);std::filesystem::remove(summaries[i].path);const auto capture=capture_path(oldId);if(regular(capture))std::filesystem::remove(capture);}return clean;}
 std::optional<std::filesystem::path> screenshot(const std::string&id)const{try{if(read(id).is_null())return std::nullopt;const auto p=capture_path(id);if(std::filesystem::is_symlink(root_)||std::filesystem::is_symlink(root_/"captures")||!regular(p))return std::nullopt;const auto n=std::filesystem::file_size(p);if(!n||n>maxShotBytes_||n>maxTotalBytes_)return std::nullopt;std::ifstream in(p,std::ios::binary);char sig[8]{};in.read(sig,8);if(in.gcount()!=8||std::string(sig,8)!=std::string("\x89PNG\r\n\x1a\n",8))return std::nullopt;return std::filesystem::absolute(p);}catch(...){return std::nullopt;}}
 void attach(const std::string&id,const std::string&png){ensure();if(read(id).is_null()||png.size()<8||png.size()>maxShotBytes_||png.size()>maxTotalBytes_||png.compare(0,8,"\x89PNG\r\n\x1a\n",8))throw std::runtime_error("Invalid vault screenshot");atomic_write(capture_path(id),png);size_t kept=0;uintmax_t bytes=0;for(const auto&e:files("captures",".png")){if(!e.bytes||e.bytes>maxShotBytes_||kept>=maxShots_||e.bytes>maxTotalBytes_-bytes){std::filesystem::remove(e.path);continue;}kept++;bytes+=e.bytes;}}
 void trash(const std::string&id){ensure();if(!valid_id(id))throw std::runtime_error("Invalid vault replay identifier");const auto dest=root_/"trash";if(std::filesystem::is_symlink(dest))throw std::runtime_error("Invalid vault trash directory");std::filesystem::create_directories(dest);for(const auto&p:{summary_path(id),capture_path(id)})if(regular(p)){const auto target=dest/p.filename();if(std::filesystem::exists(target))throw std::runtime_error("Vault item already exists in trash");std::filesystem::rename(p,target);}}
 static std::string file_uri(const std::filesystem::path&p){const auto utf8=std::filesystem::absolute(p).generic_u8string();std::string out="file://";if(utf8.empty()||utf8[0]!='/')out+='/';constexpr char hex[]="0123456789ABCDEF";for(unsigned char c:utf8){if((c<128&&std::isalnum(c))||c=='-'||c=='_'||c=='.'||c=='~'||c=='/'||c==':')out+=char(c);else{out+='%';out+=hex[c>>4];out+=hex[c&15];}}return out;}
};
}
