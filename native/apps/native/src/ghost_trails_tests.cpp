#include "ghost_playback.hpp"
#include <cassert>
#include <iostream>

static native_render::GhostPath recorded_path() {
    native_render::GhostPath path;
    path.interval = .01;
    path.start = 0;
    path.end = 1000;
    path.frames.resize(1001);
    path.teleports.resize(1001);
    for (size_t tick = 0; tick < path.frames.size(); ++tick) {
        path.frames[tick].position[0] = float(tick);
        path.frames[tick].flags = 2;
    }
    path.enabled = true;
    return path;
}

int main() {
    using namespace native_render;
    auto path = recorded_path();
    GhostTrails trails;
    auto points = trails.recorded(path, 600);
    assert(points.size() == 126);
    assert(points.front()[0] == 350 && points.back()[0] == 600);
    assert(points.front()[2] == 6);
    points = trails.recorded(path, 200);
    assert(points.front()[0] == 0 && points.back()[0] == 200);
    points = trails.recorded(path, 600);
    assert(points.front()[0] == 350);
    path.teleports[531] = 1;
    points = trails.recorded(path, 600);
    assert(points.front()[0] == 532 && points.back()[0] == 600);
    path.teleports[600] = 1;
    assert(trails.recorded(path, 600).size() == 1);
    path.teleports.assign(1001, 0);
    path.start = 100;
    assert(trails.recorded(path, 80).empty());
    assert(trails.recorded(path, 100).size() == 1);
    path.interval = .001;
    assert(trails.recorded(path, 1000).size() <= ghost_trail_capacity);
    assert(trails.recorded(path, NAN).empty());
    path = recorded_path();
    path.frames[40].flags = 0;
    path.frames[40].position[2] = 1;
    path.teleports[60] = 1;
    path.end = 100;
    path.build_route();
    assert(path.jumps.size() == 1 && path.jumps[0][0] == 39);
    assert(path.jump_links.size() == 3);
    assert(path.jump_links[1].to[0] == 59 && path.jump_links[2].from[0] == 60);
    GhostOptions options;
    options.read({{"ghostWr", false}, {"ghostRouteSource", "pb"}, {"ghostTrail", false}});
    assert(options.visible(GhostSource::pb) && !options.visible(GhostSource::wr));
    assert(options.visible(GhostSource::custom) && !options.trail && options.route_source == GhostSource::pb);
    assert(route_priority(GhostSource::custom) < route_priority(GhostSource::pb));
    assert(route_priority(GhostSource::pb) < route_priority(GhostSource::wr));
    const auto wr = ghost_source_color(GhostSource::wr);
    const auto custom = ghost_source_color(GhostSource::custom);
    assert(wr[0] == 79.f / 255 && wr[1] == 168.f / 255 && wr[2] == 1);
    assert(custom[0] == 233.f / 255 && custom[1] == 240.f / 255 && custom[2] == 251.f / 255);
    const std::array<std::array<float, 3>, 2> colors = {{{1, 0, 0}, {0, 0, 1}}};
    const auto head = trail_color(colors, 1, .5f, 200);
    const auto tail = trail_color(colors, .4f, .5f, 200);
    assert(head[0] == 1 && head[2] == 0 && std::abs(head[3] - .6f) < .0001f);
    assert(tail[0] == 0 && tail[2] == 1 && tail[3] < head[3]);
    assert(trail_color(colors, 1, 1, 40)[3] == 0);
    assert(glow_distance(999) == 1 && glow_distance(1801) == 0);
    assert(halo_width(0) == .85f && halo_alpha(0) == .08f && halo_alpha(7) < halo_alpha(1));
    path = recorded_path();
    path.start = 100;
    path.end = 900;
    assert(!ghost_elapsed_ticks(run_status_idle, 500, 0, .5f));
    assert(*ghost_elapsed_ticks(1, 140, 100, .25f) == 40.25);
    GhostPose pose;
    assert(pose_ghost(path, std::nullopt, pose) && pose.tick == 100 && !pose.moving && !pose.running);
    assert(pose.frame.position[0] == 100 && pose.frame.velocity[0] == 0);
    assert(pose_ghost(path, 40.25, pose) && pose.moving && std::abs(pose.frame.position[0] - 140.25f) < 1e-4f);
    assert(pose_ghost(path, 5000, pose) && pose.tick == 900 && !pose.moving && pose.running);
    path.teleports[141] = 1;
    assert(pose_ghost(path, 40.5, pose) && pose.frame.position[0] == 140);
    path.frames[10].yaw = 350;
    path.frames[11].yaw = 10;
    BhGhostFrame frame{};
    assert(sample_ghost_path(path, 10.5, true, frame) && std::abs(std::remainder(frame.yaw, 360.f)) < 1e-3f);
    GhostEventCursor cursor;
    bool snapped = false;
    assert(!cursor.advance(100, true, snapped) && !snapped);
    const auto played = cursor.advance(103.5, true, snapped);
    assert(played && played->first == 100 && played->second == 103 && !snapped);
    assert(!cursor.advance(103.9, true, snapped));
    assert(!cursor.advance(100, true, snapped) && snapped);
    assert(!cursor.advance(900, true, snapped) && snapped);
    std::cout << "Recorded 2.5s trails, seeks, teleport cuts, route markers, source colours, toggles and ghost "
                 "playback passed\n";
}
