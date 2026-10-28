#include "online.hpp"
#include "data_location.hpp"
#include "map_prefetch.hpp"
#include <future>
#include <iostream>
#include "bunnyhop_native.h"
#include <fstream>
#include <chrono>
int main() {
    auto check=[](bool value,const char *label) {if(!value) {std::cerr<<label<<'\n';std::exit(1);}};
    for(const auto &id:{"bhop_eazy","bhop_lol_tutorial","bhop_map-v2"}) check(native::valid_map_id(id),"valid map rejected");
    for(const auto &id:{"",".","..","../map","https://evil.test/a","a?b","a#b","a\\b"}) check(!native::valid_map_id(id),"unsafe map accepted");
    for(const auto &path:{"materials/test.vmt","models/props/test.dx90.vtx","materials/map textures/stone.vtf"})
        check(native::safe_content_path(path),"valid content rejected");
    for(const auto &path:{"","/tmp/a","../x","materials/../../a","materials/../a","C:/a","a\\..\\x"})
        check(!native::safe_content_path(path),"unsafe content accepted");
    check(!native::safe_content_path(std::string("materials/a\0.vmt",16)),"NUL path accepted");
    const auto cache =
        std::filesystem::temp_directory_path() / native::data_location::from_utf8("Jos\xc3\xa9-\xe6\xb8\xac") /
        ("native-cache-test-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    struct Cleanup{std::filesystem::path p;~Cleanup(){std::error_code e;std::filesystem::remove_all(p,e);}}cleanup{cache};
    using Bytes=std::vector<uint8_t>;const Bytes bsp{'V','B','S','P','1'},content{'m','a','t'};
    auto digest=[](const Bytes &b){char out[65]{};if(!bh_sha256(b.data(),b.size(),out))throw std::runtime_error("hash");return std::string(out);};
    const auto sha=digest(bsp),fileSha=digest(content);
    auto encode=[](const nlohmann::json &j){auto s=j.dump();return Bytes(s.begin(),s.end());};
    const auto detail=encode({{"sha256",sha},{"name","bhop_test"}});
    const auto manifest=encode({{"mapSha256",sha},{"files",{{"materials/test.vmt",{{"sha256",fileSha},{"size",content.size()}}}}}});
    int requests=0;bool offline=false,notFound=false;native::LoadProgress latest;
    native::DownloadFetch fetch=[&](const std::string &route,size_t,const std::atomic_bool*,const native::LoadProgressCallback&){++requests;if(notFound)throw std::runtime_error("HTTP 404");if(offline)throw native::DownloadNetworkError("offline fixture");if(route=="/api/maps/bhop_test")return detail;if(route=="/content-manifests/"+sha+".json")return manifest;if(route=="/api/bsp/"+sha+".bsp")return bsp;if(route=="/content/"+fileSha)return content;throw std::runtime_error("Unexpected route");};
    auto load=[&]{return native::download_map("bhop_test",cache,[](const std::string&){},nullptr,{},[&](const auto &p){latest=p;},fetch);};
    const auto first=load();check(requests==4,"first load fetches detail/BSP/manifest/content");check(std::filesystem::exists(first.content_root/"materials/test.vmt"),"content not materialized");
    const std::atomic_bool prefetch_cancel = false;
    auto prefetched = std::async(std::launch::async,
                                 [&] { return native::prefetch_map("bhop_test", sha, cache, prefetch_cancel, fetch); });
    check(prefetched.get(), "verified worker prefetch failed");
    auto stale = std::async(std::launch::async, [&] {
        return native::prefetch_map("bhop_test", std::string(64, '0'), cache, prefetch_cancel, fetch);
    });
    check(!stale.get(), "prefetch accepted a different map revision");
    requests=0;load();check(requests==1,"cached objects/manifest should avoid network");
    std::filesystem::remove(cache/"index"/"bhop_test.json"); // Older client cache migration.
    offline=true;requests=0;load();check(requests==1&&latest.offline,"offline cache did not load");
    notFound=true;bool rejected=false;try{load();}catch(...){rejected=true;}check(rejected,"404 must not use stale cache");notFound=false;
    {std::ofstream corrupt(cache/"objects"/fileSha);corrupt<<"bad";}
    rejected=false;try{load();}catch(...){rejected=true;}check(rejected,"offline corrupt object accepted");
    offline=false;requests=0;load();check(requests==2,"corrupt content should redownload");
    std::atomic_bool canceled=true;rejected=false;try{native::download_map("bhop_test",cache,[](const std::string&){},&canceled,{}, {},fetch);}catch(...){rejected=true;}check(rejected,"cancelled cache load accepted");
    const auto sound=encode({{"optional",{{"sounds",{{"files",{{"sound/player/footsteps/metal1.wav",{{"sha256",fileSha},{"size",content.size()}}}}}}}}}});
    {std::ofstream f(first.content_root.parent_path()/"manifest.json",std::ios::binary);f.write(reinterpret_cast<const char*>(sound.data()),sound.size());}
    requests=0;native::download_classic_sounds(first.content_root,cache,fetch);check(requests==0,"cached optional sound should use verified object");check(std::filesystem::exists(cache/"classic/sound/player/footsteps/metal1.wav"),"optional sound missing");
    {std::ofstream f(cache/"objects"/fileSha);f<<"bad";}requests=0;native::download_classic_sounds(first.content_root,cache,fetch);check(requests==1,"corrupt optional sound must redownload");
    const auto unsafe=encode({{"optional",{{"sounds",{{"files",{{"sound/../../bad.wav",{{"sha256",fileSha},{"size",content.size()}}}}}}}}}});{std::ofstream f(first.content_root.parent_path()/"manifest.json",std::ios::binary);f.write(reinterpret_cast<const char*>(unsafe.data()),unsafe.size());}
    rejected=false;try{native::download_classic_sounds(first.content_root,cache,fetch);}catch(...){rejected=true;}check(rejected,"unsafe optional sound accepted");
    return 0;
}
