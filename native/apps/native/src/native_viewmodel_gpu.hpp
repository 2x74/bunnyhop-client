#pragma once

// Included beside NativeViewmodel inside native; mesh/program ownership is independent of pose evaluation.
class NativeViewmodelGpu {
protected:
    struct Mesh {
        GLuint vao = 0, vbo = 0, ebo = 0;
        size_t vertices = 0, offset = 0, indices = 0, indexOffset = 0, glowOffset = 0;
        GLuint glowVbo = 0;
    };

    struct HeadwearFit {
        std::array<float, 3> scale{1, 1, 1}, offset{}, faceScale{1, 1, 1}, faceOffset{};
    };

    struct Look {
        std::string outfit = "outfit-cream", knife = "carrot", glove = "knit", gloveId = "glove-knit", hat,
                    body = "classic", bodyLook = "bunny", hatMesh;
        int finish = 0, crown = 0;
        // The standard bunny lowers its hood for a wig (loadout.ts isWig).
        bool hoodDown = false;
        std::array<float, 24> palette{};
        std::array<float, 15> gloveColors{};
        std::array<float, 3> accent{}, hairColor{};
        // The ponytail's length over the built one (loadout.hairLength / 100).
        float hairLength = 1;
        HeadwearFit fit;
    };

    gfx::Context graphicsContext;
    Gl &gl;
    using PlayerProgram = native_render::PlayerProgram;
    using PlayerMaterial = native_render::PlayerMaterial;
    static constexpr size_t vertex_floats = 23;
    // The metals' scene reflection sampler uses a separate unit from the skinning pose.
    static constexpr GLint reflection_unit = 9;
    GLuint bonesTexture = 0, identityBonesTexture = 0, reflectionCube = 0;
    std::unordered_map<int, PlayerProgram> programs;
    std::unique_ptr<native_render::PlayerShaderSources> shaders;
    int cosmeticsTier = 2, playerLookTier = 1;
    bool showGlow = true;
    std::unordered_map<std::string, Mesh> meshes;
    std::vector<float> data;

    PlayerProgram link_player_program(int finish, bool glove, bool detail, PlayerMaterial material) {
        const auto defines = native_render::player_defines(finish, glove, detail, material);
        const bool gun = material == PlayerMaterial::gun || material == PlayerMaterial::world_gun;
        const auto vertex = defines + (gun ? shaders->gunVertex : shaders->vertex);
        const auto fragment = defines
                              + (material == PlayerMaterial::ghost ? shaders->ghost
                                 : gun                             ? shaders->gun
                                                                   : shaders->solid);
        PlayerProgram p;
        p.id = link_program(gl, vertex.c_str(), fragment.c_str());
        auto at = [&](const char *name) {
            return gl.GetUniformLocation(p.id, name);
        };
        p.projection = at("projection");
        p.model = at("model");
        p.modelMatrix = at("modelMatrix");
        p.viewMatrix = at("viewMatrix");
        p.cameraPosition = at("cameraPosition");
        p.offset = at("offset");
        p.mirror = at("mirror");
        p.auraPass = at("auraPass");
        p.auraSize = at("auraSize");
        p.glowTime = at("glowTime");
        p.boneMatrices = at("boneMatrices");
        p.palette = at("uPalette");
        p.accent = at("uAccent");
        p.glove = at("uGlove");
        p.finTime = at("uFinTime");
        p.cosTier = at("uCosTier");
        p.playerLook = at("uPlayerLook");
        p.fabric = at("uFabric");
        p.headwearScale = at("uHeadwearScale");
        p.headwearOffset = at("uHeadwearOffset");
        p.headwearFaceScale = at("uHeadwearFaceScale");
        p.headwearFaceOffset = at("uHeadwearFaceOffset");
        p.hairColor = at("uHairColor");
        p.propellerAngle = at("uPropellerAngle");
        p.capybara = at("uCapybara");
        p.ponytail = at("uPonytail");
        p.finEnvOn = at("uFinEnvOn");
        p.cosEnvOn = at("uCosEnvOn");
        p.playerEnvOn = at("uPlayerEnvOn");
        p.finSunDir = at("uFinSunDir");
        p.finSunColor = at("uFinSunColor");
        p.finEnv = at("uFinEnv");
        p.cosEnv = at("uCosEnv");
        p.playerEnv = at("uPlayerEnv");
        p.gunFlash = at("uGunFlash");
        p.gunFlashPos = at("uGunFlashPos");
        p.glowEnabled = at("playerGlowEnabled");
        p.glowColor = at("playerGlowColor");
        p.glowIntensity = at("playerGlowIntensity");
        p.glowOpacity = at("glowOpacity");
        p.glowAxisA = at("glowAxisA");
        p.glowAxisB = at("glowAxisB");
        p.glowNearFade = at("glowNearFade");
        p.glowDistance = at("uGlowDistance");
        p.ghost = at("uGhost");
        p.ghostRim = at("uGhostRim");
        p.opacity = at("uOpacity");
        p.axisA = at("uAxisA");
        p.axisB = at("uAxisB");
        p.nearFade = at("uNearFade");
        return p;
    }

