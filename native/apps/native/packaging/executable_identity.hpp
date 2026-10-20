#pragma once
// Match executable-identity.ts. This is build identity; platform signatures provide authenticity.
#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>
namespace native {
inline std::vector<uint8_t> executable_identity_bytes(const std::vector<uint8_t> &input,const std::string &mode="sha256") {
    if(mode=="sha256")return input;
    if(mode!="macho-code-v1")throw std::runtime_error("Unsupported executable hash mode");
    if(input.size()>256*1024*1024)throw std::runtime_error("Executable exceeds256MiB");
    auto read=[](const std::vector<uint8_t>&b,size_t p,size_t n,bool big=false)->uint64_t{if(p>b.size()||n>b.size()-p)throw std::runtime_error("Truncated Mach-O");uint64_t v=0;for(size_t i=0;i<n;i++)v|=uint64_t(b[p+i])<<((big?n-1-i:i)*8);return v;};
    auto write=[](std::vector<uint8_t>&b,size_t p,uint64_t v,size_t n){for(size_t i=0;i<n;i++)b[p+i]=uint8_t(v>>(i*8));};
    auto canonical=[&](std::vector<uint8_t>b){
        if(b.size()<32||read(b,0,4)!=0xfeedfacf)throw std::runtime_error("Expected little-endian64-bit Mach-O");
        size_t n=size_t(read(b,16,4)),size=size_t(read(b,20,4));if(n>4096||size>b.size()-32)throw std::runtime_error("Invalid Mach-O commands");
        std::vector<std::vector<uint8_t>> commands;size_t at=32,end=b.size(),first=SIZE_MAX,count=0;
        for(size_t i=0;i<n;i++){
            if(at+8>32+size)throw std::runtime_error("Truncated Mach-O command");
            auto cmd=read(b,at,4);size_t len=size_t(read(b,at+4,4));if(len<8||len%8||len>32+size-at)throw std::runtime_error("Invalid Mach-O command size");
            std::vector<uint8_t> c(b.begin()+at,b.begin()+at+len);
            if(cmd==0x1d){if(len!=16||count++)throw std::runtime_error("Invalid Mach-O signature command");size_t offset=size_t(read(c,8,4)),length=size_t(read(c,12,4));if(offset<32+size||offset>b.size()||length>b.size()-offset)throw std::runtime_error("Invalid Mach-O signature bounds");end=offset;}
            else {
                if(cmd==0x19){if(len<72)throw std::runtime_error("Invalid segment command");size_t sections=size_t(read(c,64,4));if(sections>(len-72)/80)throw std::runtime_error("Invalid sections");for(size_t s=0;s<sections;s++){size_t offset=size_t(read(c,72+s*80+48,4));if(offset)first=std::min(first,offset);}
                    const std::array<uint8_t,16> linkedit={'_','_','L','I','N','K','E','D','I','T',0,0,0,0,0,0};if(std::equal(linkedit.begin(),linkedit.end(),c.begin()+8)){std::fill(c.begin()+32,c.begin()+40,0);std::fill(c.begin()+48,c.begin()+56,0);}
                }commands.push_back(std::move(c));
            }at+=len;
        }
        if(at!=32+size||first==SIZE_MAX||first<32+size||first>end)throw std::runtime_error("Invalid Mach-O header region");
        b.resize((end+15)/16*16);std::fill(b.begin()+end,b.end(),0);std::fill(b.begin()+32,b.begin()+first,0);size_t command_size=0;for(const auto&c:commands)command_size+=c.size();write(b,16,commands.size(),4);write(b,20,command_size,4);size_t pos=32;for(const auto&c:commands){std::copy(c.begin(),c.end(),b.begin()+pos);pos+=c.size();}return b;
    };
    constexpr char marker[]="bunnyhop-macho-code-v1";std::vector<uint8_t> result(marker,marker+sizeof(marker));
    const auto magic=input.size()>=4?read(input,0,4,true):0;
    if(magic==0xcafebabe||magic==0xcafebabf){
        const size_t n=size_t(read(input,4,4,true)),width=magic==0xcafebabe?20:32;if(n>16||8+n*width>input.size())throw std::runtime_error("Invalid fat Mach-O");
        struct Part{uint32_t cpu,sub;std::vector<uint8_t>bytes;};std::vector<Part> parts;
        for(size_t i=0;i<n;i++){size_t at=8+i*width,offset=size_t(read(input,at+8,width==20?4:8,true)),size=size_t(read(input,at+(width==20?12:16),width==20?4:8,true));if(offset<8+n*width||size<32||offset>input.size()||size>input.size()-offset)throw std::runtime_error("Invalid fat slice");parts.push_back({uint32_t(read(input,at,4,true)),uint32_t(read(input,at+4,4,true)),canonical(std::vector<uint8_t>(input.begin()+offset,input.begin()+offset+size))});}
        std::sort(parts.begin(),parts.end(),[](const Part&a,const Part&b){return a.cpu<b.cpu||(a.cpu==b.cpu&&a.sub<b.sub);});for(const auto&p:parts){size_t at=result.size();result.resize(at+16);write(result,at,p.cpu,4);write(result,at+4,p.sub,4);write(result,at+8,p.bytes.size(),8);result.insert(result.end(),p.bytes.begin(),p.bytes.end());}
    }else{auto b=canonical(input);result.insert(result.end(),b.begin(),b.end());}return result;
}
}
