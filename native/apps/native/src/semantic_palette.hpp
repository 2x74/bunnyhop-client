#pragma once
#include <array>
#include <string_view>
#include <cstdint>
namespace native {
using SemanticColor=std::array<float,4>;
constexpr SemanticColor semantic_rgb(uint32_t rgb,float alpha=1){return {float(rgb>>16&255)/255,float(rgb>>8&255)/255,float(rgb&255)/255,alpha};}
struct SemanticPalette {
    SemanticColor gain,loss,sync;
    std::array<SemanticColor,3> trainer;
    std::array<SemanticColor,5> zones;
    // Native overlay order: clip, other, push, wall, teleport, gravity.
    std::array<SemanticColor,6> triggers;
};
inline SemanticPalette semantic_palette(std::string_view mode){
    SemanticPalette p{semantic_rgb(0x4dff88),semantic_rgb(0xff5d5d),semantic_rgb(0xffd24d),
        {semantic_rgb(0x4fd08a),semantic_rgb(0xf29a3a),semantic_rgb(0xe0473f)},
        {semantic_rgb(0x33dd66),semantic_rgb(0xee3344),semantic_rgb(0x33bbdd),semantic_rgb(0xdd66ee),semantic_rgb(0xffaa33)},
        {semantic_rgb(0x8040ff),semantic_rgb(0xffaa33),semantic_rgb(0x40cccc),semantic_rgb(0xb3b3b3),semantic_rgb(0xff404d),semantic_rgb(0x4d8cff)}};
    if(mode=="redGreen"){
        p.gain=semantic_rgb(0x56b4e9);p.loss=semantic_rgb(0xd55e00);p.sync=semantic_rgb(0xf0e442);p.trainer={p.gain,p.sync,p.loss};
        p.zones={semantic_rgb(0x7fb8ff),semantic_rgb(0xee3344),semantic_rgb(0x1f5fff),semantic_rgb(0xf0e442),semantic_rgb(0xffffff)};
        p.triggers={semantic_rgb(0x8040ff),semantic_rgb(0xffffff),semantic_rgb(0x7fb8ff),semantic_rgb(0x6f7681),semantic_rgb(0xe8202a),semantic_rgb(0xf0e442)};
    }else if(mode=="blueYellow"){
        p.trainer[1]=semantic_rgb(0xc879ff);p.zones[2]=semantic_rgb(0x1f5fff);p.zones[4]=semantic_rgb(0xffffff);
        p.triggers[1]=semantic_rgb(0xe69f00);p.triggers[2]=semantic_rgb(0x0072b2);p.triggers[3]=semantic_rgb(0xe0e4ea);
    }return p;
}
}