    const PlayerProgram &program(const Look &look, PlayerMaterial material, bool detail = false) {
        const bool glove = look.glove != "knit";
        // Guns take no finish (the knife's finish stays on the knife), as on the website.
        const int finish = material == PlayerMaterial::solid ? look.finish : 0;
        const int key = native_render::player_program_key(finish, glove, detail, material);
        if (const auto found = programs.find(key); found != programs.end()) return found->second;
        return programs.emplace(key, link_player_program(finish, glove, detail, material)).first->second;
    }

    void mesh(const std::string &name, int instances = 1) {
        auto at = meshes.find(name);
        if (at == meshes.end()) return;
        auto &m = at->second;
        if (!m.vao) {
            gl.GenVertexArrays(1, &m.vao);
            gl.BindVertexArray(m.vao);
            gl.GenBuffers(1, &m.vbo);
            gl.BindBuffer(GL_ARRAY_BUFFER, m.vbo);
            gl.BufferData(
                    GL_ARRAY_BUFFER, m.vertices * vertex_floats * sizeof(float), data.data() + m.offset, GL_STATIC_DRAW
            );
            // position, normal, partColor, skinIndex, skinWeight, accent, finishUV, then headwear at location 8
            // (location 7 is the glow's smooth normal, in its own buffer).
            constexpr std::array<GLuint, 8> location = {0, 1, 2, 3, 4, 5, 6, 8};
            constexpr std::array<int, 8> size = {3, 3, 3, 4, 4, 1, 4, 1}, offset = {0, 3, 6, 9, 13, 17, 18, 22};
            for (size_t a = 0; a < location.size(); a++) {
                gl.EnableVertexAttribArray(location[a]);
                gl.VertexAttribPointer(
                        location[a],
                        size[a],
                        GL_FLOAT,
                        GL_FALSE,
                        vertex_floats * sizeof(float),
                        reinterpret_cast<void *>(size_t(offset[a]) * 4)
                );
            }
            gl.GenBuffers(1, &m.glowVbo);
            gl.BindBuffer(GL_ARRAY_BUFFER, m.glowVbo);
            gl.BufferData(GL_ARRAY_BUFFER, m.vertices * 3 * sizeof(float), data.data() + m.glowOffset, GL_STATIC_DRAW);
            gl.EnableVertexAttribArray(7);
            gl.VertexAttribPointer(7, 3, GL_FLOAT, GL_FALSE, 3 * sizeof(float), nullptr);
            if (m.indices) {
                gl.GenBuffers(1, &m.ebo);
                gl.BindBuffer(GL_ELEMENT_ARRAY_BUFFER, m.ebo);
                gl.BufferData(GL_ELEMENT_ARRAY_BUFFER, m.indices * 4, data.data() + m.indexOffset, GL_STATIC_DRAW);
            }
        }
        gl.BindVertexArray(m.vao);
        if (instances > 1) {
            if (m.indices)
                gl.DrawElementsInstanced(GL_TRIANGLES, m.indices, GL_UNSIGNED_INT, nullptr, instances);
            else
                gl.DrawArraysInstanced(GL_TRIANGLES, 0, m.vertices, instances);
        } else if (m.indices)
            gl.DrawElements(GL_TRIANGLES, m.indices, GL_UNSIGNED_INT, nullptr);
        else
            gl.DrawArrays(GL_TRIANGLES, 0, m.vertices);
    }

