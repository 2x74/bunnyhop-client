#pragma once

// Included after GL declarations. All geometry stays native; effects use a bounded streaming buffer.
class NativePresentation {
public:
    static constexpr int paint_decal = 4;
    static constexpr float paint_uv_offset = 6;

    struct Vertex {
        float p[3], c[4], uv[2];
    };

    struct Quad {
        std::array<native_render::Vec3, 4> p;
        std::array<float, 4> color;
        int soft = 0;
        float distance = 0;
        std::array<std::array<float, 2>, 4> texcoords{};
    };

private:
    Gl &gl;
    GLuint program = 0, vao = 0, vbo = 0;
    std::vector<Quad> quads;
    std::vector<Vertex> vertices;

public:
    explicit NativePresentation(Gl &g) : gl(g) {
        const char *vs = R"(#version 330 core
layout(location=0)in vec3 position;layout(location=1)in vec4 tint;layout(location=2)in vec2 texcoord;
uniform mat4 viewProjection;out vec4 vColor;out vec2 uv;out vec3 world;
void main(){world=position;vColor=tint;uv=texcoord;gl_Position=viewProjection*vec4(position,1);}
)";
        const auto fs = std::string("#version 330 core\n") + native_render::water + R"(
in vec4 vColor;in vec2 uv;in vec3 world;out vec4 color;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1)),f.x),f.y);}
const float paintUvOffset=6.,paintEdgeScale=10.;
void main(){float a=vColor.a;if(uv.y>=paintUvOffset){
    vec2 point=vec2(uv.x,uv.y-paintUvOffset)*2.-1.;
    a*=clamp((1.-length(point))*paintEdgeScale,0.,1.);
    if(a<.003)discard;
}else if(uv.y>=4.){float h=1.-(uv.y-4.);a*=h*h;}else if(uv.x>=0.){bool smoke=uv.y>1.;vec2 st=vec2(uv.x,smoke?uv.y-2.:uv.y);vec2 p=st*2.-1.;float r=dot(p,p);a*=pow(max(0.,1.-r),smoke?1.2:2.);if(smoke){float n=noise(st*5.)*.6+noise(st*11.+3.)*.3+noise(st*23.+7.)*.1;a*=smoothstep(.18,.65,n);}if(a<.003)discard;}color=vec4(waterFog(vColor.rgb,world),a);}
)";
        program = link_program(gl, vs, fs.c_str());
        gl.GenVertexArrays(1, &vao);
        gl.GenBuffers(1, &vbo);
        gl.BindVertexArray(vao);
        gl.BindBuffer(GL_ARRAY_BUFFER, vbo);
        for (int i = 0; i < 3; i++) {
            gl.EnableVertexAttribArray(i);
            const int sizes[3] = {3, 4, 2};
            const size_t offsets[3] = {0, 3, 7};
            gl.VertexAttribPointer(
                    i,
                    sizes[i],
                    GL_FLOAT,
                    GL_FALSE,
                    sizeof(Vertex),
                    reinterpret_cast<void *>(offsets[i] * sizeof(float))
            );
        }
        quads.reserve(8192);
        vertices.reserve(8192 * 6);
    }

    ~NativePresentation() {
        gl.DeleteBuffers(1, &vbo);
        gl.DeleteVertexArrays(1, &vao);
        gl.DeleteProgram(program);
    }

    GLuint shader() const { return program; }

    void clear() { quads.clear(); }

    void quad(const std::array<native_render::Vec3, 4> &p, const std::array<float, 4> &c, int soft = 0) {
        if (quads.size() < 8192 && c[3] > .001f) quads.push_back({p, c, soft, 0});
    }

    void
    decal(const std::array<native_render::Vec3, 4> &points,
          const std::array<float, 4> &color,
          const std::array<std::array<float, 2>, 4> &uv) {
        if (quads.size() < 8192) quads.push_back({points, color, paint_decal, 0, uv});
    }

    void billboard(
            const native_render::Vec3 &p,
            float size,
            const std::array<float, 4> &c,
            const native_render::Vec3 &right,
            const native_render::Vec3 &up,
            int soft = 1
    ) {
        std::array<native_render::Vec3, 4> corners;
        const float signs[4][2] = {{-1, -1}, {1, -1}, {1, 1}, {-1, 1}};
        for (int i = 0; i < 4; i++)
            for (int k = 0; k < 3; k++)
                corners[i][k] = p[k] + size * (right[k] * signs[i][0] + up[k] * signs[i][1]);
        quad(corners, c, soft);
    }

    void
    ribbon(const native_render::Vec3 &a,
           const native_render::Vec3 &b,
           float width,
           const std::array<float, 4> &color,
           const float eye[3]) {
        native_render::Vec3 dir{}, view{}, side{};
        for (int k = 0; k < 3; k++) {
            dir[k] = b[k] - a[k];
            view[k] = eye[k] - (a[k] + b[k]) * .5f;
        }
        side = {dir[1] * view[2] - dir[2] * view[1],
                dir[2] * view[0] - dir[0] * view[2],
                dir[0] * view[1] - dir[1] * view[0]};
        float length = std::hypot(std::hypot(side[0], side[1]), side[2]);
        if (length < 1e-5) return;
        std::array<native_render::Vec3, 4> p;
        for (int k = 0; k < 3; k++) {
            const float w = side[k] / length * width;
            p[0][k] = a[k] - w;
            p[1][k] = b[k] - w;
            p[2][k] = b[k] + w;
            p[3][k] = a[k] + w;
        }
        quad(p, color);
    }

    void draw(const native::Matrix &vp, const float eye[3]) {
        if (quads.empty()) return;
        for (auto &q : quads) {
            for (int k = 0; k < 3; k++) {
                const float d = (q.p[0][k] + q.p[1][k] + q.p[2][k] + q.p[3][k]) * .25f - eye[k];
                q.distance += d * d;
            }
        }
        std::stable_sort(quads.begin(), quads.end(), [](const Quad &a, const Quad &b) {
            return a.distance > b.distance;
        });
        vertices.clear();
        const int ix[6] = {0, 1, 2, 0, 2, 3};
        const float uv[4][2] = {{0, 0}, {1, 0}, {1, 1}, {0, 1}};
        for (const auto &q : quads)
            for (int i : ix) {
                Vertex v{};
                std::copy(q.p[i].begin(), q.p[i].end(), v.p);
                std::copy(q.color.begin(), q.color.end(), v.c);
                if (q.soft == paint_decal) {
                    v.uv[0] = q.texcoords[i][0];
                    v.uv[1] = q.texcoords[i][1] + paint_uv_offset;
                } else {
                    v.uv[0] = q.soft ? uv[i][0] : -1;
                    v.uv[1] = uv[i][1] + (q.soft == 3 ? 4 : q.soft == 2 ? 2 : 0);
                }
                vertices.push_back(v);
            }
        gl.UseProgram(program);
        gl.UniformMatrix4fv(gl.GetUniformLocation(program, "viewProjection"), 1, GL_FALSE, vp.data());
        gl.BindVertexArray(vao);
        gl.BindBuffer(GL_ARRAY_BUFFER, vbo);
        gl.BufferData(GL_ARRAY_BUFFER, vertices.size() * sizeof(Vertex), vertices.data(), GL_STREAM_DRAW);
        gl.Enable(GL_DEPTH_TEST);
        gl.DepthFunc(GL_LEQUAL);
        gl.DepthMask(GL_FALSE);
        gl.Disable(GL_CULL_FACE);
        gl.Enable(GL_BLEND);
        gl.BlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
        gl.DrawArrays(GL_TRIANGLES, 0, GLsizei(vertices.size()));
        gl.DepthMask(GL_TRUE);
        gl.Disable(GL_BLEND);
    }
};
