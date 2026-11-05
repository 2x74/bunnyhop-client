#pragma once

// The animated map props' skinned meshes (map_props.hpp poses them): one vertex buffer per studio model, its material
// groups per skin, and one float texture of skinning matrices that the world shaders read. A prop whose model doesn't
// load or draw stays the core's frozen prop group, which still hides and shows as the map says.
// Included from renderer.hpp after Gl.

class MapPropMeshes {
public:
    struct Group {
        uint32_t material, first, count;
    };

    // Bones per row of the matrix texture; each bone takes three RGBA texels (a 3x4 matrix).
    static constexpr uint32_t bones_per_row = 256;
    static constexpr uint32_t texels_per_bone = 3;
    // Decoded animations every posed model of a map may take, in floats (128 MiB).
    static constexpr size_t max_animation_floats = size_t(32) * 1024 * 1024;

    explicit MapPropMeshes(Gl &api) : gl(api) {}

    MapPropMeshes(const MapPropMeshes &) = delete;
    MapPropMeshes &operator=(const MapPropMeshes &) = delete;

    ~MapPropMeshes() { release(); }

    native_map_props::MapProps props;

    // Builds the posed props of the loaded map. `prop_groups` are the core's; `names` its material names.
    ResourceLoading load(BhContext *core, std::span<const BhPropGroup> prop_groups, const nlohmann::json &names) {
        release();
        mark_owners(prop_groups);
        index_prop_materials(prop_groups, names);
        size_t count = 0;
        const auto *animated = bh_animated_props(core, &count);
        for (size_t i = 0; animated && i < count; ++i) {
            const auto prop = animated[i];
            if (prop.entity >= owners_.size() || !owners_[prop.entity]) continue;
            const auto mesh = prop.studio ? mesh_for(core, prop.studio, prop.skin) : std::nullopt;
            if (mesh)
                add_instance(prop, *mesh);
            else
                ++frozen_;
            co_yield "animated prop";
        }
        if (!props.instances().empty()) create_bone_texture();
        prepare_states(core);
        std::cout << "Map props: " << props.instances().size() << " animated props, " << props.model_count()
                  << " models, " << frozen_ << " frozen\n";
    }

    // Whether the core's frozen group of `entity` is replaced by a posed mesh (always false while disabled).
    bool replaces(int32_t entity) const {
        return enabled_ && entity >= 0 && size_t(entity) < replaced_.size() && replaced_[size_t(entity)];
    }

    bool active() const { return enabled_ && !props.instances().empty(); }

    // Potato draws the frozen groups.
    void set_enabled(bool value) { enabled_ = value; }

    // What the map's I/O asked the props to play, read again only when the core says it changed.
    void refresh(BhContext *core) {
        if (props.instances().empty()) return;
        const uint32_t serial = bh_prop_anim_serial(core);
        if (core == stateContext_ && serial == stateSerial_) return;
        stateContext_ = core;
        stateSerial_ = serial;
        read_states(core);
    }

    std::span<const Group> groups(size_t instance) const {
        const auto &mesh = meshes_[instanceMeshes_[instance]];
        return mesh.groups;
    }

    GLuint vao(size_t instance) const { return models_[meshes_[instanceMeshes_[instance]].model].vao; }

    // Uploads the bone rows posed since the last upload; the texture stays bound to `unit`.
    void upload(GLenum unit) {
        const auto [first, end] = props.take_dirty();
        gl.ActiveTexture(unit);
        gl.BindTexture(GL_TEXTURE_2D, boneTexture_);
        if (first >= end) return;
        const uint32_t first_row = uint32_t(first / bones_per_row);
        const uint32_t end_row = uint32_t((end + bones_per_row - 1) / bones_per_row);
        const float *rows = props.rows().data() + size_t(first_row) * bones_per_row * texels_per_bone * 4;
        gl.PixelStorei(GL_UNPACK_ALIGNMENT, 4);
        gl.TexSubImage2D(
                GL_TEXTURE_2D,
                0,
                0,
                GLint(first_row),
                GLsizei(bones_per_row * texels_per_bone),
                GLsizei(end_row - first_row),
                GL_RGBA,
                GL_FLOAT,
                rows
        );
    }