    void draw_glow(std::span<const std::string> parts, const PlayerProgram &program, bool aura, float scale) {
        gl.Uniform1f(program.auraSize, scale);
        gl.Enable(GL_BLEND);
        gl.BlendFunc(GL_SRC_ALPHA, GL_ONE);
        gl.DepthMask(GL_FALSE);
        gl.Enable(GL_CULL_FACE);
        gl.CullFace(GL_FRONT);
        gl.Uniform1f(program.auraPass, 1);
        for (const auto &part : parts) {
            mesh(part);
        }
        if (aura && !parts.empty()) {
            gl.Uniform1f(program.auraPass, 2);
            mesh(parts.front(), native_render::glow_halo_layers);
        }
        gl.CullFace(GL_BACK);
        gl.Disable(GL_CULL_FACE);
        gl.Uniform1f(program.auraPass, 0);
        gl.Disable(GL_BLEND);
        gl.DepthMask(GL_TRUE);
    }

    struct BindOptions {
        PlayerMaterial material = PlayerMaterial::solid;
        bool detail = false;
        float opacity = 1, mirror = 1;
        std::array<float, 3> offset{};
        const native_render::Glow *glow = nullptr;
        GLuint poseTexture = 0;
    };

    // Uniforms every player program reads, the same for each draw of a frame.
    void bind_shared(const PlayerProgram &p, double seconds) {
        constexpr float sun_direction[3] = {.4196f, .7792f, .4596f}, sun_color[3] = {1, .96f, .9f};
        gl.Uniform1i(p.boneMatrices, 0);
        gl.Uniform1f(p.auraPass, 0);
        gl.Uniform1f(p.auraSize, 1);
        gl.Uniform1f(p.glowTime, float(seconds));
        gl.Uniform1f(p.finTime, float(std::fmod(seconds, 3600.)));
        gl.Uniform1f(p.cosTier, float(cosmeticsTier));
        gl.Uniform1f(p.playerLook, float(playerLookTier));
        gl.Uniform1f(p.fabric, 0);
        // The scene reflections of the Enhanced and Cinematic looks have no native equivalent: metals keep the studio.
        gl.Uniform1f(p.finEnvOn, 0);
        gl.Uniform1f(p.cosEnvOn, 0);
        gl.Uniform1f(p.playerEnvOn, 0);
        gl.Uniform3fv(p.finSunDir, 1, sun_direction);
        gl.Uniform3fv(p.finSunColor, 1, sun_color);
        gl.Uniform1i(p.finEnv, reflection_unit);
        gl.Uniform1i(p.cosEnv, reflection_unit);
        gl.Uniform1i(p.playerEnv, reflection_unit);
        const float noFlash[4] = {1, .72f, .4f, 0}, origin[3] = {};
        gl.Uniform4fv(p.gunFlash, 1, noFlash);
        gl.Uniform3fv(p.gunFlashPos, 1, origin);
        gl.Uniform1f(p.glowDistance, 1);
        gl.Uniform2f(p.glowNearFade, 0, 0);
        gl.Uniform2f(p.nearFade, 0, 0);
    }

    void bind_look(const PlayerProgram &p, const Look &look) {
        gl.Uniform3fv(p.palette, 8, look.palette.data());
        gl.Uniform3fv(p.accent, 1, look.accent.data());
        gl.Uniform3fv(p.glove, 5, look.gloveColors.data());
        gl.Uniform3fv(p.hairColor, 1, look.hairColor.data());
        gl.Uniform3fv(p.headwearScale, 1, look.fit.scale.data());
        gl.Uniform3fv(p.headwearOffset, 1, look.fit.offset.data());
        gl.Uniform3fv(p.headwearFaceScale, 1, look.fit.faceScale.data());
        gl.Uniform3fv(p.headwearFaceOffset, 1, look.fit.faceOffset.data());
        const float ponytail[4] = {0, 0, look.hairLength, 0};
        gl.Uniform4fv(p.ponytail, 1, ponytail);
    }

    void bind_glow(const PlayerProgram &p, const native_render::Glow *glow, float opacity) {
        gl.Uniform1i(p.glowEnabled, showGlow && glow && glow->enabled);
        gl.Uniform1f(p.glowOpacity, opacity);
        if (!glow) return;
        float rgb[3];
        for (int k = 0; k < 3; k++)
            rgb[k] = native_render::srgb_linear(glow->color[k]);
        gl.Uniform3fv(p.glowColor, 1, rgb);
        gl.Uniform1f(p.glowIntensity, glow->intensity);
    }

