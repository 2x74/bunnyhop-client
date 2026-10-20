#pragma once
#include "bunnyhop_native.h"
#include <algorithm>
#include <filesystem>
#include <fstream>
#include <string>
#include <stdexcept>
#include <vector>
namespace native {
// Match package.ts treeHash: globally byte-sort relative POSIX UTF-8 paths, then path,NUL,file bytes.
inline std::string assets_identity_hash(const std::filesystem::path &root) {
    if(!std::filesystem::is_directory(root)||std::filesystem::is_symlink(root))throw std::runtime_error("Native asset root is not a regular directory");
    struct Entry {std::string name;std::filesystem::path path;};std::vector<Entry> files;
    for(const auto &item:std::filesystem::recursive_directory_iterator(root)) {
        if(item.is_symlink())throw std::runtime_error("Native asset symlink rejected");
        if(item.is_directory())continue;
        if(!item.is_regular_file())throw std::runtime_error("Native asset special file rejected");
        const auto path=item.path().lexically_relative(root).generic_u8string();
        files.push_back({std::string(reinterpret_cast<const char*>(path.data()),path.size()),item.path()});
    }
    std::sort(files.begin(),files.end(),[](const Entry&a,const Entry&b){return std::lexicographical_compare(a.name.begin(),a.name.end(),b.name.begin(),b.name.end(),[](unsigned char x,unsigned char y){return x<y;});});
    constexpr size_t limit=256*1024*1024;std::vector<uint8_t> bytes;
    for(const auto &file:files){
        const uintmax_t length=std::filesystem::file_size(file.path);
        if(length>limit||bytes.size()>limit||file.name.size()+1>limit-bytes.size()||length>limit-bytes.size()-file.name.size()-1)throw std::runtime_error("Native assets exceed256MiB");
        bytes.insert(bytes.end(),file.name.begin(),file.name.end());bytes.push_back(0);const size_t at=bytes.size();bytes.resize(at+size_t(length));
        std::ifstream stream(file.path,std::ios::binary);if(!stream||!stream.read(reinterpret_cast<char*>(bytes.data()+at),std::streamsize(length)))throw std::runtime_error("Cannot read native asset file");
        if(stream.peek()!=std::char_traits<char>::eof())throw std::runtime_error("Native asset changed during identity check");
    }
    char digest[65]{};if(!bh_sha256(bytes.empty()?nullptr:bytes.data(),bytes.size(),digest))throw std::runtime_error("Cannot hash native assets");return digest;
}
}