    void bind_bones(GLenum unit) const {
        gl.ActiveTexture(unit);
        gl.BindTexture(GL_TEXTURE_2D, boneTexture_);
    }

private:
    struct Model {
        uint32_t handle = 0;
        // Index into props' models, or none when the rig or mesh can't be used.
        std::optional<uint32_t> rig;
        GLuint vao = 0, vbo = 0, ebo = 0;
        std::vector<float> vertices;
        std::vector<uint32_t> indices;
        nlohmann::json info;
    };

    struct Mesh {
        size_t model;
        int32_t skin;
        std::vector<Group> groups;
    };

    Gl &gl;
    std::vector<Model> models_;
    std::vector<Mesh> meshes_;
    std::vector<size_t> instanceMeshes_;
    std::vector<bool> owners_, replaced_;
    std::unordered_map<std::string, uint32_t> propMaterials_;
    std::vector<BhPropAnimState> states_;
    std::array<char, 2048> names_{};
    GLuint boneTexture_ = 0;
    BhContext *stateContext_ = nullptr;
    uint32_t stateSerial_ = 0;
    size_t frozen_ = 0, animationFloats_ = 0;
    bool enabled_ = true;

    void release() {
        for (auto &m : models_) {
            if (m.vao) gl.DeleteVertexArrays(1, &m.vao);
            if (m.vbo) gl.DeleteBuffers(1, &m.vbo);
            if (m.ebo) gl.DeleteBuffers(1, &m.ebo);
        }
        if (boneTexture_) gl.DeleteTextures(1, &boneTexture_);
        boneTexture_ = 0;
        models_.clear();
        meshes_.clear();
        instanceMeshes_.clear();
        props = {};
        frozen_ = animationFloats_ = 0;
        stateContext_ = nullptr;
    }

    // Entities with a moving prop group outside the 3D skybox: the props the core draws on their own.
    void mark_owners(std::span<const BhPropGroup> prop_groups) {
        owners_.clear();
        for (const auto &g : prop_groups) {
            if (g.entity < 0 || g.sky3d) continue;
            if (size_t(g.entity) >= owners_.size()) owners_.resize(size_t(g.entity) + 1);
            owners_[size_t(g.entity)] = true;
        }
        replaced_.assign(owners_.size(), false);
    }

    // map-props.ts matches studio material names against the prop mesh's materials, as written and lower case.
    void index_prop_materials(std::span<const BhPropGroup> prop_groups, const nlohmann::json &names) {
        propMaterials_.clear();
        std::vector<uint32_t> used;
        for (const auto &g : prop_groups)
            used.push_back(g.material);
        std::sort(used.begin(), used.end());
        used.erase(std::unique(used.begin(), used.end()), used.end());
        for (const auto index : used) {
            if (index >= names.size() || !names[index].is_string()) continue;
            const auto name = names[index].get<std::string>();
            propMaterials_.emplace(name, index);
            propMaterials_.emplace(native_studio::lower_ascii(name), index);
        }
    }

    std::optional<size_t> model_for(BhContext *core, uint32_t handle) {
        for (size_t i = 0; i < models_.size(); ++i)
            if (models_[i].handle == handle) return models_[i].rig ? std::optional(i) : std::nullopt;
        models_.emplace_back();
        auto &model = models_.back();
        model.handle = handle;
        try {
            load_model(core, model);
        } catch (const std::exception &error) {
            std::cerr << "Map props: model " << handle << " stays frozen: " << error.what() << "\n";
            model.rig.reset();
        }
        return model.rig ? std::optional(models_.size() - 1) : std::nullopt;
    }

