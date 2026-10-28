#pragma once
#include "bunnyhop_native.h"
#include "longjump.hpp"
#include <algorithm>
#include <cmath>
#include <string>

namespace native {
// The same thresholds and gains as web/audio/movement.ts, independent of audio devices.
class MovementAudio {
    BhState previous{};
    bool first = true, in_water = false;
    double step_timer = .15, swim_timer = 0, boost_cool = 0;

public:
    bool classic = false, footsteps = true;

    void reset() {
        first = true;
        step_timer = .15;
        swim_timer = boost_cool = 0;
    }

    template <class Sink>
    void tick(const BhState &p, double dt, double depth, const std::string &surface, Sink play) {
        const double speed = std::hypot(double(p.velocity[0]), double(p.velocity[1]));
        const bool water = depth > 6, swimming = water && depth > 34;
        const bool landed = p.events & 4, jumped = p.events & 2;
        if (first) {
            first = false;
            previous = p;
            in_water = water;
            return;
        }
        if (p.events & 1) {
            play("teleport", .8, 1.);
            previous = p;
            in_water = water;
            step_timer = .2;
            return;
        }
        boost_cool -= dt;
        if (water && !in_water)
            play("water_enter", std::clamp(.35 + std::max(0., -double(previous.velocity[2])) / 800, .35, 1.), 1.);
        else if (!water && in_water && !(depth > 0))
            play("water_exit", .7, 1.);
        in_water = water;
        const auto step = "step_" + std::string(water ? "water" : surface);
        if (landed && !swimming) {
            const auto fall = std::max(0., -double(previous.velocity[2]));
            if (classic)
                play(step, fall > 560 ? 1. : std::clamp(.35 + fall / 900, .35, .8), 1.);
            else if (fall > 560) {
                play("land_hard", std::clamp(.55 + (fall - 560) / 900, .55, 1.), 1.);
                play(step, .5, 1.);
            } else {
                play("land_soft", std::clamp(.22 + fall / 700, .2, .75) * (jumped ? .7 : 1), 1.);
                if (!jumped) play(step, .25, 1.);
            }
            step_timer = .28;
        }
        if (jumped && !swimming) {
            if (classic) {
                if (!landed) play("step_" + surface, .3, 1.);
            } else
                play("jump", landed ? .55 : .8, 1.);
        }
        const auto dvz = p.velocity[2] - double(previous.velocity[2]),
                   dh = speed - std::hypot(double(previous.velocity[0]), double(previous.velocity[1]));
        if (!jumped && !landed && boost_cool <= 0 && (dvz > 160 || dh > 180) && !swimming) {
            play("boost", std::clamp(std::max(dvz, dh) / 700, .45, 1.), 1.);
            boost_cool = .4;
        }
        if (footsteps && p.grounded && !jumped && !swimming && speed > 80) {
            step_timer -= dt;
            if (step_timer <= 0) {
                play(step, (speed >= 150 ? .55 : .22) * (p.crouched ? .55 : 1), 1.);
                step_timer = speed >= 200 && !p.crouched ? .3 : .4;
            }
        } else if (footsteps && p.on_ladder && std::abs(p.velocity[2]) > 40) {
            step_timer -= dt;
            if (step_timer <= 0) {
                play("step_metal", .4, .92);
                step_timer = .4;
            }
        } else if (p.grounded && speed <= 80)
            step_timer = std::min(step_timer, .12);
        if (swimming && std::sqrt(speed * speed + double(p.velocity[2]) * p.velocity[2]) > 60) {
            swim_timer -= dt;
            if (swim_timer <= 0) {
                play("swim", .6, 1.);
                swim_timer = .85;
            }
        } else
            swim_timer = std::min(swim_timer, .2);
        previous = p;
    }
};

// Feeds exact canonical tick pairs for live play and replay/export alike. Missing
// telemetry, skipped ticks, seeks, mode changes and external mutations fence history.
class LongjumpAnnouncements {
    LjTracker tracker;
    BhState previous{};
    uint32_t epoch = 0;
    bool first = true;

    static bool same(const BhState &a, const BhState &b) {
        if (a.tick != b.tick || a.grounded != b.grounded || a.crouched != b.crouched || a.on_ladder != b.on_ladder)
            return false;
        for (int i = 0; i < 3; ++i)
            if (a.position[i] != b.position[i] || a.velocity[i] != b.velocity[i]) return false;
        return true;
    }

public:
    void reset() {
        tracker.reset();
        first = true;
    }

    bool
    tick(const BhSnapshot &snapshot,
         const BhJumpObservation *o,
         double dt,
         const std::string &style,
         double threshold) {
        if (!o || snapshot.movement_mode != 0 || !same(snapshot.player, o->post)) {
            reset();
            return false;
        }
        if (!first && (epoch != o->epoch || !same(previous, o->pre))) tracker.reset();
        first = false;
        previous = o->post;
        epoch = o->epoch;
        const auto r = tracker.feed(o->pre, o->post, o->command, o->valid == 1, dt, style);
        return r && r->standing && !r->failed && r->distance >= threshold;
    }
};

}  // namespace native