    const PlayerProgram &
    bind(const Look &look,
         const native::Matrix &projection,
         const native::Matrix &model,
         const float eye[3],
         double seconds,
         const BindOptions &options) {
        gl.ActiveTexture(GL_TEXTURE0 + reflection_unit);
        gl.BindTexture(GL_TEXTURE_CUBE_MAP, reflectionCube);
        gl.ActiveTexture(GL_TEXTURE0);
        gl.BindTexture(GL_TEXTURE_2D, options.poseTexture ? options.poseTexture : bonesTexture);
        const auto &p = program(look, options.material, options.detail);
        gl.UseProgram(p.id);
        const auto webModel = native_render::web_model(model), webView = native_render::web_view(projection);
        const auto camera = native_render::to_web_space(eye);
        gl.UniformMatrix4fv(p.projection, 1, GL_FALSE, projection.data());
        gl.UniformMatrix4fv(p.model, 1, GL_FALSE, model.data());
        gl.UniformMatrix4fv(p.modelMatrix, 1, GL_FALSE, webModel.data());
        gl.UniformMatrix4fv(p.viewMatrix, 1, GL_FALSE, webView.data());
        gl.Uniform3fv(p.cameraPosition, 1, camera.data());
        gl.Uniform3fv(p.offset, 1, options.offset.data());
        gl.Uniform1f(p.mirror, options.mirror);
        gl.Uniform1f(p.opacity, options.opacity);
        bind_shared(p, seconds);
        bind_look(p, look);
        bind_glow(p, options.glow, options.opacity);
        return p;
    }

    void upload_bound_pose(std::span<const float> pose) {
        gl.TexImage2D(GL_TEXTURE_2D, 0, GL_RGBA32F, 3, GLsizei(pose.size() / 12), 0, GL_RGBA, GL_FLOAT, pose.data());
    }

    void upload_pose(std::span<const float> pose) {
        gl.ActiveTexture(GL_TEXTURE0);
        gl.BindTexture(GL_TEXTURE_2D, bonesTexture);
        upload_bound_pose(pose);
    }

    void prepare_resources() {
        gl.GenTextures(1, &reflectionCube);
        gl.BindTexture(GL_TEXTURE_CUBE_MAP, reflectionCube);
        const uint8_t black[4] = {0, 0, 0, 255};
        for (GLenum face = 0; face < 6; ++face)
            gl.TexImage2D(
                    GL_TEXTURE_CUBE_MAP_POSITIVE_X + face, 0, GL_RGBA8, 1, 1, 0, GL_RGBA, GL_UNSIGNED_BYTE, black
            );
        gl.TexParameteri(GL_TEXTURE_CUBE_MAP, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
        gl.TexParameteri(GL_TEXTURE_CUBE_MAP, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
        gl.GenTextures(1, &bonesTexture);
        gl.BindTexture(GL_TEXTURE_2D, bonesTexture);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
        // Floor weapons share a rigid identity pose. Keep it separate from the mutable animated rig
        // so drawing each weapon does not redefine a texture still in use by earlier draws.
        const float identity[12] = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0};
        gl.GenTextures(1, &identityBonesTexture);
        gl.BindTexture(GL_TEXTURE_2D, identityBonesTexture);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
        gl.TexImage2D(GL_TEXTURE_2D, 0, GL_RGBA32F, 3, 1, 0, GL_RGBA, GL_FLOAT, identity);
        gl.BindTexture(GL_TEXTURE_2D, bonesTexture);
    }

    explicit NativeViewmodelGpu(Gl &api) : graphicsContext(api), gl(api) {}

    ~NativeViewmodelGpu() {
        for (auto &[name, m] : meshes) {
            if (m.glowVbo) gl.DeleteBuffers(1, &m.glowVbo);
            if (m.ebo) gl.DeleteBuffers(1, &m.ebo);
            if (m.vbo) gl.DeleteBuffers(1, &m.vbo);
            if (m.vao) gl.DeleteVertexArrays(1, &m.vao);
        }
        for (const auto &[key, p] : programs)
            gl.DeleteProgram(p.id);
        if (reflectionCube) gl.DeleteTextures(1, &reflectionCube);
        if (bonesTexture) gl.DeleteTextures(1, &bonesTexture);
        if (identityBonesTexture) gl.DeleteTextures(1, &identityBonesTexture);
    }
};