    void load_model(BhContext *core, Model &model) {
        size_t bytes = 0, floats = 0, count = 0;
        const char *info = bh_studio_info(core, model.handle, &bytes);
        if (!info || !bytes) throw std::runtime_error("no studio info");
        model.info = nlohmann::json::parse(info, info + bytes);
        const float *vertices = bh_studio_vertices(core, model.handle, &floats);
        const uint32_t *indices = bh_studio_indices(core, model.handle, &count);
        if (!vertices || !indices || !floats || !count || floats % native_studio::vertex_floats)
            throw std::runtime_error("no studio mesh");
        const native_studio::AnimationReader read = [&](uint32_t animation) {
            size_t samples = 0;
            const float *data = bh_studio_animation(core, model.handle, animation, &samples);
            return data ? std::span<const float>(data, samples) : std::span<const float>();
        };
        native_studio::Rig rig(model.info, read);
        if (rig.sequences.empty()) throw std::runtime_error("no sequences");
        animationFloats_ += rig.sample_count();
        if (animationFloats_ > max_animation_floats) throw std::runtime_error("animations over the map's budget");
        model.vertices.assign(vertices, vertices + floats);
        model.indices.assign(indices, indices + count);
        check_mesh(model, rig.bones);
        model.rig = props.add_model(std::move(rig), mesh_radius(model.vertices));
    }

    static void check_mesh(const Model &model, size_t bones) {
        const size_t vertices = model.vertices.size() / native_studio::vertex_floats;
        for (const auto index : model.indices)
            if (index >= vertices) throw std::runtime_error("studio index out of range");
        for (size_t v = 0; v < vertices; ++v)
            for (size_t k = 0; k < 3; ++k) {
                const float bone =
                        model.vertices[v * native_studio::vertex_floats + native_studio::vertex_bones_at + k];
                if (!(bone >= 0) || bone >= float(bones)) throw std::runtime_error("studio bone out of range");
            }
    }

    static double mesh_radius(const std::vector<float> &vertices) {
        double radius = 0;
        for (size_t at = 0; at + 2 < vertices.size(); at += native_studio::vertex_floats)
            radius = std::max(
                    radius, std::hypot(double(vertices[at]), double(vertices[at + 1]), double(vertices[at + 2]))
            );
        return radius;
    }

    std::optional<size_t> mesh_for(BhContext *core, uint32_t handle, int32_t skin) {
        const auto model = model_for(core, handle);
        if (!model) return std::nullopt;
        for (size_t i = 0; i < meshes_.size(); ++i)
            if (meshes_[i].model == *model && meshes_[i].skin == skin)
                return meshes_[i].groups.empty() ? std::nullopt : std::optional(i);
        meshes_.push_back({*model, skin, skin_groups(models_[*model].info, skin)});
        if (meshes_.back().groups.empty()) return std::nullopt;
        upload_model(models_[*model]);
        return meshes_.size() - 1;
    }

    // Mesh groups are by skin family 0's textures; the prop's skin swaps each skin reference's texture (map-props.ts).
    std::vector<Group> skin_groups(const nlohmann::json &info, int32_t skin) const {
        const auto skins = info.value("skins", nlohmann::json::array());
        const bool remap = skins.size() > 1 && skin > 0 && size_t(skin) < skins.size();
        std::vector<Group> out;
        for (const auto &g : info.at("groups")) {
            int texture = g.at(0).get<int>();
            if (remap) texture = skinned_texture(skins[0], skins[size_t(skin)], texture);
            const auto &materials = info.at("materials");
            if (texture < 0 || size_t(texture) >= materials.size()) continue;
            const auto name = materials[size_t(texture)].value("name", std::string());
            auto found = propMaterials_.find(name);
            if (found == propMaterials_.end()) found = propMaterials_.find(native_studio::lower_ascii(name));
            if (found == propMaterials_.end()) continue;
            out.push_back({found->second, g.at(1).get<uint32_t>(), g.at(2).get<uint32_t>()});
        }
        return out;
    }

    static int skinned_texture(const nlohmann::json &family0, const nlohmann::json &family, int texture) {
        for (size_t reference = 0; reference < family0.size(); ++reference)
            if (family0[reference].get<int>() == texture)
                return reference < family.size() ? family[reference].get<int>() : texture;
        return texture;
    }

