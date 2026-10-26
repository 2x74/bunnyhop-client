#pragma once
#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <string_view>
#include <vector>
#include "unicode_grapheme_data.hpp"
namespace native {
struct UnicodePoint {uint32_t cp;size_t byte,end;};
inline std::vector<UnicodePoint> unicode_points(std::string_view s){
 std::vector<UnicodePoint> out;for(size_t i=0;i<s.size();){const auto c=uint8_t(s[i]);size_t n=c<128?1:c>=0xc2&&c<=0xdf?2:c>=0xe0&&c<=0xef?3:c>=0xf0&&c<=0xf4?4:0;uint32_t cp=n==1?c:n?c&((1u<<(7-n))-1):0xfffd;bool valid=n&&i+n<=s.size();for(size_t j=1;valid&&j<n;j++){valid=(uint8_t(s[i+j])&0xc0)==0x80;cp=(cp<<6)|(uint8_t(s[i+j])&63);}valid=valid&&!(n==3&&(cp<0x800||(cp>=0xd800&&cp<=0xdfff)))&&!(n==4&&(cp<0x10000||cp>0x10ffff));if(!valid){n=1;cp=0xfffd;}out.push_back({cp,i,i+n});i+=n;}return out;
}
// Unicode17 extended grapheme clusters, UAX29 GB3..GB999 including GB9c.
// Byte boundaries are stable across platforms and never split UTF8 or a user's
// combining/emoji/Indic cluster. Invalid bytes form replacement-codepoint units.
inline std::vector<size_t> grapheme_boundaries(std::string_view text){
 using namespace unicode_grapheme;const auto p=unicode_points(text);std::vector<size_t> out{0};
 auto control=[](unsigned g){return g==1||g==2||g==3;};
 for(size_t i=1;i<p.size();i++){
  const auto a=property(p[i-1].cp),b=property(p[i].cp);bool split=true;
  if(a==1&&b==2)split=false;
  else if(control(a)||control(b))split=true;
  else if(a==9&&(b==9||b==10||b==12||b==13))split=false;
  else if((a==12||a==10)&&(b==10||b==11))split=false;
  else if((a==13||a==11)&&b==11)split=false;
  else if(b==4||b==5||b==8||a==7)split=false;
  else if(lookup(p[i].cp,conjunct)==1){size_t j=i;bool linker=false;while(j){const auto k=lookup(p[j-1].cp,conjunct);if(k!=2&&k!=3)break;linker|=k==3;--j;}if(linker&&j&&lookup(p[j-1].cp,conjunct)==1)split=false;}
  if(split&&a==5&&lookup(p[i].cp,pictographic)){size_t j=i-1;while(j&&property(p[j-1].cp)==4)--j;if(j&&lookup(p[j-1].cp,pictographic))split=false;}
  if(split&&a==6&&b==6){size_t count=0,j=i;while(j&&property(p[j-1].cp)==6){count++;--j;}if(count%2)split=false;}
  if(split)out.push_back(p[i].byte);
 }
 if(out.back()!=text.size())out.push_back(text.size());return out;
}
inline size_t grapheme_floor(std::string_view text,size_t byte){const auto b=grapheme_boundaries(text);auto at=std::upper_bound(b.begin(),b.end(),std::min(byte,text.size()));return at==b.begin()?0:*--at;}
inline size_t grapheme_before(std::string_view text,size_t byte){const auto b=grapheme_boundaries(text);auto at=std::lower_bound(b.begin(),b.end(),std::min(byte,text.size()));return at==b.begin()?0:*--at;}
inline size_t grapheme_after(std::string_view text,size_t byte){const auto b=grapheme_boundaries(text);auto at=std::upper_bound(b.begin(),b.end(),std::min(byte,text.size()));return at==b.end()?text.size():*at;}
}
