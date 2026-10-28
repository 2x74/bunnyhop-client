#include "replay_controls.hpp"
#include <cassert>
#include <limits>

int main() {
    using R = native::ReplayControls;
    assert(R::offset(10, -5, .01, 1000) == 0);
    assert(R::offset(900, 5, .01, 1000) == 1000);
    assert(R::offset(900, 5, 0, 1000) == 900);
    assert(R::speed(1, true) == 1.5 && R::speed(1, false) == .5);
    R r;
    auto b = R::layout(1000, 700);
    r.pointer(b, b.x, b.y + 40, 1000, true);
    assert(r.dragging && r.take() == 0);
    r.motion(b, b.x + b.width, 1000);
    r.motion(b, b.x + b.width * .5f, 1000);
    assert(r.take() == 500 && !r.take());
    r.pointer(b, 0, 0, 1000, false);
    assert(!r.dragging);
    assert(r.pointer(b, b.x + b.width * 2.5f / 8, b.y + 70, 1000, true) == R::Action::pause);
    assert(R::tick_at(b, -100, 1000) == 0 && R::tick_at(b, 2000, 1000) == 1000);
}
