#include "graphemes.hpp"
#include <cassert>
#include <fstream>
#include <sstream>
#include <string>
static void utf8(std::string &s,unsigned cp){if(cp<128)s+=char(cp);else if(cp<2048){s+=char(0xc0|(cp>>6));s+=char(0x80|(cp&63));}else if(cp<65536){s+=char(0xe0|(cp>>12));s+=char(0x80|((cp>>6)&63));s+=char(0x80|(cp&63));}else{s+=char(0xf0|(cp>>18));s+=char(0x80|((cp>>12)&63));s+=char(0x80|((cp>>6)&63));s+=char(0x80|(cp&63));}}
int main(int argc,char **argv){assert(argc==2);std::ifstream f(argv[1]);assert(f);std::string line;unsigned cases=0;while(std::getline(f,line)){line=line.substr(0,line.find('#'));std::istringstream in(line);std::string word,text;std::vector<size_t> expected;while(in>>word){if(word=="÷")expected.push_back(text.size());else if(word!="×")utf8(text,unsigned(std::stoul(word,nullptr,16)));}if(expected.empty())continue;assert(native::grapheme_boundaries(text)==expected);cases++;}assert(cases>700);}
