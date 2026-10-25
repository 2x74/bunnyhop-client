#pragma once
#include <algorithm>
#include <cmath>
namespace native {
struct HudGeometry {
    float scale,width,height;
    HudGeometry(int w,int h,float percent):scale(std::max(.6f,float(h)/900.f)*std::clamp(std::isfinite(percent)?percent:100.f,50.f,175.f)/100.f),width(w/scale),height(h/scale) {}
};
}