    void upload_model(Model &model) {
        if (model.vao) return;
        const GLsizei stride = GLsizei(native_studio::vertex_floats * sizeof(float));
        gl.GenVertexArrays(1, &model.vao);
        gl.BindVertexArray(model.vao);
        gl.GenBuffers(1, &model.vbo);
        gl.BindBuffer(GL_ARRAY_BUFFER, model.vbo);
        gl.BufferData(
                GL_ARRAY_BUFFER,
                GLsizeiptr(model.vertices.size() * sizeof(float)),
                model.vertices.data(),
                GL_STATIC_DRAW
        );
        gl.GenBuffers(1, &model.ebo);
        gl.BindBuffer(GL_ELEMENT_ARRAY_BUFFER, model.ebo);
        gl.BufferData(
                GL_ELEMENT_ARRAY_BUFFER,
                GLsizeiptr(model.indices.size() * sizeof(uint32_t)),
                model.indices.data(),
                GL_STATIC_DRAW
        );
        // Locations as the world shader reads them: position, normal, uv, then bone weights and bone indices.
        const std::array<std::pair<GLuint, size_t>, 5> attributes{
                {{0, 0}, {1, 3}, {2, 6}, {5, native_studio::vertex_weights_at}, {6, native_studio::vertex_bones_at}}
        };
        for (const auto &[location, offset] : attributes) {
            gl.EnableVertexAttribArray(location);
            gl.VertexAttribPointer(
                    location,
                    location == 2 ? 2 : 3,
                    GL_FLOAT,
                    GL_FALSE,
                    stride,
                    reinterpret_cast<void *>(offset * sizeof(float))
            );
        }
        gl.BindVertexArray(0);
        model.vertices = {};
        model.indices = {};
    }

    void add_instance(const BhAnimatedProp &prop, size_t mesh) {
        std::optional<native_map_props::RandomAnimator> random;
        if (prop.random) random.emplace(prop.random_seed, prop.min_anim_time, prop.max_anim_time);
        props.add_instance(prop.entity, *models_[meshes_[mesh].model].rig, std::move(random));
        instanceMeshes_.push_back(mesh);
        replaced_[prop.entity] = true;
    }

    void create_bone_texture() {
        const uint32_t rows = uint32_t((props.bone_count() + bones_per_row - 1) / bones_per_row);
        GLint limit = 0;
        gl.GetIntegerv(GL_MAX_TEXTURE_SIZE, &limit);
        if (GLint(rows) > limit) throw std::runtime_error("Too many animated prop bones for one texture");
        props.reserve_rows(size_t(rows) * bones_per_row);
        gl.GenTextures(1, &boneTexture_);
        gl.BindTexture(GL_TEXTURE_2D, boneTexture_);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
        gl.TexImage2D(
                GL_TEXTURE_2D,
                0,
                GL_RGBA32F,
                GLsizei(bones_per_row * texels_per_bone),
                GLsizei(rows),
                0,
                GL_RGBA,
                GL_FLOAT,
                props.rows().data()
        );
    }

    // The state buffer holds every animated prop the core tracks (fixed per map).
    void prepare_states(BhContext *core) {
        states_.resize(64);
        while (bh_prop_anim_states(core, states_.data(), states_.size()) == states_.size())
            states_.resize(states_.size() * 2);
    }

    void read_states(BhContext *core) {
        const size_t count = bh_prop_anim_states(core, states_.data(), states_.size());
        auto instances = props.instances();
        size_t next = 0;
        for (size_t i = 0; i < count; ++i) {
            const auto &state = states_[i];
            while (next < instances.size() && instances[next].entity < state.entity)
                ++next;
            if (next == instances.size()) break;
            if (instances[next].entity != state.entity) continue;
            apply_state(core, i, state, instances[next]);
        }
    }

    void
    apply_state(BhContext *core, size_t index, const BhPropAnimState &state, native_map_props::PropInstance &instance) {
        const size_t written = bh_prop_anim_names(core, index, names_.data(), names_.size());
        const std::string_view anim = written ? std::string_view(names_.data()) : std::string_view();
        const std::string_view default_anim =
                written ? std::string_view(names_.data() + anim.size() + 1) : std::string_view();
        auto &model = props.model(instance.model);
        instance.state = {
                model.lookup(anim, instance.entity),
                model.lookup(default_anim, instance.entity),
                double(state.base),
                double(state.since),
                double(state.rate)
        };
        instance.set = (state.flags & native_map_props::prop_anim_set_flag) != 0;
        // A new sequence is posed again even when the frame stamp matches.
        instance.stamp = std::numeric_limits<double>::quiet_NaN();
    }
};
