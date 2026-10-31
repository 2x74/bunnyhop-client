#pragma once

// The website's route guide (apps/web/src/ghost-route.ts): the path in the ghost's colour and a white wire box on
// every takeoff, as screen-space lines of a fixed pixel width. Segments are expanded to quads once, at upload.
class GhostRouteGeometry {
    static constexpr float path_width_points = 2.5f, path_opacity = .85f;
    static constexpr float marker_width_points = 2, marker_opacity = .95f;
    static constexpr float marker_half_width_units = 6, marker_below_units = 1, marker_above_units = 2;
    static constexpr float route_lift_units = 2;

    struct Vertex {
        native_render::Vec3 point, other;
        float side = 0;
    };

    struct Mesh {
        gfx::Geometry geometry;
        int pathVertices = 0, markerVertices = 0;
    };

    gfx::Context &context;
    gfx::Program program;
    gfx::Pipeline pipeline;
    gfx::ConstantBinding constants;

    struct DrawConstants {
        native::Matrix projection{};
        std::array<float, 2> viewport{};
        float width = 0;
        std::array<float, 4> tint{};
    } values;

    std::array<Mesh, 4> meshes;
    std::vector<Vertex> vertices;

    void add_segment(const native_render::Vec3 &from, const native_render::Vec3 &to) {
        const Vertex a{from, to, 1}, b{from, to, -1}, c{to, from, -1}, d{to, from, 1};
        for (const auto &vertex : {a, b, c, a, c, d})
            vertices.push_back(vertex);
    }

    void add_path(const native_render::GhostPath &path, bool fullPath) {
        if (!fullPath) {
            for (const auto &link : path.jump_links)
                add_segment(link.from, link.to);
            return;
        }
        for (size_t tick = path.start + 1; tick <= path.end && tick < path.frames.size(); ++tick) {
            if (path.teleports[tick] || !native_render::valid_ghost_position(path.frames[tick - 1])
                || !native_render::valid_ghost_position(path.frames[tick]))
                continue;
            add_segment(
                    native_render::ghost_feet(path.frames[tick - 1], route_lift_units),
                    native_render::ghost_feet(path.frames[tick], route_lift_units)
            );
        }
    }

    void add_marker(const native_render::Vec3 &takeoff) {
        constexpr float w = marker_half_width_units;
        std::array<native_render::Vec3, 8> corners;
        for (size_t corner = 0; corner < corners.size(); ++corner) {
            corners[corner] = {
                    takeoff[0] + ((corner & 1) ? w : -w),
                    takeoff[1] + ((corner & 2) ? w : -w),
                    takeoff[2] + ((corner & 4) ? marker_above_units : -marker_below_units)
            };
        }
        constexpr std::array<std::array<int, 2>, 12> edges = {
                {{0, 1}, {1, 3}, {3, 2}, {2, 0}, {4, 5}, {5, 7}, {7, 6}, {6, 4}, {0, 4}, {1, 5}, {2, 6}, {3, 7}}
        };
        for (const auto &edge : edges)
            add_segment(corners[size_t(edge[0])], corners[size_t(edge[1])]);
    }

public:
    explicit GhostRouteGeometry(gfx::Context &api) : context(api) {
        const char *vertex = R"(#version 330 core
layout(location=0)in vec3 point;layout(location=1)in vec3 other;layout(location=2)in float side;
uniform mat4 projection;uniform vec2 viewport;uniform float width;
void main(){vec4 a=projection*vec4(point,1),b=projection*vec4(other,1);
if(a.w<1e-3){a=a+(b-a)*((1e-3-a.w)/(b.w-a.w));}if(b.w<1e-3){b=b+(a-b)*((1e-3-b.w)/(a.w-b.w));}
vec2 d=b.xy/b.w-a.xy/a.w;d.x*=viewport.x/viewport.y;d=length(d)>1e-6?normalize(d):vec2(1,0);
vec2 n=vec2(-d.y,d.x);n.x*=viewport.y/viewport.x;gl_Position=a+vec4(n*side*width/viewport.y*a.w,0,0);}
)";
        const char *fragment = R"(#version 330 core
uniform vec4 tint;out vec4 color;void main(){color=tint;}
)";
        program = context.create_program({{"ghost-route", ""}, vertex, fragment});
        const gfx::ConstantField fields[] = {
                {"projection", offsetof(DrawConstants, projection), 64, gfx::ConstantType::matrix4},
                {"viewport", offsetof(DrawConstants, viewport), 8, gfx::ConstantType::float2},
                {"width", offsetof(DrawConstants, width), 4, gfx::ConstantType::float1},
                {"tint", offsetof(DrawConstants, tint), 16, gfx::ConstantType::float4},
        };
        constants = context.create_constants(program, {fields, sizeof(DrawConstants)});
        gfx::PipelineState state;
        state.depth.write = false;
        state.blend.enabled = true;
        pipeline = context.create_pipeline(state);
        const gfx::VertexAttribute attributes[] = {
                {0, 3, offsetof(Vertex, point)},
                {1, 3, offsetof(Vertex, other)},
                {2, 1, offsetof(Vertex, side)},
        };
        for (auto &mesh : meshes)
            mesh.geometry = context.create_geometry(sizeof(Vertex), attributes);
    }

    ~GhostRouteGeometry() {
        for (auto &mesh : meshes)
            context.destroy(mesh.geometry);
        context.destroy(pipeline);
        context.destroy(program);
    }

    void upload(unsigned slot, const native_render::GhostPath &path, bool fullPath) {
        vertices.clear();
        add_path(path, fullPath);
        auto &mesh = meshes.at(slot);
        mesh.pathVertices = int(vertices.size());
        for (const auto &takeoff : path.jumps)
            add_marker(takeoff);
        mesh.markerVertices = int(vertices.size()) - mesh.pathVertices;
        context.stream_vertices(mesh.geometry, std::as_bytes(std::span(vertices)));
        vertices.clear();
        vertices.shrink_to_fit();
    }

    void
    draw(unsigned slot,
         const native::Matrix &projection,
         const std::array<float, 3> &color,
         int viewportWidth,
         int viewportHeight,
         float pixelDensity) {
        const auto &mesh = meshes.at(slot);
        if (!mesh.pathVertices && !mesh.markerVertices) return;
        context.pipeline(pipeline);
        context.bind_program(program);
        values.projection = projection;
        values.viewport = {float(std::max(viewportWidth, 1)), float(std::max(viewportHeight, 1))};
        context.bind_geometry(mesh.geometry);
        values.width = path_width_points * pixelDensity;
        values.tint = {color[0], color[1], color[2], path_opacity};
        context.constants(constants, &values);
        context.draw(gfx::Primitive::triangles, 0, mesh.pathVertices);
        values.width = marker_width_points * pixelDensity;
        values.tint = {1, 1, 1, marker_opacity};
        context.constants(constants, &values);
        context.draw(gfx::Primitive::triangles, mesh.pathVertices, mesh.markerVertices);
        context.depth_write(true);
        context.blend(false);
    }
};
