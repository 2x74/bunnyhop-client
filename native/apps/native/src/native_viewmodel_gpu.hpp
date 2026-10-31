#pragma once
#include "native_viewmodel_constants.hpp"

// Included beside NativeViewmodel inside native; mesh/program ownership is independent of pose evaluation.
class NativeViewmodelGpu {
protected:
    struct Mesh {
        gfx::Geometry geometry;
        size_t vertices = 0, offset = 0, indices = 0, indexOffset = 0, glowOffset = 0;
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

    struct PlayerProgram {
        gfx::Program program;
        gfx::ConstantBinding base, glow, accessory, ghost, actor_glow, aura, aura_pass;
        mutable NativePlayerConstants values;
    };

    std::optional<gfx::Context> ownedContext;
    gfx::Context &graphicsContext;
    using PlayerMaterial = native_render::PlayerMaterial;
    static constexpr size_t vertex_floats = 23;
    // The metals' scene reflection sampler uses a separate unit from the skinning pose.
    static constexpr unsigned reflection_unit = 9;
    static constexpr int max_pose_bones = 258;
    gfx::Texture bonesTexture, identityBonesTexture, reflectionCube;
    gfx::Sampler bonesSampler, reflectionSampler;
    std::array<gfx::Pipeline, 96> pipelines;
    bool resourcesReady = false;
    gfx::PipelineState drawState;
    std::unordered_map<int, PlayerProgram> programs;
    std::unique_ptr<native_render::PlayerShaderSources> shaders;
    int cosmeticsTier = 2, playerLookTier = 1;
    bool showGlow = true;
    std::unordered_map<std::string, Mesh> meshes;
    std::vector<float> data;

    void create_bindings(PlayerProgram &p) {
        p.base = graphicsContext.create_constants(p.program, {player_base_fields, sizeof(p.values)});
        p.glow = graphicsContext.create_constants(p.program, {player_glow_fields, sizeof(p.values)});
        p.accessory = graphicsContext.create_constants(p.program, {player_accessory_fields, sizeof(p.values)});
        p.ghost = graphicsContext.create_constants(p.program, {player_ghost_fields, sizeof(p.values)});
        p.actor_glow = graphicsContext.create_constants(p.program, {player_actor_glow_fields, sizeof(p.values)});
        p.aura = graphicsContext.create_constants(p.program, {player_aura_fields, sizeof(p.values)});
        p.aura_pass = graphicsContext.create_constants(p.program, {player_aura_pass_fields, sizeof(p.values)});
        graphicsContext.texture_unit(p.program, "boneMatrices", 0);
        graphicsContext.texture_unit(p.program, "uFinEnv", reflection_unit);
        graphicsContext.texture_unit(p.program, "uCosEnv", reflection_unit);
        graphicsContext.texture_unit(p.program, "uPlayerEnv", reflection_unit);
    }

