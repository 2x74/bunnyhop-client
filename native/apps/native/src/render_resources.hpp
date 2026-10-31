#pragma once

struct RenderGeometry {
    GLuint vao = 0, vbo = 0, ebo = 0, blend = 0;
    size_t indices = 0;
};

class RenderResources {
    Gl &gl;
    BhContext *&core;

public:
    RenderResources(Gl &g, BhContext *&c) : gl(g), core(c) {}

    GLuint emptyVao = 0, white = 0, checker = 0;
    std::vector<GLuint> ownedTextures;
    std::unordered_map<uint64_t, GLuint> textures;
    std::unordered_map<int32_t, std::pair<uint32_t, uint32_t>> textureSizes;
    std::unordered_map<int32_t, std::array<float, 3>> textureAverages;
    // Textures a cutout or translucent material reads alpha from (texture_bleed.hpp).
    std::unordered_set<int32_t> cutoutTextures;

    GLuint upload(const BhImage &image, bool repeat, bool mipmap, bool srgb = true) {
        if (!image.rgba || !image.width || !image.height || uint64_t(image.width) * image.height * 4 > image.byte_count)
            throw std::runtime_error("Invalid native texture");
        GLint limit = 0;
        gl.GetIntegerv(GL_MAX_TEXTURE_SIZE, &limit);
        if (image.width > uint32_t(limit) || image.height > uint32_t(limit))
            throw std::runtime_error("Native texture exceeds GPU limit");
        GLuint id = 0;
        gl.GenTextures(1, &id);
        ownedTextures.push_back(id);
        gl.BindTexture(GL_TEXTURE_2D, id);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, mipmap ? GL_LINEAR_MIPMAP_LINEAR : GL_LINEAR);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, repeat ? GL_REPEAT : GL_CLAMP_TO_EDGE);
        gl.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, repeat ? GL_REPEAT : GL_CLAMP_TO_EDGE);
        gl.PixelStorei(GL_UNPACK_ALIGNMENT, 1);
        gl.TexImage2D(
                GL_TEXTURE_2D,
                0,
                srgb ? GL_SRGB8_ALPHA8 : GL_RGBA8,
                image.width,
                image.height,
                0,
                GL_RGBA,
                GL_UNSIGNED_BYTE,
                image.rgba
        );
        if (mipmap) gl.GenerateMipmap(GL_TEXTURE_2D);
        return id;
    }

    GLuint texture(int32_t index, bool raw = false) {
        if (index < 0) return white;
        const uint64_t key = uint32_t(index) | (uint64_t(raw) << 32);
        const auto found = textures.find(key);
        return found == textures.end() ? checker : found->second;
    }

    ResourceLoading cache_texture(int32_t index, bool raw = false) {
        if (index < 0) co_return;
        const uint64_t key = uint32_t(index) | (uint64_t(raw) << 32);
        if (textures.count(key)) co_return;
        BhImage image{};
        GLuint id = checker;
        if (bh_texture(core, index, &image)) {
            textureSizes[index] = {image.width, image.height};
            std::vector<uint8_t> pixels;
            if (!raw && cutoutTextures.count(index)) {
                pixels.assign(image.rgba, image.rgba + image.byte_count);
                const auto width = image.width, height = image.height;
                std::packaged_task<std::vector<uint8_t>()> prepare(
                        [pixels = std::move(pixels), width, height]() mutable {
                            if (native_render::has_transparent_texels(pixels))
                                native_render::bleed_transparent_texels(pixels, width, height);
                            return std::move(pixels);
                        }
                );
                auto result = prepare.get_future();
                std::thread(std::move(prepare)).detach();
                while (result.wait_for(std::chrono::seconds(0)) != std::future_status::ready)
                    co_yield "cutout pixels";
                pixels = result.get();
            }
            co_yield "upload texture";
            const BhImage prepared{
                    pixels.empty() ? image.rgba : pixels.data(), image.byte_count, image.width, image.height
            };
            id = upload(prepared, true, true, !raw);
            if (!raw) {
                std::array<float, 3> average{};
                const size_t pixels = size_t(image.width) * image.height;
                const size_t step = std::max(size_t(1), pixels / 4096);
                size_t count = 0;
                for (size_t pixel = 0; pixel < pixels; pixel += step) {
                    for (size_t channel = 0; channel < 3; ++channel) {
                        average[channel] += native_render::srgb_linear(float(image.rgba[pixel * 4 + channel]) / 255);
                    }
                    ++count;
                }
                for (auto &channel : average)
                    channel /= std::max(size_t(1), count);
                textureAverages[index] = average;
            }
        }
        textures.emplace(key, id);
    }

    RenderGeometry geometry(
            const float *vertices,
            size_t floats,
            int stride,
            const uint32_t *indices,
            size_t count,
            const float *blend = nullptr,
            size_t blends = 0
    ) {
        RenderGeometry out;
        if (!floats || !count) return out;
        if (!vertices || !indices || floats % stride || count > size_t(std::numeric_limits<GLsizei>::max()))
            throw std::runtime_error("Invalid native geometry buffer");
        for (size_t i = 0; i < count; i++)
            if (indices[i] >= floats / stride) throw std::runtime_error("Native mesh index out of bounds");
        out.indices = count;
        gl.GenVertexArrays(1, &out.vao);
        gl.BindVertexArray(out.vao);
        gl.GenBuffers(1, &out.vbo);
        gl.BindBuffer(GL_ARRAY_BUFFER, out.vbo);
        gl.BufferData(GL_ARRAY_BUFFER, floats * sizeof(float), vertices, GL_STATIC_DRAW);
        gl.GenBuffers(1, &out.ebo);
        gl.BindBuffer(GL_ELEMENT_ARRAY_BUFFER, out.ebo);
        gl.BufferData(GL_ELEMENT_ARRAY_BUFFER, count * sizeof(uint32_t), indices, GL_STATIC_DRAW);
        gl.EnableVertexAttribArray(0);
        gl.VertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, stride * sizeof(float), nullptr);
        if (stride >= 8) {
            for (int i = 1; i < 3; i++) {
                gl.EnableVertexAttribArray(i);
                gl.VertexAttribPointer(
                        i,
                        i == 1 ? 3 : 2,
                        GL_FLOAT,
                        GL_FALSE,
                        stride * sizeof(float),
                        reinterpret_cast<void *>(size_t(i == 1 ? 3 : 6) * sizeof(float))
                );
            }
        }
        if (stride == 10) {
            gl.EnableVertexAttribArray(3);
            gl.VertexAttribPointer(
                    3, 2, GL_FLOAT, GL_FALSE, stride * sizeof(float), reinterpret_cast<void *>(8 * sizeof(float))
            );
        }
        if (blend && blends == floats / stride) {
            gl.GenBuffers(1, &out.blend);
            gl.BindBuffer(GL_ARRAY_BUFFER, out.blend);
            gl.BufferData(GL_ARRAY_BUFFER, blends * sizeof(float), blend, GL_STATIC_DRAW);
            gl.EnableVertexAttribArray(4);
            gl.VertexAttribPointer(4, 1, GL_FLOAT, GL_FALSE, sizeof(float), nullptr);
        }
        return out;
    }

    void destroy(RenderGeometry &mesh) {
        if (mesh.blend) gl.DeleteBuffers(1, &mesh.blend);
        if (mesh.ebo) gl.DeleteBuffers(1, &mesh.ebo);
        if (mesh.vbo) gl.DeleteBuffers(1, &mesh.vbo);
        if (mesh.vao) gl.DeleteVertexArrays(1, &mesh.vao);
    }

    void prepare_fallback_textures() {
        gl.GenVertexArrays(1, &emptyVao);
        const uint8_t blank[4] = {255, 255, 255, 255};
        white = upload({blank, 4, 1, 1}, true, false);
        uint8_t fallback[8 * 8 * 4];
        for (int y = 0; y < 8; y++)
            for (int x = 0; x < 8; x++) {
                const uint8_t v = ((x / 4 + y / 4) % 2) ? 140 : 185;
                const int at = (y * 8 + x) * 4;
                fallback[at] = fallback[at + 1] = fallback[at + 2] = v;
                fallback[at + 3] = 255;
            }
        checker = upload({fallback, sizeof(fallback), 8, 8}, true, true);
    }

};
