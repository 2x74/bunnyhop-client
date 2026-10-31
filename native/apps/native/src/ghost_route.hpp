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
        GLuint vao = 0, buffer = 0;
        GLsizei pathVertices = 0, markerVertices = 0;
    };

    Gl &gl;
    GLuint program = 0;
    std::array<Mesh, 4> meshes;
    std::vector<Vertex> vertices;
    GLint projectionLocation = -1, colorLocation = -1, widthLocation = -1, viewportLocation = -1;

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
    explicit GhostRouteGeometry(Gl &api) : gl(api) {
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
        program = link_program(gl, vertex, fragment);
        projectionLocation = gl.GetUniformLocation(program, "projection");
        colorLocation = gl.GetUniformLocation(program, "tint");
        widthLocation = gl.GetUniformLocation(program, "width");
        viewportLocation = gl.GetUniformLocation(program, "viewport");
        for (auto &mesh : meshes) {
            gl.GenVertexArrays(1, &mesh.vao);
            gl.GenBuffers(1, &mesh.buffer);
            gl.BindVertexArray(mesh.vao);
            gl.BindBuffer(GL_ARRAY_BUFFER, mesh.buffer);
            const int sizes[3] = {3, 3, 1};
            const size_t offsets[3] = {offsetof(Vertex, point), offsetof(Vertex, other), offsetof(Vertex, side)};
            for (GLuint attribute = 0; attribute < 3; ++attribute) {
                gl.EnableVertexAttribArray(attribute);
                gl.VertexAttribPointer(
                        attribute,
                        sizes[attribute],
                        GL_FLOAT,
                        GL_FALSE,
                        sizeof(Vertex),
                        reinterpret_cast<void *>(offsets[attribute])
                );
            }
        }
    }

    ~GhostRouteGeometry() {
        for (auto &mesh : meshes) {
            gl.DeleteBuffers(1, &mesh.buffer);
            gl.DeleteVertexArrays(1, &mesh.vao);
        }
        gl.DeleteProgram(program);
    }

    void upload(unsigned slot, const native_render::GhostPath &path, bool fullPath) {
        vertices.clear();
        add_path(path, fullPath);
        auto &mesh = meshes.at(slot);
        mesh.pathVertices = GLsizei(vertices.size());
        for (const auto &takeoff : path.jumps)
            add_marker(takeoff);
        mesh.markerVertices = GLsizei(vertices.size()) - mesh.pathVertices;
        gl.BindBuffer(GL_ARRAY_BUFFER, mesh.buffer);
        gl.BufferData(GL_ARRAY_BUFFER, vertices.size() * sizeof(Vertex), vertices.data(), GL_STATIC_DRAW);
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
        gl.Enable(GL_DEPTH_TEST);
        gl.DepthMask(GL_FALSE);
        gl.Disable(GL_CULL_FACE);
        gl.Enable(GL_BLEND);
        gl.BlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
        gl.UseProgram(program);
        gl.UniformMatrix4fv(projectionLocation, 1, GL_FALSE, projection.data());
        gl.Uniform2f(viewportLocation, float(std::max(viewportWidth, 1)), float(std::max(viewportHeight, 1)));
        gl.BindVertexArray(mesh.vao);
        gl.Uniform1f(widthLocation, path_width_points * pixelDensity);
        const float pathTint[4] = {color[0], color[1], color[2], path_opacity};
        gl.Uniform4fv(colorLocation, 1, pathTint);
        gl.DrawArrays(GL_TRIANGLES, 0, mesh.pathVertices);
        gl.Uniform1f(widthLocation, marker_width_points * pixelDensity);
        const float markerTint[4] = {1, 1, 1, marker_opacity};
        gl.Uniform4fv(colorLocation, 1, markerTint);
        gl.DrawArrays(GL_TRIANGLES, mesh.pathVertices, mesh.markerVertices);
        gl.DepthMask(GL_TRUE);
        gl.Disable(GL_BLEND);
    }
};

