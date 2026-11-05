#pragma once
// Exact damped springs for the third-person bunny (web viewmodel/feel.ts springStep / springRamp). Advanced by their
// closed-form solution over a frame instead of Euler sub-steps, so 60 and 240 fps land on the same curve.
#include <cmath>

namespace native_actor_anim {

// Damping ratios this close to 1 use the critically damped solution (the others divide by ~0 there).
constexpr double critical_damping_band = 1e-4;

// Advances (x, v) toward `target` held over dt: angular frequency `omega` (1/s), damping ratio `zeta`.
inline void spring_step(double &x, double &v, double target, double omega, double zeta, double dt) {
    if (dt <= 0) return;
    const double y0 = x - target, v0 = v;
    double y = 0, vy = 0;
    if (zeta < 1 - critical_damping_band) {
        const double wd = omega * std::sqrt(1 - zeta * zeta), e = std::exp(-zeta * omega * dt);
        const double c = std::cos(wd * dt), s = std::sin(wd * dt), b = (v0 + zeta * omega * y0) / wd;
        y = e * (y0 * c + b * s);
        vy = e * (-zeta * omega * (y0 * c + b * s) - y0 * wd * s + b * wd * c);
    } else if (zeta <= 1 + critical_damping_band) {
        const double e = std::exp(-omega * dt), b = v0 + omega * y0;
        y = (y0 + b * dt) * e;
        vy = (b - omega * (y0 + b * dt)) * e;
    } else {
        const double r = omega * std::sqrt(zeta * zeta - 1), r1 = -zeta * omega + r, r2 = -zeta * omega - r;
        const double c2 = (v0 - r1 * y0) / (r2 - r1), c1 = y0 - c2, e1 = std::exp(r1 * dt), e2 = std::exp(r2 * dt);
        y = c1 * e1 + c2 * e2;
        vy = c1 * r1 * e1 + c2 * r2 * e2;
    }
    x = target + y;
    v = vy;
}

// spring_step with the target moving in a straight line from u0 to u1 over dt (exact: a ramp's steady state trails
// it by 2 zeta r / omega, and the rest is the held-target solution about that).
inline void spring_ramp(double &x, double &v, double u0, double u1, double omega, double zeta, double dt) {
    if (dt <= 0) return;
    const double rate = (u1 - u0) / dt, lag = (2 * zeta * rate) / omega;
    x -= u0 - lag;
    v -= rate;
    spring_step(x, v, 0, omega, zeta, dt);
    x += u1 - lag;
    v += rate;
}

}  // namespace native_actor_anim
