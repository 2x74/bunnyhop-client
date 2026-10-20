#include "online.hpp"
#include <iostream>
int main() {
    auto check=[](bool value,const char *label) {if(!value) {std::cerr<<label<<'\n';std::exit(1);}};
    for(const auto &id:{"bhop_eazy","bhop_lol_tutorial","bhop_map-v2"}) check(native::valid_map_id(id),"valid map rejected");
    for(const auto &id:{"",".","..","../map","https://evil.test/a","a?b","a#b","a\\b"}) check(!native::valid_map_id(id),"unsafe map accepted");
    for(const auto &path:{"materials/test.vmt","models/props/test.dx90.vtx","materials/map textures/stone.vtf"})
        check(native::safe_content_path(path),"valid content rejected");
    for(const auto &path:{"","/tmp/a","../x","materials/../../a","materials/../a","C:/a","a\\..\\x"})
        check(!native::safe_content_path(path),"unsafe content accepted");
    check(!native::safe_content_path(std::string("materials/a\0.vmt",16)),"NUL path accepted");
    return 0;
}