    PlayerProgram link_player_program(int finish, bool glove, bool detail, PlayerMaterial material) {
        std::string vertex, fragment;
        if (graphicsContext.backend() == gfx::Backend::opengl) {
            const auto defines = native_render::player_defines(finish, glove, detail, material);
            const bool gun = material == PlayerMaterial::gun || material == PlayerMaterial::world_gun;
            vertex = defines + (gun ? shaders->gunVertex : shaders->vertex);
            fragment = defines
                       + (material == PlayerMaterial::ghost ? shaders->ghost
                          : gun                             ? shaders->gun
                                                            : shaders->solid);
        }
        const auto key = native_render::player_shader_key(finish, glove, detail, material);
        PlayerProgram p;
        p.program = graphicsContext.create_program({{key, ""}, vertex.c_str(), fragment.c_str()});
        create_bindings(p);
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

    void upload_mesh(Mesh &mesh) {
        // Interleaving once preserves every original attribute without a backend-specific second vertex stream.
        constexpr size_t gpu_vertex_floats = vertex_floats + 3;
        std::vector<float> vertices(mesh.vertices * gpu_vertex_floats);
        for (size_t i = 0; i < mesh.vertices; ++i) {
            auto *out = vertices.data() + i * gpu_vertex_floats;
            std::copy_n(data.data() + mesh.offset + i * vertex_floats, vertex_floats, out);
            std::copy_n(data.data() + mesh.glowOffset + i * 3, 3, out + vertex_floats);
        }
        static constexpr gfx::VertexAttribute attributes[] = {
                {0, 3, 0},
                {1, 3, 12},
                {2, 3, 24},
                {3, 4, 36},
                {4, 4, 52},
                {5, 1, 68},
                {6, 4, 72},
                {8, 1, 88},
                {7, 3, vertex_floats * sizeof(float)}
        };
        mesh.geometry = graphicsContext.create_geometry(gpu_vertex_floats * sizeof(float), attributes);
        graphicsContext.stream_vertices(mesh.geometry, std::as_bytes(std::span(vertices)));
        if (mesh.indices) {
            graphicsContext.upload_indices(
                    mesh.geometry, std::as_bytes(std::span(data.data() + mesh.indexOffset, mesh.indices))
            );
        }
    }

    void mesh(const Mesh *resource, int instances = 1) {
        if (!resource) return;
        const auto &mesh = *resource;
        graphicsContext.bind_geometry(mesh.geometry);
        if (mesh.indices)
            graphicsContext.draw_indexed(
                    gfx::Primitive::triangles, gfx::IndexType::u32, 0, int(mesh.indices), instances
            );
        else if (instances > 1)
            graphicsContext.draw_instanced(gfx::Primitive::triangles, 0, int(mesh.vertices), instances);
        else
            graphicsContext.draw(gfx::Primitive::triangles, 0, int(mesh.vertices));
    }

    template <size_t Size>
    static void write_vector(std::array<float, Size> &out, const float *values) {
        std::copy_n(values, Size, out.begin());
    }

    template <size_t Count>
    static void write_vector(std::array<std::array<float, 4>, Count> &out, const float *values) {
        for (size_t i = 0; i < Count; ++i)
            std::copy_n(values + i * 3, 3, out[i].begin());
    }

    void apply_draw_state() {
        const unsigned blend = !drawState.blend.enabled                               ? 0u
                               : drawState.blend.destination == gfx::BlendFactor::one ? 2u
                                                                                      : 1u;
        const unsigned index = blend + (drawState.depth.write ? 0u : 3u)
                               + (drawState.raster.cull == gfx::Cull::front ? 6u : 0u)
                               + (drawState.color_write[0] ? 0u : 12u)
                               + (drawState.raster.winding == gfx::Winding::clockwise ? 24u : 0u)
                               + (drawState.depth.compare == gfx::Compare::less ? 48u : 0u);
        graphicsContext.pipeline(pipelines[index]);
    }

    void draw_glow(std::span<const Mesh *const> parts, const PlayerProgram &program, bool aura, float scale) {
        const auto previous = drawState;
        drawState.blend = {true, gfx::BlendFactor::source_alpha, gfx::BlendFactor::one};
        drawState.depth.write = false;
        drawState.raster.cull = gfx::Cull::front;
        apply_draw_state();
        program.values.auraSize = scale;
        program.values.auraPass = 1;
        graphicsContext.constants(program.aura, &program.values);
        for (const auto &part : parts)
            mesh(part);
        if (aura && !parts.empty()) {
            program.values.auraPass = 2;
            graphicsContext.constants(program.aura_pass, &program.values);
            mesh(parts.front(), native_render::glow_halo_layers);
        }
        drawState = previous;
        apply_draw_state();
        program.values.auraPass = 0;
        graphicsContext.constants(program.aura_pass, &program.values);
    }

    struct BindOptions {
        PlayerMaterial material = PlayerMaterial::solid;
        bool detail = false;
        float opacity = 1, mirror = 1;
        std::array<float, 3> offset{};
        const native_render::Glow *glow = nullptr;
        bool identityPose = false;
    };

    // Uniforms every player program reads, the same for each draw of a frame.
    void bind_shared(const PlayerProgram &p, double seconds) {
        constexpr float sun_direction[3] = {.4196f, .7792f, .4596f}, sun_color[3] = {1, .96f, .9f};
        p.values.auraPass = 0;
        p.values.auraSize = 1;
        p.values.glowTime = float(seconds);
        p.values.finTime = float(std::fmod(seconds, 3600.));
        p.values.cosTier = float(cosmeticsTier);
        p.values.playerLook = float(playerLookTier);
        p.values.fabric = 0;
        // The scene reflections of the Enhanced and Cinematic looks have no native equivalent: metals keep the studio.
        p.values.finEnvOn = 0;
        p.values.cosEnvOn = 0;
        p.values.playerEnvOn = 0;
        write_vector(p.values.finSunDir, sun_direction);
        write_vector(p.values.finSunColor, sun_color);
        const float noFlash[4] = {1, .72f, .4f, 0}, origin[3] = {};
        write_vector(p.values.gunFlash, noFlash);
        write_vector(p.values.gunFlashPos, origin);
        p.values.glowDistance = 1;
        p.values.glowNearFade = {0, 0};
        p.values.nearFade = {0, 0};
    }

    void bind_look(const PlayerProgram &p, const Look &look) {
        write_vector(p.values.palette, look.palette.data());
        write_vector(p.values.accent, look.accent.data());
        write_vector(p.values.glove, look.gloveColors.data());
        write_vector(p.values.hairColor, look.hairColor.data());
        write_vector(p.values.headwearScale, look.fit.scale.data());
        write_vector(p.values.headwearOffset, look.fit.offset.data());
        write_vector(p.values.headwearFaceScale, look.fit.faceScale.data());
        write_vector(p.values.headwearFaceOffset, look.fit.faceOffset.data());
        const float ponytail[4] = {0, 0, look.hairLength, 0};
        write_vector(p.values.ponytail, ponytail);
    }

    void bind_glow(const PlayerProgram &p, const native_render::Glow *glow, float opacity) {
        p.values.glowEnabled = showGlow && glow && glow->enabled ? 1u : 0u;
        p.values.glowOpacity = opacity;
        if (!glow) return;
        float rgb[3];
        for (int k = 0; k < 3; k++)
            rgb[k] = native_render::srgb_linear(glow->color[k]);
        write_vector(p.values.glowColor, rgb);
        p.values.glowIntensity = glow->intensity;
    }

    const PlayerProgram &
    bind(const Look &look,
         const native::Matrix &projection,
         const native::Matrix &model,
         const float eye[3],
         double seconds,
         const BindOptions &options) {
        graphicsContext.bind_texture(reflection_unit, reflectionCube, reflectionSampler);
        graphicsContext.bind_texture(0, options.identityPose ? identityBonesTexture : bonesTexture, bonesSampler);
        const auto &p = program(look, options.material, options.detail);
        graphicsContext.bind_program(p.program);
        const auto webModel = native_render::web_model(model), webView = native_render::web_view(projection);
        const auto camera = native_render::to_web_space(eye);
        p.values.projection = projection;
        p.values.model = model;
        p.values.modelMatrix = webModel;
        p.values.viewMatrix = webView;
        write_vector(p.values.cameraPosition, camera.data());
        write_vector(p.values.offset, options.offset.data());
        p.values.mirror = options.mirror;
        p.values.opacity = options.opacity;
        bind_shared(p, seconds);
        bind_look(p, look);
        bind_glow(p, options.glow, options.opacity);
        graphicsContext.constants(p.base, &p.values);
        if (options.glow) graphicsContext.constants(p.glow, &p.values);
        return p;
    }

    void upload_pose(std::span<const float> pose) {
        graphicsContext.bind_texture(0, bonesTexture, bonesSampler);
        graphicsContext.update_texture(bonesTexture, {0, 0, 3, int(pose.size() / 12)}, pose.data());
    }

    void release_samplers() {
        // Legacy scene passes still bind textures directly and must retain each texture's own filtering.
        graphicsContext.unbind_sampler(0);
        graphicsContext.unbind_sampler(reflection_unit);
    }

    void prepare_pipelines() {
        for (unsigned i = 0; i < pipelines.size(); ++i) {
            gfx::PipelineState state;
            const unsigned blend = i % 3;
            state.blend.enabled = blend != 0;
            state.blend.destination = blend == 2 ? gfx::BlendFactor::one : gfx::BlendFactor::inverse_source_alpha;
            state.depth.write = (i / 3 % 2) == 0;
            state.raster.cull = i / 6 % 2 ? gfx::Cull::front : gfx::Cull::none;
            state.color_write.fill((i / 12 % 2) == 0);
            state.depth.compare = i / 48 ? gfx::Compare::less : gfx::Compare::less_equal;
            state.raster.winding = i / 24 % 2 ? gfx::Winding::clockwise : gfx::Winding::counter_clockwise;
            pipelines[i] = graphicsContext.create_pipeline(state);
        }
    }

    void prepare_resources() {
        if (resourcesReady) return;
        const uint8_t black[4] = {0, 0, 0, 255};
        const std::array<const void *, 6> faces = {black, black, black, black, black, black};
        reflectionCube = graphicsContext.create_texture({1, 1, gfx::Format::rgba8, gfx::TextureKind::cube}, faces);
        reflectionSampler = graphicsContext.create_sampler({});
        gfx::SamplerDesc nearest;
        nearest.minification = nearest.magnification = gfx::Filter::nearest;
        bonesSampler = graphicsContext.create_sampler(nearest);
        bonesTexture = graphicsContext.create_texture({3, max_pose_bones, gfx::Format::rgba32f});
        // Floor draws reuse a separate immutable pose while animated actors update their shared texture.
        const float identity[12] = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0};
        const std::array<const void *, 1> identity_data = {identity};
        identityBonesTexture = graphicsContext.create_texture({3, 1, gfx::Format::rgba32f}, identity_data);
        graphicsContext.bind_texture(0, bonesTexture, bonesSampler);
        prepare_pipelines();
        for (auto &[name, mesh] : meshes)
            upload_mesh(mesh);
        resourcesReady = true;
    }

    explicit NativeViewmodelGpu(Gl &api) : ownedContext(std::in_place, api), graphicsContext(*ownedContext) {}

    explicit NativeViewmodelGpu(gfx::Context &context) : graphicsContext(context) {}

    ~NativeViewmodelGpu() {
        if (!resourcesReady) return;
        for (auto &[name, mesh] : meshes)
            graphicsContext.destroy(mesh.geometry);
        for (auto &[key, p] : programs) {
            graphicsContext.destroy(p.base);
            graphicsContext.destroy(p.glow);
            graphicsContext.destroy(p.accessory);
            graphicsContext.destroy(p.ghost);
            graphicsContext.destroy(p.actor_glow);
            graphicsContext.destroy(p.aura);
            graphicsContext.destroy(p.aura_pass);
            graphicsContext.destroy(p.program);
        }
        for (auto &pipeline : pipelines)
            graphicsContext.destroy(pipeline);
        graphicsContext.destroy(reflectionCube);
        graphicsContext.destroy(bonesTexture);
        graphicsContext.destroy(identityBonesTexture);
        graphicsContext.destroy(bonesSampler);
        graphicsContext.destroy(reflectionSampler);
    }
};
