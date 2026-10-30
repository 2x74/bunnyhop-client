#pragma once
// Package identity is independent of platform signatures / ranked-build admission.
#include "bunnyhop_native.h"
#include "../vendor/nlohmann/json.hpp"
#include <string>
#include <string_view>
#include <stdexcept>
namespace native {
inline constexpr int release_physics=19,release_rules=2;
inline constexpr std::string_view release_wasm_sha256="1e6670dce25ed91b400cf0ea75eea9ceefb3392f9b3b14658d3fba828ffd26dc";
inline std::string release_platform(){
#if defined(__APPLE__)
    const std::string os="darwin";
#elif defined(_WIN32)
    const std::string os="win32";
#elif defined(__linux__)
    const std::string os="linux";
#else
    throw std::runtime_error("Unsupported release platform");
#endif
#if defined(__aarch64__) || defined(_M_ARM64)
    return os+"/arm64";
#elif defined(__x86_64__) || defined(_M_X64)
    return os+"/x64";
#else
    throw std::runtime_error("Unsupported release architecture");
#endif
}
inline std::string release_hash_mode(){return release_platform().starts_with("darwin/")?"macho-code-v1":"sha256";}
inline void verify_release_identity(const nlohmann::json &manifest,const std::string &binary,const std::string &menu,const std::string &assets){
    const auto same=[&](const char *key,const nlohmann::json &expected){if(!manifest.is_object()||!manifest.contains(key)||manifest.at(key)!=expected)throw std::runtime_error(std::string("Package identity mismatch: ")+key);};
    const auto hash=[](const std::string &value){if(value.size()!=64||value.find_first_not_of("0123456789abcdef")!=std::string::npos)throw std::runtime_error("Invalid package identity hash");};
    hash(binary);hash(menu);hash(assets);
    // Check the linked simulation's defaults, not only the manifest's labels.
    BhSettings settings{};BhRunOptions options{};bh_default_settings(&settings);bh_default_run_options(&options);
    if(settings.physics!=release_physics||options.rules!=release_rules)throw std::runtime_error("Native core does not match the compiled verifier pin");
    same("schema",1);same("physics",release_physics);same("rules",release_rules);
    same("canonicalWasmSha256",std::string(release_wasm_sha256));same("wasm","bunnyhop-web/"+std::string(release_wasm_sha256.substr(0,12)));
    const auto platform=release_platform();same("platform",platform);same("renderer","native-opengl");same("binaryHashMode",release_hash_mode());
    same("binarySha256",binary);same("menuSha256",menu);same("assetsSha256",assets);
    std::string payload="package-v1";
    for(const auto &part:{platform.substr(0,platform.find('/')),platform.substr(platform.find('/')+1),binary,menu,assets,std::string(release_wasm_sha256)}){payload+='\0';payload+=part;}
    char digest[65]{};if(!bh_sha256(reinterpret_cast<const uint8_t*>(payload.data()),payload.size(),digest))throw std::runtime_error("Cannot hash package identity");
    same("build","bunnyhop-native/"+std::string(digest,24));
}
}
