#include "sniper_zoom.hpp"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
int main(){
    native::SniperZoom zoom;BhWeaponReport weapon{};weapon.active=21;zoom.observe(weapon);
    assert(!zoom.scoped()&&zoom.fov(103)==103);assert(zoom.secondary(21)&&zoom.fov(90)==40);zoom.secondary(21);assert(zoom.fov(90)==15);zoom.secondary(21);assert(!zoom.scoped());
    zoom.secondary(21);BhAttackReport attack{};attack.weapon=21;zoom.observe(weapon,&attack);assert(!zoom.scoped()&&zoom.resume_in()==1.25);assert(!zoom.frame(1.24));assert(zoom.frame(.02)&&zoom.fov(90)==40);
    // Dry fires and ordinary report ticks never drop a scope.
    weapon.flags=16;zoom.observe(weapon);assert(zoom.scoped());
    zoom.observe(weapon,&attack);weapon.active=3;zoom.observe(weapon);assert(!zoom.scoped());zoom.frame(2);assert(!zoom.scoped()&&!zoom.secondary(3));
    for(uint32_t id=21;id<=24;++id){zoom.reset(id);zoom.secondary(id);zoom.secondary(id);attack.weapon=id;weapon.active=id;zoom.observe(weapon,&attack);zoom.frame(2);assert(zoom.level()==2);}
    // Secondary during the bolt cycle cancels the pending auto-rescope.
    zoom.observe(weapon,&attack);zoom.secondary(weapon.active);assert(zoom.level()==1&&zoom.resume_in()==0);zoom.frame(2);assert(zoom.level()==1);
    zoom.reset();assert(!zoom.scoped());zoom.frame(NAN);assert(!zoom.scoped());
}
